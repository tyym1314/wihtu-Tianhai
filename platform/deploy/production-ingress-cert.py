#!/usr/bin/env python3
"""Scope-only Certbot guard. Never runs Certbot or opens a private-key body.

The caller must hold its existing deployment lock, bind this helper to the
release manifest, call prepare_cli_config() in its owned private directory,
then immediately pass scope_check(mode)['argv'] to its clean-env runner.
--config is additive in ConfigArgParse: default CLI files are independently
required absent or empty. Shared lineages and directory hooks are untouched.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import ssl
import stat

BASE = Path('/opt/oasis')
HOST = 'oasis-player.43.98.202.236.sslip.io'
NAME = 'oasis-production-player'
CONFIG = BASE / 'acme/config'
WORK = BASE / 'acme/work'
LOGS = BASE / 'acme/logs'
PRIVATE = BASE / 'production-ingress-private'
WEBROOT = BASE / 'production-player-acme-webroot'
CLI = PRIVATE / 'certbot-cli.ini'
RENEWAL = CONFIG / 'renewal' / (NAME + '.conf')
ARCHIVE = CONFIG / 'archive' / NAME
LIVE = CONFIG / 'live' / NAME
CERTBOT = BASE / 'certbot/bin/certbot'
SERVER = 'https://acme-v02.api.letsencrypt.org/directory'
ROOT_UID = 0
ANCESTOR_STOP = Path('/')
HOOKS = frozenset(('pre_hook', 'post_hook', 'deploy_hook', 'renew_hook',
                  'manual_auth_hook', 'manual_cleanup_hook', 'installer'))


class Refusal(RuntimeError):
    """Only stable, nonsecret error codes are exposed."""


def require(value, code):
    if not value:
        raise Refusal(code)


def metadata(value):
    return {'device': value.st_dev, 'inode': value.st_ino, 'uid': value.st_uid,
            'gid': value.st_gid, 'mode': stat.S_IMODE(value.st_mode),
            'nlink': value.st_nlink, 'bytes': value.st_size,
            'mtime_ns': value.st_mtime_ns, 'ctime_ns': value.st_ctime_ns}


def parents(path):
    if path == ANCESTOR_STOP:
        return
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == ROOT_UID and
                not stat.S_IMODE(info.st_mode) & 0o022, 'UNSAFE_CERTBOT_PARENT')
        if parent == ANCESTOR_STOP:
            return
    raise Refusal('CERTBOT_PARENT_ESCAPE')


def directory(path, mode=None):
    parents(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == ROOT_UID and
            not stat.S_IMODE(info.st_mode) & 0o022, 'UNSAFE_CERTBOT_DIRECTORY')
    require(mode is None or stat.S_IMODE(info.st_mode) == mode,
            'CERTBOT_DIRECTORY_MODE')
    return metadata(info)


def regular_metadata(path, mode=None, maximum=65536):
    parents(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == ROOT_UID and not stat.S_IMODE(info.st_mode) & 0o022,
            'UNSAFE_CERTBOT_FILE')
    require(mode is None or stat.S_IMODE(info.st_mode) == mode, 'CERTBOT_FILE_MODE')
    require(0 <= info.st_size <= maximum, 'CERTBOT_FILE_SIZE')
    return metadata(info)


def read_public(path, mode=None, maximum=65536, decoder=False):
    expected = regular_metadata(path, mode, maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(metadata(os.fstat(fd)) == expected, 'CERTBOT_FILE_REPLACED')
        data = os.read(fd, maximum + 1)
        require(len(data) <= maximum and len(data) == expected['bytes'], 'CERTBOT_FILE_SIZE')
        certificate = None
        if decoder:
            os.lseek(fd, 0, os.SEEK_SET)
            fdroot = '/proc/self/fd' if Path('/proc/self/fd').is_dir() else '/dev/fd'
            try:
                certificate = ssl._ssl._test_decode_cert(fdroot + '/' + str(fd))
            except (ValueError, ssl.SSLError, OSError) as error:
                raise Refusal('INVALID_PUBLIC_CERTIFICATE') from error
        require(metadata(os.fstat(fd)) == expected and
                regular_metadata(path, mode, maximum) == expected, 'CERTBOT_FILE_REPLACED')
        return data, {**expected, 'sha256': hashlib.sha256(data).hexdigest()}, certificate
    finally:
        os.close(fd)


def prepare_cli_config():
    """The only optional mutation: create our own root0600 zero-byte CLI file."""
    directory(PRIVATE, 0o700)
    if not os.path.lexists(CLI):
        fd = os.open(CLI, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                     os.O_CLOEXEC, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
    return empty_cli(CLI)


def empty_cli(path):
    data, proof, _ = read_public(path, 0o600)
    require(data == b'', 'NONEMPTY_CERTBOT_CLI_CONFIG')
    return proof


def default_cli_paths():
    # Certbot 5.8 constants: /etc/letsencrypt/cli.ini and the root user's
    # ~/.config/letsencrypt/cli.ini; include the shared config-dir CLI as well.
    home = Path(pwd.getpwuid(ROOT_UID).pw_dir)
    require(home.is_absolute(), 'UNSAFE_ROOT_HOME')
    return tuple(dict.fromkeys((Path('/etc/letsencrypt/cli.ini'),
                               home / '.config/letsencrypt/cli.ini', CONFIG / 'cli.ini')))


def default_cli_guard():
    proof = {}
    for path in default_cli_paths():
        if not os.path.lexists(path):
            # Even an absent leaf cannot conceal a symlinked existing parent.
            nearest = path.parent
            while not os.path.lexists(nearest):
                nearest = nearest.parent
            directory(nearest)
            proof[str(path)] = {'absent': True}
        else:
            data, pin, _ = read_public(path)
            require(data == b'', 'AMBIENT_CERTBOT_CLI_CONFIG')
            proof[str(path)] = pin
    return proof


def config_value(raw):
    """Small, strict ConfigObj scalar/list grammar; never interpolates values."""
    parts, buf, quote, quoted_end = [], [], None, False
    for char in raw:
        if quote:
            if char == quote:
                quote = None
                quoted_end = True
            else:
                require(char != '\\', 'UNSUPPORTED_RENEWAL_QUOTING')
                buf.append(char)
        elif char in ('"', "'"):
            require(not ''.join(buf).strip() and not quoted_end, 'UNSUPPORTED_RENEWAL_QUOTING')
            quote = char
        elif char == '#':
            break
        elif char == ',':
            parts.append(''.join(buf).strip()); buf = []; quoted_end = False
        else:
            require(not quoted_end or char.isspace(), 'UNSUPPORTED_RENEWAL_QUOTING')
            require(char not in '\\[]' and ord(char) >= 32, 'UNSUPPORTED_RENEWAL_VALUE')
            buf.append(char)
    require(quote is None, 'UNTERMINATED_RENEWAL_QUOTE')
    last = ''.join(buf).strip()
    if not parts:
        return last
    if last:
        parts.append(last)
    require(all(parts), 'EMPTY_RENEWAL_LIST_MEMBER')
    return parts


def parse_renewal(data):
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError as error:
        raise Refusal('RENEWAL_NOT_UTF8') from error
    require('\r' not in text and '\x00' not in text, 'INVALID_RENEWAL_TEXT')
    result = {'top': {}}
    section = result['top']
    parent = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            if line == '[[webroot_map]]':
                require(parent == 'renewalparams' and 'webroot_map' not in result,
                        'INVALID_RENEWAL_NESTED_SECTION')
                section = result.setdefault('webroot_map', {})
            else:
                require(line in ('[renewalparams]', '[acme_renewal_info]'),
                        'UNKNOWN_RENEWAL_SECTION')
                parent = line[1:-1]
                require(parent not in result, 'DUPLICATE_RENEWAL_SECTION')
                section = result.setdefault(parent, {})
            continue
        require('=' in line, 'INVALID_RENEWAL_ASSIGNMENT')
        key, raw = line.split('=', 1)
        key = key.strip()
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', key) and key not in section,
                'INVALID_OR_DUPLICATE_RENEWAL_KEY')
        section[key] = config_value(raw.strip())
    return result


def validate_renewal(parsed):
    top = parsed.get('top', {})
    require(set(top) == {'version', 'archive_dir', 'cert', 'privkey', 'chain', 'fullchain'},
            'UNKNOWN_OR_MISSING_RENEWAL_TOP_KEY')
    require(isinstance(top['version'], str) and re.fullmatch(r'5\.8\.\d+', top['version']),
            'UNREVIEWED_CERTBOT_RENEWAL_VERSION')
    require(top['archive_dir'] == str(ARCHIVE), 'RENEWAL_ARCHIVE_SCOPE')
    for name in ('cert', 'privkey', 'chain', 'fullchain'):
        require(top[name] == str(LIVE / (name + '.pem')), 'RENEWAL_LIVE_SCOPE')
    params = parsed.get('renewalparams', {})
    required = {'account', 'config_dir', 'work_dir', 'logs_dir', 'authenticator',
                'webroot_path', 'server', 'key_type'}
    require(required <= set(params) <= required | HOOKS, 'UNKNOWN_OR_MISSING_RENEWAL_PARAM')
    for hook in HOOKS & set(params):
        require(params[hook] == '', 'RENEWAL_EXECUTION_HOOK')
    require(isinstance(params['account'], str) and
            re.fullmatch(r'[a-fA-F0-9]{32,128}', params['account']), 'RENEWAL_ACCOUNT_FORMAT')
    require(params['authenticator'] == 'webroot' and params['server'] == SERVER and
            params['key_type'] in ('ecdsa', 'rsa'), 'RENEWAL_PLUGIN_OR_SERVER_SCOPE')
    for name, path in (('config_dir', CONFIG), ('work_dir', WORK), ('logs_dir', LOGS)):
        require(params[name] == str(path), 'RENEWAL_SHARED_DIRECTORY_SCOPE')
    require(params['webroot_path'] in (str(WEBROOT), [str(WEBROOT)]), 'RENEWAL_WEBROOT_SCOPE')
    require(parsed.get('webroot_map') == {HOST: str(WEBROOT)}, 'RENEWAL_DOMAIN_SCOPE')
    ari = parsed.get('acme_renewal_info', {})
    require(set(ari) <= {'ari_retry_after'}, 'UNKNOWN_RENEWAL_ARI_KEY')
    if ari:
        require(isinstance(ari['ari_retry_after'], str) and
                re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)?',
                             ari['ari_retry_after']), 'INVALID_RENEWAL_ARI_TIMESTAMP')
        try:
            datetime.datetime.fromisoformat(ari['ari_retry_after'].replace('Z', '+00:00'))
        except ValueError as error:
            raise Refusal('INVALID_RENEWAL_ARI_TIMESTAMP') from error
    return {'version': top['version'], 'authenticator': 'webroot',
            'domains': [HOST], 'key_type': params['key_type'], 'hooks_empty': True}


def certificate_scope():
    directory(ARCHIVE); directory(LIVE)
    leaves, links, versions = {}, {}, set()
    for name in ('cert', 'privkey', 'chain', 'fullchain'):
        link = LIVE / (name + '.pem')
        info = link.lstat()
        require(stat.S_ISLNK(info.st_mode) and info.st_uid == ROOT_UID and info.st_nlink == 1,
                'UNSAFE_CERTIFICATE_LIVE_LINK')
        target = os.readlink(link)
        match = re.fullmatch(r'../../archive/' + re.escape(NAME) + '/' + name + r'([1-9]\d*)\.pem', target)
        require(match, 'CERTIFICATE_LINK_SCOPE')
        versions.add(match.group(1))
        leaf = ARCHIVE / (name + match.group(1) + '.pem')
        # Private key intentionally receives metadata-only validation, no open.
        leaves[name] = regular_metadata(leaf, 0o600 if name == 'privkey' else None)
        links[name] = {'metadata': metadata(info), 'target': target}
    require(len(versions) == 1, 'CERTIFICATE_VERSION_MISMATCH')
    version = next(iter(versions))
    public, leaves['cert'], decoded = read_public(ARCHIVE / ('cert' + version + '.pem'), decoder=True)
    require(decoded.get('subjectAltName') == (('DNS', HOST),), 'CERTIFICATE_SAN_SCOPE')
    fullchain, leaves['fullchain'], _ = read_public(ARCHIVE / ('fullchain' + version + '.pem'))
    first = re.match(rb'\s*(-----BEGIN CERTIFICATE-----\s+.*?-----END CERTIFICATE-----)',
                     fullchain, re.DOTALL)
    require(first and re.sub(rb'\s+', b'', first.group(1)) == re.sub(rb'\s+', b'', public),
            'CERTIFICATE_FULLCHAIN_LEAF_MISMATCH')
    for name, proof in links.items():
        link = LIVE / (name + '.pem')
        require(metadata(link.lstat()) == proof['metadata'] and os.readlink(link) == proof['target'],
                'CERTIFICATE_LINK_REPLACED')
        leaf = ARCHIVE / (name + version + '.pem')
        require(regular_metadata(leaf, 0o600 if name == 'privkey' else None) ==
                {key: val for key, val in leaves[name].items() if key != 'sha256'},
                'CERTIFICATE_LEAF_REPLACED')
    return {'version': int(version), 'san': [HOST], 'links': links, 'leaves': leaves,
            'private_key_body_read': False}


def scope_check(mode):
    require(mode in ('certonly', 'renew'), 'INVALID_CERTBOT_SCOPE_MODE')
    directory(PRIVATE, 0o700)
    directory(WEBROOT)
    for path in (CONFIG, WORK, LOGS):
        directory(path)
    certbot = regular_metadata(CERTBOT, maximum=1024 * 1024)
    require(certbot['mode'] & 0o111, 'CERTBOT_NOT_EXECUTABLE')
    cli = empty_cli(CLI)
    ambient = default_cli_guard()
    proof = {'mode': mode, 'lineage': NAME, 'domains': [HOST], 'cli_config': cli,
             'default_cli_configs': ambient, 'certbot': certbot,
             'directory_hooks_disabled': True}
    common = ['--config', str(CLI), '--no-directory-hooks', '--pre-hook', '',
              '--post-hook', '', '--deploy-hook', '', '--config-dir', str(CONFIG),
              '--work-dir', str(WORK), '--logs-dir', str(LOGS), '--server', SERVER,
              '--non-interactive', '--cert-name', NAME]
    if mode == 'renew':
        data, renewal, _ = read_public(RENEWAL)
        proof['renewal'] = {**renewal, **validate_renewal(parse_renewal(data))}
        proof['certificate'] = certificate_scope()
        argv = [str(CERTBOT), 'renew', '--quiet', *common]
    else:
        require(not any(os.path.lexists(path) for path in (RENEWAL, ARCHIVE, LIVE)),
                'EXISTING_PRODUCTION_LINEAGE')
        argv = [str(CERTBOT), 'certonly', '--webroot', '-w', str(WEBROOT), '-d', HOST,
                '--agree-tos', '--register-unsafely-without-email', '--keep-until-expiring', *common]
    # Catch accidental concurrent changes before returning authorization.
    require(empty_cli(CLI) == cli and default_cli_guard() == ambient,
            'CERTBOT_CLI_CONFIG_CHANGED')
    require(regular_metadata(CERTBOT, maximum=1024 * 1024) == certbot, 'CERTBOT_CHANGED')
    if mode == 'renew':
        require(read_public(RENEWAL)[1] == renewal, 'CERTBOT_RENEWAL_CHANGED')
        require(certificate_scope() == proof['certificate'], 'CERTIFICATE_SCOPE_CHANGED')
    return {**proof, 'argv': argv}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('certonly', 'renew', 'prepare-cli'))
    args = parser.parse_args()
    try:
        result = prepare_cli_config() if args.mode == 'prepare-cli' else scope_check(args.mode)
        print(json.dumps({'passed': True, 'scope': result}, sort_keys=True))
    except (Refusal, OSError) as error:
        code = str(error) if isinstance(error, Refusal) else 'CERTBOT_SCOPE_FILESYSTEM_ERROR'
        print(json.dumps({'passed': False, 'error_code': code}, sort_keys=True))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Exact 04/05 Mock overlay activation and profile-aware runtime adapter.

No generic release/config bypass. Default is read-only. All privileged execution
is a Runtime boundary; this file's tests replace it, never contact the host.
"""
import argparse
from contextlib import contextmanager
import ctypes
import glob
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import ssl
import stat
import subprocess
import tarfile
import time
import types
import urllib.error
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
# This is a reviewed dependency transition, not permission to use whatever
# installer happens to be adjacent. Historical releases remain byte-for-byte.
LEGACY_INSTALLER_SHA = '8b631520883f039e07c53b191360e359b8df4cebb7a247713aba5929291a19df'
DEPENDENCIES = {
    'install.py': '9ccd1b7b1f751ebb2d0d5e5dc52699de4ad1daff4f7a1423108059dbc4f52639',
    'upgrade.py': 'ea6417ca904f95a8bc5cc6e2589d2ee543b803975509d226578eb638659d1fcf',
    'route_profile.py': '7c2e2ed387a1fa29953d8f0db30e00039d2831f39ebbc61658db6733d7e0542d',
    'asset_store.py': 'dedea88dc2739c79d128c6ea84802ded4417a94bfe455c4151290dbc7fbbdbdf',
    'asset_routes.py': '2729eef44d6fc55fffcd8016ea5401657d25a5873121b373bcbc850daa26f9f0',
    'asset_bundle.py': '50db617d949877e30ff184f3a9effc5ca47bd17b398d97f9758580e83a8c7a69',
}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def dependency_identity():
    for name, expected in DEPENDENCIES.items():
        p = HERE / name
        s = p.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and not s.st_mode & 0o022
                and sha(p.read_bytes()) == expected, 'PROFILE_DEPENDENCY_NOT_REVIEWED')
    return {'adapter': sha(Path(__file__).read_bytes()), 'dependencies': dict(DEPENDENCIES)}


dependency_identity()  # Verify exact sources BEFORE executing any dependency.


def load(name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


upgrade = load('mock_profile_upgrade', HERE / 'upgrade.py')
profile = load('mock_activation_profile', HERE / 'route_profile.py')
installer, store, bundle = upgrade.installer, profile.store, profile.bundle
CONTROL_NAME = '.activation-04-to-05-v1'
PHASES = {'prepared', 'switching', 'configured', 'reloading', 'verified', 'complete',
          'restoring', 'restored', 'rolled_back'}


def root_dir(path, mode=0o700):
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.geteuid()
            and stat.S_IMODE(s.st_mode) == mode, 'PROFILE_DIRECTORY_IDENTITY')


def read_file(path, mode, maximum=8 * 1024 * 1024):
    return profile.owned_bytes(path, os.geteuid(), mode, maximum)


def make_dir(path, mode):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=mode)
        path.chmod(mode)
        upgrade.sync_dir(path.parent)
    root_dir(path, mode)


def exclusive_material(path, raw, mode):
    """Resume only an owned prefix of these exact deterministic bytes."""
    if path.exists() or path.is_symlink():
        require(read_file(path, mode, len(raw)) == raw, 'PROFILE_MATERIAL_CHANGED')
        return
    pending = path.with_name('.' + path.name + '.pending')
    if pending.exists() or pending.is_symlink():
        observed_mode = stat.S_IMODE(pending.lstat().st_mode)
        require(observed_mode in (0o600, mode), 'PROFILE_PARTIAL_CHANGED')
        partial = read_file(pending, observed_mode, len(raw))
        require(raw.startswith(partial) and (observed_mode == 0o600 or partial == raw), 'PROFILE_PARTIAL_CHANGED')
        pending.unlink()
        upgrade.sync_dir(pending.parent)
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(raw)
        out.flush()
        os.fchmod(out.fileno(), mode)
        os.fsync(out.fileno())
    os.rename(pending, path)
    upgrade.sync_dir(path.parent)


class Materials:
    def __init__(self, base=installer.BASE, config=profile.TLS_CONF, store_parent=store.STORE.parent,
                 material_root=profile.PROFILE_ROOT):
        self.base, self.config = Path(base), Path(config)
        self.store_parent, self.root = Path(store_parent), Path(material_root)
        self.control = self.root.parent / CONTROL_NAME
        self.bundle_path = self.control / 'bundle.tar'

    def inputs(self, source=None):
        if source is not None:
            self.unprepared_source = Path(source)
        source = (Path(source) if source is not None else self.bundle_path if self.bundle_path.exists()
                  else getattr(self, 'unprepared_source', self.bundle_path))
        with bundle.open_regular(source) as stream:
            raw = stream.read(bundle.MAX_BUNDLE_BYTES + 1)
        before, old_files = profile.read_release_inputs(self.base / 'releases' / upgrade.OLD_NAME, '04')
        after, new_files = profile.read_release_inputs(self.base / 'releases' / upgrade.NEW_NAME, '05')
        result = dict(old_manifest=before, new_manifest=after, old_files=old_files,
                      new_files=new_files, asset_bundle=raw)
        profile.build_profiles(**result)
        return result

    def verify(self, inputs=None, require_overlay=False):
        inputs = inputs or self.inputs()
        found = profile.verify_profile_files(inputs, self.config, self.bundle_path,
                    store_parent=self.store_parent, material_root=self.root, owner=os.geteuid())
        if require_overlay:
            require(found['profile'] == 'overlay', 'PROFILE_OVERLAY_REQUIRED')
        return found

    def prepare(self, source):
        inputs = self.inputs(source)
        generated = profile.build_profiles(**inputs)
        # Parent ancestors use the same no-link/no-untrusted-write policy as store.
        store.Store(self.root.parent, owner=os.geteuid()).ancestors()
        make_dir(self.root.parent, 0o755)
        make_dir(self.control, 0o700)
        intent = bundle.encoded({'kind': 'mock-profile-materials-v1', 'identity': dependency_identity(),
            'bundle_sha256': sha(inputs['asset_bundle']), 'files': {n: sha(v) for n, v in generated.items()}})
        exclusive_material(self.control / 'materials.json', intent, 0o600)
        exclusive_material(self.bundle_path, inputs['asset_bundle'], 0o600)
        assets = store.Store(self.store_parent, owner=os.geteuid())
        if assets.parent.exists() and any((assets.parent / name).exists() for name in
                                         (store.INTENT, store.INTENT + '.pending', store.STAGE, store.NAME)):
            assets.recover(self.bundle_path)
        else:
            assets.install(self.bundle_path)
        stage = self.root.with_name('.' + self.root.name + '.stage')
        if self.root.exists() or self.root.is_symlink():
            require(not stage.exists() and not stage.is_symlink(), 'PROFILE_AMBIGUOUS_MATERIALS')
        else:
            if stage.exists() or stage.is_symlink():
                root_dir(stage, stat.S_IMODE(stage.lstat().st_mode))
                require(stat.S_IMODE(stage.lstat().st_mode) in (0o700, 0o755), 'PROFILE_STAGE_MODE')
            else:
                make_dir(stage, 0o700)
            allowed = set(generated) | {'.' + n + '.pending' for n in generated}
            require({p.name for p in stage.iterdir()} <= allowed, 'PROFILE_STAGE_MEMBERS')
            for name, raw in generated.items():
                exclusive_material(stage / name, raw, 0o444)
            stage.chmod(0o755)
            upgrade.sync_dir(stage)
            os.rename(stage, self.root)
            upgrade.sync_dir(self.root.parent)
        self.verify_materials(inputs)
        return {'status': 'prepared', 'store_installed': True, 'nginx_changed': False}

    def verify_materials(self, inputs):
        generated = profile.build_profiles(**inputs)
        root_dir(self.control)
        require(read_file(self.bundle_path, 0o600, bundle.MAX_BUNDLE_BYTES) == inputs['asset_bundle'],
                'PROFILE_BUNDLE_CHANGED')
        expected = bundle.encoded({'kind': 'mock-profile-materials-v1', 'identity': dependency_identity(),
            'bundle_sha256': sha(inputs['asset_bundle']), 'files': {n: sha(v) for n, v in generated.items()}})
        require(read_file(self.control / 'materials.json', 0o600) == expected, 'PROFILE_PREPARATION_CHANGED')
        root_dir(self.root, 0o755)
        require({p.name for p in self.root.iterdir()} == set(generated), 'PROFILE_MATERIAL_MEMBERS')
        for name, raw in generated.items():
            require(read_file(self.root / name, 0o444, len(raw)) == raw, 'PROFILE_MATERIAL_CHANGED')
        store.Store(self.store_parent, owner=os.geteuid()).check(self.bundle_path)
        return generated

    @contextmanager
    def shared(self):
        with store.Store(self.store_parent, owner=os.geteuid()).locked(shared=True):
            yield


def covered_assets(before, after, inputs):
    """Discharge only the exact 88 missing bodies and the reviewed four pairs."""
    profile.build_profiles(**inputs)
    with tarfile.open(fileobj=io.BytesIO(inputs['asset_bundle']), mode='r:') as tar:
        plan = bundle.json_value(tar.extractfile('BUNDLE-PLAN.json').read())
    retained = {e['source_path']: e['sha256'] for e in plan['entries']}
    require(set(upgrade.coverage(before, after)['changed']) == set(profile.MUTABLE)
            and set(upgrade.coverage(after, before)['changed']) == set(profile.MUTABLE), 'PROFILE_MUTABLE_SCOPE_CHANGED')
    for name, policy in profile.MUTABLE.items():
        require((before.get(name), after.get(name)) == (policy['04'][0], policy['05'][0]), 'PROFILE_MUTABLE_BYTES_CHANGED')
    require(not upgrade.coverage(before, after)['missing']
            and set(upgrade.coverage(after, before)['missing']) == set(retained)
            and all(after.get(n) == h for n, h in retained.items()), 'PROFILE_STATIC_SCOPE_CHANGED')
    evidence = {'kind': 'exact-mock-04-05-overlay', 'retained_count': len(retained),
                'bundle_sha256': sha(inputs['asset_bundle']), 'mutable_policy': sha(profile.build_profiles(**inputs)['policy.json'])}
    return tuple(dict(upgrade.coverage(a, b), compatible=True, resolution=evidence)
                 for a, b in ((before, after), (after, before)))


class ReviewedUpgrade(upgrade.Upgrade):
    def installer_identity(self, old, new):
        dependency_identity()
        path = 'platform/deploy/mock-sandbox/install.py'
        require(old.get(path) == new.get(path) == LEGACY_INSTALLER_SHA, 'PROFILE_LEGACY_INSTALLER_CHANGED')


class ProfileRuntime(upgrade.Runtime):
    def __init__(self, materials):
        self.materials = materials

    def route_identity(self, state):
        return self.materials.verify()['config_sha256']


class ProfileUpgrade(ReviewedUpgrade):
    def __init__(self, materials, runtime=None, lock_root=Path('/run/lock')):
        self.materials = materials
        super().__init__(materials.base, runtime or UpgradeRuntime(materials), lock_root)
        self.work = self.private / 'upgrade-profile-04-to-05-v1'
        self.journal = self.work / 'journal.json'

    def asset_coverage(self, before, after):
        self.materials.verify(require_overlay=True)
        activation = Activation(self.materials, self.runtime, self.lock_root)
        activation.committed()
        return covered_assets(before, after, self.materials.inputs())

    def save(self, journal, phase):
        identity = dependency_identity()
        require(journal.get('profile_adapter', identity) == identity, 'PROFILE_UPGRADE_IDENTITY_CHANGED')
        journal['profile_adapter'] = identity
        super().save(journal, phase)

    def load_journal(self):
        result = super().load_journal()
        require(result.get('profile_adapter') == dependency_identity(), 'PROFILE_UPGRADE_IDENTITY_CHANGED')
        return result

    @contextmanager
    def locked(self, network=False):
        with super().locked(network):
            if network:
                yield
            else:
                with self.materials.shared():
                    yield


def config_inventory(main=Path('/etc/nginx/nginx.conf'), tls=profile.TLS_CONF):
    """Read include closure; reject unknown write destinations, never run Nginx.

    Nginx remains the grammar authority inside the isolated namespace. This
    conservative scanner only inventories includes and potential write paths.
    """
    files, writes, seen = {}, set(), set()
    file_directives = {'access_log', 'error_log', 'pid', 'lock_file'}
    directory_directives = {'client_body_temp_path', 'proxy_temp_path', 'fastcgi_temp_path',
                            'uwsgi_temp_path', 'scgi_temp_path', 'proxy_cache_path', 'fastcgi_cache_path'}

    def scan(path):
        path = Path(path)
        require(path.is_absolute() and '..' not in path.parts, 'NGINX_UNSAFE_INCLUDE')
        require(str(path) not in seen and len(seen) < 256, 'NGINX_INCLUDE_CYCLE_OR_DUPLICATE')
        seen.add(str(path))
        actual = path.resolve(strict=True)
        for component in (actual, *actual.parents):
            s = component.lstat()
            require(s.st_uid in (0, os.geteuid()) and not s.st_mode & 0o022, 'NGINX_CONFIG_OWNER')
        s = actual.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= 8 * 1024 * 1024, 'NGINX_UNSAFE_CONFIG')
        raw = actual.read_bytes()
        files[str(path)] = {'target': str(actual), 'sha256': sha(raw), 'mode': stat.S_IMODE(s.st_mode), 'uid': s.st_uid}
        lex = shlex.shlex(raw.decode(), posix=True, punctuation_chars='{};')
        lex.whitespace_split = True
        directive = []
        for word in lex:
            if set(word) <= set('{};'):
                if directive and directive[0] == 'include':
                    require(len(directive) == 2 and '$' not in directive[1], 'NGINX_UNSUPPORTED_INCLUDE')
                    pattern = Path(directive[1])
                    if not pattern.is_absolute():
                        pattern = main.parent / pattern
                    for child in sorted(glob.glob(str(pattern))):
                        scan(child)
                if directive and directive[0] in file_directives | directory_directives:
                    require(len(directive) >= 2, 'NGINX_UNSUPPORTED_WRITE_PATH')
                    dest = directive[1]
                    if dest not in ('off', 'stderr', '/dev/stderr', '/dev/null'):
                        require(dest.startswith('/') and '$' not in dest, 'NGINX_UNSUPPORTED_WRITE_PATH')
                        target = Path(dest) if directive[0] in directory_directives else Path(dest).parent
                        require(any(target == p or target.is_relative_to(p) for p in
                                    (Path('/var/lib/nginx'), Path('/var/log/nginx'), Path('/run'))),
                                'NGINX_WRITE_PATH_REQUIRES_REVIEW')
                        writes.add(str(target))
                directive = []
            else:
                directive.append(word)
        require(not directive, 'NGINX_UNTERMINATED_CONFIG')
    scan(main)
    require(str(tls) in files and files[str(tls)]['target'] == str(tls), 'NGINX_MOCK_INCLUDE_IDENTITY')
    return {'files': files, 'write_directories': sorted(writes)}


def same_enclosure(before, after, tls):
    def without(config):
        return {name: value for name, value in config['files'].items() if name != str(tls)}
    require(without(before) == without(after)
            and before['write_directories'] == after['write_directories'], 'NGINX_ENCLOSURE_CHANGED')


def namespace_write_directories(enclosure, compiled):
    require('configure arguments:' in compiled, 'NGINX_BUILD_PATHS_UNKNOWN')
    flags = dict(item[2:].split('=', 1) for item in shlex.split(compiled.split('configure arguments:', 1)[1])
                 if item.startswith('--') and '=' in item)
    defaults = {'http-client-body-temp-path': 'client_body_temp', 'http-proxy-temp-path': 'proxy_temp',
                'http-fastcgi-temp-path': 'fastcgi_temp', 'http-uwsgi-temp-path': 'uwsgi_temp',
                'http-scgi-temp-path': 'scgi_temp', 'error-log-path': 'logs/error.log',
                'http-log-path': 'logs/access.log', 'pid-path': 'logs/nginx.pid', 'lock-path': 'logs/nginx.lock'}
    prefix = Path(flags.get('prefix', '/usr/local/nginx'))
    directories = set(enclosure['write_directories'])
    for flag, default in defaults.items():
        path = Path(flags.get(flag, default))
        if not path.is_absolute():
            path = prefix / path
        if str(path) in ('/dev/stderr', '/dev/null'):
            continue
        target = path if flag.endswith('temp-path') else path.parent
        require('..' not in target.parts and any(target == p or target.is_relative_to(p) for p in
                    (Path('/var/lib/nginx'), Path('/var/log/nginx'), Path('/run'))), 'NGINX_COMPILED_WRITE_PATH_REQUIRES_REVIEW')
        directories.add(str(target))
    minimal = [Path(d) for d in sorted(directories, key=lambda v: (len(Path(v).parts), v))]
    return [d for d in minimal if not any(p != d and d.is_relative_to(p) for p in minimal)]


def namespace_syntax_child(work):
    """Called ONLY by unshare. Recursive readonly is mandatory before nginx.

    No host mount or path may change: mount namespace must differ, propagation
    becomes private, then mount_setattr makes every existing mount readonly.
    Only this nonce work mount and explicitly shadowed Nginx write directories
    regain write access. Unknown/unsupported capability => refuse before -t.
    """
    import platform
    work = Path(work)
    expected_parent = profile.PROFILE_ROOT.parent / CONTROL_NAME
    require(work.parent == expected_parent and re.fullmatch(r'syntax-[a-f0-9]{32}', work.name), 'NGINX_NAMESPACE_SCOPE')
    root_dir(work)
    job = json.loads(read_file(work / 'job.json', 0o600))
    require(os.readlink('/proc/self/ns/mnt') != job['parent_namespace'], 'NGINX_NAMESPACE_REQUIRED')
    require(job['identity'] == dependency_identity(), 'NGINX_NAMESPACE_IDENTITY')
    require(sha(read_file(work / 'candidate.conf', 0o600)) == job['candidate_sha256'], 'NGINX_CANDIDATE_CHANGED')
    actual = config_inventory()
    require(actual == job['enclosure'], 'NGINX_ENCLOSURE_CHANGED')

    def command(args):
        p = subprocess.run(args, capture_output=True, timeout=30)
        require(p.returncode == 0, 'NGINX_NAMESPACE_COMMAND_FAILED')
        return p

    command(['/usr/bin/mount', '--make-rprivate', '/'])
    command(['/usr/bin/mount', '--bind', str(work), str(work)])
    require(platform.machine() in ('x86_64', 'aarch64'), 'NGINX_NAMESPACE_ARCH_UNSUPPORTED')
    class MountAttr(ctypes.Structure):
        _fields_ = [('attr_set', ctypes.c_uint64), ('attr_clr', ctypes.c_uint64),
                    ('propagation', ctypes.c_uint64), ('userns_fd', ctypes.c_uint64)]
    libc = ctypes.CDLL(None, use_errno=True)
    def readonly(path, recursive, enabled):
        attr = MountAttr(1 if enabled else 0, 0 if enabled else 1, 0, 0)
        require(libc.syscall(ctypes.c_long(442), ctypes.c_long(-100), ctypes.c_char_p(os.fsencode(path)),
                            ctypes.c_uint(0x8000 if recursive else 0),
                            ctypes.byref(attr), ctypes.sizeof(attr)) == 0, 'NGINX_RECURSIVE_READONLY_UNAVAILABLE')
    readonly('/', True, True)
    # Inspect every mount, not just /. Child cannot proceed after a partial ro.
    lines = Path('/proc/self/mountinfo').read_text().splitlines()
    require(all('ro' in line.split()[5].split(',') for line in lines), 'NGINX_ROOT_NOT_READONLY')
    readonly(str(work), False, False)
    version = command(['/usr/sbin/nginx', '-V'])
    # Bind only minimal ancestors; forbid hiding any source config or capsule.
    minimal = namespace_write_directories(actual, version.stderr.decode())
    for number, destination in enumerate(minimal):
        require(destination.is_dir() and destination.resolve() == destination, 'NGINX_WRITE_DIRECTORY_MISSING')
        require(not work.is_relative_to(destination) and all(not Path(p).is_relative_to(destination)
                for p in actual['files']), 'NGINX_NAMESPACE_HIDES_INPUT')
        shadow = work / ('write-' + str(number))
        shadow.mkdir(mode=0o700)
        command(['/usr/bin/mount', '--bind', str(shadow), str(destination)])
    command(['/usr/bin/mount', '--bind', str(work / 'candidate.conf'), str(profile.TLS_CONF)])
    # Full real enclosing config, modules and other vhosts; no shadow prefix.
    command(['/usr/sbin/nginx', '-t', '-e', '/dev/stderr', '-c', '/etc/nginx/nginx.conf'])
    print(json.dumps({'full_enclosure_tested': True, 'recursive_readonly': True,
                      'namespace': os.readlink('/proc/self/ns/mnt'), 'shadowed_directories': [str(p) for p in minimal]}))


class ActivationRuntime(ProfileRuntime):
    def enclosure(self):
        return config_inventory(tls=self.materials.config)

    def nginx_identity(self):
        pid = self.run(['systemctl', 'show', 'nginx', '--property=MainPID', '--value']).decode().strip()
        require(pid.isdigit() and int(pid) > 1
                and self.run(['systemctl', 'is-active', 'nginx']).decode().strip() == 'active', 'NGINX_NOT_ACTIVE')
        require(Path('/proc/' + pid + '/exe').resolve() == Path('/usr/sbin/nginx'), 'NGINX_MASTER_CHANGED')
        command = Path('/proc/' + pid + '/cmdline').read_bytes().rstrip(b'\0').decode()
        require(command in ('nginx: master process /usr/sbin/nginx',
                            'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;'),
                'NGINX_MASTER_CONFIGURATION_REQUIRES_REVIEW')
        return {'main_pid': int(pid), 'executable': '/usr/sbin/nginx', 'command_sha256': sha(command.encode())}

    def syntax(self, raw, enclosure):
        work = self.materials.control / ('syntax-' + uuid.uuid4().hex)
        make_dir(work, 0o700)
        exclusive_material(work / 'candidate.conf', raw, 0o600)
        job = {'identity': dependency_identity(), 'candidate_sha256': sha(raw), 'enclosure': enclosure,
               'parent_namespace': os.readlink('/proc/self/ns/mnt')}
        exclusive_material(work / 'job.json', bundle.encoded(job), 0o600)
        # No -t/-T ever runs in the production mount namespace. Keep this small
        # evidence on failure; no broad tmp cleanup and no package installation.
        result = self.run(['/usr/bin/unshare', '--mount', '--fork', '--propagation', 'private',
            '/usr/bin/python3', '-B', str(Path(__file__).resolve()), '_namespace-check', '--work', str(work)])
        report = json.loads(result)
        require(report.get('full_enclosure_tested') and report.get('recursive_readonly')
                and report.get('namespace') != job['parent_namespace'], 'NGINX_NAMESPACE_PROOF_MISSING')
        require(self.enclosure() == enclosure, 'NGINX_ENCLOSURE_CHANGED')
        exclusive_material(work / 'result.json', bundle.encoded(report), 0o600)
        return sha(bundle.encoded(report))

    def reload(self):
        self.nginx_identity()
        # The usual ExecReload may run a second nginx parser in the host mount
        # namespace. Signal only the verified unit's master after isolated -t.
        self.run(['systemctl', 'kill', '--kill-who=main', '--signal=HUP', 'nginx'])

    def wait_profile(self, kind, inputs, release):
        """Observe async HUP before the full one-pass acceptance; read-only GETs.

        Signal delivery is not acknowledgement. Transient old-worker reads are
        recorded as observations, never recast as successful verification.
        """
        expected = inputs['new_files' if kind == 'overlay' or release.name == upgrade.NEW_NAME
                          else 'old_files'][profile.JSON_PATH]
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                            urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        observations, deadline = [], time.monotonic() + 8
        for _attempt in range(30):
            left = deadline - time.monotonic()
            if left <= 0:
                break
            try:
                request = urllib.request.Request('https://' + installer.HOST + '/downloads/android-smoke-build.json',
                                                headers={'Accept-Encoding': 'identity'})
                with opener.open(request, timeout=min(1, left)) as response:
                    if response.status == 200 and response.read(len(expected) + 1) == expected:
                        return {'observed': kind, 'previous_observations': observations}
                    observations.append('previous_or_unexpected_representation')
            except (OSError, urllib.error.URLError):
                observations.append('transport_or_http_error')
            time.sleep(min(.1, max(0, deadline - time.monotonic())))
        raise RuntimeError('PROFILE_RELOAD_NOT_OBSERVED')

    def probe(self, kind, inputs, release):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                            urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        values = inputs['old_files' if release.name == upgrade.OLD_NAME else 'new_files']
        cases = []
        if kind == 'overlay':
            with tarfile.open(fileobj=io.BytesIO(inputs['asset_bundle']), mode='r:') as archive:
                plan = bundle.json_value(archive.extractfile('BUNDLE-PLAN.json').read())
                cases += [(e['url_path'], archive.extractfile(e['bundle_member']).read(),
                           e['headers']['Content-Type'], 'public,max-age=31536000,immutable') for e in plan['entries']]
        for name, policy in profile.MUTABLE.items():
            raw = inputs['new_files'][name] if kind == 'overlay' and name == profile.JSON_PATH else values[name]
            cases.append((name.removeprefix('platform/dist'), raw, policy['mime'], 'no-store' if kind == 'overlay' else None))
        deadline = time.monotonic() + 60
        for path, raw, mime, cache in cases:
            for method in ('GET', 'HEAD'):
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'PROFILE_HTTP_DEADLINE')
                request = urllib.request.Request('https://' + installer.HOST + path, method=method,
                                                headers={'Accept-Encoding': 'identity'})
                with opener.open(request, timeout=min(5, remaining)) as response:
                    body = response.read(len(raw) + 1)
                    require(response.status == 200 and body == (raw if method == 'GET' else b'')
                            and int(response.headers.get('Content-Length', '-1')) == len(raw)
                            and response.headers.get_content_type() == mime
                            and not response.headers.get('Content-Encoding'), 'PROFILE_HTTP_BODY_OR_HEADERS')
                    if cache:
                        require(response.headers.get('Cache-Control') == cache and response.headers.get('ETag'), 'PROFILE_HTTP_CACHE')
        return {'profile': kind, 'paths': len(cases), 'methods': ['GET', 'HEAD'], 'strict_tls': True,
                'release': release.name, 'gameplay_acceptance': False}


class UpgradeRuntime(ActivationRuntime):
    def health(self):
        super().health()
        state = installer.load()
        release = Path(state['release'])
        require(release.name in (upgrade.OLD_NAME, upgrade.NEW_NAME), 'MOCK_PIN_INVALID')
        self.materials.verify(require_overlay=True)
        self.probe('overlay', self.materials.inputs(), release)


class Activation:
    def __init__(self, materials=None, runtime=None, lock_root=Path('/run/lock')):
        self.materials = materials or Materials()
        self.runtime = runtime or ActivationRuntime(self.materials)
        self.lock_root = Path(lock_root)
        self.task = ReviewedUpgrade(self.materials.base, self.runtime, self.lock_root)
        self.journal = self.materials.control / 'activation.json'

    def save(self, journal, phase):
        require(phase in PHASES, 'PROFILE_PHASE_UNKNOWN')
        journal['phase'] = phase
        upgrade.write_json(self.journal, journal)

    def load(self):
        root_dir(self.materials.control)
        journal = json.loads(read_file(self.journal, 0o600))
        require(journal.get('kind') == 'mock-overlay-04-05-v1' and journal.get('phase') in PHASES
                and journal.get('identity') == dependency_identity(), 'PROFILE_ACTIVATION_IDENTITY')
        require(re.fullmatch('[a-f0-9]{64}', journal.get('syntax_proof', '')), 'PROFILE_SYNTAX_PROOF_MISSING')
        if journal['phase'] == 'complete':
            require(journal.get('http_observation', {}).get('profile') == 'overlay', 'PROFILE_HTTP_PROOF_MISSING')
        return journal

    def committed(self):
        journal = self.load()
        require(journal['phase'] == 'complete', 'PROFILE_ACTIVATION_NOT_COMMITTED')
        self.materials.verify_materials(self.materials.inputs())
        require(self.materials.verify(require_overlay=True)['config_sha256'] == journal['overlay_sha256'], 'PROFILE_CONFIG_CHANGED')
        return journal

    def inspect(self, inputs):
        dependency_identity()
        state, pin = self.task.state()
        releases = self.task.release_checks()
        require(state['release'] == str(self.task.old) and pin == self.task.old
                and state['manifest_sha256'] == releases['old_manifest'], 'PROFILE_ACTIVATION_REQUIRES_04')
        # Verify every conservative unmanifested static dependency before using
        # only the precise bundle/mutable-policy substitutions.
        covered_assets(upgrade.static_assets(self.task.old), upgrade.static_assets(self.task.new), inputs)
        resources = self.runtime.guard(state)
        resources = json.loads(json.dumps(resources))
        resources.get('configuration_sha256', {}).pop('nginx', None)
        require(all(self.runtime.services()[name] == 'active' for name in upgrade.APP_UNITS), 'RUNNING_MOCK_REQUIRED')
        self.runtime.preflight(self.task.old)
        require(upgrade.available(self.task.base) >= upgrade.RESERVE + 32 * 1024 ** 2, 'PROFILE_SPACE_INSUFFICIENT')
        return {'state': state, 'pin': str(pin), 'releases': releases, 'resources': resources,
                'private': self.task.private_hashes(), 'live': self.task.live_boundary(),
                'nginx': self.runtime.nginx_identity()}

    def check(self, source=None):
        with self.task.locked():
            inputs = self.materials.inputs(source)
            generated = profile.build_profiles(**inputs)
            found = profile.classify_config_bytes(read_file(self.materials.config, 0o644), **inputs)
            self.inspect(inputs)
            result = {'status': 'checked', 'profile': found['profile'], 'pair': [upgrade.OLD_NAME, upgrade.NEW_NAME],
                      'activation_performed': False, 'nginx_syntax_tested': False, 'apply_allowed': False}
            if source is None:
                self.materials.verify_materials(inputs)
                self.materials.verify(inputs)
                result['materials_verified'] = True
            # Read-only cannot claim that a future full enclosing syntax test or
            # reload/HTTP confirmation has already succeeded.
            result['candidate_sha256'] = sha(generated['overlay.conf'])
            return result

    def prepare(self, source):
        with self.task.locked():
            inputs = self.materials.inputs(source)
            self.inspect(inputs)
            require(profile.classify_config_bytes(read_file(self.materials.config, 0o644), **inputs)['profile'] == 'original',
                    'PROFILE_PREPARE_REQUIRES_ORIGINAL')
            return self.materials.prepare(source)

    def fixed(self, journal, inputs):
        require(self.inspect(inputs) == journal['boundary'], 'PROFILE_BOUNDARY_CHANGED')
        self.materials.verify_materials(inputs)
        same_enclosure(journal['enclosure'], self.runtime.enclosure(), self.materials.config)
        raw = read_file(self.materials.config, 0o644)
        require(sha(raw) in (journal['original_sha256'], journal['overlay_sha256']), 'PROFILE_CONFIG_CHANGED')

    def replace_config(self, raw):
        path = self.materials.config
        read_file(path, 0o644)
        # No symlink or unowned ancestor may turn this one-file write elsewhere.
        bundle.safe_local_path(path)
        for parent in path.parents:
            s = parent.lstat()
            require(s.st_uid in (0, os.geteuid()) and not s.st_mode & 0o022, 'PROFILE_CONFIG_PARENT')
        temporary = path.with_name('.oasis-mock-profile-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(raw)
            out.flush()
            os.fchmod(out.fileno(), 0o644)
            os.fsync(out.fileno())
        os.replace(temporary, path)
        upgrade.sync_dir(path.parent)

    def activate(self):
        with self.task.locked(), self.materials.shared():
            require(not self.journal.exists() and not self.journal.is_symlink(), 'PROFILE_ACTIVATION_REQUIRES_RECOVER')
            inputs = self.materials.inputs()
            generated = self.materials.verify_materials(inputs)
            require(read_file(self.materials.config, 0o644) == generated['original.conf'], 'PROFILE_ORIGINAL_REQUIRED')
            boundary = self.inspect(inputs)
            enclosure = self.runtime.enclosure()
            # Full real configuration in readonly mount namespace. No journal or
            # effective write on unavailable isolation or syntax failure.
            proof = self.runtime.syntax(generated['overlay.conf'], enclosure)
            require(self.inspect(inputs) == boundary and self.runtime.enclosure() == enclosure, 'PROFILE_PREFLIGHT_DRIFT')
            exclusive_material(self.materials.control / 'original.conf', generated['original.conf'], 0o600)
            journal = {'kind': 'mock-overlay-04-05-v1', 'identity': dependency_identity(), 'boundary': boundary,
                       'enclosure': enclosure, 'syntax_proof': proof,
                       'original_sha256': sha(generated['original.conf']), 'overlay_sha256': sha(generated['overlay.conf'])}
            self.save(journal, 'prepared')
            try:
                self.fixed(journal, inputs)
                self.save(journal, 'switching')
                self.replace_config(generated['overlay.conf'])
                self.save(journal, 'configured')
                return self.finish(journal, inputs, 'overlay')
            except Exception:
                try:
                    self.rollback(journal, inputs)
                except Exception:
                    raise RuntimeError('PROFILE_ACTIVATION_RECOVERY_REQUIRED') from None
                raise RuntimeError('PROFILE_ACTIVATION_FAILED_RESTORED') from None

    def finish(self, journal, inputs, kind):
        self.fixed(journal, inputs)
        require(profile.classify_config_bytes(read_file(self.materials.config, 0o644), **inputs)['profile'] == kind,
                'PROFILE_CONFIG_CHANGED')
        self.save(journal, 'reloading' if kind == 'overlay' else 'restored')
        self.runtime.reload()
        journal['reload_observation'] = self.runtime.wait_profile(kind, inputs, self.task.old)
        self.save(journal, 'reloading' if kind == 'overlay' else 'restored')
        self.runtime.health()
        report = self.runtime.probe(kind, inputs, self.task.old)
        self.fixed(journal, inputs)
        journal['http_observation'] = report
        self.save(journal, 'verified' if kind == 'overlay' else 'restored')
        self.save(journal, 'complete' if kind == 'overlay' else 'rolled_back')
        return {'status': 'activated' if kind == 'overlay' else 'restored_original', 'profile': kind,
                'http_observation': report, 'api_stopped': False, 'upgrade_performed': False}

    def rollback(self, journal, inputs):
        self.fixed(journal, inputs)
        original = read_file(self.materials.control / 'original.conf', 0o600)
        require(sha(original) == journal['original_sha256'], 'PROFILE_BACKUP_CHANGED')
        self.runtime.syntax(original, self.runtime.enclosure())
        self.save(journal, 'restoring')
        self.replace_config(original)
        return self.finish(journal, inputs, 'original')

    def recover(self):
        with self.task.locked(), self.materials.shared():
            journal = self.load()
            inputs = self.materials.inputs()
            self.materials.verify_materials(inputs)
            if journal['phase'] == 'complete':
                self.committed()
                state, pin = self.task.state()
                require(pin in (self.task.old, self.task.new) and state['release'] == str(pin), 'MOCK_PIN_INVALID')
                self.runtime.guard(state)
                report = self.runtime.probe('overlay', inputs, pin)
                return {'status': 'already_activated', 'profile': 'overlay', 'http_observation': report}
            self.fixed(journal, inputs)
            if journal['phase'] == 'rolled_back':
                require(sha(read_file(self.materials.config, 0o644)) == journal['original_sha256'], 'PROFILE_CONFIG_CHANGED')
                self.runtime.probe('original', inputs, self.task.old)
                return {'status': 'already_restored', 'profile': 'original'}
            # Recovery never guesses which reload completed: converge to exact
            # disk profile via a fresh syntax check/reload/HTTP readback.
            if journal['phase'] in ('restoring', 'restored'):
                return self.rollback(journal, inputs)
            raw = read_file(self.materials.config, 0o644)
            if sha(raw) == journal['overlay_sha256']:
                self.runtime.syntax(raw, self.runtime.enclosure())
                try:
                    return self.finish(journal, inputs, 'overlay')
                except Exception:
                    return self.rollback(journal, inputs)
            return self.rollback(journal, inputs)

    def start(self):
        """Start existing applications only; infrastructure/certificates must exist.

        Unlike historical install.start this does not provision or run Nginx.
        Unknown profiles and drift fail before any service mutation.
        """
        with self.task.locked():
            inputs = self.materials.inputs()
            self.task.release_checks()
            state, pin = self.task.state()
            require(pin in (self.task.old, self.task.new) and state['release'] == str(pin)
                    and state['manifest_sha256'] == upgrade.digest(pin / 'RELEASE-MANIFEST.json'), 'MOCK_PIN_INVALID')
            found = self.materials.verify(inputs)
            if found['profile'] == 'overlay':
                self.committed()
            else:
                require(pin == self.task.old, 'PROFILE_05_REQUIRES_OVERLAY')
            self.runtime.guard(state)
            self.runtime.preflight(pin)
            before = self.runtime.services()
            if not all(before[name] == 'active' for name in upgrade.APP_UNITS):
                self.runtime.start()
            # Do not stop an already running service on a failed readback.
            self.runtime.health()
            self.runtime.probe(found['profile'], inputs, pin)
            return {'status': 'started', 'profile': found['profile'], 'release': pin.name,
                    'nginx_reloaded': False, 'requires_gameplay_acceptance': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', default='check', choices=('check', 'prepare', 'activate', 'recover',
        'start', 'upgrade-check', 'upgrade', 'upgrade-recover', '_namespace-check'))
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--work', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    dependency_identity()
    if args.mode == '_namespace-check':
        require(args.work is not None and args.bundle is None, 'NGINX_NAMESPACE_SCOPE')
        namespace_syntax_child(args.work)
        return
    require(args.work is None and (args.bundle is None or args.mode in ('check', 'prepare')), 'PROFILE_ARGUMENT_SCOPE')
    task = Activation()
    if args.mode == 'prepare':
        require(args.bundle is not None, 'PROFILE_BUNDLE_REQUIRED')
        result = task.prepare(args.bundle)
    elif args.mode == 'check':
        result = task.check(args.bundle)
    elif args.mode.startswith('upgrade'):
        adapter = ProfileUpgrade(task.materials)
        if args.mode == 'upgrade-check':
            with adapter.locked():
                result = adapter.check()[0]
        else:
            result = adapter.apply() if args.mode == 'upgrade' else adapter.recover()
    else:
        result = getattr(task, args.mode)()
    # Never print keys, configuration text, private digests, raw command errors
    # or business rows; private journal retains the boundary evidence.
    result = {k: v for k, v in result.items() if k not in ('private_hashes', 'business', 'resources', 'live_boundary')}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, (RuntimeError, ValueError)) and re.fullmatch('[A-Z0-9_]+', str(error)) else 'MOCK_PROFILE_FAILED'
        raise SystemExit(code) from None

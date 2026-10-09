import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name('production-ingress-cert.py')
spec = importlib.util.spec_from_file_location('production_ingress_cert', MODULE)
cert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cert)

# Public, self-signed fixture only. No private key is shipped or required.
PUBLIC_CERT = b'''-----BEGIN CERTIFICATE-----
MIIDbzCCAlegAwIBAgIUFGs62OORygHz0kXRfaLes9dC5yUwDQYJKoZIhvcNAQEL
BQAwLjEsMCoGA1UEAwwjb2FzaXMtcGxheWVyLjQzLjk4LjIwMi4yMzYuc3NsaXAu
aW8wHhcNMjYxMDA5MTgxNDU4WhcNMzYxMDA2MTgxNDU4WjAuMSwwKgYDVQQDDCNv
YXNpcy1wbGF5ZXIuNDMuOTguMjAyLjIzNi5zc2xpcC5pbzCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAOSTmbZWjuOyuIeGtpjNnISRYOiMHs+3GKLEM15H
nTFMWA3n4xVRU6b09yh0aOBZp8XUapqiZ1af7m7FqugnrcDTYRBotlH6zioA8Pim
hEbzy2ggoX7C2SVdFrQjVuF6bz9FoDtZILJMkjzCrBBYZ9inineywbwG2zFsOhwM
utuiQbEleiMFQdSLGb0AlWoD0ayYQfGLTvE9m5ZNq+QqUZuzii7XV71paoR+NXSU
1yTEmeKyfnU1fLSiuspo//d+4mu3RERz90bi5P8X39e2TE2JztuRqvdCtneqczoq
t9UISIMs/Jv6cRcyXd2qGor4eUz/pGP55Asi+FLbgwF94GcCAwEAAaOBhDCBgTAd
BgNVHQ4EFgQUP4B2XIvwXt9LZ8sAC7s6yGHT10kwHwYDVR0jBBgwFoAUP4B2XIvw
Xt9LZ8sAC7s6yGHT10kwDwYDVR0TAQH/BAUwAwEB/zAuBgNVHREEJzAlgiNvYXNp
cy1wbGF5ZXIuNDMuOTguMjAyLjIzNi5zc2xpcC5pbzANBgkqhkiG9w0BAQsFAAOC
AQEAgbGcg6zPEjc3Iw+N0w5/Qmqa4Lg8dQtq5t3jLOa7XFW4Bq47hK3rBIpfC86w
/t5BOALsH5huFqIILGK6o3sd7UNXyFrhAfO3keJxih/pNkujFt4JHBO8c93K83j6
GjdB01uRHcZwwejOY/kX8clgb5AdCGkx9Ig9rbMGfSSOu4hIDjyaq8S9/0PBDnwZ
aCom4uwhCLs/ekZFaVRTlsBHfpugFonAh5v1BSYvBelazZ6+5M7sNjCTU6m0BUuQ
wnGMDxspbx7gVBD/A6BnCs9lVfG/foOcFzF7NfUH8WLUHq+jYS8uDwhftcO47Djz
qw7H28T+UywLiGploYbTW1HRvA==
-----END CERTIFICATE-----
'''


class CertbotScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.patchers = []
        locations = {
            'ROOT_UID': os.getuid(), 'ANCESTOR_STOP': self.root,
            'BASE': self.root / 'oasis', 'CONFIG': self.root / 'oasis/acme/config',
            'WORK': self.root / 'oasis/acme/work', 'LOGS': self.root / 'oasis/acme/logs',
            'PRIVATE': self.root / 'oasis/production-ingress-private',
            'WEBROOT': self.root / 'oasis/production-player-acme-webroot',
            'CERTBOT': self.root / 'oasis/certbot/bin/certbot',
        }
        locations['CLI'] = locations['PRIVATE'] / 'certbot-cli.ini'
        locations['RENEWAL'] = locations['CONFIG'] / 'renewal' / (cert.NAME + '.conf')
        locations['ARCHIVE'] = locations['CONFIG'] / 'archive' / cert.NAME
        locations['LIVE'] = locations['CONFIG'] / 'live' / cert.NAME
        for key, value in locations.items():
            p = patch.object(cert, key, value); p.start(); self.patchers.append(p)
        for directory in (cert.CONFIG, cert.WORK, cert.LOGS, cert.PRIVATE, cert.WEBROOT,
                          cert.RENEWAL.parent, cert.ARCHIVE.parent, cert.LIVE.parent, cert.CERTBOT.parent):
            directory.mkdir(parents=True, exist_ok=True)
        os.chmod(cert.PRIVATE, 0o700)
        cert.CERTBOT.write_bytes(b'#!/bin/false\n'); os.chmod(cert.CERTBOT, 0o755)
        self.ambient = (self.root / 'etc/letsencrypt/cli.ini',
                        self.root / 'root/.config/letsencrypt/cli.ini', cert.CONFIG / 'cli.ini')
        p = patch.object(cert, 'default_cli_paths', return_value=self.ambient)
        p.start(); self.patchers.append(p)
        cert.prepare_cli_config()

    def tearDown(self):
        for p in reversed(self.patchers):
            p.stop()
        self.temporary.cleanup()

    def renewal(self):
        # Actual Certbot 5.8 ConfigObj syntax: trailing-list comma, nested map,
        # and ARI cache section; account is a synthetic nonsecret identifier.
        return f'''# renewal metadata
version = 5.8.0
archive_dir = {cert.ARCHIVE}
cert = {cert.LIVE}/cert.pem
privkey = {cert.LIVE}/privkey.pem
chain = {cert.LIVE}/chain.pem
fullchain = {cert.LIVE}/fullchain.pem
[renewalparams]
account = {'a' * 32}
config_dir = {cert.CONFIG}
work_dir = {cert.WORK}
logs_dir = {cert.LOGS}
authenticator = webroot
webroot_path = {cert.WEBROOT},
server = {cert.SERVER}
key_type = ecdsa
[[webroot_map]]
{cert.HOST} = {cert.WEBROOT}
[acme_renewal_info]
ari_retry_after = 2026-10-09T21:27:48
'''.encode()

    def install_lineage(self):
        cert.ARCHIVE.mkdir(); cert.LIVE.mkdir()
        for name in ('cert', 'privkey', 'chain', 'fullchain'):
            path = cert.ARCHIVE / (name + '1.pem')
            path.write_bytes(b'NEVER_OPEN_PRIVATE_KEY' if name == 'privkey' else PUBLIC_CERT)
            os.chmod(path, 0o600 if name == 'privkey' else 0o644)
            (cert.LIVE / (name + '.pem')).symlink_to('../../archive/' + cert.NAME + '/' + path.name)
        cert.RENEWAL.write_bytes(self.renewal()); os.chmod(cert.RENEWAL, 0o644)

    def assert_refused(self, operation, code):
        with self.assertRaisesRegex(cert.Refusal, '^' + code + '$'):
            operation()

    def test_real_configobj_metadata_and_public_certificate_positive(self):
        self.install_lineage()
        result = cert.scope_check('renew')
        self.assertEqual(result['renewal']['version'], '5.8.0')
        self.assertEqual(result['certificate']['san'], [cert.HOST])
        self.assertFalse(result['certificate']['private_key_body_read'])
        self.assertNotIn('a' * 32, str(result))

    def test_private_key_is_never_opened_in_renewal(self):
        self.install_lineage()
        original = os.open
        def guarded(path, *args, **kwargs):
            self.assertNotIn('privkey', str(path))
            return original(path, *args, **kwargs)
        with patch.object(cert.os, 'open', side_effect=guarded):
            cert.scope_check('renew')

    def test_certonly_and_renew_have_explicit_scope_flags_and_no_directory_hooks(self):
        for mode in ('certonly', 'renew'):
            if mode == 'renew':
                self.install_lineage()
            argv = cert.scope_check(mode)['argv']
            self.assertEqual(argv[0], str(cert.CERTBOT))
            self.assertEqual(argv[1], mode)
            self.assertIn('--no-directory-hooks', argv)
            self.assertEqual(argv[argv.index('--config') + 1], str(cert.CLI))
            self.assertEqual(argv[argv.index('--cert-name') + 1], cert.NAME)
            for hook in ('--pre-hook', '--post-hook', '--deploy-hook'):
                self.assertEqual(argv[argv.index(hook) + 1], '')
            if mode == 'renew':
                self.assertNotIn('-d', argv)
            else:
                self.assertEqual(argv[argv.index('-d') + 1], cert.HOST)

    def test_shared_directory_hooks_are_disabled_without_touching_them(self):
        hook = cert.CONFIG / 'renewal-hooks/deploy/shared-hook'
        hook.parent.mkdir(parents=True); hook.write_bytes(b'fake hook must never run')
        before = hook.read_bytes()
        argv = cert.scope_check('certonly')['argv']
        self.assertIn('--no-directory-hooks', argv)
        self.assertEqual(hook.read_bytes(), before)

    def test_nonempty_default_cli_is_rejected_even_with_own_empty_explicit_config(self):
        for path in self.ambient:
            with self.subTest(path=path):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'deploy-hook = touch /tmp/shared-hook\n')
                self.assert_refused(lambda: cert.scope_check('certonly'), 'AMBIENT_CERTBOT_CLI_CONFIG')
                path.unlink()

    def test_empty_default_cli_positive(self):
        for path in self.ambient:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'')
        self.assertEqual(len(cert.scope_check('certonly')['default_cli_configs']), 3)

    def test_own_cli_mode_and_contents_exact_under_private_umask(self):
        cert.CLI.unlink()
        previous = os.umask(0o077)
        try:
            proof = cert.prepare_cli_config()
        finally:
            os.umask(previous)
        self.assertEqual(proof['mode'], 0o600)
        self.assertEqual(cert.CLI.read_bytes(), b'')
        cert.CLI.write_bytes(b'# even comments are not our empty config\n')
        self.assert_refused(lambda: cert.scope_check('certonly'), 'NONEMPTY_CERTBOT_CLI_CONFIG')

    def test_own_cli_wrong_mode_refused(self):
        os.chmod(cert.CLI, 0o644)
        self.assert_refused(cert.prepare_cli_config, 'CERTBOT_FILE_MODE')

    def test_own_cli_symlink_and_hardlink_refused(self):
        cert.CLI.unlink(); other = self.root / 'other'; other.write_bytes(b'')
        cert.CLI.symlink_to(other)
        self.assert_refused(cert.prepare_cli_config, 'UNSAFE_CERTBOT_FILE')
        cert.CLI.unlink(); os.link(other, cert.CLI)
        self.assert_refused(cert.prepare_cli_config, 'UNSAFE_CERTBOT_FILE')

    def test_world_writable_parent_refused(self):
        os.chmod(cert.CONFIG.parent, 0o777)
        path = cert.CONFIG / 'cli.ini'; path.write_bytes(b'')
        self.assert_refused(lambda: cert.scope_check('certonly'), 'UNSAFE_CERTBOT_PARENT')

    def test_symlinked_absent_default_parent_refused(self):
        path = self.ambient[0]; path.parent.parent.mkdir(parents=True)
        path.parent.symlink_to(cert.CONFIG, target_is_directory=True)
        self.assert_refused(lambda: cert.scope_check('certonly'), 'UNSAFE_CERTBOT_DIRECTORY')

    def test_foreign_owner_refused(self):
        with patch.object(cert, 'ROOT_UID', os.getuid() + 12345):
            self.assert_refused(lambda: cert.scope_check('certonly'), 'UNSAFE_CERTBOT_PARENT')

    def test_certonly_refuses_existing_lineage_without_adopting(self):
        self.install_lineage()
        before = cert.RENEWAL.read_bytes()
        self.assert_refused(lambda: cert.scope_check('certonly'), 'EXISTING_PRODUCTION_LINEAGE')
        self.assertEqual(cert.RENEWAL.read_bytes(), before)

    def test_hooks_and_installer_nonempty_always_refused(self):
        data = self.renewal()
        for key in cert.HOOKS:
            with self.subTest(key=key):
                edited = data.replace(b'[[webroot_map]]', (key + ' = /bin/true\n[[webroot_map]]').encode())
                self.assert_refused(lambda: cert.validate_renewal(cert.parse_renewal(edited)),
                                    'RENEWAL_EXECUTION_HOOK')

    def test_explicit_empty_hook_metadata_positive(self):
        edited = self.renewal().replace(b'[[webroot_map]]',
                                      b'pre_hook =\npost_hook = ""\ndeploy_hook =\n[[webroot_map]]')
        self.assertTrue(cert.validate_renewal(cert.parse_renewal(edited))['hooks_empty'])

    def test_unknown_execution_parameters_refused(self):
        for key in ('nginx_server_root', 'manual_public_ip_logging_ok', 'config', 'deploy-hook',
                    'renew_before_expiry', 'webroot_map', 'http01_port', 'dry_run'):
            with self.subTest(key=key):
                edited = self.renewal().replace(b'[[webroot_map]]',
                                               (key + ' = unsafe\n[[webroot_map]]').encode())
                self.assert_refused(lambda: cert.validate_renewal(cert.parse_renewal(edited)),
                                    'UNKNOWN_OR_MISSING_RENEWAL_PARAM')

    def test_server_authenticator_and_keytype_scope(self):
        for old, new in ((cert.SERVER, 'https://evil.invalid/acme'), ('authenticator = webroot',
                       'authenticator = nginx'), ('key_type = ecdsa', 'key_type = foreign')):
            edited = self.renewal().replace(old.encode(), new.encode())
            self.assert_refused(lambda: cert.validate_renewal(cert.parse_renewal(edited)),
                                'RENEWAL_PLUGIN_OR_SERVER_SCOPE')

    def test_paths_are_exact_and_canonical(self):
        for key in ('archive_dir', 'cert', 'privkey', 'chain', 'fullchain', 'config_dir',
                    'work_dir', 'logs_dir', 'webroot_path'):
            parsed = cert.parse_renewal(self.renewal())
            area = parsed['top'] if key in parsed['top'] else parsed['renewalparams']
            area[key] = '/opt/oasis/current/../private'
            with self.subTest(key=key), self.assertRaises(cert.Refusal):
                cert.validate_renewal(parsed)

    def test_map_extra_domain_or_wrong_webroot_refused(self):
        for mapping in ({cert.HOST: str(cert.WEBROOT), 'game.tianyahuyu.com': str(cert.WEBROOT)},
                        {cert.HOST: '/opt/oasis/acme-webroot'}, {cert.HOST: [str(cert.WEBROOT)]}):
            parsed = cert.parse_renewal(self.renewal()); parsed['webroot_map'] = mapping
            self.assert_refused(lambda: cert.validate_renewal(parsed), 'RENEWAL_DOMAIN_SCOPE')

    def test_single_path_scalar_or_quoted_list_compatible(self):
        for value in (str(cert.WEBROOT), '"' + str(cert.WEBROOT) + '",'):
            edited = self.renewal().replace((str(cert.WEBROOT) + ',').encode(), value.encode())
            self.assertEqual(cert.validate_renewal(cert.parse_renewal(edited))['domains'], [cert.HOST])

    def test_multiple_path_list_refused(self):
        parsed = cert.parse_renewal(self.renewal())
        parsed['renewalparams']['webroot_path'].append('/opt/oasis/other')
        self.assert_refused(lambda: cert.validate_renewal(parsed), 'RENEWAL_WEBROOT_SCOPE')

    def test_duplicate_keys_sections_and_wrong_nesting_refused(self):
        cases = ((b'version = 5.8.0\n', 'INVALID_OR_DUPLICATE_RENEWAL_KEY'),
                 (b'[renewalparams]\n', 'DUPLICATE_RENEWAL_SECTION'),
                 (b'[[webroot_map]]\n', 'INVALID_RENEWAL_NESTED_SECTION'),
                 (b'[unknown]\n', 'UNKNOWN_RENEWAL_SECTION'))
        for suffix, code in cases:
            if suffix.startswith(b'version'):
                data = self.renewal().replace(b'archive_dir =', suffix + b'archive_dir =')
            else:
                data = self.renewal() + suffix
            self.assert_refused(lambda: cert.parse_renewal(data), code)

    def test_unsupported_quoting_interpolation_and_nul_refused(self):
        for value in ('"quoted"suffix', '"unterminated', r'"slash\path"', 'x,,y', '[unsafe]'):
            with self.subTest(value=value), self.assertRaises(cert.Refusal):
                cert.config_value(value)
        with self.assertRaises(cert.Refusal):
            cert.parse_renewal(self.renewal() + b'\x00')
        parsed = cert.parse_renewal(self.renewal())
        parsed['renewalparams']['webroot_path'] = '%(shared)s'
        self.assert_refused(lambda: cert.validate_renewal(parsed), 'RENEWAL_WEBROOT_SCOPE')

    def test_ari_metadata_strict_and_non_executable(self):
        for ari in ({'ari_retry_after': 'not-a-date'}, {'ari_retry_after': '2026-99-99T21:27:48'},
                    {'deploy_hook': '/bin/true'}):
            parsed = cert.parse_renewal(self.renewal()); parsed['acme_renewal_info'] = ari
            with self.assertRaises(cert.Refusal):
                cert.validate_renewal(parsed)

    def test_unreviewed_certbot_major_minor_rejected(self):
        data = self.renewal().replace(b'5.8.0', b'6.0.0')
        self.assert_refused(lambda: cert.validate_renewal(cert.parse_renewal(data)),
                            'UNREVIEWED_CERTBOT_RENEWAL_VERSION')

    def test_renewal_symlink_or_hardlink_refused(self):
        self.install_lineage(); original = cert.RENEWAL.with_suffix('.old')
        cert.RENEWAL.rename(original); cert.RENEWAL.symlink_to(original)
        self.assert_refused(lambda: cert.scope_check('renew'), 'UNSAFE_CERTBOT_FILE')
        cert.RENEWAL.unlink(); os.link(original, cert.RENEWAL)
        self.assert_refused(lambda: cert.scope_check('renew'), 'UNSAFE_CERTBOT_FILE')

    def test_live_link_escape_version_and_regular_file_refused(self):
        self.install_lineage()
        link = cert.LIVE / 'privkey.pem'
        for target in ('../../archive/oasis-game/privkey1.pem',
                       '../../archive/' + cert.NAME + '/privkey2.pem',
                       '/opt/oasis/private/master.key'):
            link.unlink(); link.symlink_to(target)
            with self.assertRaises((cert.Refusal, FileNotFoundError)):
                cert.certificate_scope()
        link.unlink(); link.write_bytes(b'not a symlink')
        self.assert_refused(cert.certificate_scope, 'UNSAFE_CERTIFICATE_LIVE_LINK')

    def test_existing_mixed_version_is_rejected(self):
        self.install_lineage()
        newer = cert.ARCHIVE / 'privkey2.pem'; newer.write_bytes(b'never read'); os.chmod(newer, 0o600)
        link = cert.LIVE / 'privkey.pem'; link.unlink()
        link.symlink_to('../../archive/' + cert.NAME + '/privkey2.pem')
        self.assert_refused(cert.certificate_scope, 'CERTIFICATE_VERSION_MISMATCH')

    def test_private_key_insecure_mode_rejected_without_reading(self):
        self.install_lineage(); os.chmod(cert.ARCHIVE / 'privkey1.pem', 0o644)
        self.assert_refused(cert.certificate_scope, 'CERTBOT_FILE_MODE')

    def test_actual_san_mismatch_and_extra_san_rejected(self):
        self.install_lineage()
        with patch.object(cert, 'HOST', 'other.invalid'):
            self.assert_refused(cert.certificate_scope, 'CERTIFICATE_SAN_SCOPE')
        original = cert.read_public
        def extra(path, *args, **kwargs):
            data, pin, decoded = original(path, *args, **kwargs)
            if decoded:
                decoded['subjectAltName'] += (('DNS', 'game.tianyahuyu.com'),)
            return data, pin, decoded
        with patch.object(cert, 'read_public', side_effect=extra):
            self.assert_refused(cert.certificate_scope, 'CERTIFICATE_SAN_SCOPE')

    def test_fullchain_wrong_leaf_rejected(self):
        self.install_lineage(); (cert.ARCHIVE / 'fullchain1.pem').write_bytes(b'not matching leaf')
        self.assert_refused(cert.certificate_scope, 'CERTIFICATE_FULLCHAIN_LEAF_MISMATCH')

    def test_same_bytes_public_file_replacement_during_read_refused(self):
        target = cert.CLI
        original = cert.os.read
        def swap(fd, size):
            data = original(fd, size)
            replacement = target.with_suffix('.swap'); replacement.write_bytes(b'')
            os.chmod(replacement, 0o600); replacement.replace(target)
            return data
        with patch.object(cert.os, 'read', side_effect=swap):
            self.assert_refused(lambda: cert.empty_cli(target), 'CERTBOT_FILE_REPLACED')

    def test_invalid_public_cert_refused(self):
        self.install_lineage(); (cert.ARCHIVE / 'cert1.pem').write_bytes(b'not PEM')
        self.assert_refused(cert.certificate_scope, 'INVALID_PUBLIC_CERTIFICATE')

    def test_invalid_mode_never_returns_argv(self):
        self.assert_refused(lambda: cert.scope_check('revoke'), 'INVALID_CERTBOT_SCOPE_MODE')

    def test_shared_work_or_log_symlink_cannot_receive_certbot_writes(self):
        for path in (cert.WORK, cert.LOGS):
            with self.subTest(path=path):
                path.rmdir(); path.symlink_to(cert.PRIVATE, target_is_directory=True)
                self.assert_refused(lambda: cert.scope_check('certonly'), 'UNSAFE_CERTBOT_DIRECTORY')
                path.unlink(); path.mkdir()

    def test_shared_work_or_log_directory_with_foreign_write_permission_refused(self):
        for path in (cert.WORK, cert.LOGS):
            with self.subTest(path=path):
                os.chmod(path, 0o777)
                self.assert_refused(lambda: cert.scope_check('certonly'), 'UNSAFE_CERTBOT_DIRECTORY')
                os.chmod(path, 0o755)

    def test_certificate_changed_after_initial_scope_cannot_authorize_renewal(self):
        self.install_lineage()
        original = cert.certificate_scope
        calls = 0
        def change():
            nonlocal calls
            proof = original()
            calls += 1
            if calls == 2:
                proof['version'] += 1
            return proof
        with patch.object(cert, 'certificate_scope', side_effect=change):
            self.assert_refused(lambda: cert.scope_check('renew'), 'CERTIFICATE_SCOPE_CHANGED')

    def test_short_regular_file_read_cannot_hide_trailing_configuration(self):
        path = cert.CLI
        path.write_bytes(b'foreign tail')
        with patch.object(cert.os, 'read', return_value=b''):
            self.assert_refused(lambda: cert.empty_cli(path), 'CERTBOT_FILE_SIZE')


if __name__ == '__main__':
    unittest.main()

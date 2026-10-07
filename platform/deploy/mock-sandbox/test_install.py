import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

specification = importlib.util.spec_from_file_location('mock_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(specification)
specification.loader.exec_module(installer)


class InstallSafetyTests(unittest.TestCase):
    def test_files_are_created_exclusively_and_never_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'owned'
            installer.exact_file(target, 'expected', 0o600)
            with patch.object(installer.os, 'getuid', return_value=0):
                with self.assertRaisesRegex(RuntimeError, 'REFUSE_EXISTING_DIFFERENT_FILE'):
                    installer.exact_file(target, 'replacement', 0o600)
            self.assertEqual(target.read_text(), 'expected')
            link = Path(temporary) / 'alias'
            link.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'REFUSE_SYMLINK'):
                installer.exact_file(link, 'expected', 0o600)

    def test_network_policy_allows_only_mock_endpoints_for_mock_uid(self):
        policy = installer.network_text(991, '172.30.0.2')
        self.assertIn('meta skuid 991 reject', policy)
        self.assertIn('18981, 18982, 18983, 18985', policy)
        self.assertIn('ip daddr 172.30.0.2 tcp dport 5432 accept', policy)
        self.assertNotIn('18881', policy)
        self.assertNotIn('18883', policy)
        self.assertNotIn('flush ruleset', policy)
        with self.assertRaisesRegex(RuntimeError, 'INVALID_MOCK_DATABASE_ADDRESS'):
            installer.network_text(991, '8.8.8.8')

    def test_database_guard_rejects_live_bindings_and_networks(self):
        state = {'id': 'test-owned', 'postgres_image': 'sha256:pinned'}
        container = {
            'Config': {'Labels': {installer.LABEL: 'test-owned'}},
            'Image': 'sha256:pinned',
            'HostConfig': {'PortBindings': {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18983'}]}, 'Memory': 1024 ** 3, 'NanoCpus': 500000000, 'NetworkMode': installer.NETWORK},
            'Mounts': [{'Destination': '/var/lib/postgresql/data', 'Type': 'volume', 'Name': installer.VOLUME}],
            'NetworkSettings': {'Networks': {installer.NETWORK: {}}}
        }
        resources = {'container': container, 'volume': {'Labels': {installer.LABEL: 'test-owned'}}, 'network': {'Labels': {installer.LABEL: 'test-owned'}, 'Internal': True}}
        with patch.object(installer, 'inspect', side_effect=lambda kind, name: resources[kind]):
            installer.database_guard(state)
            container['HostConfig']['PortBindings']['5432/tcp'][0]['HostIp'] = '0.0.0.0'
            with self.assertRaisesRegex(RuntimeError, 'MOCK_POSTGRES_BINDING_CHANGED'):
                installer.database_guard(state)
            container['HostConfig']['PortBindings']['5432/tcp'][0]['HostIp'] = '127.0.0.1'
            resources['network']['Internal'] = False
            with self.assertRaisesRegex(RuntimeError, 'MOCK_NETWORK_NOT_ISOLATED'):
                installer.database_guard(state)
            resources['network']['Internal'] = True
            container['HostConfig']['PortBindings'] = {}
            installer.database_guard(state)

    def test_command_failures_never_echo_sensitive_output(self):
        result = installer.subprocess.CompletedProcess(['docker'], 1, 'private-password', 'private-key')
        with patch.object(installer.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError) as raised:
                installer.run(['docker', 'create'])
        self.assertNotIn('private-', str(raised.exception))

    def test_release_requires_an_exact_immutable_directory(self):
        for value in ['/opt/oasis/current', '/opt/oasis/android-mock-current', '/tmp/20261007-02', '../releases/20261007-02']:
            with self.assertRaisesRegex(RuntimeError, 'EXACT_IMMUTABLE_RELEASE_REQUIRED'):
                installer.release_check(value)

    def test_firewall_fingerprint_ignores_ephemeral_rule_handles(self):
        def document(handle):
            return json.dumps({'nftables': [{'metainfo': {'version': 'example'}}, {'table': {'family': 'inet', 'name': 'oasis_android_mock', 'handle': handle}}, {'rule': {'family': 'inet', 'table': 'oasis_android_mock', 'chain': 'output', 'expr': [{'reject': None}], 'handle': handle + 1}}]})
        with patch.object(installer, 'output', side_effect=[document(4), document(20)]):
            self.assertEqual(installer.network_fingerprint(), installer.network_fingerprint())

    def test_systemd_templates_pin_mock_and_run_isolation_each_start(self):
        directory = Path(__file__).parent
        for name in ('api', 'demo'):
            text = (directory / ('mock-' + name + '.service.example')).read_text()
            self.assertIn('WorkingDirectory=/opt/oasis/android-mock-current/platform', text)
            self.assertIn('ExecStartPre=+/usr/bin/python3 deploy/mock-sandbox/install.py guard', text)
            self.assertIn('preflight.mjs --mock-env /opt/oasis/android-mock-private/runtime.env', text)
            self.assertNotIn('WorkingDirectory=/opt/oasis/current', text)
            self.assertIn('CPUQuota=', text)

    def test_stop_disables_database_dependency_without_removing_firewall(self):
        with patch.object(installer, 'resources') as resources, patch.object(installer, 'run') as run, patch('sys.stdout', new=io.StringIO()):
            installer.stop({'id': 'owned'})
        resources.assert_called_once_with({'id': 'owned'})
        run.assert_called_once_with(['systemctl', 'disable', '--now', 'oasis-android-mock-certificate.timer', 'oasis-android-mock-demo', 'oasis-android-mock-api', installer.PROXY_UNIT + '.socket', installer.PROXY_UNIT + '.service', 'oasis-android-mock-network', 'oasis-android-mock-db'])
        network_unit = {}
        with patch.object(installer, 'exact_file', side_effect=lambda path, text: network_unit.update({path.name: text})):
            installer.install_units(Path(__file__).resolve().parents[3])
        self.assertNotIn('ExecStop=', network_unit['oasis-android-mock-network.service'])

    def test_proxy_units_are_loopback_uid_confined_and_boot_ordered(self):
        files = installer.proxy_unit_files({'postgres_address': '172.20.0.2'})
        socket_unit = next(text for path, text in files.items() if path.suffix == '.socket')
        service_unit = next(text for path, text in files.items() if path.suffix == '.service')
        dropin = next(text for path, text in files.items() if path.suffix == '.conf')
        self.assertIn('ListenStream=127.0.0.1:18983', socket_unit)
        self.assertIn('DefaultDependencies=no', socket_unit)
        self.assertIn('After=oasis-android-mock-network.service', socket_unit)
        self.assertIn('WantedBy=multi-user.target', socket_unit)
        self.assertNotIn('WantedBy=sockets.target', socket_unit)
        self.assertIn('User=oasis-mock', service_unit)
        self.assertIn('ExecStart=/usr/lib/systemd/systemd-socket-proxyd 172.20.0.2:5432', service_unit)
        self.assertIn('install.py guard-proxy', service_unit)
        self.assertNotIn('runtime.env', service_unit)
        self.assertIn('Requires=oasis-android-mock-db-proxy.socket oasis-android-mock-db-proxy.service', dropin)
        with self.assertRaisesRegex(RuntimeError, 'INVALID_MOCK_DATABASE_ADDRESS'):
            installer.proxy_unit_files({'postgres_address': '8.8.8.8'})

    def test_api_guard_requires_socket_after_proxy_boundary_checks(self):
        with patch.object(installer, 'proxy_guard') as boundary, patch.object(installer, 'output', return_value='inactive'), patch.object(installer, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'SOCKET_PROXY_NOT_LISTENING'):
                installer.guard({'id': 'owned'})
        boundary.assert_called_once_with({'id': 'owned'})
        run.assert_not_called()

    def test_public_probe_retries_reload_window_and_requires_exact_body(self):
        wrong = io.BytesIO(b'wrong-vhost')
        correct = io.BytesIO(b'exact-challenge')
        wrong.status = correct.status = 200
        opener = Mock()
        opener.open.side_effect = [OSError('old listener'), wrong, correct]
        with patch.object(installer.urllib.request, 'build_opener', return_value=opener) as build, patch.object(installer.time, 'sleep') as sleep:
            installer.public_probe('http://' + installer.HOST + '/challenge', lambda body: body == b'exact-challenge', 'PUBLIC_ACME_ROUTE_FAILED')
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertTrue(all(call.kwargs['timeout'] <= 1.5 for call in opener.open.call_args_list))
        self.assertIsNone(build.call_args.args[1].redirect_request(None, None, 301, '', {}, 'https://unexpected.example'))

    def test_public_probe_failure_is_bounded_and_uses_fixed_error(self):
        opener = Mock()
        opener.open.side_effect = OSError('private details')
        ticks = iter(range(30))
        with patch.object(installer.urllib.request, 'build_opener', return_value=opener), patch.object(installer.time, 'sleep'), patch.object(installer.time, 'monotonic', side_effect=lambda: next(ticks)):
            with self.assertRaisesRegex(RuntimeError, '^MOCK_PUBLIC_HEALTH_FAILED$'):
                installer.public_probe('https://' + installer.HOST + '/health', lambda body: True, 'MOCK_PUBLIC_HEALTH_FAILED')
        self.assertLessEqual(opener.open.call_count, 4)

    def test_certificate_issuance_is_not_retried(self):
        with patch.object(installer, 'acme'), patch.object(installer, 'run', side_effect=RuntimeError('COMMAND_FAILED')) as run:
            with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED'):
                installer.certificate({'id': 'owned'})
        self.assertEqual(run.call_count, 1)
        self.assertIn('certonly', run.call_args.args[0])

    def status_result(self, *, service_states=None, database_running=False, responses=(), guard_failure=None):
        service_states = service_states or {name: 'inactive' for name in installer.RUNTIME_UNITS}
        opener = Mock()
        opener.open.side_effect = responses
        state = {'release': '/opt/oasis/releases/20261007-02'}
        with patch.object(installer, 'release_guard'), patch.object(installer, 'database_guard'), patch.object(installer, 'guard', side_effect=guard_failure) as guard, patch.object(installer, 'inspect', return_value={'State': {'Running': database_running}}), patch.object(installer, 'output', side_effect=lambda arguments, **kwargs: service_states[arguments[2]] if arguments[1] == 'is-active' else 'disabled'), patch.object(installer.urllib.request, 'build_opener', return_value=opener), patch('sys.stdout', new=io.StringIO()) as output:
            installer.status(state)
        return json.loads(output.getvalue()), guard, opener

    def health_response(self, payload=None):
        response = io.StringIO(json.dumps(payload or {'status': 'ok', 'environment': 'sandbox'}))
        response.status = 200
        return response

    def test_status_reports_stopped_without_network_probes(self):
        result, guard, opener = self.status_result()
        self.assertEqual(result['status'], 'stopped')
        self.assertFalse(result['healthy'])
        self.assertFalse(result['database_running'])
        self.assertEqual(result['isolation'], 'not_probed')
        self.assertEqual(set(result['startup_enabled'].values()), {'disabled'})
        guard.assert_not_called()
        opener.open.assert_not_called()

    def test_partial_start_is_degraded_even_if_database_is_running(self):
        result, guard, opener = self.status_result(database_running=True)
        self.assertEqual(result['status'], 'degraded')
        self.assertFalse(result['healthy'])
        guard.assert_not_called()
        opener.open.assert_not_called()

    def test_status_requires_running_proxy_not_only_application_services(self):
        states = {name: 'active' for name in installer.RUNTIME_UNITS}
        states[installer.PROXY_UNIT + '.service'] = 'failed'
        result, guard, opener = self.status_result(service_states=states, database_running=True)
        self.assertEqual(result['status'], 'degraded')
        self.assertFalse(result['healthy'])
        guard.assert_not_called()
        opener.open.assert_not_called()

    def test_active_services_need_database_readiness_and_sandbox_https_health(self):
        states = {name: 'active' for name in installer.RUNTIME_UNITS}
        for failed_check in ('api', 'public_https'):
            with self.subTest(failed_check=failed_check):
                responses = [self.health_response(), self.health_response(), self.health_response()]
                responses[0 if failed_check == 'api' else 2] = OSError('private endpoint details') if failed_check == 'api' else self.health_response({'status': 'ok', 'environment': 'production'})
                result, guard, opener = self.status_result(service_states=states, database_running=True, responses=responses)
                self.assertEqual(result['status'], 'degraded')
                self.assertFalse(result['healthy'])
                self.assertFalse(result['health_checks'][failed_check])
                self.assertNotIn('private endpoint', json.dumps(result))
                guard.assert_called_once()
                self.assertEqual(opener.open.call_args_list[0].args[0], 'http://127.0.0.1:18981/health/ready')

    def test_healthy_status_requires_all_probes_and_isolation(self):
        states = {name: 'active' for name in installer.RUNTIME_UNITS}
        result, guard, opener = self.status_result(service_states=states, database_running=True, responses=[self.health_response() for _ in range(3)])
        self.assertEqual(result['status'], 'running')
        self.assertTrue(result['healthy'])
        self.assertEqual(result['isolation'], 'verified')
        guard.assert_called_once()
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(opener.open.call_args_list[1].args[0].get_header('Host'), installer.HOST)
        self.assertEqual(opener.open.call_args_list[2].args[0], 'https://' + installer.HOST + '/health')

    def test_status_aborts_on_isolation_failure(self):
        states = {name: 'active' for name in installer.RUNTIME_UNITS}
        with self.assertRaisesRegex(RuntimeError, 'NETWORK_POLICY_DRIFT'):
            self.status_result(service_states=states, database_running=True, guard_failure=RuntimeError('NETWORK_POLICY_DRIFT'))


class StartProfileTests(unittest.TestCase):
    """Filesystem and call-sequence fixtures; every external operation is mocked."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.release = self.root / 'release'
        templates = self.release / 'platform/deploy/mock-sandbox'
        templates.mkdir(parents=True)
        text = Path(__file__).with_name('mock.nginx.conf.example').read_text()
        (templates / 'mock.nginx.conf.example').write_text(text)
        self.expected = text.replace('mock-game.example.invalid', installer.HOST).replace('/live/ANDROID_MOCK/', '/live/oasis-android-mock/')
        self.tls = self.root / 'mock.conf'
        self.cert = self.root / 'certificate'
        self.cert.mkdir()
        self.state = {'release': str(self.release)}
        self.events = []
        self.active = {'oasis-android-mock-api', 'oasis-android-mock-demo'}
        self.tls_uid = 0
        stat = Path.stat

        def fixture_stat(path, *args, **kwargs):
            result = stat(path, *args, **kwargs)
            # Model root-owned production files without chown/root privileges.
            if path == self.tls:
                return os.stat_result((*result[:4], self.tls_uid, *result[5:]))
            return result

        def run(arguments, **kwargs):
            self.events.append(tuple(arguments))
            if arguments[:2] == ['systemctl', 'start']:
                self.active.update(arguments[2:])
            elif arguments[:2] == ['systemctl', 'stop']:
                self.active.difference_update(arguments[2:])
            return installer.subprocess.CompletedProcess(arguments, 0, '', '')

        def ensure(*args, **kwargs):
            self.events.append('tls-ensure')
            return exact_file(*args, **kwargs)

        def response(_request, **_kwargs):
            self.events.append('health')
            value = io.StringIO('{"status":"ok","environment":"sandbox"}')
            value.status = 200
            return value

        exact_file = installer.exact_file
        patches = (
            patch.object(installer, 'TLS_CONF', self.tls),
            patch.object(installer, 'CERT', self.cert),
            patch.object(Path, 'stat', fixture_stat),
            patch.object(installer, 'check', side_effect=lambda *_args: self.events.append('check')),
            patch.object(installer, 'guard', side_effect=lambda *_args: self.events.append('guard')),
            patch.object(installer, 'load', return_value=self.state),
            patch.object(installer, 'run', side_effect=run),
            patch.object(installer, 'exact_file', side_effect=ensure),
            patch.object(installer.urllib.request, 'urlopen', side_effect=response),
            patch.object(installer, 'public_probe', side_effect=lambda *_args: self.events.append('public-health')),
            patch('sys.stdout', new=io.StringIO()),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def write_original(self):
        self.tls.write_text(self.expected)
        self.tls.chmod(0o644)

    def assert_no_application_mutation(self):
        applications = {'oasis-android-mock-api', 'oasis-android-mock-demo'}
        self.assertTrue(applications <= self.active)
        for call in installer.run.call_args_list:
            arguments = call.args[0]
            self.assertFalse(arguments[0] == 'systemctl' and applications.intersection(arguments[2:]), arguments)

    def test_unknown_existing_profile_rejects_before_any_command_and_preserves_running_apps(self):
        self.tls.write_text(self.expected + '\n# unknown overlay\n')
        before = self.tls.read_bytes(), self.tls.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, 'REFUSE_EXISTING_DIFFERENT_FILE'):
            installer.start(self.state)
        installer.check.assert_not_called()
        installer.run.assert_not_called()
        installer.exact_file.assert_not_called()
        self.assert_no_application_mutation()
        self.assertEqual((self.tls.read_bytes(), self.tls.stat().st_ino), before)

    def test_original_profile_wrong_owner_or_mode_rejects_before_any_command(self):
        self.write_original()
        for owner, mode in ((991, 0o644), (0, 0o666), (0, 0o600)):
            with self.subTest(owner=owner, mode=oct(mode)):
                self.tls_uid = owner
                self.tls.chmod(mode)
                with self.assertRaisesRegex(RuntimeError, 'EXISTING_FILE_PERMISSIONS'):
                    installer.start(self.state)
        installer.check.assert_not_called()
        installer.run.assert_not_called()
        self.assert_no_application_mutation()

    def test_symlink_and_directory_profiles_reject_before_any_command(self):
        for target in (self.root / 'absent', self.release):
            with self.subTest(target=target.name):
                self.tls.symlink_to(target)
                with self.assertRaisesRegex(RuntimeError, 'REFUSE_SYMLINK'):
                    installer.start(self.state)
                self.tls.unlink()
        self.tls.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'REFUSE_EXISTING_DIFFERENT_FILE'):
            installer.start(self.state)
        installer.check.assert_not_called()
        installer.run.assert_not_called()
        self.assert_no_application_mutation()

    def test_original_profile_keeps_identity_and_normal_startup_order(self):
        self.write_original()
        before = self.tls.read_bytes(), self.tls.stat().st_ino, self.tls.stat().st_mtime
        installer.start(self.state)
        self.assertEqual((self.tls.read_bytes(), self.tls.stat().st_ino, self.tls.stat().st_mtime), before)
        app_start = ('systemctl', 'start', 'oasis-android-mock-api', 'oasis-android-mock-demo')
        self.assertLess(self.events.index('check'), self.events.index('guard'))
        self.assertLess(self.events.index('guard'), self.events.index('tls-ensure'))
        self.assertLess(self.events.index('tls-ensure'), self.events.index(app_start))
        self.assertLess(self.events.index('health'), self.events.index(('nginx', '-t')))
        self.assertLess(self.events.index(('systemctl', 'reload', 'nginx')), self.events.index('public-health'))
        self.assertFalse(any(call.args[0][:2] == ['systemctl', 'stop'] for call in installer.run.call_args_list))

    def test_first_tls_creation_follows_isolation_and_precedes_app_start(self):
        self.active.clear()
        original_guard = installer.guard.side_effect

        def guarded(state):
            self.assertFalse(self.tls.exists())
            original_guard(state)

        installer.guard.side_effect = guarded
        original_run = installer.run.side_effect

        def commands(arguments, **kwargs):
            if arguments[:3] == ['systemctl', 'start', 'oasis-android-mock-api']:
                self.assertEqual(self.tls.read_text(), self.expected)
                self.assertEqual(self.tls.stat().st_mode & 0o777, 0o644)
            return original_run(arguments, **kwargs)

        installer.run.side_effect = commands
        installer.start(self.state)
        self.assertLess(self.events.index('guard'), self.events.index('tls-ensure'))
        self.assertEqual(self.tls.read_text(), self.expected)

    def test_first_tls_file_not_created_before_release_check_or_certificate(self):
        installer.check.side_effect = RuntimeError('RELEASE_PIN_CHANGED')
        with self.assertRaisesRegex(RuntimeError, 'RELEASE_PIN_CHANGED'):
            installer.start(self.state)
        self.assertFalse(self.tls.exists())
        installer.run.assert_not_called()
        installer.check.side_effect = None
        self.cert.rmdir()
        with self.assertRaisesRegex(RuntimeError, 'MOCK_CERTIFICATE_MISSING'):
            installer.start(self.state)
        self.assertFalse(self.tls.exists())
        installer.run.assert_not_called()

    def test_isolation_failure_creates_no_tls_and_never_stops_existing_apps(self):
        installer.guard.side_effect = RuntimeError('NETWORK_POLICY_DRIFT')
        with self.assertRaisesRegex(RuntimeError, 'NETWORK_POLICY_DRIFT'):
            installer.start(self.state)
        self.assertFalse(self.tls.exists())
        installer.exact_file.assert_not_called()
        self.assert_no_application_mutation()

    def test_late_tls_conflict_precedes_app_start_and_stop_handler(self):
        def conflict(_state):
            self.tls.write_text('different profile created during isolation checks')

        installer.guard.side_effect = conflict
        with self.assertRaisesRegex(RuntimeError, 'REFUSE_EXISTING_DIFFERENT_FILE'):
            installer.start(self.state)
        self.assert_no_application_mutation()
        self.assertEqual(self.tls.read_text(), 'different profile created during isolation checks')
        self.assertFalse(any(call.args[0][0] == 'nginx' for call in installer.run.call_args_list))

    def test_exclusive_tls_create_failure_does_not_enter_app_stop_handler(self):
        installer.exact_file.side_effect = FileExistsError('exclusive fixture conflict')
        with self.assertRaises(FileExistsError):
            installer.start(self.state)
        self.assert_no_application_mutation()
        self.assertFalse(self.tls.exists())


if __name__ == '__main__':
    unittest.main()

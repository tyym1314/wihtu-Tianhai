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
        run.assert_called_once_with(['systemctl', 'disable', '--now', 'oasis-android-mock-certificate.timer', 'oasis-android-mock-demo', 'oasis-android-mock-api', 'oasis-android-mock-network', 'oasis-android-mock-db'])
        network_unit = {}
        with patch.object(installer, 'exact_file', side_effect=lambda path, text: network_unit.update({path.name: text})):
            installer.install_units(Path(__file__).resolve().parents[3])
        self.assertNotIn('ExecStop=', network_unit['oasis-android-mock-network.service'])

    def status_result(self, *, service_states=None, database_running=False, responses=(), guard_failure=None):
        service_states = service_states or {name: 'inactive' for name in installer.UNITS[:4]}
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

    def test_active_services_need_database_readiness_and_sandbox_https_health(self):
        states = {name: 'active' for name in installer.UNITS[:4]}
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
        states = {name: 'active' for name in installer.UNITS[:4]}
        result, guard, opener = self.status_result(service_states=states, database_running=True, responses=[self.health_response() for _ in range(3)])
        self.assertEqual(result['status'], 'running')
        self.assertTrue(result['healthy'])
        self.assertEqual(result['isolation'], 'verified')
        guard.assert_called_once()
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(opener.open.call_args_list[1].args[0].get_header('Host'), installer.HOST)
        self.assertEqual(opener.open.call_args_list[2].args[0], 'https://' + installer.HOST + '/health')

    def test_status_aborts_on_isolation_failure(self):
        states = {name: 'active' for name in installer.UNITS[:4]}
        with self.assertRaisesRegex(RuntimeError, 'NETWORK_POLICY_DRIFT'):
            self.status_result(service_states=states, database_running=True, guard_failure=RuntimeError('NETWORK_POLICY_DRIFT'))


if __name__ == '__main__':
    unittest.main()

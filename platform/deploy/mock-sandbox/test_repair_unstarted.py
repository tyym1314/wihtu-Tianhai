import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

specification = importlib.util.spec_from_file_location('mock_repair', Path(__file__).with_name('repair_unstarted.py'))
repair = importlib.util.module_from_spec(specification)
specification.loader.exec_module(repair)
installer = repair.installer


class RepairTests(unittest.TestCase):
    def test_release_transition_rejects_non_tooling_changes_or_removal(self):
        installer_path = 'platform/deploy/mock-sandbox/install.py'
        repair_path = 'platform/deploy/mock-sandbox/repair_unstarted.py'
        old = {installer_path: 'old', 'platform/server/index.mjs': 'same'}
        new = {**old, installer_path: 'new', repair_path: 'new'}
        with patch.object(installer, 'release_check', side_effect=[(repair.OLD, 'old-hash'), (repair.NEW, 'new-hash')]), patch.object(repair, 'manifest_entries', side_effect=[old, new]):
            self.assertEqual(repair.verify_releases(), ('old-hash', 'new-hash'))
        for changed in ({**new, 'platform/server/index.mjs': 'changed'}, {key: value for key, value in new.items() if key != 'platform/server/index.mjs'}):
            with patch.object(installer, 'release_check', return_value=(repair.NEW, 'hash')), patch.object(repair, 'manifest_entries', side_effect=[old, changed]):
                with self.assertRaisesRegex(RuntimeError, 'REPAIR_NON_TOOLING_CHANGE'):
                    repair.verify_releases()

    def test_unstarted_preflight_uses_owned_container_and_rejects_prior_use(self):
        state = {'uid': 991, 'postgres_address': '172.20.0.2', 'network_fingerprint': 'same'}
        database = {'State': {'Running': True}, 'NetworkSettings': {'Networks': {installer.NETWORK: {'IPAddress': state['postgres_address']}}}}
        def outputs(arguments, **kwargs):
            if arguments[0] == 'ss':
                return ''
            return {'is-active': 'inactive', 'is-enabled': 'disabled', 'show': '0'}[arguments[1]]
        with tempfile.TemporaryDirectory() as folder, patch.object(installer, 'TLS_CONF', Path(folder) / 'not-published'), patch.object(installer, 'database_guard'), patch.object(installer, 'inspect', return_value=database), patch.object(installer.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=991)), patch.object(installer, 'network_fingerprint', return_value='same'), patch.object(installer, 'output', side_effect=outputs) as output, patch.object(installer, 'database_sql', return_value='0') as sql, patch.object(installer, 'guard') as guard:
            repair.verify_unstarted(state)
            guard.assert_not_called()
            self.assertIn("n.nspname !~ '^pg_'", sql.call_args.args[0])
            self.assertTrue(sql.call_args.args[0].startswith('SELECT count(*)'))
            sql.return_value = '1'
            with self.assertRaisesRegex(RuntimeError, 'REPAIR_DATABASE_NOT_EMPTY'):
                repair.verify_unstarted(state)
            sql.return_value = '0'
            for field, value, code in [('is-active', 'active', 'REPAIR_API_ALREADY_RUNNING'), ('is-enabled', 'enabled', 'REPAIR_API_ENABLED'), ('show', '123', 'REPAIR_API_PREVIOUSLY_STARTED')]:
                output.side_effect = lambda arguments, **kwargs: value if len(arguments) > 1 and arguments[1] == field else outputs(arguments, **kwargs)
                with self.assertRaisesRegex(RuntimeError, code):
                    repair.verify_unstarted(state)

    def fixture(self, folder):
        base = Path(folder).resolve()
        old, new = base / 'releases/20261007-03', base / 'releases/20261007-04'
        old.mkdir(parents=True)
        new.mkdir()
        private = base / 'private'
        private.mkdir(mode=0o700)
        (private / 'state').mkdir(mode=0o700)
        for relative in repair.SECRET_FILES:
            (private / relative).write_bytes(b'x' * 32)
            (private / relative).chmod(0o600)
        state = {'kind': 'isolated-13-game-mock', 'host': installer.HOST, 'id': 'owned', 'release': str(old), 'manifest_sha256': 'old-hash', 'postgres_address': '172.20.0.2'}
        marker = private / 'installation.json'
        marker.write_text(json.dumps(state))
        marker.chmod(0o600)
        pin = base / 'current'
        pin.symlink_to(old)
        return old, new, private, marker, pin, state

    def run_fixture(self, folder, *, before=None, run_failure=None, apply=True):
        old, new, private, marker, pin, state = self.fixture(folder)
        original_stat = Path.stat
        def root_stat(path, *arguments, **keywords):
            value = original_stat(path, *arguments, **keywords)
            values = list(value)
            values[4] = 0
            return os.stat_result(values)
        with patch.object(repair, 'OLD', old), patch.object(repair, 'NEW', new), patch.object(repair, 'JOURNAL', private / 'repair.json'), patch.object(installer, 'PRIVATE', private), patch.object(installer, 'MARKER', marker), patch.object(installer, 'PIN', pin), patch.object(Path, 'stat', root_stat), patch.object(Path, 'lstat', lambda path: root_stat(path, follow_symlinks=False)), patch.object(repair, 'verify_releases', return_value=('old-hash', 'new-hash')), patch.object(repair, 'verify_unstarted') as unstarted, patch.object(repair, 'verify_proxy_destinations'), patch.object(installer, 'proxy_binary_guard'), patch.object(installer, 'proxy_files_guard'), patch.object(installer, 'install_proxy_units') as install, patch.object(installer, 'run', side_effect=run_failure) as run, patch('sys.stdout', new=io.StringIO()):
            original_files = {relative: (private / relative).read_bytes() for relative in repair.SECRET_FILES}
            if before:
                before(old, new, private, marker, pin, state)
            repair.repair(apply=apply)
            return {'state': json.loads(marker.read_text()), 'pin': pin.resolve(), 'old': old, 'new': new, 'private': private, 'original': state, 'original_files': original_files, 'files': {relative: (private / relative).read_bytes() for relative in repair.SECRET_FILES}, 'install': install, 'run': run, 'unstarted': unstarted}

    def test_check_never_writes_or_starts_services(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.run_fixture(folder, apply=False)
            self.assertEqual(result['state'], result['original'])
            self.assertEqual(result['pin'], result['old'])
            self.assertEqual(result['files'], result['original_files'])
            self.assertFalse((result['private'] / 'repair.json').exists())
            result['install'].assert_not_called()
            result['run'].assert_not_called()

    def test_apply_preserves_secrets_and_only_reloads_unit_definitions(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.run_fixture(folder)
            self.assertEqual(result['pin'], result['new'])
            self.assertEqual(result['state']['release'], str(result['new']))
            self.assertEqual(result['state']['tooling_repair']['status'], 'complete')
            self.assertEqual(result['files'], result['original_files'])
            result['install'].assert_called_once_with(result['original'])
            result['run'].assert_called_once_with(['systemctl', 'daemon-reload'])
            self.assertEqual(result['unstarted'].call_count, 2)

    def test_other_original_release_is_rejected_before_install(self):
        def alter(old, new, private, marker, pin, state):
            state['release'] = str(old.parent / '20261007-02')
            marker.write_text(json.dumps(state))
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, 'REPAIR_ONLY_UNSTARTED_03_TO_04'):
                self.run_fixture(folder, before=alter)

    def test_interrupted_pin_transition_resumes_only_with_matching_journal(self):
        def interrupted(old, new, private, marker, pin, state):
            journal = {'kind': repair.KIND, 'old_hash': 'old-hash', 'new_hash': 'new-hash', 'original_state': state, 'private_snapshot': repair.private_snapshot()}
            installer.exact_file(repair.JOURNAL, json.dumps(journal, indent=2) + '\n', 0o600)
            pin.unlink()
            pin.symlink_to(new)
        with tempfile.TemporaryDirectory() as folder:
            result = self.run_fixture(folder, before=interrupted)
            self.assertEqual(result['state']['tooling_repair']['status'], 'complete')
            self.assertEqual(result['files'], result['original_files'])

    def test_completed_repair_is_read_only_and_private_drift_is_rejected(self):
        def completed(old, new, private, marker, pin, state):
            journal = {'kind': repair.KIND, 'old_hash': 'old-hash', 'new_hash': 'new-hash', 'original_state': state, 'private_snapshot': repair.private_snapshot()}
            installer.exact_file(repair.JOURNAL, json.dumps(journal, indent=2) + '\n', 0o600)
            pin.unlink()
            pin.symlink_to(new)
            installer.save(repair.target_state(state, 'old-hash', 'new-hash', 'complete'))
        with tempfile.TemporaryDirectory() as folder:
            result = self.run_fixture(folder, before=completed)
            result['install'].assert_not_called()
            result['run'].assert_not_called()
            result['unstarted'].assert_not_called()
        def drift(*values):
            completed(*values)
            (values[2] / 'state/master.key').write_bytes(b'changed' * 4)
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, 'REPAIR_PRIVATE_STATE_CHANGED'):
                self.run_fixture(folder, before=drift)


if __name__ == '__main__':
    unittest.main()

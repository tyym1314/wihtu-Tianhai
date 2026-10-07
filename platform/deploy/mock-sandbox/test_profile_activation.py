"""Relocated transaction fixtures; no nginx/mount/systemctl/database/network.

The HTTP routing module has separate real Linux evidence. These tests exercise
controller policy and crash semantics with a deliberately labelled FakeRuntime.
"""
from contextlib import ExitStack
import copy
import fcntl
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, path):
    import types
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


HERE = Path(__file__).resolve().parent
a = load('profile_activation_test', HERE / 'profile_activation.py')
pf = load('profile_activation_material_fixtures', HERE / 'test_route_profile.py')
uf = load('profile_activation_upgrade_fixtures', HERE / 'test_upgrade.py')


class Crash(BaseException):
    pass


class FakeRuntime(uf.FakeRuntime):
    def __init__(self, materials):
        super().__init__()
        self.materials = materials
        self.loaded = 'original'
        self.master = 1234

    def resources(self, state):
        result = super().resources(state)
        result['configuration_sha256'] = {'nginx': self.materials.verify()['config_sha256'], 'api': 'fixed'}
        return result

    def enclosure(self):
        return {'files': {str(self.materials.config): {'sha256': a.sha(self.materials.config.read_bytes())},
                          'other-vhost': {'sha256': 'fixed'}}, 'write_directories': ['/var/log/nginx']}

    def nginx_identity(self):
        return {'main_pid': self.master}

    def syntax(self, raw, enclosure):
        self.event('syntax')
        assert enclosure == self.enclosure()
        assert raw in [a.profile.build_profiles(**self.materials.inputs())[n] for n in ('original.conf', 'overlay.conf')]
        return a.sha(b'fixture-proof-not-a-real-namespace')

    def reload(self):
        self.event('reload')
        self.loaded = a.profile.classify_config_bytes(self.materials.config.read_bytes(), **self.materials.inputs())['profile']

    def probe(self, kind, inputs, release):
        self.event('probe:' + kind)
        assert self.loaded == kind
        return {'profile': kind, 'release': release.name, 'fixture_only': True}

    def wait_profile(self, kind, inputs, release):
        self.event('wait:' + kind)
        assert self.loaded == kind
        return {'observed': kind, 'previous_observations': [], 'fixture_only': True}


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.p = pf.ProfileTests(methodName='runTest')
        self.p.setUp()
        self.addCleanup(self.p.doCleanups)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(a, 'profile', pf.profile))
        self.stack.enter_context(patch.object(a, 'store', pf.profile.store))
        self.stack.enter_context(patch.object(a, 'bundle', pf.profile.bundle))
        self.stack.enter_context(patch.object(a.subprocess, 'run', side_effect=AssertionError('real command forbidden')))
        self.root = self.p.root
        self.base = self.root / 'base'
        self.old = self.base / 'releases' / a.upgrade.OLD_NAME
        self.new = self.base / 'releases' / a.upgrade.NEW_NAME
        critical = {
            'platform/server/schema.sql': b'schema', 'platform/server/pvp/schema.sql': b'pvp schema',
            'platform/server/wallet/schema.sql': b'wallet schema', 'platform/server/index.mjs': b'server',
            'platform/package.json': b'package', 'platform/package-lock.json': b'lock',
            'platform/deploy/mock-sandbox/install.py': (HERE / 'install.py').read_bytes(),
            'platform/deploy/mock-sandbox/preflight.mjs': b'preflight',
            'platform/deploy/mock-sandbox/isolation.mjs': b'isolation',
            'platform/deploy/restore-drill.mjs': b'fixture audit',
            'platform/deploy/demo-host.mjs': b'fixture host',
            'platform/server/pvp/index.mjs': b'reviewed new pvp',
            'platform/shared/run-action-receipt.mjs': b'reviewed new receipt',
        }
        new_files = {**self.p.fixture.bodies, **critical, **self.p.new_files}
        old_files = {k: v for k, v in new_files.items() if k not in self.p.fixture.assets
                     and k != 'platform/shared/run-action-receipt.mjs'}
        old_files.update(self.p.old_files)
        old_files['platform/server/pvp/index.mjs'] = b'reviewed old pvp'
        manifests = []
        for root, sources in ((self.old, old_files), (self.new, new_files)):
            root.mkdir(parents=True)
            for name, value in sources.items():
                uf.put(root, name, value)
            manifest = a.bundle.encoded({n: a.sha(v) for n, v in sources.items()})
            manifests.append(manifest)
            uf.put(root, 'RELEASE-MANIFEST.json', manifest)
            for dependency in ('tsx', 'pg'):
                uf.put(root, 'platform/node_modules/' + dependency + '/package.json', b'{}')
        self.p.fixture.bodies = new_files
        self.p.fixture.manifest = json.loads(manifests[1])
        self.p.fixture.sources['manifest'] = manifests[1]
        self.p.fixture.pins['old_manifest'] = a.sha(manifests[0])
        self.p.fixture.report.update(old_manifest=a.sha(manifests[0]), new_manifest=a.sha(manifests[1]))
        self.p.fixture.update_evidence()
        self.p.fixture.write_source()
        self.p.fixture.compile(output=self.root / 'controller-bundle')
        self.source = self.root / 'controller-bundle/bundle.tar'
        for target, field, value in ((a.profile, 'MANIFEST_PINS', {'04': a.sha(manifests[0]), '05': a.sha(manifests[1])}),
             (a.profile, 'MANIFEST_COUNTS', {'04': len(old_files), '05': len(new_files)}),
             (a.upgrade, 'NEW_MANIFEST', a.sha(manifests[1])),
             (a.upgrade, 'REVIEWED_PVP', (a.sha(old_files['platform/server/pvp/index.mjs']), a.sha(new_files['platform/server/pvp/index.mjs']))),
             (a.upgrade, 'RECEIPT_SHA', a.sha(new_files['platform/shared/run-action-receipt.mjs'])),
             (a, 'LEGACY_INSTALLER_SHA', a.sha(critical['platform/deploy/mock-sandbox/install.py']))):
            self.stack.enter_context(patch.object(target, field, value))
        self.stack.enter_context(patch.object(a.upgrade, 'available', return_value=a.upgrade.RESERVE + 2 ** 30))
        self.stack.enter_context(patch.object(a.upgrade.installer.pwd, 'getpwnam',
                                            return_value=SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getgid())))
        self.materials = a.Materials(self.base, self.root / 'nginx.conf', self.p.parent,
                                     self.root / 'profile-materials' / '04-to-05-v1')
        self.runtime = FakeRuntime(self.materials)
        self.task = a.Activation(self.materials, self.runtime, self.base / 'locks')
        task = self.task.task
        task.private.mkdir(mode=0o750)
        task.private.chmod(0o750)
        for name in a.upgrade.PRIVATE_FILES:
            uf.put(task.private, name, 'fixture secret ' + name, 0o600)
        (task.private / 'state').chmod(0o700)
        self.state = {'kind': 'isolated-13-game-mock', 'host': a.installer.HOST, 'id': 'fixture',
            'release': str(self.old), 'manifest_sha256': a.sha(manifests[0]), 'uid': os.geteuid()}
        uf.put(task.private, 'installation.json', json.dumps(self.state), 0o600)
        task.pin.symlink_to(self.old)
        (self.base / 'current').symlink_to(self.new)
        uf.put(self.base, 'private/runtime.env', 'untouched live fixture', 0o600)
        uf.put(self.base, 'private/release.lock', '')
        for name in ('install', 'network'):
            uf.put(task.lock_root, 'oasis-android-mock-' + name + '.lock', '')
        self.inputs = self.materials.inputs(self.source)
        self.artifacts = a.profile.build_profiles(**self.inputs)
        uf.put(self.root, 'nginx.conf', self.artifacts['original.conf'])
        self.pristine = uf.tree(self.base)

    def prepare(self):
        return self.task.prepare(self.source)

    def activate(self):
        self.prepare()
        return self.task.activate()

    def assert_untouched(self):
        self.assertEqual(uf.tree(self.base), self.pristine)
        self.assertTrue(self.runtime.active)
        self.assertNotIn('stop', self.runtime.events)
        self.assertNotIn('start', self.runtime.events)

    def test_default_check_before_prepare_is_read_only_and_never_claims_apply(self):
        before = uf.tree(self.root)
        result = self.task.check(self.source)
        self.assertFalse(result['apply_allowed'])
        self.assertEqual(uf.tree(self.root), before)
        self.assertNotIn('syntax', self.runtime.events)
        self.assert_untouched()

    def test_prepare_and_idempotent_prepare_never_touch_services_config_release(self):
        self.assertEqual(self.prepare()['status'], 'prepared')
        before = uf.tree(self.root)
        self.prepare()
        self.assertEqual(uf.tree(self.root), before)
        self.assertEqual(self.materials.config.read_bytes(), self.artifacts['original.conf'])
        self.assert_untouched()

    def test_activate_readback_and_recovery_do_not_stop_any_application(self):
        result = self.activate()
        self.assertEqual(result['status'], 'activated')
        self.assertEqual(self.task.load()['phase'], 'complete')
        self.assertEqual(self.task.recover()['status'], 'already_activated')
        self.assertLess(self.runtime.events.index('syntax'), self.runtime.events.index('reload'))
        self.assert_untouched()

    def test_unknown_profile_rejects_before_service_or_material_mutation(self):
        self.materials.config.write_bytes(self.artifacts['original.conf'] + b'include unknown;\n')
        before = uf.tree(self.root)
        for operation in (lambda: self.task.check(self.source), self.prepare, self.task.start):
            with self.assertRaisesRegex((RuntimeError, ValueError), 'UNKNOWN_ROUTE_PROFILE'):
                operation()
        self.assertEqual(uf.tree(self.root), before)
        self.assert_untouched()

    def test_source_dependency_installer_store_and_material_drift_fail_before_reload(self):
        self.prepare()
        for mutation in ('installer', 'mutable', 'extra_static', 'material', 'receipt'):
            with self.subTest(mutation=mutation):
                target = {'installer': self.old / 'platform/deploy/mock-sandbox/install.py',
                          'mutable': self.new / a.profile.JSON_PATH,
                          'extra_static': self.new / 'platform/dist/extra-unlisted.js',
                          'material': self.materials.root / 'overlay.conf',
                          'receipt': self.p.parent / a.store.RECEIPT}[mutation]
                existed = target.exists()
                old = target.read_bytes() if existed else None
                mode = target.stat().st_mode & 0o777 if existed else 0o644
                target.chmod(0o644) if existed else None
                target.write_bytes(b'drift')
                target.chmod(mode)
                with self.assertRaises((RuntimeError, ValueError)):
                    self.task.activate()
                if existed:
                    target.chmod(0o644)
                    target.write_bytes(old)
                    target.chmod(mode)
                else:
                    target.unlink()
                self.assertNotIn('reload', self.runtime.events)
        self.assertFalse(self.task.journal.exists())

    def test_missing_namespace_capability_fails_before_effective_write(self):
        self.prepare()
        self.runtime.failure = 'syntax'
        with self.assertRaisesRegex(RuntimeError, 'FIXTURE_INJECTED_FAILURE'):
            self.task.activate()
        self.assertFalse(self.task.journal.exists())
        self.assertEqual(self.materials.config.read_bytes(), self.artifacts['original.conf'])
        self.assertNotIn('reload', self.runtime.events)

    def test_reload_or_http_failure_restores_exact_original_without_stopping_api(self):
        self.prepare()
        self.runtime.failure = 'probe:overlay'
        with self.assertRaisesRegex(RuntimeError, 'FAILED_RESTORED'):
            self.task.activate()
        self.assertEqual(self.task.load()['phase'], 'rolled_back')
        self.assertEqual(self.materials.config.read_bytes(), self.artifacts['original.conf'])
        self.assertEqual(self.runtime.loaded, 'original')
        self.assertEqual(self.task.recover()['status'], 'already_restored')
        self.assert_untouched()

    def test_interrupted_every_activation_phase_converges(self):
        # Separate fixtures preserve each durable phase; BaseException models
        # process loss, avoiding the ordinary Exception rollback handler.
        for phase in ('prepared', 'switching', 'configured', 'reloading', 'verified', 'complete'):
            with self.subTest(phase=phase):
                inner = ActivationTests('runTest')
                inner.setUp()
                try:
                    inner.prepare()
                    save = inner.task.save
                    def crash(journal, next_phase):
                        save(journal, next_phase)
                        if next_phase == phase:
                            raise Crash()
                    with patch.object(inner.task, 'save', side_effect=crash), self.assertRaises(Crash):
                        inner.task.activate()
                    result = inner.task.recover()
                    self.assertIn(result['status'], ('restored_original', 'activated', 'already_activated'))
                    self.assertIn(inner.task.load()['phase'], ('rolled_back', 'complete'))
                    inner.assert_untouched()
                finally:
                    inner.doCleanups()

    def test_foreign_enclosure_or_pin_blocks_recovery_without_reloading(self):
        self.prepare()
        original = self.task.save
        def crash(journal, phase):
            original(journal, phase)
            if phase == 'configured':
                raise Crash()
        with patch.object(self.task, 'save', side_effect=crash), self.assertRaises(Crash):
            self.task.activate()
        self.runtime.master += 1
        with self.assertRaisesRegex(RuntimeError, 'BOUNDARY_CHANGED'):
            self.task.recover()
        self.assertNotIn('reload', self.runtime.events)
        self.assertTrue(self.runtime.active)

    def test_start_checks_profiles_before_mutation_and_does_not_stop_on_failed_health(self):
        self.prepare()
        self.assertEqual(self.task.start()['profile'], 'original')
        self.activate()
        self.runtime.active = False
        self.assertEqual(self.task.start()['profile'], 'overlay')
        self.assertIn('start', self.runtime.events)
        self.runtime.failure = 'health'
        with self.assertRaisesRegex(RuntimeError, 'FIXTURE_INJECTED_FAILURE'):
            self.task.start()
        self.assertTrue(self.runtime.active)
        self.assertNotIn('stop', self.runtime.events)

    def test_full_upgrade_uses_inherited_backup_and_business_semantics(self):
        self.activate()
        task = a.ProfileUpgrade(self.materials, self.runtime, self.base / 'locks')
        result = task.apply()
        self.assertEqual(result['status'], 'upgraded')
        self.assertEqual(task.state()[1], self.new)
        self.assertEqual(self.materials.config.read_bytes(), self.artifacts['overlay.conf'])
        self.assertTrue((task.work / 'backup/database.dump').exists())
        self.runtime.business['pending']['presentations'] += 1
        self.assertEqual(task.recover()['status'], 'already_complete')
        self.assertEqual(self.task.recover()['status'], 'already_activated')

    def test_upgrade_failure_restores04_but_retains_overlay(self):
        self.activate()
        task = a.ProfileUpgrade(self.materials, self.runtime, self.base / 'locks')
        self.runtime.failure = 'preflight:' + a.upgrade.NEW_NAME
        with self.assertRaisesRegex(RuntimeError, 'FAILED_ROLLED_BACK'):
            task.apply()
        self.assertEqual(task.state()[1], self.old)
        self.assertTrue(self.runtime.active)
        self.assertEqual(self.materials.config.read_bytes(), self.artifacts['overlay.conf'])
        self.assertEqual(task.recover()['status'], 'already_rolled_back')

    def test_pending_obligation_refuses_upgrade_without_stopping(self):
        self.activate()
        task = a.ProfileUpgrade(self.materials, self.runtime, self.base / 'locks')
        self.runtime.business['pending']['presentations'] = 1
        with self.assertRaisesRegex(RuntimeError, 'PENDING'):
            task.apply()
        self.assertNotIn('stop', self.runtime.events)
        self.assertFalse(task.work.exists())

    def test_prepare_unknown_members_and_published_bytes_not_repaired(self):
        self.prepare()
        target = self.materials.root / a.profile.CANONICAL_JSON
        target.chmod(0o644)
        target.write_bytes(b'corrupt')
        target.chmod(0o444)
        with self.assertRaisesRegex(RuntimeError, 'MATERIAL_CHANGED'):
            self.prepare()
        self.assertEqual(target.read_bytes(), b'corrupt')

    def test_lock_competition_never_mutates_or_starts_services(self):
        path = self.base / 'private/release.lock'
        with path.open() as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.prepare()
        self.assertFalse(self.materials.control.exists())
        self.assert_untouched()

    def test_installer_exact_dependency_and_old_baseline_are_both_required(self):
        with patch.dict(a.DEPENDENCIES, {'install.py': '0' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_NOT_REVIEWED'):
                self.task.check(self.source)
        with patch.object(a, 'LEGACY_INSTALLER_SHA', '0' * 64):
            with self.assertRaisesRegex(RuntimeError, 'LEGACY_INSTALLER_CHANGED'):
                self.task.check(self.source)
        self.assert_untouched()

    def test_material_partial_write_resume_and_no_links(self):
        folder = self.root / 'partial'
        folder.mkdir()
        target = folder / 'sealed'
        uf.put(folder, '.sealed.pending', b'ex', 0o600)
        a.exclusive_material(target, b'exact', 0o444)
        self.assertEqual(target.read_bytes(), b'exact')
        target.unlink()
        uf.put(folder, '.sealed.pending', b'exact', 0o444)
        a.exclusive_material(target, b'exact', 0o444)
        target.unlink()
        target.symlink_to(self.materials.config)
        with self.assertRaises((RuntimeError, ValueError)):
            a.exclusive_material(target, b'exact', 0o444)

    def test_config_inventory_tracks_include_additions_and_unknown_write_paths(self):
        root = self.root / 'enclosure'
        tls = uf.put(root, 'mock.conf', 'server { listen 443; }\n')
        main = uf.put(root, 'nginx.conf', 'events {} http { include ' + str(root / '*.vhost') + '; include ' + str(tls) + '; }\n')
        before = a.config_inventory(main, tls)
        uf.put(root, 'new.vhost', 'server { listen 8443; }\n')
        after = a.config_inventory(main, tls)
        with self.assertRaisesRegex(RuntimeError, 'ENCLOSURE_CHANGED'):
            a.same_enclosure(before, after, tls)
        main.write_text('events {} http { include ' + str(tls) + '; access_log /opt/unreviewed/log; }\n')
        with self.assertRaisesRegex(RuntimeError, 'WRITE_PATH_REQUIRES_REVIEW'):
            a.config_inventory(main, tls)

    def test_namespace_entry_rejects_before_commands_without_nonce_scope(self):
        with self.assertRaisesRegex(RuntimeError, 'NAMESPACE_SCOPE'):
            a.namespace_syntax_child(self.root)

    def test_namespace_includes_all_compiled_temp_and_log_pid_lock_paths(self):
        flags = ['--prefix=/usr/share/nginx', '--error-log-path=/var/log/nginx/error.log',
                 '--http-log-path=/var/log/nginx/access.log', '--pid-path=/run/nginx.pid',
                 '--lock-path=/run/lock/nginx.lock']
        flags += ['--http-' + key + '-temp-path=/var/lib/nginx/' + leaf for key, leaf in
                  [('client-body', 'body'), ('proxy', 'proxy'), ('fastcgi', 'fastcgi'), ('uwsgi', 'uwsgi'), ('scgi', 'scgi')]]
        text = 'nginx version: fixture\nconfigure arguments: ' + ' '.join(flags)
        result = a.namespace_write_directories({'write_directories': ['/var/log/nginx']}, text)
        self.assertEqual(set(map(str, result)), {'/run', '/var/log/nginx', '/var/lib/nginx/body',
            '/var/lib/nginx/proxy', '/var/lib/nginx/fastcgi', '/var/lib/nginx/uwsgi', '/var/lib/nginx/scgi'})
        for bad in ('/opt/unreviewed', '/var/lib/nginx/../../../opt/escape'):
            with self.assertRaisesRegex(RuntimeError, 'COMPILED_WRITE_PATH_REQUIRES_REVIEW'):
                a.namespace_write_directories({'write_directories': []}, text.replace('/var/lib/nginx/proxy', bad))
        with self.assertRaisesRegex(RuntimeError, 'COMPILED_WRITE_PATH_REQUIRES_REVIEW'):
            a.namespace_write_directories({'write_directories': []}, 'configure arguments: --prefix=/usr/share/nginx')

    def test_config_inventory_rejects_duplicate_include_and_unsafe_log(self):
        root = self.root / 'duplicate-config'
        tls = uf.put(root, 'mock.conf', 'server { listen 443; }\n')
        main = uf.put(root, 'nginx.conf', 'http { include "' + str(tls) + '"; include "' + str(tls) + '"; }\n')
        with self.assertRaisesRegex(RuntimeError, 'INCLUDE_CYCLE_OR_DUPLICATE'):
            a.config_inventory(main, tls)
        for log in ('syslog:server=example.invalid', '$unknown/log'):
            main.write_text('http { include "' + str(tls) + '"; access_log ' + log + '; }\n')
            with self.assertRaisesRegex(RuntimeError, 'UNSUPPORTED_WRITE_PATH'):
                a.config_inventory(main, tls)

    def test_upgrade_recovery_keeps_new_business_and_overlay_after_start(self):
        self.activate()
        task = a.ProfileUpgrade(self.materials, self.runtime, self.base / 'locks')
        save = task.save
        def crash(journal, phase):
            save(journal, phase)
            if phase == 'healthy':
                raise Crash()
        with patch.object(task, 'save', side_effect=crash), self.assertRaises(Crash):
            task.apply()
        self.runtime.business['pending']['presentations'] += 1
        stops = self.runtime.events.count('stop')
        self.assertEqual(task.recover()['status'], 'upgraded')
        self.assertEqual(self.runtime.events.count('stop'), stops)
        self.assertEqual(task.state()[1], self.new)
        self.assertEqual(self.materials.config.read_bytes(), self.artifacts['overlay.conf'])

    def test_config_replacement_crash_before_journal_update_recovers_overlay(self):
        self.prepare()
        replace = self.task.replace_config
        def crash(raw):
            replace(raw)
            raise Crash()
        with patch.object(self.task, 'replace_config', side_effect=crash), self.assertRaises(Crash):
            self.task.activate()
        self.assertEqual(self.task.load()['phase'], 'switching')
        self.assertEqual(self.task.recover()['status'], 'activated')
        self.assert_untouched()

    def test_uncommitted_activation_cannot_authorize_upgrade(self):
        self.prepare()
        self.materials.config.write_bytes(self.artifacts['overlay.conf'])
        task = a.ProfileUpgrade(self.materials, self.runtime, self.base / 'locks')
        with self.assertRaises(FileNotFoundError):
            task.apply()
        self.assertNotIn('stop', self.runtime.events)

    def test_stage_rename_interruption_reuses_exact_sealed_materials(self):
        rename = a.os.rename
        def crash(source, target):
            if Path(target) == self.materials.root:
                raise Crash()
            return rename(source, target)
        with patch.object(a.os, 'rename', side_effect=crash), self.assertRaises(Crash):
            self.prepare()
        self.assertEqual(self.prepare()['status'], 'prepared')
        self.assert_untouched()

    def test_recovery_does_not_deactivate_overlay_after_complete_upgrade(self):
        self.activate()
        task = a.ProfileUpgrade(self.materials, self.runtime, self.base / 'locks')
        task.apply()
        reloads = self.runtime.events.count('reload')
        self.assertEqual(self.task.recover()['status'], 'already_activated')
        self.assertEqual(self.runtime.events.count('reload'), reloads)
        self.assertEqual(task.state()[1], self.new)


if __name__ == '__main__':
    unittest.main()

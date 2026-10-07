import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


def load_publisher():
    spec = importlib.util.spec_from_file_location('static_publisher_under_test', Path(__file__).with_name('publish-static-assets.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(content):
    return hashlib.sha256(content).hexdigest()


class StaticPublisherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        (self.base / 'private').mkdir()
        (self.base / 'private/release.lock').touch()
        (self.base / 'releases').mkdir()
        self.publisher = load_publisher()
        self.old = self.release('20261007-04', b'export const old = true;')
        self.new = self.release('20261008-02', b'export const newer = true;')
        (self.base / 'current').symlink_to(self.old)
        (self.base / 'android-mock-current').symlink_to(self.old)
        self.store = self.base / 'static-assets'
        patch = mock.patch.object(self.publisher.os, 'statvfs', return_value=mock.Mock(
            f_frsize=4096, f_bsize=4096, f_bavail=20 * 1024 ** 3 // 4096))
        patch.start()
        self.addCleanup(patch.stop)

    def release(self, name, content):
        root = self.base / 'releases' / name
        root.mkdir()
        files = {f'platform/server/fixture-{i}.mjs': b'code' for i in range(10)}
        files['platform/arena/dist/assets/Fixture-' + digest(content)[:8] + '.js'] = content
        for relative, data in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (root / 'RELEASE-MANIFEST.json').write_text(json.dumps({p: digest(b) for p, b in files.items()}))
        return root

    def put(self, root, name, data):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        manifest_path = root / 'RELEASE-MANIFEST.json'
        manifest = json.loads(manifest_path.read_text())
        manifest[name] = digest(data)
        manifest_path.write_text(json.dumps(manifest))
        return path

    def url(self, root):
        return next(iter(self.publisher.manifest_assets(root)[0]))

    def snapshot(self, root):
        return {str(p.relative_to(root)): ('link', os.readlink(p)) if p.is_symlink() else ('file', digest(p.read_bytes()))
                for p in root.rglob('*') if p.is_file() or p.is_symlink()}

    def test_check_only_does_not_create_store_or_change_any_source_or_pointer(self):
        before = self.snapshot(self.base)
        report = self.publisher.publish(self.new, self.base)
        self.assertEqual(report['status'], 'checked')
        self.assertEqual(report['new_files'], 1)
        self.assertFalse(self.store.exists())
        self.assertEqual(self.snapshot(self.base), before)

    def test_publish_is_idempotent_independent_copy_and_preserves_source_and_pointers(self):
        before = self.snapshot(self.base)
        first = self.publisher.publish(self.new, self.base, apply=True)
        repeated = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(first['new_files'], 1)
        self.assertEqual(repeated['new_files'], 0)
        self.assertEqual(repeated['coverage']['receipts'], 1)
        asset = self.publisher.manifest_assets(self.new)[0][self.url(self.new)]
        target = self.store / self.url(self.new).lstrip('/')
        self.assertNotEqual(target.stat().st_ino, (self.new / asset['source']).stat().st_ino)
        for name, data in before.items():
            self.assertEqual(self.snapshot(self.base)[name], data)
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertEqual((self.base / 'android-mock-current').resolve(), self.old)

    def test_all_url_conflicts_are_checked_before_first_new_file(self):
        self.publisher.publish(self.old, self.base, apply=True)
        old_name = self.publisher.manifest_assets(self.old)[0][self.url(self.old)]['source']
        self.put(self.new, old_name, b'changed bytes under the published URL')
        before = self.snapshot(self.store)
        with self.assertRaisesRegex(ValueError, 'STATIC_URL_CONFLICT'):
            self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(self.snapshot(self.store), before)
        self.assertFalse((self.store / self.url(self.new).lstrip('/')).exists())

    def test_source_and_store_symlinks_are_rejected(self):
        public = self.url(self.new)
        source = self.new / self.publisher.manifest_assets(self.new)[0][public]['source']
        original = source.read_bytes()
        elsewhere = self.base / 'external.js'
        elsewhere.write_bytes(original)
        source.unlink()
        source.symlink_to(elsewhere)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RETAINED_PATH'):
            self.publisher.publish(self.new, self.base, apply=True)
        source.unlink()
        source.write_bytes(original)
        self.publisher.publish(self.old, self.base, apply=True)
        (self.store / 'arena').rename(self.store / 'saved-arena')
        outside = self.base / 'outside'
        outside.mkdir()
        (self.store / 'arena').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RETAINED_PATH'):
            self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(list(outside.iterdir()), [])

    def test_tampered_source_and_disk_reserve_fail_before_writes(self):
        public = self.url(self.new)
        source = self.new / self.publisher.manifest_assets(self.new)[0][public]['source']
        original = source.read_bytes()
        source.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'STATIC_SOURCE_HASH_MISMATCH'):
            self.publisher.publish(self.new, self.base, apply=True)
        source.write_bytes(original)
        with mock.patch.object(self.publisher.os, 'statvfs', return_value=mock.Mock(
                f_frsize=4096, f_bsize=4096, f_bavail=self.publisher.RESERVE // 4096)):
            with self.assertRaisesRegex(ValueError, 'STATIC_STORE_RESERVE_REQUIRED'):
                self.publisher.publish(self.new, self.base, apply=True)
        self.assertFalse(self.store.exists())

    def test_old_rollback_checks_newer_registered_assets_and_republish_restores_missing_bytes(self):
        self.publisher.publish(self.old, self.base, apply=True)
        self.publisher.publish(self.new, self.base, apply=True)
        report = self.publisher.verify_coverage(self.old, self.base)
        self.assertEqual(report['required_assets'], 1)
        self.assertEqual(report['registered_assets'], 2)
        target = self.store / self.url(self.new).lstrip('/')
        target.unlink()  # Simulated storage loss; the publisher never removes files.
        with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_MISSING'):
            self.publisher.verify_coverage(self.old, self.base)
        with self.assertRaisesRegex(ValueError, 'REGISTERED_STATIC_ASSET_MISSING'):
            self.publisher.publish(self.old, self.base, apply=True)
        restored = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(restored['new_files'], 1)
        self.assertEqual(restored['coverage']['receipts'], 2)
        self.publisher.verify_coverage(self.old, self.base)

    def test_failed_publish_can_resume_without_replacing_the_first_public_file(self):
        self.put(self.new, 'platform/dist/assets/Second-12345678.js', b'another JS file')
        original = self.publisher.install_atomic
        calls = 0

        def interrupted(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('SIMULATED_INTERRUPTION')
            return original(*args)

        with mock.patch.object(self.publisher, 'install_atomic', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, 'SIMULATED_INTERRUPTION'):
                self.publisher.publish(self.new, self.base, apply=True)
        present = [p for p in self.store.rglob('*.js') if p.is_file()]
        self.assertEqual(len(present), 1)
        inode = present[0].stat().st_ino
        self.assertEqual(list((self.store / '.registry').glob('*.json')), [])
        with self.assertRaisesRegex(ValueError, 'STATIC_PUBLISH_INCOMPLETE'):
            self.publisher.verify_coverage(self.new, self.base)
        report = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(report['new_files'], 1)
        self.assertEqual(present[0].stat().st_ino, inode)
        self.publisher.verify_coverage(self.new, self.base)

    def test_lock_content_dependencies_are_published_but_old_unlisted_files_are_not_required(self):
        (self.old / 'platform/arena/dist/assets/Unlisted-abcdefgh.js').write_bytes(b'historic unlisted')
        self.publisher.publish(self.old, self.base, apply=True)
        self.publisher.verify_coverage(self.old, self.base)
        public = self.url(self.new)
        info = self.publisher.manifest_assets(self.new)[0][public]
        source = [{'release': self.old.name, 'manifest_sha256': 'a' * 64}]
        assets = [{'path': info['source'], 'publicPath': public, 'sha256': info['sha256'], 'bytes': info['bytes'],
                   'contentType': 'application/javascript', 'sources': source, 'dependencies': ['/mark.svg']}]
        self.put(self.new, 'platform/dist/mark.svg', b'<svg/>')
        assets.append({'path': 'platform/dist/mark.svg', 'publicPath': '/mark.svg', 'sha256': digest(b'<svg/>'),
                       'bytes': 6, 'role': 'dependency', 'contentType': 'image/svg+xml', 'sources': source, 'dependencies': []})
        lock = {'schema': 'oasis-retained-static-v1', 'bundle': {'url': 'https://example.com/fixed.tar.gz',
                'sha256': 'a' * 64, 'bytes': 1}, 'assets': assets}
        self.put(self.new, 'platform/retained-assets.lock.json', json.dumps(lock).encode())
        report = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(report['required_assets'], 2)
        self.assertEqual((self.store / 'mark.svg').read_bytes(), b'<svg/>')

    def test_registry_tampering_and_symlink_lock_are_rejected(self):
        self.publisher.publish(self.new, self.base, apply=True)
        receipt = next((self.store / '.registry').glob('*.json'))
        receipt.write_bytes(receipt.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'STATIC_RECEIPT_HASH_MISMATCH'):
            self.publisher.verify_coverage(self.new, self.base)
        lock = self.base / 'private/release.lock'
        lock.unlink()
        lock.symlink_to(self.base / 'outside-lock')
        with self.assertRaises(OSError):
            self.publisher.publish(self.old, self.base, apply=True)

    def test_deployment_lock_is_shared_and_nonblocking(self):
        with self.publisher.deployment_lock(self.base):
            with self.assertRaises(BlockingIOError):
                self.publisher.publish(self.new, self.base, apply=True)
        self.assertFalse(self.store.exists())

    def test_missing_new_receipt_and_asset_are_detected_when_checking_old_rollback(self):
        self.publisher.publish(self.old, self.base, apply=True)
        self.publisher.publish(self.new, self.base, apply=True)
        receipt = next(p for p in (self.store / '.registry').glob('*.json')
                       if json.loads(p.read_text())['release'] == self.new.name)
        receipt.unlink()
        (self.store / self.url(self.new).lstrip('/')).unlink()
        before = self.snapshot(self.base)
        with self.assertRaisesRegex(ValueError, 'STATIC_REGISTERED_RECEIPT_MISSING'):
            self.publisher.verify_coverage(self.old, self.base)
        for release in (self.old, self.new):
            with self.assertRaisesRegex(ValueError, 'STATIC_REGISTERED_RECEIPT_MISSING'):
                self.publisher.publish(release, self.base, apply=True)
        self.assertEqual(self.snapshot(self.base), before)

    def test_head_loss_is_not_treated_as_permission_to_reinitialize_existing_store(self):
        self.publisher.publish(self.old, self.base, apply=True)
        (self.base / self.publisher.HEAD_PATH).unlink()
        before = self.snapshot(self.base)
        with self.assertRaisesRegex(ValueError, 'STATIC_HEAD_MISSING'):
            self.publisher.verify_coverage(self.old, self.base)
        with self.assertRaisesRegex(ValueError, 'STATIC_HEAD_MISSING'):
            self.publisher.publish(self.old, self.base, apply=True)
        self.assertEqual(self.snapshot(self.base), before)

    def test_interruption_after_receipt_accepts_only_exact_pending_candidate_on_retry(self):
        self.publisher.publish(self.old, self.base, apply=True)
        original = self.publisher.write_head

        def interrupted(base, value, previous):
            if value['pending'] is None:
                raise RuntimeError('SIMULATED_HEAD_COMMIT_INTERRUPTION')
            return original(base, value, previous)

        with mock.patch.object(self.publisher, 'write_head', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, 'SIMULATED_HEAD_COMMIT_INTERRUPTION'):
                self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(len(list((self.store / '.registry').glob('*.json'))), 2)
        with self.assertRaisesRegex(ValueError, 'STATIC_PUBLISH_INCOMPLETE'):
            self.publisher.verify_coverage(self.old, self.base)
        with self.assertRaisesRegex(ValueError, 'STATIC_PUBLISH_PENDING_FOR_DIFFERENT_CANDIDATE'):
            self.publisher.publish(self.old, self.base, apply=True)
        report = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(report['new_files'], 0)
        self.assertEqual(report['coverage']['receipts'], 2)
        self.publisher.verify_coverage(self.old, self.base)

    def test_unanchored_receipt_cannot_be_adopted_even_when_it_matches_the_candidate(self):
        self.publisher.publish(self.old, self.base, apply=True)
        required, manifest_sha256 = self.publisher.manifest_assets(self.new)
        receipt = {'schema': self.publisher.SCHEMA, 'release': self.new.name,
                   'manifest_sha256': manifest_sha256,
                   'assets': {public: {key: item[key] for key in ('sha256', 'bytes')}
                              for public, item in required.items()}}
        payload = self.publisher.json_bytes(receipt)
        (self.store / '.registry' / (digest(payload) + '.json')).write_bytes(payload)
        with self.assertRaisesRegex(ValueError, 'STATIC_UNANCHORED_RECEIPT'):
            self.publisher.publish(self.new, self.base, apply=True)
        with self.assertRaisesRegex(ValueError, 'STATIC_UNANCHORED_RECEIPT'):
            self.publisher.verify_coverage(self.old, self.base)

    def test_block_allocation_bound_covers_ten_thousand_one_byte_files(self):
        missing = [f'/arena/assets/tiny-{i:08d}.js' for i in range(10000)]
        wanted = {public: {'bytes': 1} for public in missing}
        space = self.publisher.space_bound(self.base, self.store, missing, wanted, 120, 300)
        self.assertGreaterEqual(space['allocation_bound_bytes'], 10000 * 4096)
        self.assertGreater(space['allocation_bound_bytes'], 10000 + 1024 * 1024)
        self.assertGreaterEqual(space['new_directories'], 4)
        with mock.patch.object(self.publisher.os, 'statvfs', return_value=mock.Mock(
                f_frsize=16384, f_bsize=16384, f_bavail=(self.publisher.RESERVE + 2 * 1024 ** 2) // 16384)):
            larger = self.publisher.space_bound(self.base, self.store, missing, wanted, 120, 300)
        self.assertGreater(larger['allocation_bound_bytes'], space['allocation_bound_bytes'])
        self.assertLess(larger['free_bytes'] - larger['allocation_bound_bytes'], self.publisher.RESERVE)

    def test_first_publish_must_not_shadow_current_unmanifested_fallback_with_different_bytes(self):
        current_mark = self.old / 'platform/dist/mark.svg'
        current_mark.parent.mkdir(parents=True, exist_ok=True)
        current_mark.write_bytes(b'<svg>A</svg>')  # Deliberately omitted from the old manifest.
        public = self.url(self.new)
        info = self.publisher.manifest_assets(self.new)[0][public]
        source = [{'release': self.old.name, 'manifest_sha256': 'a' * 64}]
        different = b'<svg>B</svg>'
        self.put(self.new, 'platform/dist/mark.svg', different)
        assets = [{'path': info['source'], 'publicPath': public, 'sha256': info['sha256'], 'bytes': info['bytes'],
                   'contentType': 'application/javascript', 'sources': source, 'dependencies': ['/mark.svg']},
                  {'path': 'platform/dist/mark.svg', 'publicPath': '/mark.svg', 'sha256': digest(different),
                   'bytes': len(different), 'role': 'dependency', 'contentType': 'image/svg+xml',
                   'sources': source, 'dependencies': []}]
        lock = {'schema': 'oasis-retained-static-v1', 'bundle': {'url': 'https://example.com/fixed.tar.gz',
                'sha256': 'a' * 64, 'bytes': 1}, 'assets': assets}
        self.put(self.new, 'platform/retained-assets.lock.json', json.dumps(lock).encode())
        before = self.snapshot(self.base)
        with self.assertRaisesRegex(ValueError, 'STATIC_CURRENT_FALLBACK_CONFLICT'):
            self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(self.snapshot(self.base), before)
        self.assertFalse(self.store.exists())

    def test_current_fallback_symlink_is_not_followed_or_shadowed(self):
        public = self.url(self.new)
        info = self.publisher.manifest_assets(self.new)[0][public]
        path = self.old / info['source']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(self.new / info['source'])
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RETAINED_PATH'):
            self.publisher.publish(self.new, self.base, apply=True)
        self.assertFalse(self.store.exists())

    def test_space_drop_after_preflight_stops_file_install_and_same_candidate_can_resume(self):
        available = [20 * 1024 ** 3]
        statvfs = lambda path: mock.Mock(f_frsize=4096, f_bsize=4096, f_bavail=available[0] // 4096)
        install = self.publisher.install_atomic

        def consume_before_install(*args):
            available[0] = self.publisher.RESERVE
            return install(*args)

        with mock.patch.object(self.publisher.os, 'statvfs', side_effect=statvfs):
            with mock.patch.object(self.publisher, 'install_atomic', side_effect=consume_before_install):
                with self.assertRaisesRegex(ValueError, 'STATIC_STORE_WRITE_RESERVE_REQUIRED'):
                    self.publisher.publish(self.new, self.base, apply=True)
            head = self.publisher.load_head(self.base)
            self.assertEqual(head['pending']['release'], self.new.name)
            self.assertEqual(head['receipts'], [])
            self.assertFalse((self.store / self.url(self.new).lstrip('/')).exists())
            with self.assertRaisesRegex(ValueError, 'STATIC_PUBLISH_INCOMPLETE'):
                self.publisher.verify_coverage(self.new, self.base)
            available[0] = 20 * 1024 ** 3
            restored = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(restored['status'], 'published')
        self.assertEqual(restored['new_files'], 1)
        self.assertIsNone(self.publisher.load_head(self.base)['pending'])
        self.assertEqual((self.base / 'current').resolve(), self.old)

    def test_space_drop_after_receipt_keeps_pending_until_a_successful_retry(self):
        available = [20 * 1024 ** 3]
        statvfs = lambda path: mock.Mock(f_frsize=4096, f_bsize=4096, f_bavail=available[0] // 4096)
        install = self.publisher.install_atomic

        def consume_after_receipt(destination, *args):
            install(destination, *args)
            if destination.parent.name == self.publisher.REGISTRY:
                available[0] = self.publisher.RESERVE - 4096

        with mock.patch.object(self.publisher.os, 'statvfs', side_effect=statvfs):
            with mock.patch.object(self.publisher, 'install_atomic', side_effect=consume_after_receipt):
                with self.assertRaisesRegex(ValueError, 'STATIC_STORE_RESERVE_REQUIRED'):
                    self.publisher.publish(self.new, self.base, apply=True)
            self.assertIsNotNone(self.publisher.load_head(self.base)['pending'])
            self.assertEqual(len(list((self.store / '.registry').glob('*.json'))), 1)
            with self.assertRaisesRegex(ValueError, 'STATIC_PUBLISH_INCOMPLETE'):
                self.publisher.verify_coverage(self.new, self.base)
            available[0] = 20 * 1024 ** 3
            restored = self.publisher.publish(self.new, self.base, apply=True)
        self.assertEqual(restored['status'], 'published')
        self.assertEqual(restored['new_files'], 0)
        self.assertIsNone(self.publisher.load_head(self.base)['pending'])


if __name__ == '__main__':
    unittest.main()

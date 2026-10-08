"""Offline filesystem/package regression tests; no remote, installer or service."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mock_release_views_test', HERE / 'release_views.py')
views = importlib.util.module_from_spec(spec)
spec.loader.exec_module(views)


class ReleaseViewsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.old, self.new = self.root / 'old', self.root / 'new'
        self.old.mkdir()
        self.new.mkdir()
        self.shared = {
            'platform/dist/art/font.woff2': b'font',
            'platform/public/sdk/api.mjs': b'sdk',
            'platform/specs/examples/partner-host/public/style.css': b'partner',
            'platform/legacy/dist/bundles/runtime-a.js': b'legacy',
        }
        self.old_files = {**self.shared, 'platform/dist/index.html': b'old HTML', 'platform/server/index.mjs': b'old server',
                          'platform/arena/dist/assets/old-a.js': b'old JS', 'src/.DS_Store': b'metadata'}
        self.new_files = {**self.shared, 'platform/dist/index.html': b'new HTML', 'platform/server/index.mjs': b'new server',
                          'platform/arena/dist/assets/new-b.js': b'new JS'}
        for index, name in enumerate(views.MUTABLE):
            self.old_files[name] = ('old mutable ' + str(index)).encode()
            self.new_files[name] = ('new mutable ' + str(index)).encode()
        self.old_sha = self.tree(self.old, self.old_files)
        self.new_sha = self.tree(self.new, self.new_files)
        self.extra = 'platform/arena/dist/assets/retained-extra.js'
        self.cache = 'platform/deploy/mock-sandbox/__pycache__/install.cpython-310.pyc'
        self.put(self.old / self.extra, b'extra old JS')
        self.put(self.old / self.cache, b'cache')
        self.inv = self.inventory()

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(0o644)
        os.utime(path, ns=(views.FIXED_MTIME_NS,) * 2)

    def tree(self, root, files):
        for name, body in files.items():
            self.put(root / name, body)
        raw = views.encoded({name: views.sha(body) for name, body in files.items()})
        self.put(root / views.MANIFEST, raw)
        return views.sha(raw)

    def inventory(self, *, caches=True):
        actual = views.scan_tree(self.old)
        return views.encoded({'schema': views.INVENTORY_SCHEMA, 'manifest_sha256': self.old_sha,
                              'files': actual['files'], 'directories': actual['directories'],
                              'excluded_caches': {self.cache: actual['files'][self.cache]} if caches else {}})

    def args(self, output=None):
        return dict(old_root=self.old, new_root=self.new, old_manifest_sha256=self.old_sha,
                    new_manifest_sha256=self.new_sha, old_inventory=self.inv,
                    publication_epoch=views.FIXED_MTIME_NS // 1000000000 + 2,
                    old_inventory_sha256=views.sha(self.inv), output=output or self.root / 'result')

    def build(self, output=None):
        return views.build_views(**self.args(output))

    def assert_fail_clean(self, code=None):
        with self.assertRaisesRegex(ValueError, code or '.'):
            self.build()
        self.assertFalse((self.root / 'result').exists())

    def test_forward_rollback_preserve_source_business_and_cover_all_static(self):
        old_before, new_before = views.scan_tree(self.old), views.scan_tree(self.new)
        result = self.build()
        a, b = self.root / 'result/forward', self.root / 'result/rollback'
        self.assertEqual((a / 'platform/server/index.mjs').read_bytes(), b'new server')
        self.assertEqual((b / 'platform/server/index.mjs').read_bytes(), b'old server')
        self.assertEqual((a / 'platform/dist/index.html').read_bytes(), b'new HTML')
        self.assertEqual((b / 'platform/dist/index.html').read_bytes(), b'old HTML')
        sa, sb = views.scan_tree(a), views.scan_tree(b)
        static = lambda s: {n: v['sha256'] for n, v in s['files'].items() if views.is_static(n)}
        self.assertEqual(static(sa), static(sb))
        self.assertIn(self.extra, sa['files'])
        for name in views.MUTABLE:
            versioned = 'platform/dist/mock-releases/' + self.new_sha + '/' + name.removeprefix('platform/dist/')
            for output in (a, b):
                self.assertEqual((output / name).read_bytes(), self.old_files[name])
                self.assertEqual((output / versioned).read_bytes(), self.new_files[name])
        self.assertEqual(old_before, views.scan_tree(self.old))
        self.assertEqual(new_before, views.scan_tree(self.new))
        self.assertTrue(result['static_coverage_equal'])

    def test_complete_new_manifest_and_truthful_source_receipt_cover_every_body(self):
        result = self.build()
        for role in ('forward', 'rollback'):
            root = self.root / 'result' / role
            actual = views.scan_tree(root)
            manifest = json.loads((root / views.MANIFEST).read_bytes())
            self.assertEqual(set(manifest), set(actual['files']) - {views.MANIFEST})
            self.assertTrue(all(actual['files'][p]['sha256'] == h for p, h in manifest.items()))
            receipt = json.loads((root / views.RECEIPT).read_bytes())
            self.assertTrue(receipt['derived_view'])
            self.assertFalse(receipt['original_release_identity'])
            self.assertEqual(receipt['source_manifests'], {'old': self.old_sha, 'new': self.new_sha})
            self.assertNotIn(result['views'][role]['manifest_sha256'], (self.old_sha, self.new_sha))
            self.assertFalse(receipt['dependencies']['copied'])
            self.assertTrue(receipt['dependencies']['external_validation_and_install_required'])
            self.assertEqual(set(receipt['files']) | {views.RECEIPT}, set(manifest))

    def test_explicit_cache_and_single_historical_metadata_exclusion_recorded(self):
        self.build()
        for role in ('forward', 'rollback'):
            root = self.root / 'result' / role
            receipt = json.loads((root / views.RECEIPT).read_bytes())
            self.assertEqual(receipt['excluded_caches'][self.cache]['sha256'], views.sha(b'cache'))
            self.assertEqual(receipt['excluded_source_metadata']['src/.DS_Store']['sha256'], views.sha(b'metadata'))
            self.assertFalse((root / self.cache).exists())
            self.assertFalse((root / 'src/.DS_Store').exists())
            self.assertFalse((root / 'platform/deploy/mock-sandbox/__pycache__').exists())

    def test_reproducible_bytes_modes_mtimes_and_no_hardlinks(self):
        self.build(self.root / 'one')
        self.build(self.root / 'two')
        a, b = views.scan_tree(self.root / 'one'), views.scan_tree(self.root / 'two')
        self.assertEqual(a['files'], b['files'])
        self.assertEqual(a['directories'], b['directories'])
        seen = set()
        for source in (self.root / 'one', self.root / 'two'):
            for path in source.rglob('*'):
                role = path.relative_to(source).parts[0]
                expected = (self.args()['publication_epoch'] + (role == 'rollback')) * 1000000000
                self.assertEqual(path.stat().st_mtime_ns, expected)
                if path.is_file():
                    self.assertEqual(path.stat().st_nlink, 1)
                    identity = path.stat().st_dev, path.stat().st_ino
                    self.assertNotIn(identity, seen)
                    seen.add(identity)

    def test_changed_same_size_html_has_increasing_publication_seconds_in_both_directions(self):
        self.build()
        paths = [self.old / 'platform/dist/index.html',
                 self.root / 'result/forward/platform/dist/index.html',
                 self.root / 'result/rollback/platform/dist/index.html']
        self.assertEqual(len({p.stat().st_size for p in paths}), 1)
        self.assertEqual([p.read_bytes() for p in paths], [b'old HTML', b'new HTML', b'old HTML'])
        seconds = [p.stat().st_mtime_ns // 1000000000 for p in paths]
        self.assertTrue(seconds[0] < seconds[1] < seconds[2])
        for role, timestamp in zip(('forward', 'rollback'), seconds[1:]):
            receipt = json.loads((self.root / 'result' / role / views.RECEIPT).read_bytes())
            self.assertEqual(receipt['output_mtime_ns'], timestamp * 1000000000)
            self.assertEqual(receipt['publication_epoch'], seconds[1])

    def test_publication_epoch_must_be_explicit_integral_and_newer_than_source(self):
        for epoch in [True, 1.5, -1, 2147483646, views.FIXED_MTIME_NS // 1000000000]:
            with self.subTest(epoch=epoch), self.assertRaises(ValueError):
                views.build_views(**{**self.args(), 'publication_epoch': epoch})
            self.assertFalse((self.root / 'result').exists())

    def test_missing_declared_resource_and_missing_extra_both_refuse(self):
        path = self.old / self.extra
        path.unlink()
        self.assert_fail_clean('INVENTORY_MISMATCH')
        self.put(path, b'extra old JS')
        (self.new / 'platform/arena/dist/assets/new-b.js').unlink()
        self.assert_fail_clean('DECLARED_SOURCE_MISSING')

    def test_all_five_static_prefix_conflicts_are_refused(self):
        for name in self.shared:
            original = self.new_files[name]
            self.new_files[name] = b'changed under same URL'
            self.new_sha = self.tree(self.new, self.new_files)
            self.assert_fail_clean('UNCLASSIFIED_STATIC_CONFLICT')
            self.new_files[name] = original
        self.new_sha = self.tree(self.new, self.new_files)

    def test_new_or_old_undeclared_extra_refused_even_if_regular(self):
        self.put(self.new / 'unlisted', b'x')
        self.assert_fail_clean('NEW_SOURCE_UNDECLARED_EXTRAS')
        (self.new / 'unlisted').unlink()
        self.put(self.old / 'unlisted', b'x')
        self.assert_fail_clean('INVENTORY_MISMATCH')
        self.inv = self.inventory()
        self.assert_fail_clean('UNCLASSIFIED_OLD_EXTRA')

    def test_unknown_empty_directory_requires_inventory(self):
        (self.old / 'not-counted').mkdir()
        self.assert_fail_clean('INVENTORY_MISMATCH')
        (self.old / 'not-counted').rmdir()
        (self.new / 'not-counted').mkdir()
        self.assert_fail_clean('UNDECLARED_DIRECTORY')

    def test_symlink_file_directory_and_hardlink_refuse(self):
        target = self.old / self.extra
        for kind in ('file', 'directory', 'hardlink'):
            p = self.old / 'bad'
            if kind == 'hardlink':
                os.link(target, p)
            else:
                p.symlink_to(target if kind == 'file' else self.old / 'platform', target_is_directory=kind == 'directory')
            self.assert_fail_clean('SYMLINK|NOT_SINGLE_REGULAR_FILE')
            p.unlink()

    def test_source_path_component_symlink_refused(self):
        link = self.root / 'old-link'
        link.symlink_to(self.old, target_is_directory=True)
        args = self.args()
        args['old_root'] = link
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            views.build_views(**args)

    def test_fifo_and_file_directory_collisions_refuse(self):
        path = self.old / 'fifo'
        os.mkfifo(path)
        self.assert_fail_clean('NOT_SINGLE_REGULAR_FILE')
        path.unlink()
        target = self.new / 'platform/arena/dist/assets/new-b.js'
        target.unlink()
        target.mkdir()
        self.assert_fail_clean('DECLARED_SOURCE_MISSING')

    def test_cache_exclusion_requires_exact_unmanifested_pyc_inventory(self):
        for change in ('no_declaration', 'noncache', 'wrong_hash', 'manifested'):
            inv = json.loads(self.inventory())
            if change == 'no_declaration':
                inv['excluded_caches'] = {}
            elif change == 'noncache':
                inv['excluded_caches'] = {self.extra: inv['files'][self.extra]}
            elif change == 'wrong_hash':
                inv['excluded_caches'][self.cache]['sha256'] = '0' * 64
            else:
                self.old_files[self.cache] = b'cache'
                self.old_sha = self.tree(self.old, self.old_files)
                inv = json.loads(self.inventory())
            self.inv = views.encoded(inv)
            self.assert_fail_clean()

    def test_source_manifest_inventory_and_inventory_digest_binding(self):
        for key, value in [('old_manifest_sha256', '0' * 64), ('new_manifest_sha256', '0' * 64),
                           ('old_inventory_sha256', '0' * 64)]:
            args = self.args()
            args[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                views.build_views(**args)
        raw = (self.old / views.MANIFEST).read_bytes()
        (self.old / views.MANIFEST).write_bytes(raw + b' ')
        self.assert_fail_clean('SOURCE_MANIFEST_SHA_MISMATCH')

    def test_paths_duplicate_json_and_reserved_derived_receipt_refuse(self):
        for name in ('../x', '/x', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\x00b', 'node_modules/x'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                views.safe_name(name)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_JSON_KEY'):
            views.json_value(b'{"x":1,"x":2}')
        self.new_files[views.RECEIPT] = b'prior receipt'
        self.new_sha = self.tree(self.new, self.new_files)
        self.assert_fail_clean('RESERVED_SOURCE_BODY')

    def test_versioned_path_collision_rejects_existing_not_overwrites(self):
        # Construct a plan directly because a manifest hash is content-addressed.
        inv = views.validate_inventory(self.inv, views.sha(self.inv), self.old_sha)
        old = views.verify_source(self.old, self.old_sha, inventory=inv)
        new = views.verify_source(self.new, self.new_sha)
        name = 'platform/dist/mock-releases/' + self.new_sha + '/downloads/android-smoke-build.json'
        new['observed']['files'][name] = {'sha256': views.sha(b'x'), 'bytes': 1, 'mode': 0o644}
        with self.assertRaisesRegex(ValueError, 'VERSIONED_PATH_ALREADY_EXISTS'):
            views.make_plan(old, new, self.new_sha)

    def test_existing_output_and_source_overlap_are_never_modified(self):
        target = self.root / 'result'
        target.mkdir()
        self.put(target / 'mine', b'preserve')
        self.assertEqual((target / 'mine').read_bytes(), b'preserve')
        with self.assertRaisesRegex(ValueError, 'OUTPUT_EXISTS'):
            self.build()
        self.assertEqual((target / 'mine').read_bytes(), b'preserve')
        for output in (self.old / 'derived', self.root):
            with self.assertRaisesRegex(ValueError, 'OUTPUT_OVERLAPS_SOURCE'):
                self.build(output)

    def test_source_mutation_mid_build_refuses_and_removes_only_owned_output(self):
        real = views.copy_body
        changed = False
        def mutate(*args):
            nonlocal changed
            if not changed:
                changed = True
                (self.old / self.cache).write_bytes(b'changed cache')
            return real(*args)
        with patch.object(views, 'copy_body', side_effect=mutate):
            self.assert_fail_clean('SOURCE_CHANGED_DURING_BUILD')
        self.assertTrue(self.old.exists() and self.new.exists())

    def test_final_output_stays_absent_until_both_views_are_verified(self):
        real = views.copy_body
        output = self.root / 'result'
        observed = []
        def observe(*args):
            self.assertFalse(output.exists())
            staging = list(self.root.glob('.result.mock-view-staging-*'))
            self.assertEqual(len(staging), 1)
            self.assertEqual(stat.S_IMODE(staging[0].stat().st_mode), 0o700)
            observed.append(args[1])
            return real(*args)
        with patch.object(views, 'copy_body', side_effect=observe):
            self.build()
        self.assertTrue(observed)
        self.assertTrue((output / 'forward' / views.MANIFEST).is_file())
        self.assertTrue((output / 'rollback' / views.MANIFEST).is_file())
        self.assertFalse(list(self.root.glob('.result.mock-view-staging-*')))

    def test_destination_appearing_during_build_is_not_overwritten(self):
        real = views.copy_body
        output = self.root / 'result'
        created = False
        def create_destination(*args):
            nonlocal created
            if not created:
                output.mkdir()
                self.put(output / 'keep', b'other owner')
                created = True
            return real(*args)
        with patch.object(views, 'copy_body', side_effect=create_destination):
            with self.assertRaisesRegex(ValueError, 'OUTPUT_APPEARED_DURING_BUILD'):
                self.build()
        self.assertEqual((output / 'keep').read_bytes(), b'other owner')
        self.assertFalse(list(self.root.glob('.result.mock-view-staging-*')))

    def test_pyc_outside_explicit_old_cache_is_never_a_view_body(self):
        name = 'platform/dist/legacy.pyc'
        self.new_files[name] = b'cache disguised as static body'
        self.new_sha = self.tree(self.new, self.new_files)
        self.assert_fail_clean('MANIFESTED_CACHE_FORBIDDEN')
        (self.new / name).unlink()
        del self.new_files[name]
        self.new_sha = self.tree(self.new, self.new_files)
        self.put(self.old / name, b'old extra bytecode')
        self.inv = self.inventory()
        self.assert_fail_clean('UNCLASSIFIED_OLD_EXTRA')

    def test_source_body_replaced_between_scan_and_copy_refused(self):
        real = views.copy_body
        changed = False
        def mutate(source, *args):
            nonlocal changed
            if not changed:
                changed = True
                source.write_bytes(b'not the authenticated body')
            return real(source, *args)
        with patch.object(views, 'copy_body', side_effect=mutate):
            self.assert_fail_clean('SOURCE_CHANGED_BEFORE_COPY')

    def test_dependencies_are_not_read_copied_or_claimed_verified(self):
        dependency = self.old / 'platform/node_modules'
        dependency.mkdir()
        (dependency / 'outside-link').symlink_to('/definitely/not/read')
        self.put(dependency / 'body', b'not copied')
        result = self.build()
        for role in result['views']:
            root = self.root / 'result' / role
            self.assertFalse((root / 'platform/node_modules').exists())
            receipt = json.loads((root / views.RECEIPT).read_bytes())
            self.assertEqual(receipt['dependencies']['observed_excluded_roots']['old'], ['platform/node_modules'])
            self.assertFalse(receipt['dependencies']['verified'])

    def test_only_exact_platform_dependency_root_is_excludable(self):
        for root, name in ((self.old, 'node_modules'), (self.new, 'platform/dist/node_modules'),
                           (self.new, 'platform/server/node_modules')):
            folder = root / name
            folder.mkdir()
            self.put(folder / 'hidden.js', b'cannot evade manifest checks')
            self.assert_fail_clean('UNREVIEWED_DEPENDENCY_ROOT')
            (folder / 'hidden.js').unlink()
            folder.rmdir()

    def test_only_exact_old_declared_ds_store_is_excludable(self):
        self.new_files['other/.DS_Store'] = b'bad metadata'
        self.new_sha = self.tree(self.new, self.new_files)
        self.assert_fail_clean('UNCLASSIFIED_SOURCE_METADATA')

    def archive(self, *, edit=None, extra=(), trailing=b''):
        raw = views.encoded({name: views.sha(body) for name, body in self.new_files.items()})
        entries = [(name, body) for name, body in self.new_files.items()] + [(views.MANIFEST, raw)] + list(extra)
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:') as package:
            for index, (name, body) in enumerate(entries):
                info = tarfile.TarInfo(name)
                info.size = len(body)
                info.mode = 0o644
                if edit is not None:
                    edit(info, index)
                package.addfile(info, io.BytesIO(body) if info.isfile() else None)
        path = self.root / 'source.tar'
        path.write_bytes(stream.getvalue() + trailing)
        return path, views.sha(raw)

    def unpack(self, path, manifest_sha):
        return views.unpack_release(path, expected_archive_sha256=views.sha(path.read_bytes()),
                                    expected_manifest_sha256=manifest_sha, output=self.root / 'unpacked')

    def test_complete_archive_reader_verifies_all_bodies(self):
        path, manifest = self.archive()
        result = self.unpack(path, manifest)
        self.assertEqual(result['files'], len(self.new_files))
        self.assertEqual(views.scan_tree(self.root / 'unpacked')['files'], views.scan_tree(self.new)['files'])

    def test_archive_link_directory_duplicate_and_dangerous_path_refuse(self):
        for kind in ('link', 'directory', 'duplicate', 'traversal'):
            def edit(info, index):
                if index == 0 and kind == 'link':
                    info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
                elif index == 0 and kind == 'directory':
                    info.type = tarfile.DIRTYPE
                elif index == 0 and kind == 'traversal':
                    info.name = '../escaped'
            path, manifest = self.archive(edit=edit, extra=[(views.MANIFEST, b'bad')] if kind == 'duplicate' else [])
            with self.subTest(kind=kind), self.assertRaises((ValueError, tarfile.TarError)):
                self.unpack(path, manifest)
            self.assertFalse((self.root / 'unpacked').exists())
        self.assertFalse((self.root / 'escaped').exists())

    def test_archive_undeclared_trailing_and_wrong_digest_refuse(self):
        for extra, trailing in (([('extra', b'x')], b''), ([], b'not tar padding')):
            path, manifest = self.archive(extra=extra, trailing=trailing)
            with self.assertRaises(ValueError):
                self.unpack(path, manifest)
            self.assertFalse((self.root / 'unpacked').exists())
        path, manifest = self.archive()
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_SHA_MISMATCH'):
            views.unpack_release(path, expected_archive_sha256='0' * 64, expected_manifest_sha256=manifest, output=self.root / 'unpacked')
        self.assertFalse((self.root / 'unpacked').exists())


if __name__ == '__main__':
    unittest.main()

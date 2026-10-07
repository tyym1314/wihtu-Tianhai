import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from release_build import (MAX_RETAINED_BYTES, RETAINED_LOCK, load_retained_lock,
                           materialize_retained_assets, record, verify, verify_retained_assets)


def sha(content):
    return hashlib.sha256(content).hexdigest()


def asset(name, content=b'export default 1;', **extra):
    path = 'platform/arena/dist/assets/' + name
    return {'path': path, 'publicPath': '/arena/assets/' + name, 'sha256': sha(content),
            'bytes': len(content), 'contentType': 'application/javascript',
            'sources': [{'release': '20261007-04', 'manifest_sha256': 'a' * 64}],
            'dependencies': [], **extra}


class RetainedAssetTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.contents = b'export default 1;'
        self.asset = asset('Old-12345678.js', self.contents)
        self.lock = {'schema': 'oasis-retained-static-v1',
                     'bundle': {'url': 'https://example.com/retained.tar.gz', 'bytes': 1, 'sha256': 'b' * 64},
                     'assets': [self.asset]}
        (self.root / 'platform').mkdir()
        self.write_lock()

    def write_lock(self):
        (self.root / RETAINED_LOCK).write_text(json.dumps(self.lock))

    def write_asset(self, entry=None, contents=None):
        entry = self.asset if entry is None else entry
        path = self.root / entry['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.contents if contents is None else contents)
        return path

    def bundle(self, members=None, format=tarfile.USTAR_FORMAT):
        if members is None:
            members = [(self.asset['path'], self.contents)]
        archive = self.root / 'retained.tar.gz'
        with tarfile.open(archive, 'w:gz', format=format) as tar:
            for name, contents in members:
                info = tarfile.TarInfo(name) if isinstance(name, str) else name
                if info.isfile():
                    info.size = len(contents)
                    tar.addfile(info, io.BytesIO(contents))
                else:
                    tar.addfile(info)
        self.lock['bundle'].update(bytes=archive.stat().st_size, sha256=sha(archive.read_bytes()))
        self.write_lock()
        return archive

    def test_verified_bundle_materializes_and_reuses_exact_existing_bytes(self):
        archive = self.bundle()
        self.assertEqual(materialize_retained_assets(self.root, archive)['materialized'], 1)
        self.assertEqual(materialize_retained_assets(self.root, archive)['materialized'], 0)
        verify_retained_assets(self.root)

    def test_necessary_directory_entry_is_allowed(self):
        directory = tarfile.TarInfo('platform/arena/dist/assets/')
        directory.type = tarfile.DIRTYPE
        archive = self.bundle([(directory, b''), (self.asset['path'], self.contents)])
        materialize_retained_assets(self.root, archive)

    def test_missing_or_modified_asset_fails_even_if_new_stamp_is_requested(self):
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_MISSING'):
            record(self.root)
        self.write_asset(contents=b'different bytes')
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_HASH_MISMATCH'):
            record(self.root)

    def test_lock_is_required(self):
        (self.root / RETAINED_LOCK).unlink()
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_MISSING'):
            load_retained_lock(self.root)

    def test_asset_paths_are_limited_to_reviewed_static_namespaces(self):
        for name in ('platform/arena/dist/assets/../x-12345678.js', '/etc/key-12345678.js',
                     'platform/arena/dist/index.html', 'platform/dist/downloads/file-12345678.js',
                     'platform/dist/assets/file-12345678.js.map', 'platform/dist/assets/.env',
                     'platform/dist/assets/x\\y-12345678.js'):
            with self.subTest(path=name):
                self.asset['path'] = name
                self.write_lock()
                with self.assertRaises(ValueError):
                    load_retained_lock(self.root)

    def test_bundle_requires_fixed_https_without_auth_or_redirect_metadata(self):
        for url in ('http://example.com/retained.tar.gz', 'https://x:y@example.com/retained.tar.gz',
                    'https://example.com/retained.tar.gz?token=private',
                    'https://example.com:8443/retained.tar.gz', 'file:///tmp/retained.tar.gz'):
            with self.subTest(url=url):
                self.lock['bundle']['url'] = url
                self.write_lock()
                with self.assertRaisesRegex(ValueError, 'RETAINED_BUNDLE_HTTPS_REQUIRED'):
                    load_retained_lock(self.root)

    def test_size_and_duplicate_paths_are_rejected(self):
        self.lock['bundle']['bytes'] = MAX_RETAINED_BYTES + 1
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'INVALID_RETAINED_BUNDLE_SIZE'):
            load_retained_lock(self.root)
        self.lock['bundle']['bytes'] = 1
        self.lock['assets'].append(copy.deepcopy(self.asset))
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_RETAINED_ASSET'):
            load_retained_lock(self.root)

    def test_unfingerprinted_asset_requires_reachable_dependency_role(self):
        model = asset('pvp/run/fox.glb', b'glb', contentType='model/gltf-binary', role='dependency')
        self.lock['assets'].append(model)
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'UNREACHABLE_RETAINED_DEPENDENCY'):
            load_retained_lock(self.root)
        self.asset['dependencies'].append(model['publicPath'])
        self.write_lock()
        load_retained_lock(self.root)
        del model['role']
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'RETAINED_ROOT_NOT_FINGERPRINTED'):
            load_retained_lock(self.root)

    def test_dependency_graph_must_be_closed_and_orphan_cycles_are_rejected(self):
        self.asset['dependencies'] = ['/arena/assets/Missing-abcdefgh.js']
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'RETAINED_DEPENDENCY_MISSING'):
            load_retained_lock(self.root)
        self.asset['dependencies'] = []
        a = asset('first.js', role='dependency', dependencies=['/arena/assets/second.js'])
        b = asset('second.js', role='dependency', dependencies=['/arena/assets/first.js'])
        self.lock['assets'].extend([a, b])
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'UNREACHABLE_RETAINED_DEPENDENCY'):
            load_retained_lock(self.root)

    def test_whole_archive_checked_before_any_materialization(self):
        second = asset('Later-abcdefgh.js')
        self.lock['assets'].append(second)
        archive = self.bundle([(self.asset['path'], self.contents), (second['path'], b'corrupt')])
        with self.assertRaisesRegex(ValueError, 'RETAINED_ARCHIVE_MANIFEST_MISMATCH'):
            materialize_retained_assets(self.root, archive)
        self.assertFalse((self.root / self.asset['path']).exists())

    def test_root_mark_and_preview_images_are_only_allowed_as_explicit_dependencies(self):
        for name, mime in (('mark.svg', 'image/svg+xml'), ('previews/run.png', 'image/png'),
                           ('previews/run.webm', 'video/webm')):
            entry = asset(name, b'image', role='dependency', contentType=mime)
            entry.update(path='platform/dist/' + name, publicPath='/' + name)
            self.lock['assets'].append(entry)
            self.asset['dependencies'].append(entry['publicPath'])
        self.write_lock()
        load_retained_lock(self.root)
        self.lock['assets'][-1]['role'] = 'fingerprint'
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'RETAINED_ROOT_RESOURCE_REQUIRES_DEPENDENCY_ROLE'):
            load_retained_lock(self.root)
        self.lock['assets'][-1].update(path='platform/dist/other.png', publicPath='/other.png', role='dependency')
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'INVALID_RETAINED_NAMESPACE'):
            load_retained_lock(self.root)

    def test_preview_motion_requires_video_webm_mime_and_explicit_reachable_dependency(self):
        motion = asset('previews/run.webm', b'video', role='dependency', contentType='video/webm')
        motion.update(path='platform/dist/previews/run.webm', publicPath='/previews/run.webm')
        self.lock['assets'].append(motion)
        self.asset['dependencies'].append(motion['publicPath'])
        archive = self.bundle([(self.asset['path'], self.contents), (motion['path'], b'video')])
        materialize_retained_assets(self.root, archive)
        self.assertEqual((self.root / motion['path']).read_bytes(), b'video')
        motion['contentType'] = 'image/png'
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'INVALID_RETAINED_CONTENT_TYPE'):
            load_retained_lock(self.root)
        motion.update(path='platform/arena/dist/assets/run.webm', publicPath='/arena/assets/run.webm', contentType='video/webm')
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'INVALID_RETAINED_EXTENSION'):
            load_retained_lock(self.root)
        motion.update(path='platform/dist/previews/run.mp4', publicPath='/previews/run.mp4', contentType='video/mp4')
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'INVALID_RETAINED_NAMESPACE'):
            load_retained_lock(self.root)

    def test_different_existing_bytes_are_never_overwritten(self):
        archive = self.bundle()
        destination = self.write_asset(contents=b'current incompatible build')
        with self.assertRaisesRegex(ValueError, 'RETAINED_DESTINATION_CONFLICT'):
            materialize_retained_assets(self.root, archive)
        self.assertEqual(destination.read_bytes(), b'current incompatible build')

    def test_digest_tampering_duplicate_and_extra_archive_members_fail(self):
        archive = self.bundle()
        archive.write_bytes(archive.read_bytes() + b'x')
        with self.assertRaisesRegex(ValueError, 'RETAINED_BUNDLE_HASH_MISMATCH'):
            materialize_retained_assets(self.root, archive)
        for members in (
                [(self.asset['path'], self.contents), (self.asset['path'], self.contents)],
                [(self.asset['path'], self.contents), ('platform/arena/dist/assets/Extra-abcdefgh.js', b'x')],
                [('../outside.js', b'x')]):
            with self.subTest(members=members):
                archive = self.bundle(members)
                with self.assertRaises(ValueError):
                    materialize_retained_assets(self.root, archive)
        self.assertFalse((self.root / self.asset['path']).exists())

    def test_symlinks_and_hardlinks_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            entry = tarfile.TarInfo(self.asset['path'])
            entry.type, entry.linkname = kind, '/tmp/foreign'
            archive = self.bundle([(entry, b'')])
            with self.assertRaisesRegex(ValueError, 'RETAINED_USTAR_REQUIRED'):
                materialize_retained_assets(self.root, archive)

    def test_pax_and_gnu_extended_records_are_rejected(self):
        entry = tarfile.TarInfo(self.asset['path'])
        entry.pax_headers = {'comment': 'extension is not allowed'}
        archive = self.bundle([(entry, self.contents)], format=tarfile.PAX_FORMAT)
        with self.assertRaisesRegex(ValueError, 'RETAINED_USTAR_REQUIRED'):
            materialize_retained_assets(self.root, archive)
        archive = self.bundle(format=tarfile.GNU_FORMAT)
        with self.assertRaisesRegex(ValueError, 'RETAINED_USTAR_REQUIRED'):
            materialize_retained_assets(self.root, archive)

    def test_symlink_destination_or_parent_cannot_escape_dist(self):
        archive = self.bundle()
        outside = self.root / 'outside'
        outside.mkdir()
        parent = self.root / 'platform/arena/dist/assets'
        parent.parent.mkdir(parents=True)
        parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RETAINED_PATH'):
            materialize_retained_assets(self.root, archive)
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

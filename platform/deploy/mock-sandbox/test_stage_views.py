"""Owned temporary filesystem only; no /opt, locks, SQL, services or network."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load('stage_views_test', HERE / 'stage_views.py')
v = load('stage_builder_helpers', HERE / 'release_views.py')


class StageTests(unittest.TestCase):
    def test_load_inputs_reads_actual_derived_metadata_and_source_validator_stays_strict(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            roots, item = self.sources(root)
            source_manifests = {}
            for kind, path in roots.items():
                body = 'platform/dist/' + kind + '.txt'
                raw = json.dumps({body: m.sha((path / body).read_bytes())}).encode()
                (path / v.MANIFEST).write_bytes(raw)
                source_manifests[kind] = m.sha(raw)
                for file in path.rglob('*'):
                    if file.is_file() and not file.is_symlink():
                        os.utime(file, ns=(1000000000, 1000000000))
            capsule = root / 'capsule'
            capsule.mkdir()
            module = types.SimpleNamespace(SOURCE_NEW='new', SOURCE_NEW_MANIFEST=source_manifests['new'],
                INSTALLED_DEPS={'entries':5,'sha256':'separately-tested'}, RECEIPTS={},
                ROLES={'origin':('old',source_manifests['old'])}, time=time,
                validate_publication=load('stage_runtime_publication', HERE / 'view_runtime.py').validate_publication)
            for role in m.ROLES:
                target = capsule / role
                target.mkdir()
                receipt = {**item['receipt'], 'role':role, 'source_manifests':source_manifests,
                           'publication_epoch':100, 'output_mtime_ns':(100+(role=='rollback'))*1000000000}
                raw_receipt = json.dumps(receipt).encode()
                manifest = {**item['manifest'], v.RECEIPT:m.sha(raw_receipt)}
                raw_manifest = json.dumps(manifest).encode()
                (target/v.RECEIPT).write_bytes(raw_receipt)
                (target/v.MANIFEST).write_bytes(raw_manifest)
                module.ROLES[role]=(role,m.sha(raw_manifest))
                module.RECEIPTS[role]=m.sha(raw_receipt)
                with self.assertRaisesRegex(ValueError, 'RESERVED_SOURCE_BODY'):
                    v.validate_manifest(raw_manifest, m.sha(raw_manifest))
            adapter = types.SimpleNamespace(views=v, _inventory=lambda:None,
                _source_new=lambda:(v.validate_manifest((roots['new']/v.MANIFEST).read_bytes(),source_manifests['new']),v.scan_tree(roots['new'])),
                releases={'origin':roots['old'],'forward':root/'absent16','rollback':root/'absent17'},
                installed_dependencies=Mock(return_value=module.INSTALLED_DEPS))
            with patch.object(m, 'trusted_path'):
                loaded, _ = m.load_inputs(module, adapter, capsule)
            self.assertEqual(set(loaded),set(m.ROLES))
            for role in m.ROLES:
                self.assertEqual(loaded[role]['raw_manifest'],(capsule/role/v.MANIFEST).read_bytes())
                self.assertEqual(loaded[role]['raw_receipt'],(capsule/role/v.RECEIPT).read_bytes())

    def test_derived_manifest_rejects_self_missing_duplicate_receipt_unsafe_path_or_hash(self):
        good = {'platform/dist/body.txt':'a'*64,v.RECEIPT:'b'*64}
        bad = [{v.MANIFEST:'c'*64,**good}, {'platform/dist/body.txt':'a'*64},
               {**good,'../unsafe':'a'*64}, {**good,'platform/dist/body.txt':'not-a-hash'}]
        for value in bad:
            raw=json.dumps(value).encode()
            with self.assertRaises((RuntimeError,ValueError)):
                m.derived_manifest(v,raw,m.sha(raw))
        duplicate = ('{"'+v.RECEIPT+'":"'+'a'*64+'","'+v.RECEIPT+'":"'+'b'*64+'"}').encode()
        with self.assertRaises(ValueError):
            m.derived_manifest(v,duplicate,m.sha(duplicate))
        raw=json.dumps(good).encode()
        with self.assertRaisesRegex(RuntimeError,'STAGE_DERIVED_MANIFEST_CHANGED'):
            m.derived_manifest(v,raw,'0'*64)

    def test_stage_uses_frozen_inventory_dependency_algorithm_not_legacy_keys(self):
        legacy = Mock(side_effect=AssertionError('legacy root-excluding helper must not run'))
        current = Mock(return_value={'entries': 8338, 'sha256': 'legacy-map'})
        adapter = types.SimpleNamespace(
            views=types.SimpleNamespace(verify_source=Mock(return_value={'observed': {}})),
            _inventory=Mock(return_value={}), _source_new=Mock(return_value=({}, {})),
            releases={'origin': Path('/opt/oasis/releases/20261007-04')},
            installed_dependencies=current, upgrade=types.SimpleNamespace(dependencies=legacy))
        module = types.SimpleNamespace(ROLES={'origin':('20261007-04','fixed')}, SOURCE_NEW='20261008-15',
            INSTALLED_DEPS={'entries': 8339, 'sha256': 'frozen-inventory'})
        with self.assertRaisesRegex(RuntimeError, 'STAGE_SOURCE_DEPENDENCIES_CHANGED'):
            m.load_inputs(module, adapter, Path('/unused-capsule'))
        self.assertEqual(current.call_args_list, [unittest.mock.call(Path('/opt/oasis/releases/20261007-04')),
                                                unittest.mock.call(Path('/opt/oasis/releases/20261008-15'))])
        legacy.assert_not_called()

    def sources(self, root):
        old, new = root / 'old', root / 'new'
        for path in (old, new):
            (path / 'platform/dist').mkdir(parents=True)
        (old / 'platform/dist/old.txt').write_bytes(b'old-byte')
        (new / 'platform/dist/new.txt').write_bytes(b'new-byte')
        deps = old / 'platform/node_modules'
        (deps / 'pkg').mkdir(parents=True)
        (deps / '.bin').mkdir()
        (deps / 'pkg/cli.js').write_bytes(b'program')
        (deps / 'pkg/cli.js').chmod(0o755)
        (deps / '.bin/tool').symlink_to('../pkg/cli.js')
        files = {}
        for source, path in (('old', 'old.txt'), ('new', 'new.txt')):
            name = 'platform/dist/' + path
            data = (dict(old=old, new=new)[source] / name).read_bytes()
            files[name] = dict(source=source, path=name, bytes=len(data), mode=0o644, output_mode=0o644, sha256=m.sha(data))
        receipt = {'files': files, 'output_mtime_ns': 1700000000000000000}
        raw_receipt = json.dumps(receipt).encode()
        manifest = {name: value['sha256'] for name, value in files.items()}
        manifest[v.RECEIPT] = m.sha(raw_receipt)
        item = dict(receipt=receipt, manifest=manifest, raw_receipt=raw_receipt, raw_manifest=json.dumps(manifest).encode())
        return {'old': old, 'new': new}, item

    def test_independent_body_and_dependencies_exact_frozen_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            sources, item = self.sources(root)
            original = {str(path): (path.lstat().st_mtime_ns, path.lstat().st_ino) for source in sources.values() for path in source.rglob('*')}
            target = root / 'new-view'
            m.build_one(types.SimpleNamespace(views=v), item, sources, target)
            self.assertEqual((target / v.MANIFEST).read_bytes(), item['raw_manifest'])
            self.assertEqual((target / v.RECEIPT).read_bytes(), item['raw_receipt'])
            observed = v.scan_tree(target)
            for name, entry in item['receipt']['files'].items():
                self.assertEqual(observed['files'][name], {key: entry[key] for key in ('sha256', 'bytes', 'mode')})
                self.assertNotEqual((target / name).stat().st_ino, (sources[entry['source']] / entry['path']).stat().st_ino)
            stamp = item['receipt']['output_mtime_ns']
            for name in (*observed['files'], *observed['directories']):
                self.assertEqual((target / name).stat().st_mtime_ns, stamp)
            self.assertEqual(target.stat().st_mtime_ns, stamp)
            self.assertEqual(os.readlink(target / 'platform/node_modules/.bin/tool'), '../pkg/cli.js')
            self.assertNotEqual((target / 'platform/node_modules/pkg/cli.js').stat().st_ino,
                                (sources['old'] / 'platform/node_modules/pkg/cli.js').stat().st_ino)
            self.assertEqual(original, {str(path): (path.lstat().st_mtime_ns, path.lstat().st_ino) for source in sources.values() for path in source.rglob('*')})

    def test_copy_refuses_hash_drift_symlink_and_existing_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            source = root / 'source'
            source.write_bytes(b'body')
            entry = dict(mode=0o644, output_mode=0o644, sha256=m.sha(b'wrong'), bytes=4)
            with self.assertRaisesRegex(RuntimeError, 'STAGE_SOURCE_CHANGED_DURING_COPY'):
                m.copy_body(v, source, root / 'partial', entry, 1700000000000000000)
            # Partial owned staging is intentionally preserved, never published.
            self.assertTrue((root / 'partial').exists())
            with self.assertRaisesRegex(RuntimeError, 'STAGE_TARGET_EXISTS'):
                m.copy_body(v, source, root / 'partial', entry, 1700000000000000000)
            link = root / 'link'
            link.symlink_to(source)
            with self.assertRaises(ValueError):
                m.copy_body(v, link, root / 'untouched', entry, 1700000000000000000)
            self.assertFalse((root / 'untouched').exists())

    def test_partial_publish_preserves_first_and_remaining_owned_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            staged = {role: root / ('staged-' + role) for role in m.ROLES}
            finals = {role: root / ('final-' + role) for role in m.ROLES}
            for path in staged.values():
                path.mkdir(); (path / 'body').write_bytes(b'complete')
            observation = {'published': []}
            rename = os.rename
            def failing(source, target):
                if source == staged['rollback']:
                    raise OSError('injected second publication failure')
                rename(source, target)
            adapter = types.SimpleNamespace(upgrade=types.SimpleNamespace(sync_dir=Mock()))
            with patch.object(m.os, 'rename', side_effect=failing):
                with self.assertRaises(OSError):
                    m.publish_pair(adapter, staged, finals, observation)
            self.assertEqual(observation['published'], [str(finals['forward'])])
            self.assertEqual((finals['forward'] / 'body').read_bytes(), b'complete')
            self.assertEqual((staged['rollback'] / 'body').read_bytes(), b'complete')
            self.assertFalse(finals['rollback'].exists())

    def test_any_existing_final_refuses_before_first_rename(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            finals = {role: root / role for role in m.ROLES}
            finals['rollback'].mkdir()
            with patch.object(m.os, 'rename') as rename:
                with self.assertRaisesRegex(RuntimeError, 'STAGE_TARGET_EXISTS'):
                    m.publish_pair(None, {}, finals, {'published': []})
                rename.assert_not_called()

    def test_capacity_fails_before_copy_and_requires_fifteen_percent_plus_backup(self):
        files = {'a': {'bytes': 100}}
        item = {'manifest': {'a': 'sha'}, 'receipt': {'files': files}, 'raw_manifest': b'{}', 'raw_receipt': b'{}'}
        adapter = types.SimpleNamespace(views=types.SimpleNamespace(MANIFEST='manifest', parents=lambda names: []),
            upgrade=types.SimpleNamespace(Runtime=lambda:types.SimpleNamespace(database_size=lambda:1024), mock_private_directory=Mock()))
        usage = types.SimpleNamespace(f_frsize=4096, f_blocks=10000000, f_bavail=1000000)
        with tempfile.TemporaryDirectory() as folder, patch.object(m, 'BASE', Path(folder).resolve()), \
             patch.object(m.os, 'statvfs', return_value=usage), patch.object(m, 'dependency_bound', return_value=1024):
            with self.assertRaisesRegex(RuntimeError, 'STAGE_INSUFFICIENT_CAPACITY'):
                m.budget(adapter, {'forward':item, 'rollback':item}, {'old':Path(folder)})
            usage.f_bavail = 4000000
            value = m.budget(adapter, {'forward':item, 'rollback':item}, {'old':Path(folder)})
            self.assertEqual(value['retained_bytes'], 6144000000)
            self.assertGreater(value['backup_bound_bytes'], 64 * 1024 ** 2)
            self.assertEqual(value['growth_bytes'], 32 * 1024 ** 2)


if __name__ == '__main__':
    unittest.main()

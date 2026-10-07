"""Offline fixtures; test-only pins never reach the CLI or live infrastructure."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('asset_bundle.py')
spec = importlib.util.spec_from_file_location('asset_bundle_test', SOURCE)
bundle = importlib.util.module_from_spec(spec)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), bundle.__dict__)


class BundleTests(unittest.TestCase):
    def setUp(self):
        # macOS /tmp and /var are symlinks; use a real workspace temporary parent.
        self.tmp = tempfile.TemporaryDirectory(prefix='.asset-bundle-test-', dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.assets = {
            'platform/arena/dist/assets/RunGame-Ab_cd-12.js': b'export const run = 42;\n',
            'platform/dist/assets/index-AbCd0123.css': b'body { color: blue; }\n',
        }
        self.bodies = {**self.assets, 'platform/server/index.mjs': b'non-selected but verified\n',
                       **{name: ('new ' + name).encode() for name in bundle.CONFLICTS}}
        self.manifest = {name: bundle.sha(body) for name, body in self.bodies.items()}
        self.sources = {'manifest': bundle.encoded(self.manifest)}
        self.report = {
            'mode': 'check-only', 'old': '/opt/oasis/releases/' + bundle.OLD,
            'new': '/opt/oasis/releases/' + bundle.NEW, 'apply_allowed': False,
            'old_manifest': bundle.PINS['old_manifest'], 'new_manifest': bundle.sha(self.sources['manifest']),
            'blockers': ['forward_assets', 'rollback_assets'],
            'forward_assets': {'checked': 618, 'missing': [], 'changed': sorted(bundle.CONFLICTS), 'compatible': False},
            'rollback_assets': {'checked': 706, 'missing': sorted(self.assets), 'changed': sorted(bundle.CONFLICTS), 'compatible': False},
        }
        self.pins = dict(bundle.PINS)
        self.addCleanup(patch.stopall)
        patch.object(bundle, 'PINS', self.pins).start()
        patch.object(bundle, 'EXPECTED_COUNT', len(self.assets)).start()
        patch.object(bundle, 'EXPECTED_BYTES', sum(map(len, self.assets.values()))).start()
        self.update_evidence()
        self.archive = self.root / 'source.tar.gz'
        self.write_source()

    def update_evidence(self):
        self.sources['check_log'] = (b'CONTROLLER_STDOUT_BEGIN\n' + bundle.encoded(self.report)
                                     + b'\nCONTROLLER_STDOUT_END\n')
        self.sources['check_metadata'] = bundle.encoded({
            'mode': 'one real check-only; no apply/recover', 'ssh_exit_code': 2,
            'log_sha256': bundle.sha(self.sources['check_log'])})
        for key, raw in self.sources.items():
            self.pins[key] = bundle.sha(raw)

    def write_source(self, changes=None, omit=(), extra=(), member_edit=None):
        bodies = {**self.bodies, 'RELEASE-MANIFEST.json': self.sources['manifest'], **(changes or {})}
        with tarfile.open(self.archive, 'w:gz', format=tarfile.PAX_FORMAT) as tar:
            for name, body in list(bodies.items()) + list(extra):
                if name in omit:
                    continue
                info = tarfile.TarInfo(name)
                info.size = len(body)
                info.pax_headers = {'mtime': '123.456'}
                if member_edit:
                    member_edit(info)
                tar.addfile(info, io.BytesIO(body))
        self.pins['archive'] = bundle.sha(self.archive.read_bytes())

    def files(self):
        plan = bundle.make_plan(self.sources, self.assets)
        return {**{bundle.SOURCE_MEMBERS[k]: v for k, v in self.sources.items()},
                'BUNDLE-PLAN.json': bundle.encoded(plan),
                **{'files' + bundle.asset_url(k): v for k, v in self.assets.items()}}

    def compile(self, output=None):
        for key, data in self.sources.items():
            (self.root / key).write_bytes(data)
        return bundle.compile_bundle(self.archive, self.root / 'manifest', self.root / 'check_metadata',
                                     self.root / 'check_log', output or self.root / 'output')

    def test_full_source_compile_and_readonly_check(self):
        report = self.compile()
        self.assertTrue(report['verified'])
        self.assertFalse(report['apply_allowed'])
        self.assertEqual(report['unresolved_conflicts'], 4)
        path = self.root / 'output' / 'bundle.tar'
        def snapshot():
            return {str(p.relative_to(self.root)): (p.stat().st_size, p.stat().st_mtime_ns,
                    bundle.sha(p.read_bytes())) for p in self.root.rglob('*') if p.is_file()}
        before = snapshot()
        with patch.object(Path, 'mkdir', side_effect=AssertionError('write forbidden')), \
                patch.object(Path, 'write_bytes', side_effect=AssertionError('write forbidden')):
            self.assertEqual(bundle.check_bundle(path), report)
        self.assertEqual(snapshot(), before)

    def test_deterministic_bundle_and_exclusive_output(self):
        self.compile(self.root / 'a')
        self.compile(self.root / 'b')
        self.assertEqual((self.root / 'a/bundle.tar').read_bytes(), (self.root / 'b/bundle.tar').read_bytes())
        before = (self.root / 'a/receipt.json').read_bytes()
        with self.assertRaises(FileExistsError):
            self.compile(self.root / 'a')
        self.assertEqual((self.root / 'a/receipt.json').read_bytes(), before)

    def test_manifest_and_evidence_pin_changes_refused(self):
        for key in self.sources:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'SOURCE_PIN_MISMATCH'):
                bundle.validated_sources({**self.sources, key: self.sources[key] + b' '})

    def test_full_archive_pin_changes_refused(self):
        self.archive.write_bytes(self.archive.read_bytes() + b'changes')
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_PIN_MISMATCH'):
            bundle.source_assets(self.archive, self.sources)

    def test_nonselected_source_hash_verified(self):
        self.write_source(changes={'platform/server/index.mjs': b'drift'})
        with self.assertRaisesRegex(ValueError, 'SOURCE_FILE_HASH_MISMATCH'):
            bundle.source_assets(self.archive, self.sources)

    def test_missing_source_refused(self):
        self.write_source(omit=['platform/server/index.mjs'])
        with self.assertRaisesRegex(ValueError, 'MISSING_SOURCE_FILES'):
            bundle.source_assets(self.archive, self.sources)

    def test_unmanifested_source_refused(self):
        self.write_source(extra=[('private.env', b'not allowed')])
        with self.assertRaisesRegex(ValueError, 'UNMANIFESTED_SOURCE'):
            bundle.source_assets(self.archive, self.sources)

    def test_duplicate_same_or_conflicting_tar_member_refused(self):
        name = next(iter(self.assets))
        for body in (self.assets[name], b'conflict'):
            with self.subTest(body=body):
                self.write_source(extra=[(name, body)])
                with self.assertRaisesRegex(ValueError, 'DUPLICATE'):
                    bundle.source_assets(self.archive, self.sources)

    def test_tar_link_and_special_types_refused(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind):
                def change(info):
                    info.type = kind
                    info.size = 0
                    info.linkname = '/etc/secret' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                self.write_source(member_edit=change)
                with self.assertRaisesRegex(ValueError, 'UNSAFE_TAR_TYPE'):
                    bundle.source_assets(self.archive, self.sources)

    def test_pax_path_override_refused(self):
        self.write_source(member_edit=lambda member: member.pax_headers.update({'path': member.name}))
        with self.assertRaisesRegex(ValueError, 'UNSAFE_TAR_EXTENSION'):
            bundle.source_assets(self.archive, self.sources)

    def test_tar_traversal_and_alias_paths_refused(self):
        for name in ('../escape', '/escape', 'platform/../escape', 'platform//escape', './platform/escape',
                     'platform/escape\\x', 'platform/%2e%2e/x'):
            with self.subTest(name=name):
                self.write_source(extra=[(name, b'x')])
                with self.assertRaisesRegex(ValueError, 'UNSAFE_PATH'):
                    bundle.source_assets(self.archive, self.sources)

    def test_api_or_nonhashed_paths_never_map(self):
        for path in ('platform/dist/api/a-AbCd0123.js', 'platform/dist/assets/index.js',
                     'platform/arena/dist/assets/nested/a-AbCd0123.js', 'platform/dist/assets/x-AbCd0123.html',
                     'platform/dist/assets/x-AbCd0123.js?x=1', 'platform/dist/assets/x-AbCd0123.js#f',
                     'platform/dist/assets/.env', 'platform/dist/assets/a-%2e%2e%2f.js'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                bundle.asset_url(path)
        self.assertEqual(bundle.asset_url('platform/legacy/dist/bundles/main-Abcd123_.js'),
                         '/legacy/bundles/main-Abcd123_.js')

    def test_unknown_missing_or_duplicate_gap_refused(self):
        original = copy.deepcopy(self.report)
        for missing in ([], [next(iter(self.assets))] * 2, ['platform/dist/api/a-AbCd0123.js'] * 2):
            self.report = copy.deepcopy(original)
            self.report['rollback_assets']['missing'] = missing
            self.update_evidence()
            with self.assertRaises(ValueError):
                bundle.validated_sources(self.sources)

    def test_four_conflicts_remain_exact_and_blocking(self):
        original = copy.deepcopy(self.report)
        for direction in ('forward_assets', 'rollback_assets'):
            self.report = copy.deepcopy(original)
            self.report[direction]['changed'].pop()
            self.update_evidence()
            with self.assertRaisesRegex(ValueError, 'CONFLICT_EVIDENCE'):
                bundle.validated_sources(self.sources)

    def test_foreign_release_or_manifest_refused(self):
        original = copy.deepcopy(self.report)
        for key, value in (('old', '/opt/oasis/current'), ('new', '/opt/oasis/releases/20261008-06'),
                           ('old_manifest', '0' * 64), ('new_manifest', '0' * 64), ('apply_allowed', True)):
            self.report = {**original, key: value}
            self.update_evidence()
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'EVIDENCE_SCOPE'):
                bundle.validated_sources(self.sources)

    def test_json_duplicates_and_nonfinite_refused(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                bundle.json_value(raw)

    def test_missing_bundle_asset_and_extra_private_member_refused(self):
        files = self.files()
        files.pop('files' + bundle.asset_url(next(iter(self.assets))))
        with self.assertRaisesRegex(ValueError, 'BUNDLE_ASSET_MISSING'):
            bundle.check_bytes(bundle.tar_bytes(files))
        files = self.files()
        files['private.env'] = b'not publishable'
        with self.assertRaisesRegex(ValueError, 'UNEXPECTED_BUNDLE_MEMBER'):
            bundle.check_bytes(bundle.tar_bytes(files))

    def test_asset_byte_corruption_refused(self):
        files = self.files()
        files['files' + bundle.asset_url(next(iter(self.assets)))] += b'!'
        with self.assertRaisesRegex(ValueError, 'PAYLOAD_HASH_MISMATCH'):
            bundle.check_bytes(bundle.tar_bytes(files))

    def test_route_url_methods_mime_cache_length_and_hash_forgery_refused(self):
        for key, value in (('url_path', '/api/pvp/rooms/x'), ('methods', ['GET', 'POST']),
                           ('body_bytes', 0), ('sha256', '0' * 64),
                           ('headers', {'Content-Type': 'text/html', 'Cache-Control': 'no-store'})):
            files = self.files()
            plan = json.loads(files['BUNDLE-PLAN.json'])
            plan['entries'][0][key] = value
            files['BUNDLE-PLAN.json'] = bundle.encoded(plan)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'PLAN_MISMATCH'):
                bundle.check_bytes(bundle.tar_bytes(files))

    def test_origin_storage_or_conflict_exemption_forgery_refused(self):
        for mutate in (lambda p: p['scope'].update(origin='https://game.tianyahuyu.com'),
                       lambda p: p.update(storage='/opt/oasis/static-assets'),
                       lambda p: p.update(unresolved_conflicts=[]),
                       lambda p: p.update(apply_allowed=True)):
            files = self.files()
            plan = json.loads(files['BUNDLE-PLAN.json'])
            mutate(plan)
            files['BUNDLE-PLAN.json'] = bundle.encoded(plan)
            with self.assertRaisesRegex(ValueError, 'PLAN_MISMATCH'):
                bundle.check_bytes(bundle.tar_bytes(files))

    def test_trailing_or_concatenated_tar_refused(self):
        raw = bundle.tar_bytes(self.files())
        for suffix in (b'\0' * 512, b'hidden secret', bundle.tar_bytes({'extra': b'x'})):
            with self.subTest(length=len(suffix)), self.assertRaisesRegex(ValueError, 'NONCANONICAL_BUNDLE'):
                bundle.check_bytes(raw + suffix)

    def test_noncanonical_bundle_owner_or_mode_refused(self):
        for attribute, value in (('mode', 0o777), ('uid', 501), ('mtime', 123)):
            out = io.BytesIO()
            with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                for name, body in self.files().items():
                    info = tarfile.TarInfo(name)
                    info.size, info.mode = len(body), 0o644
                    setattr(info, attribute, value)
                    tar.addfile(info, io.BytesIO(body))
            with self.assertRaisesRegex(ValueError, 'NONCANONICAL_BUNDLE_MEMBER'):
                bundle.check_bytes(out.getvalue())

    def test_symlink_hardlink_and_symlink_parent_refused(self):
        target = self.root / 'data'
        target.write_bytes(b'{}')
        link = self.root / 'link'
        link.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            bundle.read_small(link)
        link.unlink()
        os.link(target, link)
        with self.assertRaisesRegex(ValueError, 'LOCAL_NOT_REGULAR'):
            bundle.read_small(target)
        directory = self.root / 'via'
        directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            bundle.read_small(directory / 'data')

    def test_wrong_asset_total_refused(self):
        with patch.object(bundle, 'EXPECTED_BYTES', bundle.EXPECTED_BYTES + 1):
            with self.assertRaisesRegex(ValueError, 'GAP_LENGTH_MISMATCH'):
                bundle.source_assets(self.archive, self.sources)

    def test_source_length_limit(self):
        with patch.object(bundle, 'MAX_FILE_BYTES', 5):
            with self.assertRaisesRegex(ValueError, 'TAR_FILE_TOO_LARGE'):
                bundle.source_assets(self.archive, self.sources)

    def test_invalid_input_does_not_create_output(self):
        self.archive.write_bytes(b'wrong archive')
        with self.assertRaises(ValueError):
            self.compile()
        self.assertFalse((self.root / 'output').exists())

    def test_cli_errors_do_not_print_input_content_or_path(self):
        out = io.StringIO()
        with patch('sys.stdout', out):
            code = bundle.main(['check', '--bundle', str(self.root / 'sensitive-secret.env')])
        self.assertEqual(code, 2)
        self.assertNotIn('sensitive-secret', out.getvalue())
        self.assertNotIn(str(self.root), out.getvalue())


if __name__ == '__main__':
    unittest.main()

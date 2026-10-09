"""Real temporary source hashes; no service, database or operator action."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('history_provision_test',HERE/'provision.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

class HistoricalSource(unittest.TestCase):
    def fixture(self,root,new=False):
        release=root/'20261010-03';release.mkdir()
        names=list(p.HELPERS if new else p.LEGACY_HELPERS)
        paths=['platform/server/index.mjs','platform/server/runtime-mode.mjs','platform/server/platform.mjs','platform/server/db.mjs','platform/server/schema.sql','platform/package-lock.json','platform/deploy/restore-drill.mjs','platform/server/transfers/audit.mjs']
        if new:paths+=['platform/shared/games.mjs','platform/shared/run-practice-profiles.mjs','platform/server/production-admission.mjs']
        paths+=['platform/deploy/production-instance/'+n for n in names]
        members={}
        for name in paths:
            file=release/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(('historical fixture '+name+'\n').encode());members[name]=p.digest(file.read_bytes())
        loader=release/'platform/node_modules/tsx/dist/loader.mjs';loader.parent.mkdir(parents=True);loader.write_bytes(b'fixture, never executed')
        self.manifest(release,members)
        approved={n:members['platform/deploy/production-instance/'+n] for n in names}
        return release,members,approved
    def manifest(self,release,members):
        (release/'RELEASE-MANIFEST.json').write_bytes(p.canonical(members))
        return p.digest((release/'RELEASE-MANIFEST.json').read_bytes())
    def temporary_path(self,release):
        match=p.re.fullmatch
        return patch.object(p.re,'fullmatch',side_effect=lambda pattern,value,*a,**kw: True if pattern==r'/opt/oasis/releases/\d{8}-\d{2}' and value==str(release) else match(pattern,value,*a,**kw))
    def test_historical_closure_is_accepted_without_relaxing_current_controller(self):
        with tempfile.TemporaryDirectory() as temp:
            release,members,approved=self.fixture(Path(temp));sha=self.manifest(release,members)
            with self.temporary_path(release):
                result=p.verify_historical_release(release,sha,approved)
                self.assertEqual(result['helpers'],approved)
                self.assertEqual(len(result['inspection_closure']),3)
                with self.assertRaises(p.Refusal):p.verify_release(release,sha)
    def test_runtime_or_deploy_import_changes_are_refused(self):
        for name in ['platform/server/runtime-mode.mjs','platform/deploy/restore-drill.mjs','platform/server/transfers/audit.mjs']:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temp:
                release,members,approved=self.fixture(Path(temp));sha=self.manifest(release,members);(release/name).write_bytes(b'changed')
                with self.temporary_path(release),self.assertRaises(p.Refusal):p.verify_historical_release(release,sha,approved)
    def test_resealed_backup_source_cannot_approve_changed_helpers(self):
        with tempfile.TemporaryDirectory() as temp:
            release,members,approved=self.fixture(Path(temp));name='platform/deploy/production-instance/inspect-backup.mjs';(release/name).write_bytes(b'changed inspector');members[name]=p.digest((release/name).read_bytes());sha=self.manifest(release,members)
            with self.temporary_path(release),self.assertRaisesRegex(p.Refusal,'HISTORICAL_HELPER_CLOSURE_CHANGED'):p.verify_historical_release(release,sha,approved)
    def test_new_contract_requires_its_actual_import_closure(self):
        with tempfile.TemporaryDirectory() as temp:
            release,members,approved=self.fixture(Path(temp),new=True);sha=self.manifest(release,members)
            with self.temporary_path(release):self.assertEqual(len(p.verify_historical_release(release,sha,approved)['inspection_closure']),6)
            del members['platform/server/production-admission.mjs'];sha=self.manifest(release,members)
            with self.temporary_path(release),self.assertRaisesRegex(p.Refusal,'HISTORICAL_INSPECTION_IMPORT_CHANGED'):p.verify_historical_release(release,sha,approved)
    def test_source_symlink_and_unknown_helper_approval_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            release,members,approved=self.fixture(Path(temp));sha=self.manifest(release,members);file=release/'platform/server/index.mjs';copy=file.with_suffix('.original');file.rename(copy);file.symlink_to(copy.name)
            with self.temporary_path(release),self.assertRaisesRegex(p.Refusal,'SYMLINK'):p.verify_historical_release(release,sha,approved)
            with self.assertRaisesRegex(p.Refusal,'HISTORICAL_RELEASE_APPROVAL_INVALID'):p.verify_historical_release(release,sha,{**approved,'unknown.py':'a'*64})

if __name__=='__main__':unittest.main()

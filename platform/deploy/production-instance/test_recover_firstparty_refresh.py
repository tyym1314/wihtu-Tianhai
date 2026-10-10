"""Focused exact incident replay and operation ordering. No services/DB/network."""
import ast
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).parent
ROOT=HERE.parents[2]
EVIDENCE=ROOT/'platform/review/firstparty-release-20261010/root-refresh05-actual-toupm57d'

def module(name,path):
    value=types.ModuleType(name);value.__file__=str(path)
    exec(compile(ast.parse(path.read_bytes()),str(path),'exec'),value.__dict__);return value

r=module('recover_contract',HERE/'recover-firstparty-refresh.py')
b=module('frozen_refresh_contract',HERE/'refresh-firstparty-source.py')
b.Refusal=r.Refusal


class IncidentRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw=(HERE/'refresh-firstparty-source.py').read_bytes()
        assert hashlib.sha256(cls.raw).hexdigest()==r.BASE_SHA
        fp=EVIDENCE/'failed-refresh-core-receipt.json';op=EVIDENCE/'partial-static-readonly-v2.json'
        if not fp.is_file() or not op.is_file():
            raise unittest.SkipTest('actual incident replay only: private980/86c9 evidence is not distributed in Git/CI')
        assert hashlib.sha256(fp.read_bytes()).hexdigest()==r.FAILED_SHA
        assert hashlib.sha256(op.read_bytes()).hexdigest()==r.OBSERVATION_SHA
        cls.failed=json.loads(fp.read_bytes());cls.observed=json.loads(op.read_bytes())

    def test_actual_exact_incident_replay_keeps_original_false(self):
        original=copy.deepcopy(self.failed)
        with self.assertRaisesRegex(r.Refusal,'REFRESH_STATIC_INODE_ALIAS'):
            b.static_delta(self.failed['static_before'],self.observed['static_after'],self.failed['static_plan'])
        result=r.incident_proof(b,self.raw,self.failed,self.observed)
        self.assertEqual(result,self.observed['static_after']);self.assertEqual(self.failed,original)
        self.assertFalse(self.failed['passed']);self.assertEqual(self.failed['phase'],'failed_closed')

    def test_other_alias_or_body_receipt_head_changes_refuse(self):
        after=self.observed['static_after'];old=self.failed['static_before'];plan=self.failed['static_plan']
        unchanged=next(iter(old['entries']));new=plan['missing'][0]
        for mutate in (
            lambda v:v['entries'][new].update(device=old['entries'][unchanged]['device'],inode=old['entries'][unchanged]['inode']),
            lambda v:v['entries'][unchanged].update(sha256='e'*64),
            lambda v:v['entries'][r.ALIAS].update(nlink=2),
            lambda v:v['head_pin'].update(inode=v['entries'][new]['inode']),
            lambda v:v['head'].update(pending={'unapproved':True}),
            lambda v:v['receipts'][plan['receipt_sha256']+'.json'].update(mode=0o600)):
            changed=copy.deepcopy(after);mutate(changed)
            with self.assertRaises(r.Refusal):r.persistent_delta(b,self.raw,old,changed,plan)

    def test_failed_stage_data_or_advertised_alias_drift_refuse(self):
        for mutate in (lambda f,o:f.update(passed=True),lambda f,o:f.update(committed_policy={'state':'closed'}),
            lambda f,o:f['restore']['cleanup'].update(database_removed=False),
            lambda f,o:o['database']['counts'].update(players=2),
            lambda f,o:o['aliases'][0].update(old_path='fabricated')):
            failed=copy.deepcopy(self.failed);observed=copy.deepcopy(self.observed);mutate(failed,observed)
            with self.assertRaises(r.Refusal):r.incident_proof(b,self.raw,failed,observed)

    def test_twenty_field_root_approval_no_automatic_admission(self):
        args=types.SimpleNamespace(manifest_sha256=self.failed['target_manifest_sha256'],source_commit=self.failed['source_commit'])
        policy=self.failed['original_database']['policy'];raw=b'actual audit placeholder explicitly synthetic'
        audit={'passed':True,'app_id':policy['app_id'],'policy_scope':{k:policy[k] for k in ('scope','currency_scale','allowed_origins','game_ids')}}
        proof=dict(schema=1,kind='production-firstparty-admission-approval',passed=True,action='restore-runtime',
            scope_kind='runtime-restore',audit_sha256=r.digest(raw),release=str(b.TARGET),manifest_sha256=args.manifest_sha256,
            source_commit=args.source_commit,app_id=policy['app_id'],profile='firstparty-free-v1',
            approved_by='synthetic_test_root',approved_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            **audit['policy_scope'],**{k:False for k in r.FINANCE})
        self.assertEqual(set(proof),b.APPROVAL_KEYS);r.approval(b,proof,raw,audit,args)
        for key,value in [('schema',True),('schema',1.0),('financial_admission_enabled',True),
            ('scope_kind','source-refresh'),('action','refresh'),('audit_sha256','f'*64)]:
            changed=copy.deepcopy(proof);changed[key]=value
            with self.assertRaises(r.Refusal):r.approval(b,changed,raw,audit,args)

    def test_readonly_modes_and_original_lock_release_before_timer_restore(self):
        tree=ast.parse((HERE/'recover-firstparty-refresh.py').read_bytes())
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
        text=ast.unparse(main)
        self.assertNotIn('publish(',text);self.assertNotIn('transition(',text)
        self.assertNotIn("['systemctl', 'start'",text)
        outer=next(n for n in ast.walk(main) if isinstance(n,ast.With) and any('controller_directory_lock' in ast.unparse(x.context_expr) for x in n.items))
        inner=outer.body[1] if isinstance(outer.body[0],ast.Assign) else outer.body[0]
        self.assertIsInstance(inner,ast.With)
        self.assertIn('locked_files',ast.unparse(inner.items[0].context_expr))
        self.assertIn('tool.restore_api(capsule)',ast.unparse(inner))
        self.assertNotIn('restore_timers()',ast.unparse(inner))
        self.assertIn('tool.restore_timers()',ast.unparse(outer.body[-1]))
        klass=r.recovery_class(b,self.raw);guard=ast.unparse(next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='fixed04'))
        for key in ('marker','marker_pin','production_pin','env_pin','resources','volume_pin','app_tcp','bootstrap_pin','protected_inventory_pin'):
            self.assertIn(repr(key),guard)
        self.assertIn('self.retained_graph',guard)
        self.assertTrue(hasattr(klass,'final_restore'))


if __name__=='__main__':unittest.main()

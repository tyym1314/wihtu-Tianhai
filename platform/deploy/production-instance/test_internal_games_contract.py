"""New first-party internal profile contracts; no deployment, network or target state."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
import test_upgrade_admission as fixture
import test_admission_runtime as runtime_fixture

HERE=Path(__file__).resolve().parent
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
a=fixture.a;c=fixture.u;r=load('internal_refresh_contract','refresh-firstparty-source.py')

class InternalGamesContract(unittest.TestCase):
 def inputs(self):
  data=fixture.db('open');data['policy'].update(release=str(r.SOURCE),manifest_sha256=r.SOURCE_MANIFEST)
  approval={name:copy.deepcopy(data['policy'][name]) for name in ('app_id','scope','currency_scale','allowed_origins')}
  approval.update(profile=a.INTERNAL_PROFILE,game_ids=sorted(a.RELEASED_GAMES),approved_by='fixture_root',approved_at='2026-10-13T00:00:00.000Z')
  return data,approval
 def test_explicit_reviewed_profile_changes_only_exact_owned_metadata(self):
  data,approval=self.inputs();value=r.refresh_policy(data['policy'],approval,r.TARGET,'5'*64,'6'*64,target_profile=a.INTERNAL_PROFILE)
  self.assertEqual(value['state'],'closed');self.assertEqual(value['game_ids'],sorted(a.RELEASED_GAMES));self.assertEqual(value['profile'],a.INTERNAL_PROFILE)
  for name in ('app_id','scope','currency_scale','allowed_origins'):self.assertEqual(value[name],data['policy'][name])
  for mutate in (lambda v:v.update(profile=a.FREE_PROFILE),lambda v:v['game_ids'].pop(),lambda v:v.update(currency_scale=0),lambda v:v['scope'].update(app_id='app_foreign')):
   bad=copy.deepcopy(approval);mutate(bad)
   with self.assertRaises(r.Refusal):r.refresh_policy(data['policy'],bad,r.TARGET,'5'*64,'6'*64,target_profile=a.INTERNAL_PROFILE)
 def test_migration_follows_complete_original_cas_and_changes_only_owned_app_policy(self):
  data,approval=self.inputs();expected=r.refresh_policy(data['policy'],approval,r.TARGET,'5'*64,'6'*64,target_profile=a.INTERNAL_PROFILE)
  original,_=c.policy_transaction_sql('open',data,{},'6'*64);sql=r.policy_sql(c,data,expected)
  self.assertEqual(sql[:sql.index('ALTER TABLE')],original[:original.index('UPDATE gp_apps')])
  self.assertLess(sql.index('WALLET_SCOPE_CHANGED_AFTER_CHECK'),sql.index('ALTER TABLE'))
  self.assertLess(sql.index('FINANCIAL_STATE_CHANGED_AFTER_CHECK'),sql.index('ALTER TABLE'))
  self.assertIn('internal_coin_issued bigint NOT NULL DEFAULT 0 CHECK(internal_coin_issued>=0)',sql)
  self.assertIn("status='paused',game_ids=",sql);self.assertIn("profile='firstparty-internal-games-v1',game_ids=",sql)
  for verb in ('CREATE TABLE','DELETE','INSERT','DROP TABLE'):self.assertNotIn(verb,sql)
  bad=copy.deepcopy(expected);bad['game_ids'].append('mock');self.assertRaises(r.Refusal,r.policy_sql,c,data,bad)
 def test_game_order_may_differ_but_original_cas_keeps_exact_arrays(self):
  data,approval=self.inputs();data['app']['game_ids']=list(reversed(data['policy']['game_ids']))
  self.assertNotEqual(data['app']['game_ids'],data['policy']['game_ids'])
  expected=r.refresh_policy(data['policy'],approval,r.TARGET,'5'*64,'6'*64,target_profile=a.INTERNAL_PROFILE)
  original,_=c.policy_transaction_sql('open',data,{},'6'*64);sql=r.policy_sql(c,data,expected)
  self.assertEqual(sql[:sql.index('ALTER TABLE')],original[:original.index('UPDATE gp_apps')])
  bad=copy.deepcopy(data);bad['app']['game_ids'][0]=bad['app']['game_ids'][1]
  self.assertRaises(r.Refusal,r.policy_sql,c,bad,expected)
  bad=copy.deepcopy(data);bad['policy']['game_ids'].append(bad['policy']['game_ids'][0])
  self.assertRaises(r.Refusal,r.policy_sql,c,bad,expected)
 def test_runtime_changes_only_three_explicit_lines_and_closed_profile_remains_invalid(self):
  env=runtime_fixture.free_env();env.update(OASIS_ADMISSION_RELEASE=str(r.SOURCE),OASIS_ADMISSION_MANIFEST_SHA256=r.SOURCE_MANIFEST)
  raw=('# local contract fixture\n'+''.join(k+'='+v+'\n' for k,v in env.items())).encode()
  changed=r.refresh_runtime(a,raw,r.TARGET,'5'*64,target_profile=a.INTERNAL_PROFILE)
  self.assertEqual(sum(x!=y for x,y in zip(raw.splitlines(),changed.splitlines())),3)
  parsed=a.parse_env_text(changed.decode());self.assertEqual(a.runtime_profile(parsed)['profile'],a.INTERNAL_PROFILE)
  self.assertEqual(parsed['OASIS_DATABASE_URL'],env['OASIS_DATABASE_URL'])
  self.assertRaises(r.Refusal,r.refresh_runtime,a,raw,r.TARGET,'5'*64,target_profile='closed')
 def test_internal_snapshot_and_persisted_state_are_separate_from_free_zero_contract(self):
  sql=c.snapshot_sql('app_fixture_actual',profile=a.INTERNAL_PROFILE)
  self.assertIn("'wallet_scope',(SELECT to_jsonb(w)",sql);self.assertIn("'internal_audit'",sql)
  data=fixture.db('open');data['app']['game_ids']=sorted(a.RELEASED_GAMES);data['policy'].update(profile=a.INTERNAL_PROFILE,game_ids=sorted(a.RELEASED_GAMES));data['wallet_scope'].update(internal_coin_issued='100010000',treasury_available='100000000',ledger_version='4');data.update(financial_rows=6,nonzero_money=2,internal_audit={'internal_coin_integrity_errors':0,'internal_financial_scope_errors':0})
  c.validate_database(data,a,fixture.args('open'),action='open',profile=a.INTERNAL_PROFILE)
  for field in ('internal_coin_issued','internal_audit'):
   bad=copy.deepcopy(data);(bad['wallet_scope'] if field=='internal_coin_issued' else bad).pop(field)
   with self.assertRaises(c.Refusal):c.validate_database(bad,a,fixture.args('open'),action='open',profile=a.INTERNAL_PROFILE)
  self.assertRaises(c.Refusal,c.validate_database,data,a,fixture.args('open'),action='open',profile=a.FREE_PROFILE)
 def test_marker_current_profile_cannot_reuse_old_free_policy(self):
  marker,source,_=runtime_fixture.free_history();source['inspection_contract']=a.INTERNAL_CONTRACT;source['runtime_profile']['profile']=a.INTERNAL_PROFILE
  for policy in source['policy_approvals']:policy.update(profile=a.INTERNAL_PROFILE,game_ids=sorted(a.RELEASED_GAMES))
  self.assertEqual(a.approved_source(marker,runtime_fixture.NEW,runtime_fixture.MANIFEST)['runtime_profile']['profile'],a.INTERNAL_PROFILE)
  source['policy_approvals'][0].update(profile=a.FREE_PROFILE,game_ids=sorted(a.ARENA_GAMES))
  self.assertRaises(ValueError,a.approved_source,marker,runtime_fixture.NEW,runtime_fixture.MANIFEST)
 def test_python_and_js_audits_are_identical_and_cli_constant_is_initialized(self):
  source=f"import{{INTERNAL_AUDIT_SQL}}from{json.dumps((HERE/'inspect-backup.mjs').as_uri())};process.stdout.write(INTERNAL_AUDIT_SQL);"
  result=subprocess.run(['node','--input-type=module','-e',source],capture_output=True,check=True)
  self.assertEqual(result.stdout.decode(),a.internal_audit_sql());self.assertIn('IS DISTINCT FROM',result.stdout.decode())
  data,approval=self.inputs();policy=r.refresh_policy(data['policy'],approval,r.TARGET,'5'*64,'6'*64,target_profile=a.INTERNAL_PROFILE)
  expected={'inspection_contract':a.INTERNAL_CONTRACT,'runtime_profile':{'profile':a.INTERNAL_PROFILE,'app_id':policy['app_id'],'public_origin':policy['allowed_origins'][0],'release':policy['release'],'manifest_sha256':policy['manifest_sha256']},'policy_approvals':[policy]}
  result=subprocess.run(['node',str(HERE/'inspect-backup.mjs'),'sql'],input=json.dumps({'expected':expected}).encode(),capture_output=True)
  self.assertEqual(result.returncode,0,result.stderr.decode());self.assertIn("'inspection_contract','production-internal-games-v1'",result.stdout.decode())

if __name__=='__main__':unittest.main()

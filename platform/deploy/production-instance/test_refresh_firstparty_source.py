"""Local source-refresh protocol. Synthetic fixtures; no DB/services/network."""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import test_upgrade_admission as fixture
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('refresh_focused',HERE/'refresh-firstparty-source.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r);c=fixture.u

def fp(inode,body=b'old',mode=0o644):
    return dict(uid=0,gid=0,mode=mode,device=1,inode=inode,kind='file',bytes=len(body),sha256=r.digest(body),nlink=1,mtime_ns=10,ctime_ns=11)
def dp(inode,uid=0,mode=0o755):
    return dict(uid=uid,gid=uid,mode=mode,device=1,inode=inode,kind='directory',bytes=4096,nlink=2,mtime_ns=10,ctime_ns=11)
def static_fixture():
    before=dict(entries={'/arena/assets/old.js':fp(1)},receipts={'0'*64+'.json':fp(2)},
        registered={'/arena/assets/old.js':{'bytes':3,'sha256':r.digest(b'old')}},
        head={'schema':'oasis-static-assets-head-v1','receipts':['0'*64],'pending':None},head_pin=fp(3,b'old head',0o600),
        directories={'.':dp(100),'.registry':dp(101,mode=0o700),'arena':dp(102),'arena/assets':dp(103)},
        ancestors={'/':dp(200),'/opt':dp(201),'/opt/oasis':dp(202),'/opt/oasis/private':dp(203,998,0o700)})
    after=copy.deepcopy(before);after['entries']['/arena/assets/new.js']=fp(4,b'new')
    after['receipts']['1'*64+'.json']=fp(5,b'receipt');after['receipts']['1'*64+'.json']['sha256']='1'*64
    after['registered']['/arena/assets/new.js']={'bytes':3,'sha256':r.digest(b'new')}
    after['head']['receipts'].append('1'*64);after['head_pin']=fp(6,b'new head',0o600)
    for name in ('.registry','arena','arena/assets'):after['directories'][name]['ctime_ns']+=1
    after['ancestors']['/opt/oasis/private']['ctime_ns']+=1
    plan=dict(old_registered=before['registered'],old_head=before['head'],missing=['/arena/assets/new.js'],
        wanted={'/arena/assets/new.js':after['registered']['/arena/assets/new.js']},receipt_sha256='1'*64,receipt_bytes=7,
        head=after['head'],head_sha256=after['head_pin']['sha256'],head_bytes=8)
    return before,after,plan

class RefreshContracts(unittest.TestCase):
    def test_legacy_common_has_no_positional_mode_and_exact_flags(self):
        values={name:('close' if name=='--action' else '1073741824' if name=='--capacity-budget-bytes' else 'synthetic')
                for name in r.LEGACY_COMMON_FLAGS}
        argv=[part for name in sorted(values) for part in (name,values[name])]
        parsed=r.legacy_args(c,argv);self.assertEqual((parsed.mode,parsed.action),('audit','open'))
        for bad in (['audit',*argv],argv[:-2],argv+['--audit','unexpected'],['--mode','audit',*argv[2:]]):
            with self.assertRaises(r.Refusal):r.legacy_args(c,bad)

    def test_static_exact_append_and_sanctioned_source_parent(self):
        before,after,plan=static_fixture();r.static_delta(before,after,plan)
        for mutate in (lambda v:v['entries']['/arena/assets/old.js'].update(inode=99),
                       lambda v:v['entries'].update({'/arena/assets/foreign.js':fp(7)}),
                       lambda v:v['ancestors']['/opt'].update(ctime_ns=99),lambda v:v['head_pin'].update(inode=3)):
            bad=copy.deepcopy(after);mutate(bad)
            with self.assertRaises(r.Refusal):r.static_delta(before,bad,plan)
        old={'target':str(r.SOURCE),'st_dev':1,'st_ino':7,'st_uid':0,'st_gid':0,'st_nlink':1,'st_mode':0o120777}
        new={**old,'target':str(r.TARGET),'st_ino':8};final=copy.deepcopy(after)
        final['ancestors']['/opt/oasis']['ctime_ns']+=1
        self.assertEqual(r.source_parent_delta(after,final,old,new)['new_production_pin'],new)
        final['entries']['/arena/assets/old.js']['sha256']='f'*64
        with self.assertRaises(r.Refusal):r.source_parent_delta(after,final,old,new)

    def test_original_locked_sql_keeps_all_predicates_and_no_data_deletes(self):
        data=fixture.db('open');data['policy'].update(release=str(r.SOURCE),manifest_sha256=r.SOURCE_MANIFEST,revision='3')
        approval={'approved_by':'fixture_root','approved_at':'2026-10-10T00:00:00Z'}
        expected=r.refresh_policy(data['policy'],approval,r.TARGET,'5'*64,'6'*64)
        self.assertEqual((expected['state'],expected['revision']),('closed','4'))
        changed={'release','manifest_sha256','revision','proof_sha256','approved_at'}
        self.assertEqual({k:v for k,v in expected.items() if k not in changed},{k:v for k,v in data['policy'].items() if k not in changed})
        original,_=c.policy_transaction_sql('open',data,{},'6'*64);query=r.policy_sql(c,data,expected)
        self.assertEqual(query[:query.index('UPDATE gp_apps')],original[:original.index('UPDATE gp_apps')])
        self.assertEqual(query[query.index('\nSELECT ',query.index('UPDATE gp_apps')):],original[original.index('\nSELECT ',original.index('UPDATE gp_apps')):])
        self.assertIn("status='paused'",query);self.assertIn(str(r.TARGET),query)
        self.assertNotIn('DELETE',query);self.assertNotIn('INSERT',query);self.assertIn('FINANCIAL_STATE_CHANGED_AFTER_CHECK',query)

    def test_twenty_root_fields_scope_source_and_no_finance(self):
        scope=c.validate_database(fixture.db('open'),fixture.a,fixture.args('open'),action='open')
        audit={'passed':True,'app_id':'app_fixture_actual','policy_scope':scope};raw=r.canonical(audit)
        args=types.SimpleNamespace(action='refresh',manifest_sha256='5'*64,source_commit='6'*40)
        value={'schema':1,'kind':'production-firstparty-admission-approval','passed':True,'action':'refresh',
               'scope_kind':'source-refresh','audit_sha256':r.digest(raw),'release':str(r.TARGET),
               'manifest_sha256':args.manifest_sha256,'source_commit':args.source_commit,'app_id':audit['app_id'],
               'profile':'firstparty-free-v1',**scope,'financial_admission_enabled':False,'probability_admission_enabled':False,
               'thirdparty_financial_admission_enabled':False,'approved_by':'fixture_root','approved_at':dt.datetime.now(dt.timezone.utc).isoformat()}
        self.assertEqual(set(value),r.APPROVAL_KEYS);self.assertEqual(r.root_approval(value,raw,audit,args),value)
        for field,bad in [('schema',True),('schema',1.0),('financial_admission_enabled',True),('manifest_sha256','7'*64),('scope_kind','firstparty-free-only')]:
            value2=copy.deepcopy(value);value2[field]=bad
            with self.assertRaises(r.Refusal):r.root_approval(value2,raw,audit,args)

    def test_fd_replay_and_same_bytes_name_replacement(self):
        with tempfile.TemporaryDirectory(dir=HERE) as directory:
            path=Path(directory)/'input';path.write_bytes(b'bound');held=r.HeldInputs(c)
            try:
                self.assertEqual(held.read(path,r.digest(b'bound'),private=False),b'bound')
                self.assertEqual(held.read(path,r.digest(b'bound'),private=False),b'bound');self.assertEqual(len(held.fds),1)
                with self.assertRaises(r.Refusal):held.read(path,'f'*64,private=False)
                path.unlink();path.write_bytes(b'bound')
                with self.assertRaises(c.Refusal):held.guard()
            finally:held.close()

    def test_existing_free_runtime_changes_two_lines_preserves_profile_app_and_private_bytes(self):
        import test_admission_runtime as history
        env=history.free_env();env.update(OASIS_ADMISSION_RELEASE=str(r.SOURCE),OASIS_ADMISSION_MANIFEST_SHA256=r.SOURCE_MANIFEST)
        raw=('# synthetic fixture, not a production env\n'+''.join(k+'='+v+'\n' for k,v in env.items())).encode()
        out=r.refresh_runtime(history.a,raw,r.TARGET,'5'*64)
        lines=raw.splitlines(keepends=True);actual=out.splitlines(keepends=True)
        self.assertEqual(len(lines),len(actual));self.assertEqual(sum(x!=y for x,y in zip(lines,actual)),2)
        parsed=history.a.parse_env_text(out.decode())
        self.assertEqual(parsed['OASIS_ADMISSION_PROFILE'],env['OASIS_ADMISSION_PROFILE'])
        self.assertEqual(parsed['OASIS_FIRSTPARTY_APP_ID'],env['OASIS_FIRSTPARTY_APP_ID'])
        self.assertEqual(parsed['OASIS_DATABASE_URL'],env['OASIS_DATABASE_URL'])
        with self.assertRaises((r.Refusal,ValueError)):r.refresh_runtime(history.a,raw.replace(b'OASIS_ADMISSION_RELEASE=',b'# OASIS_ADMISSION_RELEASE='),r.TARGET,'5'*64)

    def test_original_method_journal_capsule_and_fresh_are_bound(self):
        tool=r.Refresh.__new__(r.Refresh);tool.before={'units':{'files':{'fixture':1}}};tool.authored={'own':2}
        tool.locks={'lock':3};tool.global_locks_held=True;tool.lease=('own',4);events=[];stable=[]
        tool.event=lambda phase,**fields:events.append((phase,fields));tool.stable=lambda:stable.append(True)
        ctx=types.SimpleNamespace();tool.bind_context(ctx);ctx.event('target_units_loaded');ctx.fresh()
        self.assertEqual(ctx.capsule['audit']['state'],tool.before);self.assertEqual(ctx.authored_paths,tool.authored)
        self.assertEqual(events,[('target_units_loaded',{})]);self.assertEqual(stable,[True]);self.assertTrue(ctx.global_locks_held)

    def test_check_does_not_count_itself_in_original_input_pins(self):
        tool=r.Refresh.__new__(r.Refresh);tool.args=types.SimpleNamespace(action='open',audit='/audit',audit_sha256='1'*64,
            approval='/approval',approval_sha256='2'*64,controller_sha256='3'*64,manifest_sha256='4'*64,source_commit='5'*40)
        original={'passed':True,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'stable':'same'};raw=r.canonical(original)
        class Inputs:
            files={'/audit':{'sha256':'1'*64},'/approval':{'sha256':'2'*64},'/check':{'sha256':'6'*64}}
            def read(self,path,expected):return raw if path=='/audit' else b'{}'
        tool.inputs=Inputs();tool.audit=lambda:copy.deepcopy(original);tool.core=c
        with patch.object(r,'root_approval',return_value={'fixture':True}):value=tool.check()
        self.assertEqual(set(value['input_pins']),{'/audit','/approval'})

    def test_timer_tail_unlocked_typed_and_failure_not_relabelled(self):
        tool=r.Refresh.__new__(r.Refresh);tool.core=types.SimpleNamespace(OWN_TIMERS=('own.timer',),ONESHOT_WAIT_SECONDS=1,
            read_file=lambda *a,**k:(b'{}',{}));tool.b=types.SimpleNamespace(p=types.SimpleNamespace(PRIVATE=Path('/fixture')))
        calls=[];tool.source_guard=lambda:calls.append('source');tool.public_expected={};tool.observe=lambda:calls.append('fullscope')
        tool.context=types.SimpleNamespace(global_locks_held=True,guardian=types.SimpleNamespace(guard=lambda value:calls.append('protected')),
            installed_units=lambda *a,**k:{'pending_jobs':[],'states':{'own.timer':{'ActiveState':'active'}}},
            b=types.SimpleNamespace(ops=types.SimpleNamespace(owned_resources=lambda *a:None)))
        tool.runtime=types.SimpleNamespace(command=lambda *a,**k:calls.append('start'));tool.global_locks_held=True
        with self.assertRaises(r.Refusal):tool.restore_timers()
        self.assertNotIn('start',calls)
        tool.global_locks_held=False;tool.restore_timers();self.assertFalse(tool.context.global_locks_held)
        self.assertIn('fullscope',calls)
        with patch.object(r.time,'monotonic',side_effect=[0,0,2]):
            with self.assertRaisesRegex(r.Refusal,'JOBS_TIMEOUT'):tool.restore_timers()
        tool.context.installed_units=lambda *a,**k:{'pending_jobs':[],'states':{'own.timer':{'ActiveState':'inactive'}}}
        with self.assertRaisesRegex(r.Refusal,'NOT_RESTORED'):tool.restore_timers()

if __name__=='__main__':unittest.main()

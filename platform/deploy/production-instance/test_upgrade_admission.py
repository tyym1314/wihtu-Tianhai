"""Local contracts and real temporary files; never approves a production policy."""
import copy
import datetime as dt
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from contextlib import contextmanager,ExitStack
from unittest.mock import Mock,patch

HERE=Path(__file__).resolve().parent
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
u=load('upgrade_admission_fixture','upgrade-admission.py')
a=load('admission_upgrade_contract_fixture','admission-runtime.py')
p=load('provision_upgrade_contract_fixture','provision.py')
r=load('retirement_upgrade_contract_fixture','../retire-mock-sources.py');r.Refusal=u.Refusal
M='a'*64

def args(action='upgrade'):
 return types.SimpleNamespace(action=action,release=str(u.TARGET),manifest_sha256=M,
        controller_sha256='b'*64,source_commit='c'*40,controller_origin_commit='e'*40,app_id='app_fixture_actual',
        origin='https://isolated.example.test',capacity_budget_bytes=1<<30)

def db(action='upgrade'):
 app={'id':'app_fixture_actual','partner_id':'partner_oasis_platform','environment':'production',
      'wallet_scope_id':'wallet_fixture_scope','currency_id':'COIN','currency_scale':2,'status':'paused',
      'wallet_url':'','allowed_origins':['https://isolated.example.test'],'game_ids':sorted(a.ARENA_GAMES),
      'competitive_fee_bps':500,'math_profile':'draft-fixture'}
 scope={name:app['id'] if name=='app_id' else app[name] for name in a.SCOPE_FIELDS}
 wallet={'scope_id':':'.join(scope.values()),**scope,'currency_scale':2,
         **{name:0 for name in ('treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version')}}
 value={'database':'oasis_production','database_oid':u.OID,'environment':'production','apps':1,'app':app,
        'binding':{'app_id':app['id'],'provider':'platform','wallet_url':None,'wallet_key_id':None,'scope':scope},
        'wallet_scope':wallet,'policy':None,'counts':dict.fromkeys(('players','logins','sessions','wallet_users','rooms','transfers'),0),
        'financial_rows':0,'nonzero_money':0,'pending_rooms':0,'pending_pvp_operations':0,'active_users':0}
 if action in ('open','close'):
  state='closed' if action=='open' else 'open';app['status']='paused' if state=='closed' else 'active'
  value['policy']={'app_id':app['id'],'profile':a.FREE_PROFILE,'state':state,'revision':'2',
       'scope':scope,'currency_scale':2,'allowed_origins':app['allowed_origins'],'game_ids':app['game_ids'],
       'release':str(u.TARGET),'manifest_sha256':M,'proof_sha256':'d'*64,'approved_by':'fixture_root',
       'approved_at':'2026-10-10T00:00:00.000Z'}
 return value

def proof(action='upgrade'):
 value=db(action);scope=u.validate_database(value,a,args(action),action=action)
 audit={'passed':True,'policy_scope':scope};raw=u.canonical(audit)
 result={'schema':1,'kind':'production-firstparty-admission-approval','passed':True,'action':action,
    'scope_kind':'source-upgrade' if action=='upgrade' else 'firstparty-free-only','audit_sha256':u.digest(raw),
    'release':str(u.TARGET),'manifest_sha256':M,'source_commit':'c'*40,'app_id':'app_fixture_actual',
    **scope,'profile':a.FREE_PROFILE,'financial_admission_enabled':False,'probability_admission_enabled':False,
    'thirdparty_financial_admission_enabled':False,'approved_by':'fixture_root',
    'approved_at':dt.datetime.now(dt.timezone.utc).isoformat()}
 return result,raw,audit


class FileContracts(unittest.TestCase):
 def test_real_fd_read_rejects_symlink_and_hardlink(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();file=root/'file';file.write_bytes(b'bound');(root/'link').symlink_to(file)
   with self.assertRaises(OSError):u.read_file(root/'link')
   os.link(file,root/'hard')
   with self.assertRaisesRegex(u.Refusal,'REGULAR_FILE'):u.read_file(file)

 def test_real_fd_read_rejects_parent_symlink(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();(root/'real').mkdir();(root/'real/file').write_bytes(b'bound');(root/'link').symlink_to(root/'real')
   with self.assertRaisesRegex(u.Refusal,'PARENT_SYMLINK'):u.read_file(root/'link/file')

 def test_bound_read_rejects_same_bytes_name_replacement(self):
  with tempfile.TemporaryDirectory() as directory:
   file=Path(directory).resolve()/'file';file.write_bytes(b'bound');original=os.read;replaced=False
   def change(fd,count):
    nonlocal replaced
    body=original(fd,count)
    if not replaced:
     file.unlink();file.write_bytes(b'bound');replaced=True
    return body
   with patch.object(u.os,'read',side_effect=change),self.assertRaisesRegex(u.Refusal,'CHANGED_DURING_READ'):u.read_file(file)

 def test_explicit_external_hash_required_bytes(self):
  with tempfile.TemporaryDirectory() as directory:
   file=Path(directory).resolve()/'file';file.write_bytes(b'bound')
   with self.assertRaisesRegex(u.Refusal,'EXTERNAL_HASH'):u.read_file(file,'f'*64)
   self.assertEqual(u.read_file(file,u.digest(b'bound'))[0],b'bound')

 def test_real_atomic_replace_mode_survives_umask_and_keeps_final_inode(self):
  with tempfile.TemporaryDirectory() as directory:
   file=Path(directory).resolve()/'file';file.write_bytes(b'old');before=u.pin(file);mask=os.umask(0o077)
   try:new=u.atomic_replace(file,b'new',before,mode=0o644)
   finally:os.umask(mask)
   self.assertEqual(file.read_bytes(),b'new');self.assertEqual(stat.S_IMODE(file.stat().st_mode),0o644)
   self.assertEqual(new,u.pin(file));self.assertNotEqual(before['st_ino'],new['st_ino'])

 def test_same_byte_replacement_never_overwritten(self):
  with tempfile.TemporaryDirectory() as directory:
   file=Path(directory).resolve()/'file';file.write_bytes(b'old');before=u.pin(file);file.unlink();file.write_bytes(b'old')
   with self.assertRaisesRegex(u.Refusal,'TARGET_CHANGED'):u.atomic_replace(file,b'new',before)
   self.assertEqual(file.read_bytes(),b'old')

 def test_actual_fd_lock_refuses_unlink_recreate(self):
  with tempfile.TemporaryDirectory() as directory:
   file=Path(directory).resolve()/'lock';file.write_bytes(b'');before=u.pin(file);fd=os.open(file,os.O_RDONLY)
   try:
    file.unlink();file.write_bytes(b'')
    with self.assertRaisesRegex(u.Refusal,'LOCK_REPLACED'):u.lock_guard(fd,file,before)
   finally:os.close(fd)

 def test_wrong_parent_tool_location_cannot_run_real_check(self):
  with self.assertRaisesRegex(u.Refusal,'LOCATION_OR_PROVENANCE'):u.controller_guard(args(),types.SimpleNamespace())

 def test_private_parent_exception_is_only_exact_witnessed_shared_directory(self):
  actual=u.Path.lstat
  shared=u.Path('/opt/oasis/private')
  safe=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=998,st_gid=998,st_dev=64515,st_ino=934465)
  root=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_dev=64515,st_ino=1)
  def fake(path):return safe if path==shared else root
  with patch.object(u.Path,'is_symlink',return_value=False),patch.object(u.Path,'lstat',side_effect=fake,autospec=True), \
       patch.object(u.os,'open',side_effect=OSError('past verified parents')) as opened:
   with self.assertRaisesRegex(OSError,'past verified'):u.read_file(shared/'approval.json',private=True)
   opened.assert_called_once()
  for field in ('st_gid','st_dev','st_ino'):
   bad=copy.copy(safe);setattr(bad,field,getattr(bad,field)+1)
   with patch.object(u.Path,'is_symlink',return_value=False),patch.object(u.Path,'lstat',side_effect=lambda path:bad if path==shared else root,autospec=True), \
        patch.object(u.os,'open') as opened,self.assertRaisesRegex(u.Refusal,'PRIVATE_PARENT_UNSAFE'):
    u.read_file(shared/'approval.json',private=True)
   opened.assert_not_called()


class LoaderContracts(unittest.TestCase):
 def test_private_patch_never_changes_frozen_runtime_controller_or_commit(self):
  aa=args();aa.manifest_sha256=u.RUNTIME_MANIFEST;aa.source_commit=u.RUNTIME_SOURCE_COMMIT
  members={'platform/deploy/production-instance/upgrade-admission.py':u.PACKAGED_CONTROLLER_SHA}
  self.assertNotEqual(aa.controller_sha256,u.PACKAGED_CONTROLLER_SHA)
  self.assertEqual(u.runtime_controller_binding(aa,members),u.PACKAGED_CONTROLLER_SHA)
  for changed in ('manifest_sha256','source_commit'):
   bad=copy.copy(aa);setattr(bad,changed,'f'*(64 if changed=='manifest_sha256' else 40))
   with self.assertRaisesRegex(u.Refusal,'FROZEN_RUNTIME'):u.runtime_controller_binding(bad,members)
  with self.assertRaisesRegex(u.Refusal,'FROZEN_RUNTIME'):
   u.runtime_controller_binding(aa,{next(iter(members)):aa.controller_sha256})

 def test_private_controller_origin_is_explicit_separate_and_capsule_bound(self):
  aa=args();aa.manifest_sha256=u.RUNTIME_MANIFEST;aa.source_commit=u.RUNTIME_SOURCE_COMMIT
  with patch.object(u,'__file__',str(u.TOOL)),patch.object(u,'read_file',return_value=(b'private version',{'synthetic':True})), \
       patch.object(u,'pin',return_value={'st_mode':stat.S_IFDIR|0o700,'st_uid':0,'st_gid':0}):
   result=u.controller_guard(aa,types.SimpleNamespace(p=types.SimpleNamespace(no_mount=lambda path:None),pins={},job_executables={}))
   self.assertEqual(result['runtime_source_commit'],u.RUNTIME_SOURCE_COMMIT)
   self.assertEqual(result['controller_origin_commit'],aa.controller_origin_commit)
   self.assertEqual(result['packaged_controller_sha256'],u.PACKAGED_CONTROLLER_SHA)
   for origin in ('','unknown','f'*39,'F'*40,True):
    aa.controller_origin_commit=origin
    with self.assertRaises(u.Refusal):u.controller_guard(aa,types.SimpleNamespace())
  first={'controller_origin_commit':'a'*40};second={'controller_origin_commit':'b'*40}
  self.assertNotEqual(u.stable_capsule(first),u.stable_capsule(second))

 def test_real_current_operations_imports_verified_modules_without_loader_reads(self):
  p=types.SimpleNamespace(DATABASE='oasis_production',PRIVATE=Path('/isolated'),Refusal=u.Refusal)
  path=HERE/'operations.py';body=path.read_bytes()
  with patch.object(importlib.machinery.SourceFileLoader,'exec_module',side_effect=AssertionError('second loader')), \
       patch.object(importlib.machinery.SourceFileLoader,'get_data',side_effect=AssertionError('pyc or name read')):
   module,_=u.module_bytes(path,u.digest(body),inject={'p':p,'a':a},strip_loaders=True)
  self.assertIs(module.p,p);self.assertIs(module.a,a)

 def test_real_original_operations_imports_same_verified_provision(self):
  p=types.SimpleNamespace(DATABASE='oasis_production',PRIVATE=Path('/isolated'),Refusal=u.Refusal)
  path=HERE/'fixtures/bootstrap-tail-20261010-03/operations.py'
  with patch.object(importlib.machinery.SourceFileLoader,'exec_module',side_effect=AssertionError('second loader')):
   module,_=u.module_bytes(path,u.OLD_HELPERS['operations.py'],inject={'p':p},strip_loaders=True)
  self.assertIs(module.p,p)

 def test_unknown_or_missing_loader_binding_refused_before_exec(self):
  with self.assertRaisesRegex(u.Refusal,'UNBOUND_HELPER'):u.module_bytes(HERE/'operations.py',u.digest((HERE/'operations.py').read_bytes()),strip_loaders=True)
  with tempfile.TemporaryDirectory() as directory:
   file=Path(directory).resolve()/'helper.py';file.write_text('raise AssertionError("must not execute")\n')
   with self.assertRaisesRegex(u.Refusal,'LOADER_SHAPE'):u.module_bytes(file,u.digest(file.read_bytes()),inject={'p':object()},strip_loaders=True)


@contextmanager
def process_fixture(release_name='old'):
 """Synthetic /proc files and real executable inodes, not a live approval."""
 with tempfile.TemporaryDirectory() as directory:
  root=Path(directory).resolve();proc=root/'proc';proc.mkdir();old=root/'03';target=root/'04'
  for release in (old,target):(release/'platform/node_modules/@esbuild/linux-x64/bin').mkdir(parents=True)
  release=old if release_name=='old' else target
  node=root/'node';node.write_bytes(b'isolated owned Node');node.chmod(0o755)
  esbuild=release/'platform/node_modules/@esbuild/linux-x64/bin/esbuild';esbuild.write_bytes(b'isolated esbuild');esbuild.chmod(0o755)
  def write(pid,ppid=1,start='100',exe=None,cwd=None,uids=None,argv=None,cgroup=u.API_CGROUP):
   item=proc/str(pid);item.mkdir(exist_ok=True);exe=exe or node;cwd=cwd or release/'platform'
   fields=['S',str(ppid)]+['0']*18;fields[19]=str(start)
   (item/'stat').write_text(str(pid)+' (isolated process) '+' '.join(fields)+'\n')
   (item/'status').write_text('Name:\tisolated\nUid:\t'+'\t'.join(str(x) for x in (uids or [997]*4))+'\n')
   (item/'cmdline').write_bytes(('\0'.join(argv or [str(node),'--import','tsx','server/index.mjs'])+'\0').encode())
   (item/'cgroup').write_text(cgroup)
   for name,to in [('cwd',cwd),('exe',exe)]:
    path=item/name
    if os.path.lexists(path):path.unlink()
    path.symlink_to(to)
   return item
  write(101)
  for pid in (102,103):write(pid,ppid=101,start=str(pid),exe=esbuild,argv=[str(esbuild),'--service=0.28.2','--ping'])
  units={'states':{'oasis-production-api.service':{'ActiveState':'active','MainPID':'101',
      'process':{'pid':101,'start_ticks':'100','cwd':str(release/'platform'),'exe':str(node),'uid':'997'}}}}
  original_read=u.read_file;original_stat=u.os.stat
  def bound(path,*aa,**kw):
   body,identity=original_read(path,*aa,**kw)
   if Path(path) in (node,esbuild):identity={**identity,'st_uid':0,'st_gid':0}
   return body,identity
  def mapped(path,*aa,**kw):
   value=original_stat(path,*aa,**kw)
   if Path(path).parent.parent==proc and Path(path).name=='exe':
    return types.SimpleNamespace(**{key:(0 if key in ('st_uid','st_gid') else getattr(value,key)) for key in
        ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')})
   return value
  with ExitStack() as stack:
   for name,value in {'OLD':old,'TARGET':target,'PROC_ROOT':proc,'NODE_EXE':node,
                      'NODE_SHA':u.digest(node.read_bytes()),'ESBUILD_SHA':u.digest(esbuild.read_bytes())}.items():
    stack.enter_context(patch.object(u,name,value))
   stack.enter_context(patch.object(u,'read_file',side_effect=bound));stack.enter_context(patch.object(u.os,'stat',side_effect=mapped))
   yield types.SimpleNamespace(root=root,proc=proc,release=release,node=node,esbuild=esbuild,write=write,units=units)


class ConsumerContracts(unittest.TestCase):
 def test_both_sources_accept_only_actual_main_and_two_direct_esbuild_helpers(self):
  for source in ('old','target'):
   with self.subTest(source=source),process_fixture(source) as f:
    proof=u.consumer_guard(f.units,f.release)
    self.assertEqual([row['pid'] for row in proof['processes']],[101,102,103])
    self.assertEqual(proof['processes'][1]['ppid'],101)
    self.assertEqual(set(proof['executables']),{str(f.node),str(f.esbuild)})

 def test_main_api_without_helpers_is_valid_and_inactive_has_no_consumers(self):
  with process_fixture() as f:
   for pid in (102,103):shutil.rmtree(f.proc/str(pid))
   self.assertEqual(len(u.consumer_guard(f.units,f.release)['processes']),1)
   f.units['states']['oasis-production-api.service']={'ActiveState':'inactive','MainPID':'0'}
   with self.assertRaisesRegex(u.Refusal,'FOREIGN_SOURCE'):u.consumer_guard(f.units,f.release)
   shutil.rmtree(f.proc/'101');self.assertEqual(u.consumer_guard(f.units,f.release)['processes'],[])

 def test_foreign_uid_source_cgroup_parent_exe_and_arguments_all_refused(self):
  for change in ('foreign-cwd','other-source','uid','saved-uid','cgroup','parent','older','node','version','extra','unrelated-node'):
   with self.subTest(change=change),process_fixture() as f:
    values={'ppid':101,'start':'102','exe':f.esbuild,'argv':[str(f.esbuild),'--service=0.28.2','--ping']}
    if change=='foreign-cwd':values['cwd']=f.root
    elif change=='other-source':values['cwd']=u.TARGET/'platform'
    elif change=='uid':values['uids']=[0]*4
    elif change=='saved-uid':values['uids']=[997,997,0,997]
    elif change=='cgroup':values['cgroup']='0::/system.slice/foreign.service\n'
    elif change=='parent':values['ppid']=103
    elif change=='older':values['start']='99'
    elif change=='node':values.update(exe=f.node,argv=[str(f.node),'server/pvp/engine-worker.mjs'])
    elif change=='version':values['argv']=[str(f.esbuild),'--service=9.9.9','--ping']
    elif change=='extra':values['argv'].append('--foreign')
    elif change=='unrelated-node':values.update(exe=f.node,ppid=1,argv=[str(f.node),'foreign.mjs'])
    f.write(102,**values)
    with self.assertRaisesRegex(u.Refusal,'FOREIGN_SOURCE'):u.consumer_guard(f.units,f.release)

 def test_actual_thread_worker_contract_does_not_authorize_a_separate_node_pid(self):
  code=(HERE/'../../server/pvp/engine-pool.mjs').resolve().read_text()
  self.assertIn("import {Worker} from 'node:worker_threads'",code)
  self.assertIn('new Worker(workerUrl,{execArgv:[]})',code)
  self.assertNotIn('child_process',code)
  with process_fixture() as f:
   f.write(104,ppid=101,start='104',exe=f.node,argv=[str(f.node),'server/pvp/engine-worker.mjs'])
   with self.assertRaisesRegex(u.Refusal,'FOREIGN_SOURCE'):u.consumer_guard(f.units,f.release)

 def test_stale_main_start_identity_fake_pid_parent_or_command_is_refused(self):
  for change in ('start','pid','parent','argv','uids','cgroup'):
   with self.subTest(change=change),process_fixture() as f:
    if change=='start':f.units['states']['oasis-production-api.service']['process']['start_ticks']='99'
    elif change=='pid':f.units['states']['oasis-production-api.service']['process']['pid']=100
    else:
     fields={'ppid':1}
     if change=='parent':fields['ppid']=2
     elif change=='argv':fields['argv']=[str(f.node),'--import','tsx','foreign.mjs']
     elif change=='uids':fields['uids']=[997,0,997,997]
     elif change=='cgroup':fields['cgroup']='0::/system.slice/foreign.service\n'
     f.write(101,**fields)
    with self.assertRaisesRegex(u.Refusal,'API_PROCESS_CHANGED'):u.consumer_guard(f.units,f.release)

 def test_pid_reuse_or_new_foreign_consumer_between_full_samples_is_refused(self):
  for change in ('pid-reuse','new-process'):
   with self.subTest(change=change),process_fixture() as f:
    original=u.consumer_snapshot;count=0
    def sample():
     nonlocal count
     result=original();count+=1
     if count==1:
      if change=='pid-reuse':f.write(102,ppid=101,start='999',exe=f.esbuild,argv=[str(f.esbuild),'--service=0.28.2','--ping'])
      else:f.write(104,ppid=1,start='104',argv=[str(f.node),'foreign.mjs'])
     return result
    with patch.object(u,'consumer_snapshot',side_effect=sample),self.assertRaisesRegex(u.Refusal,'PROCESS_CHANGED'):
     u.consumer_guard(f.units,f.release)

 def test_cpu_stat_changes_are_not_mistaken_for_pid_reuse(self):
  with process_fixture() as f:
   original=Path.read_text;count=0
   def read(path,*aa,**kw):
    nonlocal count
    body=original(path,*aa,**kw)
    if path==f.proc/'101/stat':
     count+=1;fields=body.rsplit(')',1)[1].split();fields[11]=str(count)
     return body.rsplit(')',1)[0]+') '+' '.join(fields)+'\n'
    return body
   with patch.object(Path,'read_text',autospec=True,side_effect=read):self.assertEqual(len(u.consumer_guard(f.units,f.release)['processes']),3)

 def test_changed_executable_mode_body_link_or_mapped_inode_is_refused(self):
  for change in ('mode','body','hardlink','mapped-inode','replace-after-read'):
   with self.subTest(change=change),process_fixture() as f:
    if change=='mode':f.esbuild.chmod(0o775)
    elif change=='body':f.esbuild.write_bytes(b'foreign body')
    elif change=='hardlink':os.link(f.esbuild,f.root/'external-link')
    elif change=='mapped-inode':
     original=u.os.stat
     def mapped(path,*aa,**kw):
      value=original(path,*aa,**kw)
      if Path(path)==f.proc/'102/exe':value=copy.copy(value);value.st_ino+=1
      return value
     with patch.object(u.os,'stat',side_effect=mapped),self.assertRaisesRegex(u.Refusal,'MAPPING_CHANGED'):
      u.consumer_guard(f.units,f.release)
     continue
    elif change=='replace-after-read':
     original=u.consumer_snapshot;count=0
     def sample():
      nonlocal count
      value=original();count+=1
      if count==2:
       body=f.esbuild.read_bytes();f.esbuild.unlink();f.esbuild.write_bytes(body);f.esbuild.chmod(0o755)
      return value
     with patch.object(u,'consumer_snapshot',side_effect=sample),self.assertRaisesRegex(u.Refusal,'EXECUTABLE_CHANGED'):
      u.consumer_guard(f.units,f.release)
     continue
    with self.assertRaises(u.Refusal):u.consumer_guard(f.units,f.release)

 def test_foreign_consumer_refusal_precedes_actual_owned_unit_stop(self):
  controller=object.__new__(u.Controller);controller.b=types.SimpleNamespace(oldp=None,job_executables={},
      ingress=types.SimpleNamespace(configurations=lambda binding:{'/etc/systemd/system/'+name:'expected' for name in (u.OWN_JOBS[2],u.OWN_TIMERS[2])}),
      units=types.SimpleNamespace(UNIT_NAMES=(u.OWN_JOBS[2],u.OWN_TIMERS[2]),namespace_guard=lambda *aa,**kw:None,loaded_guard=lambda *aa,**kw:None))
  names=('oasis-production-api.service',u.OWN_TIMERS[0],u.OWN_JOBS[0],u.OWN_TIMERS[1],u.OWN_JOBS[1])
  controller.p=types.SimpleNamespace(unit_templates=lambda *aa:dict.fromkeys(names,'expected'),unit_namespace_guard=lambda templates:None,
      expected_commands=lambda body:{},UNITS=names)
  controller.runtime=types.SimpleNamespace(service=lambda name:{'FragmentPath':'/etc/systemd/system/'+name,'DropInPaths':'','NeedDaemonReload':'no','ActiveState':'inactive','MainPID':'0',
      'SubState':'dead','ControlPID':'0','Result':'success','ExecMainStatus':'0','ExecMainCode':'1'},
      loaded_commands=lambda name:{},command=Mock())
  controller.fresh=Mock();controller.event=Mock()
  with patch.object(u,'pin',return_value={'st_uid':0,'st_gid':0,'st_mode':stat.S_IFREG|0o644,'sha256':u.digest(b'expected')}), \
       patch.object(u,'consumer_guard',side_effect=u.Refusal('ADMISSION_FOREIGN_SOURCE_OR_UID_CONSUMER')), \
       self.assertRaisesRegex(u.Refusal,'FOREIGN_SOURCE'):controller.stop_writers({'release':str(u.TARGET),'manifest_sha256':M})
  controller.runtime.command.assert_not_called();controller.fresh.assert_not_called()


class TimerLifecycleContracts(unittest.TestCase):
 def controller(self):
  controller=object.__new__(u.Controller);controller.args=args('approve');controller.global_locks_held=False
  controller.directory_lease=(11,Path('/isolated/private'),{'isolated':True});controller.locks={}
  controller.authored_marker={'release':str(u.TARGET),'manifest_sha256':M};controller.capsule={}
  controller.receipt={'passed':False,'phase':'verified_pending_owned_timers'}
  controller.waited_jobs={}
  controller.fresh=Mock();controller.event=Mock();controller.b=types.SimpleNamespace(ops=types.SimpleNamespace(owned_resources=Mock()))
  controller.runtime=types.SimpleNamespace(command=Mock());return controller

 def unit_states(self,busy=()):
  states={name:{'ActiveState':'active','MainPID':'0'} for name in u.OWN_TIMERS}
  states.update({name:{'ActiveState':'inactive','MainPID':'0','SubState':'dead','Result':'success','ExecMainCode':'0','ExecMainStatus':'0'} for name in u.OWN_JOBS})
  for name in busy:states[name]={'ActiveState':'activating','MainPID':'201','process':{'pid':201,'start_ticks':'100','uid':'0'}}
  return {'pending_jobs':list(busy),'states':states}

 def test_real_directory_fd_flock_serializes_operations_and_refuses_name_replacement(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();root.chmod(0o700);tool=root/'controller.py';tool.write_bytes(b'isolated');tool.chmod(0o600)
   original_pin=u.pin;original_fstat=u.os.fstat
   def rooted(path,*aa,**kw):return {**original_pin(path,*aa,**kw),'st_uid':0,'st_gid':0}
   def descriptor(fd):
    actual=original_fstat(fd)
    return types.SimpleNamespace(**{key:(0 if key in ('st_uid','st_gid') else getattr(actual,key)) for key in
        ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')})
   with patch.object(u,'TOOL',tool),patch.object(u,'controller_guard',return_value={}), \
        patch.object(u,'pin',side_effect=rooted),patch.object(u.os,'fstat',side_effect=descriptor):
    with u.controller_directory_lock(args(),object()) as lease:
     code='import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\ntry:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(0)\nsys.exit(3)'
     result=subprocess.run([sys.executable,'-I','-B','-c',code,str(root)],capture_output=True)
     self.assertEqual(result.returncode,0)
     u.directory_lock_guard(*lease)
    # The lease releases on exit and does not write metadata.
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try:u.fcntl.flock(fd,u.fcntl.LOCK_EX|u.fcntl.LOCK_NB)
    finally:os.close(fd)
    original=rooted(root);fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);renamed=root.with_name(root.name+'-old')
    try:
     root.rename(renamed);root.mkdir(mode=0o700)
     with self.assertRaisesRegex(u.Refusal,'DIRECTORY_LOCK_REPLACED'):u.directory_lock_guard(fd,root,original)
    finally:os.close(fd);root.rmdir();renamed.rename(root)

 def test_execute_apply_releases_both_locks_before_timer_tail_and_never_passes_early(self):
  order=[];controller=self.controller();aa=args();aa.mode='apply'
  @contextmanager
  def directory(*_):order.append('directory-acquired');yield controller.directory_lease;order.append('directory-released')
  @contextmanager
  def locks(*_):order.append('shared-ops-acquired');yield {};order.append('shared-ops-released')
  def apply():
   self.assertTrue(controller.global_locks_held);self.assertFalse(controller.receipt['passed']);order.append('pending-verified');return controller.receipt
  def tail():
   self.assertFalse(controller.global_locks_held);self.assertIn('shared-ops-released',order)
   self.assertFalse(controller.receipt['passed']);order.append('timer-start-idle-final-guards');controller.receipt['passed']=True;return controller.receipt
  controller.apply=apply;controller.finish_after_unlock=tail
  with patch.object(u,'controller_directory_lock',side_effect=directory),patch.object(u,'locked_files',side_effect=locks):
   result=u.execute_lifecycle(controller,aa,types.SimpleNamespace(p=object()),None)
  self.assertTrue(result['passed']);self.assertEqual(order,['directory-acquired','shared-ops-acquired','pending-verified','shared-ops-released','timer-start-idle-final-guards','directory-released'])

 def test_audit_and_check_remain_read_only_without_timer_activation(self):
  @contextmanager
  def directory(*_):yield (11,Path('/isolated'),{})
  @contextmanager
  def locks(*_):yield {}
  for mode in ('audit','check'):
   controller=self.controller();aa=args();aa.mode=mode;controller.audit=Mock(return_value={'passed':True});controller.check=Mock(return_value={'passed':True})
   controller.finish_after_unlock=Mock()
   with patch.object(u,'controller_directory_lock',side_effect=directory),patch.object(u,'locked_files',side_effect=locks):
    u.execute_lifecycle(controller,aa,types.SimpleNamespace(p=object()),None)
   controller.finish_after_unlock.assert_not_called();controller.runtime.command.assert_not_called()

 def test_restart_under_locks_starts_api_only_and_real_ready_no_timer_commands(self):
  controller=self.controller();controller.global_locks_held=True;controller.installed_units=Mock();controller.runtime.http=Mock()
  controller.restart_writers(controller.authored_marker)
  controller.runtime.command.assert_called_once_with(['systemctl','start','oasis-production-api.service'],timeout=60)
  controller.runtime.http.assert_called_once_with('http://127.0.0.1:18891/health/ready',200,'production')
  controller.event.assert_called_once_with('owned_api_ready_timers_deferred')

 def test_open_close_stop_only_exact_timers_and_preserve_api(self):
  controller=self.controller();controller.installed_units=Mock()
  controller.runtime.service=Mock(return_value={'ActiveState':'inactive','MainPID':'0'})
  controller.stop_timers(controller.authored_marker)
  controller.runtime.command.assert_called_once_with(['systemctl','stop',*u.OWN_TIMERS],timeout=60)
  self.assertNotIn('oasis-production-api.service',controller.runtime.command.call_args.args[0])

 def test_timer_tail_starts_exact_timers_only_after_pending_verification_and_success_marks_complete(self):
  controller=self.controller();order=[]
  def verified(*,complete):
   order.append('complete' if complete else 'pending');self.assertFalse(controller.global_locks_held)
   self.assertFalse(controller.receipt['passed']);controller.receipt['passed']=complete
  def started(command,**kw):
   self.assertEqual(order,['pending']);self.assertEqual(command,['systemctl','start',*u.OWN_TIMERS]);self.assertFalse(controller.receipt['passed']);order.append('timer-start')
  controller.verify_finished=verified;controller.runtime.command=started
  def idle(*_):order.append('exact-jobs-success');return self.unit_states()
  controller.wait_owned_jobs=Mock(side_effect=idle)
  with patch.object(u,'directory_lock_guard',return_value=None):result=controller.finish_after_unlock()
  self.assertTrue(result['passed']);self.assertEqual(order,['pending','timer-start','exact-jobs-success','complete'])
  self.assertEqual(result['timer_tail']['observed_running_invocations'],{})
  self.assertTrue(all(value['ExecMainCode']=='0' for value in result['timer_tail']['idle_job_status'].values()))
  self.assertIn('not fresh backup',result['timer_tail']['claim'])
  controller.global_locks_held=True
  with self.assertRaisesRegex(u.Refusal,'REQUIRES_UNLOCKED'):controller.finish_after_unlock()
  with self.assertRaisesRegex(u.Refusal,'COMPLETION_REQUIRES_UNLOCKED'):u.Controller.verify_finished(controller,complete=True)
  controller.global_locks_held=False;controller.directory_lease=None
  with self.assertRaisesRegex(u.Refusal,'COMPLETION_REQUIRES_UNLOCKED'):u.Controller.verify_finished(controller,complete=True)

 def test_transient_known_job_waits_and_never_mutates_or_marks_complete_while_busy(self):
  controller=self.controller();clock=[0.0]
  controller.installed_units=Mock(side_effect=[self.unit_states((u.OWN_JOBS[1],)),self.unit_states()])
  with patch.object(u.time,'monotonic',side_effect=lambda:clock[0]),patch.object(u.time,'sleep',side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)):
   result=controller.wait_owned_jobs(controller.authored_marker,60)
  self.assertEqual(result['pending_jobs'],[]);self.assertEqual(controller.installed_units.call_count,2)
  self.assertEqual(set(controller.waited_jobs),{u.OWN_JOBS[1]})
  self.assertFalse(controller.receipt['passed']);controller.runtime.command.assert_not_called()
  self.assertEqual(controller.fresh.call_count,2);self.assertEqual(controller.b.ops.owned_resources.call_count,2)

 def test_timeout_failed_nonzero_foreign_template_or_source_error_never_becomes_success(self):
  for code in ('ADMISSION_OWN_ONESHOT_FAILED','ADMISSION_FOREIGN_SOURCE_OR_UID_CONSUMER','ADMISSION_OWN_UNIT_CHANGED','ADMISSION_OWN_UNIT_CACHED_COMMAND_CHANGED','ADMISSION_SOURCE_PIN_CHANGED'):
   controller=self.controller();controller.installed_units=Mock(side_effect=u.Refusal(code))
   with self.subTest(code=code),self.assertRaisesRegex(u.Refusal,code):controller.wait_owned_jobs(controller.authored_marker,u.time.monotonic()+60)
   self.assertFalse(controller.receipt['passed']);controller.runtime.command.assert_not_called()
  controller=self.controller();clock=[0.0];controller.installed_units=Mock(return_value=self.unit_states((u.OWN_JOBS[0],)))
  with patch.object(u.time,'monotonic',side_effect=lambda:clock[0]),patch.object(u.time,'sleep',side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)),self.assertRaisesRegex(u.Refusal,'ONESHOT_TIMEOUT'):
   controller.wait_owned_jobs(controller.authored_marker,60)
  self.assertEqual(clock[0],60);self.assertFalse(controller.receipt['passed'])

 def test_timer_tail_job_or_final_guard_failure_remains_failed_and_cleanup_distinct(self):
  for where in ('jobs','final'):
   controller=self.controller();controller.verify_finished=Mock(side_effect=[None,u.Refusal('ADMISSION_SOURCE_PIN_CHANGED')] if where=='final' else None)
   controller.wait_owned_jobs=Mock(side_effect=u.Refusal('ADMISSION_OWN_ONESHOT_FAILED') if where=='jobs' else None,return_value=self.unit_states())
   with self.subTest(where=where),self.assertRaises(u.Refusal):controller.finish_after_unlock()
   self.assertFalse(controller.receipt['passed'])
  @contextmanager
  def directory(*_):yield (11,Path('/isolated'),{})
  @contextmanager
  def locks(*_):yield {}
  controller=self.controller();aa=args();aa.mode='apply';controller.apply=Mock(return_value=controller.receipt)
  controller.finish_after_unlock=Mock(side_effect=u.Refusal('ADMISSION_OWN_ONESHOT_FAILED'))
  controller.safe_stop_api=Mock(side_effect=u.Refusal('ADMISSION_FOREIGN_SOURCE_OR_UID_CONSUMER'))
  with patch.object(u,'controller_directory_lock',side_effect=directory),patch.object(u,'locked_files',side_effect=locks),self.assertRaisesRegex(u.Refusal,'ONESHOT_FAILED'):
   u.execute_lifecycle(controller,aa,types.SimpleNamespace(p=object()),None)
  self.assertFalse(controller.receipt['passed']);self.assertEqual(controller.receipt['error_code'],'ADMISSION_OWN_ONESHOT_FAILED')
  self.assertEqual(controller.receipt['cleanup_error_code'],'ADMISSION_FOREIGN_SOURCE_OR_UID_CONSUMER')

 def test_timeout_with_still_busy_owned_job_does_not_claim_api_stopped_or_force_unknown_cleanup(self):
  controller=self.controller();controller.directory_lease=None;controller.source_guard=Mock();controller.guardian=types.SimpleNamespace(guard=Mock())
  controller.capsule={'audit':{'state':{'protected':{},'production_pin':{'target':str(u.TARGET)}}}}
  controller.authored_paths={};controller.p=types.SimpleNamespace(PIN=Path('/isolated/PIN'),PRIVATE=Path('/isolated/private'))
  controller.b.oldops=None;controller.installed_units=Mock(side_effect=u.Refusal('ADMISSION_OWN_ONESHOT_BUSY'))
  with patch.object(u,'pin',return_value={'target':str(u.TARGET)}):controller.fail_closed(u.Refusal('ADMISSION_OWN_ONESHOT_TIMEOUT'))
  self.assertFalse(controller.receipt['passed']);self.assertFalse(controller.receipt['closed_runtime_confirmed'])
  self.assertEqual(controller.receipt['cleanup_error_code'],'ADMISSION_OWN_ONESHOT_BUSY')
  self.assertNotIn('cleanup',controller.receipt);controller.runtime.command.assert_not_called()

 def test_exact_busy_job_process_identity_and_failed_status_guard(self):
  with process_fixture('target') as f:
   name=u.OWN_JOBS[1];argv=[str(f.node),str(f.release/'platform/deploy/production-instance/monitor.mjs')]
   f.write(201,ppid=1,start='201',uids=[0]*4,argv=argv,cgroup='0::/system.slice/'+name+'\n')
   state={'MainPID':'201','ActiveState':'activating','SubState':'start','ControlPID':'0','Result':'success','ExecMainStatus':'0','ExecMainCode':'0',
          'process':{'pid':201,'start_ticks':'201','uid':'0','cwd':str(f.release/'platform'),'exe':str(f.node)}}
   body='WorkingDirectory='+str(f.release/'platform')+'\nExecStart='+' '.join(argv)+'\n';executables={str(f.node):u.executable_guard(f.node,u.NODE_SHA)}
   self.assertTrue(u.oneshot_guard(name,state,body,f.release,executables))
   for field,value in [('Result','exit-code'),('ExecMainStatus','1'),('ControlPID','99'),('SubState','foreign')]:
    with self.subTest(field=field),self.assertRaises(u.Refusal):u.oneshot_guard(name,{**state,field:value},body,f.release,executables)
   for change in ('uid','cgroup','argv','parent','tick'):
    fields={'ppid':1,'start':'201','uids':[0]*4,'argv':argv,'cgroup':'0::/system.slice/'+name+'\n'}
    if change=='uid':fields['uids']=[997]*4
    elif change=='cgroup':fields['cgroup']='0::/system.slice/foreign.service\n'
    elif change=='argv':fields['argv']=[str(f.node),'foreign.mjs']
    elif change=='parent':fields['ppid']=101
    else:fields['start']='999'
    f.write(201,**fields)
    with self.subTest(change=change),self.assertRaisesRegex(u.Refusal,'ONESHOT_PROCESS_CHANGED'):
     u.oneshot_guard(name,state,body,f.release,executables)
   idle={'MainPID':'0','ActiveState':'inactive','SubState':'dead','ControlPID':'0','Result':'success','ExecMainStatus':'0','ExecMainCode':'1'}
   self.assertFalse(u.oneshot_guard(name,idle,body,f.release,executables))
   failed={**idle,'ActiveState':'failed','SubState':'failed','Result':'exit-code','ExecMainStatus':'1'}
   with self.assertRaisesRegex(u.Refusal,'ONESHOT_FAILED'):u.oneshot_guard(name,failed,body,f.release,executables)
   self.assertFalse(u.oneshot_guard(name,failed,body,f.release,executables,cleanup=True))

 def test_oneshot_runtime_sampler_requires_real_status_fields_and_retries_only_pid_transition(self):
  class Base:
   def service(self,name):return {'MainPID':'0','ActiveState':'inactive'}
  runtime=u.make_runtime(types.SimpleNamespace(Runtime=Base));name=u.OWN_JOBS[0]
  valid='MainPID=0\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainCode=1\nControlPID=0\n'
  runtime.command=Mock(return_value=valid);result=runtime.service(name);self.assertEqual(result['ExecMainStatus'],'0')
  for raw in (valid.replace('Result=success\n',''),valid+'Result=success\n'):
   runtime.command=Mock(return_value=raw)
   with self.assertRaisesRegex(u.Refusal,'STATUS_INVALID'):runtime.service(name)
  runtime.command=Mock(side_effect=[valid.replace('MainPID=0','MainPID=201'),valid])
  self.assertEqual(runtime.service(name)['MainPID'],'0');self.assertEqual(runtime.command.call_count,2)


class RuntimeContracts(unittest.TestCase):
 def test_four_public_fields_only_and_secret_bytes_untouched(self):
  original=b'# private original\nNODE_ENV=production\nOASIS_PRODUCTION_ADMISSION_ENABLED=0\nOASIS_DATABASE_URL=postgres://literal:$(not_executed)@127.0.0.1/db\n'
  new=u.edit_runtime(original,{'OASIS_ADMISSION_PROFILE':'closed'})
  self.assertTrue(new.startswith(original));self.assertIn(b'$(not_executed)',new)
  with self.assertRaisesRegex(u.Refusal,'EDIT_INVALID'):u.edit_runtime(original,{'OASIS_PRODUCTION_ADMISSION_ENABLED':'1'})
  with self.assertRaisesRegex(u.Refusal,'EDIT_INVALID'):u.edit_runtime(original,{'OASIS_ADMISSION_PROFILE':'closed\nEVIL=1'})

 def test_closed_to_free_keeps_every_other_line(self):
  old=b'NODE_ENV=production\nOASIS_PRODUCTION_ADMISSION_ENABLED=0\n# comment retained\nOASIS_ADMISSION_PROFILE=closed\n'
  new=u.edit_runtime(old,dict(zip(u.FREE_FIELDS,('firstparty-free-v1','app_actual',str(u.TARGET),M))))
  self.assertEqual(new.splitlines()[:3],old.splitlines()[:3]);self.assertEqual(new.count(b'OASIS_ADMISSION_PROFILE='),1)

 def test_real_command_cleans_ambient_and_uses_fixed_absolute_binary(self):
  runtime=u.make_runtime(types.SimpleNamespace(Runtime=object))
  with patch.dict(os.environ,{'PATH':'/attacker','LD_PRELOAD':'bad','NODE_OPTIONS':'bad','DBUS_SYSTEM_BUS_ADDRESS':'bad','HTTPS_PROXY':'bad'}), \
       patch.object(u.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='ok',stderr='')) as call:
   self.assertEqual(runtime.command(['systemctl','show','owned']), 'ok')
  self.assertEqual(call.call_args.args[0][0],'/usr/bin/systemctl');self.assertEqual(call.call_args.kwargs['env'],u.SAFE_ENV)
  with self.assertRaisesRegex(u.Refusal,'UNKNOWN_OPERATOR'):runtime.command(['/attacker/systemctl','show'])

 def test_node_failure_raw_outputs_remain_exclusive_private(self):
  with tempfile.TemporaryDirectory() as directory:
   def exclusive(path,body):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:os.fchmod(fd,0o600);os.write(fd,body)
    finally:os.close(fd)
   runtime=u.make_runtime(types.SimpleNamespace(Runtime=object,exclusive=exclusive));runtime.diagnostics=Path(directory).resolve()
   result=types.SimpleNamespace(returncode=1,stdout='raw structured output',stderr='synthetic diagnostic secret')
   with patch.object(u.subprocess,'run',return_value=result),self.assertRaisesRegex(u.Refusal,'COMMAND_FAILED_NODE'):runtime.command(['/usr/bin/node','-e','throw'])
   files=list(Path(directory).resolve().iterdir());self.assertEqual(len(files),2)
   self.assertTrue(all(stat.S_IMODE(file.stat().st_mode)==0o600 for file in files))
   self.assertEqual(sorted(file.read_text() for file in files),['raw structured output','synthetic diagnostic secret'])

 def test_migration_uses_official_exports_never_bootstrap_or_seed(self):
  code=u.migration_script(u.TARGET)
  for word in ('seedPlatform','createApp','CREATE ROLE','bootstrap(','DROP DATABASE','listen('):self.assertNotIn(word,code)
  self.assertIn('migratePlatform()',code);self.assertIn("admissionProfile!=='closed'",code)

 def test_capacity_budget_and_reserve_no_relaxation(self):
  disk=types.SimpleNamespace(f_bavail=9<<30,f_blocks=32<<30,f_frsize=1)
  with patch.object(u.os,'statvfs',return_value=disk):self.assertEqual(u.capacity_guard(types.SimpleNamespace(BASE='/isolated'),1<<30)['budget_bytes'],1<<30)
  with self.assertRaisesRegex(u.Refusal,'TOO_SMALL'):u.capacity_guard(types.SimpleNamespace(BASE='/isolated'),(1<<30)-1)
  disk.f_bavail=5<<30
  with patch.object(u.os,'statvfs',return_value=disk),self.assertRaisesRegex(u.Refusal,'RESERVE_FAILED'):u.capacity_guard(types.SimpleNamespace(BASE='/isolated'),1<<30)


class ApprovalContracts(unittest.TestCase):
 def test_explicit_action_scope_and_real_metadata_only(self):
  value,raw,audit=proof();self.assertEqual(u.approve_proof(value,raw,audit,args())['scope_kind'],'source-upgrade')
  for key,changed in [('scope_kind','formal-launch'),('action','open'),('manifest_sha256','f'*64),
                      ('source_commit','d'*40),('financial_admission_enabled',True),('probability_admission_enabled',True),
                      ('thirdparty_financial_admission_enabled',True),('game_ids',['run']),('audit_sha256','f'*64)]:
   with self.subTest(key=key),self.assertRaises(u.Refusal):u.approve_proof({**value,key:changed},raw,audit,args())

 def test_unknown_proof_fields_expired_time_and_injected_actor_refused(self):
  value,raw,audit=proof()
  for changed in [{**value,'isolated_fixture':True},{**value,'approved_at':'2000-01-01T00:00:00Z'},
                  {**value,'approved_by':'root;run_other_command'},{**value,'passed':False},{**value,'schema':True}]:
   with self.assertRaises(u.Refusal):u.approve_proof(changed,raw,audit,args())

 def test_capsule_ignores_only_known_times_and_capacity_not_fingerprints(self):
  old={'at':'old','audit':{'at':'old','capacity':{'available':1},'state':{'inode':1}},'approval':{'approved_at':'unchanged'}}
  new=copy.deepcopy(old);new['at']='new';new['audit']['at']='new';new['audit']['capacity']={'available':2}
  self.assertEqual(u.stable_capsule(old),u.stable_capsule(new))
  new['audit']['state']['inode']=2;self.assertNotEqual(u.stable_capsule(old),u.stable_capsule(new))


class DatabaseContracts(unittest.TestCase):
 def test_initial_state_exact_oid_app_scope_11_and_zero_all_money(self):
  value=db();self.assertEqual(len(u.validate_database(value,a,args(),action='upgrade')['game_ids']),11)
  changes=[lambda v:v.update(database_oid=16385),lambda v:v['app'].update(partner_id='foreign'),
           lambda v:v['app'].update(game_ids=['run']),lambda v:v['binding'].update(provider='external'),
           lambda v:v['wallet_scope'].update(treasury_available=1),lambda v:v.update(nonzero_money=1),
           lambda v:v['counts'].update(players=1),lambda v:v['app'].update(status='active')]
  for change in changes:
   bad=copy.deepcopy(value);change(bad)
   with self.assertRaises(u.Refusal):u.validate_database(bad,a,args(),action='upgrade')

 def test_close_allows_existing_bot_obligations_without_deleting_them(self):
  value=db('close');value['counts'].update(players=1,sessions=1,wallet_users=1,rooms=1)
  value.update(pending_rooms=1,pending_pvp_operations=1,active_users=1)
  u.validate_database(value,a,args('close'),action='close')
  sql,expected=u.policy_transaction_sql('close',value,proof('close')[0],'e'*64)
  self.assertEqual(expected['state'],'closed');self.assertEqual(expected['revision'],'3')
  for key in ('proof_sha256','approved_by','approved_at','release','manifest_sha256'):self.assertEqual(expected[key],value['policy'][key])
  for command in ('DELETE','TRUNCATE','DROP','CREATE ROLE'):self.assertNotIn(command,sql)
  self.assertLess(sql.index('gp_apps WHERE'),sql.index('gp_production_admission WHERE'))
  self.assertLess(sql.index('gp_production_admission WHERE'),sql.index('gp_wallet_bindings WHERE'))

 def test_approve_does_not_activate_and_open_preserves_source_proof(self):
  value=db('approve');approval=proof('approve')[0]
  sql,policy=u.policy_transaction_sql('approve',value,approval,'e'*64)
  self.assertEqual(policy['revision'],'1');self.assertEqual(policy['state'],'closed');self.assertNotIn("status='active'",sql)
  value=db('open');sql,next_policy=u.policy_transaction_sql('open',value,proof('open')[0],'e'*64)
  self.assertEqual(next_policy['proof_sha256'],value['policy']['proof_sha256']);self.assertIn("status='active'",sql)

 def test_duplicate_approval_wrong_revision_and_repeated_action_refused(self):
  value=db('open')
  with self.assertRaisesRegex(u.Refusal,'NO_POLICY'):u.policy_transaction_sql('approve',value,proof()[0],'e'*64)
  value['policy']['revision']='9223372036854775807'
  with self.assertRaisesRegex(u.Refusal,'EXHAUSTED'):u.policy_transaction_sql('open',value,proof('open')[0],'e'*64)
  with self.assertRaises(u.Refusal):u.validate_database(db('open'),a,args('close'),action='close')

 def test_snapshot_handles_old_absent_policy_without_querying_absent_table(self):
  old=u.snapshot_sql('app_fixture_actual',policy_exists=False);new=u.snapshot_sql('app_fixture_actual')
  self.assertNotIn('FROM gp_production_admission',old);self.assertIn('FROM gp_production_admission',new)
  for code in (old,new):self.assertIn('READ ONLY',code);self.assertNotIn('OR version<>0',code)
  self.assertIn("a.id='app_APP_POLICY_FINANCIAL'",u.snapshot_sql('app_APP_POLICY_FINANCIAL'))
  with self.assertRaises(u.Refusal):u.snapshot_sql("app';DROP DATABASE live;--")

 def test_untrusted_app_column_names_cannot_become_sql_identifiers(self):
  value=db('close');value['app']['id);DROP TABLE gp_apps;--']='bad'
  with self.assertRaisesRegex(u.Refusal,'APP_COLUMNS_CHANGED'):u.policy_transaction_sql('close',value,{},'e'*64)


def retired_fixture():
 """Synthetic metadata contracts only: these documents are never live approvals."""
 aa=args();base='/opt/oasis/private/mock-source-retirement-20261010/'
 for name in ('source_audit','archive_proof','archive_review','retirement_check','retirement_receipt'):
  setattr(aa,name,base+name+'.json');setattr(aa,name+'_sha256',{'source_audit':u.SOURCE_AUDIT_SHA,
     'archive_proof':u.ARCHIVE_PROOF_SHA,'archive_review':u.ARCHIVE_REVIEW_SHA}.get(name,'d'*64))
 aa.protected_inventory=base+'reviewed.json';aa.protected_inventory_sha256='e'*64
 prior={'kind':'production-protected-inventory','paths':list(p.REQUIRED_PINS),'current':'/opt/oasis/releases/20261009-03',
        'previous':'/opt/oasis/releases/20261009-02','retirement_receipt_sha256':p.RETIRE_SHA,
        'snapshot':{'files':{'/opt/oasis/private':{**r.PUBLIC_PRIVATE_PARENT_IDENTITY,'kind':'directory'}}}}
 original=str(r.ORIGINAL_INVENTORY_PATH)
 inv={'kind':'mock-source-retirement-reviewed-inventory-v1','source_commit':'f'*40,'explicit_obsolete_archive_review':True,
      'obsolete_sources':['/opt/oasis/releases/'+name for name in u.OBSOLETE_NAMES],
      'historical_inventory':{'path':original,'sha256':u.HISTORICAL_INVENTORY_SHA,'obsolete_paths':list(u.OBSOLETE_REFS)},
      'protected_paths':[item for item in prior['paths'] if item not in u.OBSOLETE_REFS]+[original],
      'source_audit_sha256':u.SOURCE_AUDIT_SHA,'archive_proof_sha256':u.ARCHIVE_PROOF_SHA,
      'root_independent_archive_review':{'path':aa.archive_review,'sha256':u.ARCHIVE_REVIEW_SHA},
      'production_release':str(u.OLD),'production_manifest_sha256':u.OLD_MANIFEST,'helpers':u.OLD_HELPERS,
      'additional_paths':['/etc/systemd/system/oasis-production-api.service','/opt/oasis/acme/config/live/oasis-production-player/fullchain.pem']}
 snapshot={'files':dict.fromkeys(inv['protected_paths']+inv['additional_paths'],{'synthetic':True}),
           'services':{'public.service':{'synthetic':True}},'containers':{'public':{'synthetic':True}}}
 inv['snapshot']={'protected':snapshot}
 proof={'kind':'retired-mock-complete-local-archive-proof-v1','remote_before_after_equal':True,
        'source_audit_sha256':u.SOURCE_AUDIT_SHA,'trees':{},'archives':{}}
 audit={'kind':'retired-mock-source-readonly-audit','passed':True,'retirement_receipt_sha256':r.RETIREMENT_SHA,'releases':{}}
 review={'kind':'root-independent-mock-archive-review-v1','passed':True,'proof_sha256':u.ARCHIVE_PROOF_SHA,'archives':{}}
 for name in u.OBSOLETE_NAMES:
  entries={'.':{'kind':'directory','uid':0,'gid':0,'mode':0o755,'device':64515,'inode':r.ROOT_INODES[name]},
           'RELEASE-MANIFEST.json':{'kind':'file','sha256':r.MANIFESTS[name],'bytes':100}}
  tree={'entries':entries,'entries_sha256':'a'*64,'entry_count':9571,'total_file_bytes':357000000};proof['trees'][name]=tree
  archive={'full_gzip_eof_verified':True,'each_entry_verified':True,'tree_sha256':'a'*64,'entry_count':9571,'archive_sha256':'b'*64,'archive_bytes':225000000}
  proof['archives'][name]=archive
  audit['releases']['/opt/oasis/releases/'+name]={'entries':r.audit_members(tree),'manifest_sha256':r.MANIFESTS[name]}
  review['archives'][name]={'archive_sha256':'b'*64,'archive_bytes':225000000,'members':9571,'file_bytes':357000000,
        'source_tree_sha256':'a'*64,'full_body_and_metadata_verified':True,'gzip_eof_crc_and_exact_zero_tail_verified':True}
 external={'inventory_sha256':aa.protected_inventory_sha256,'source_audit_sha256':u.SOURCE_AUDIT_SHA,
     'archive_proof_sha256':u.ARCHIVE_PROOF_SHA,'root_independent_archive_review_sha256':u.ARCHIVE_REVIEW_SHA,
     'historical_inventory_sha256':u.HISTORICAL_INVENTORY_SHA,'tool_sha256':'c'*64}
 check={'kind':'mock-source-retirement-check-v1','passed':True,'source_commit':inv['source_commit'],'external_bindings':external,
        'trees':proof['trees'],'snapshot':inv['snapshot']}
 receipt={'kind':'mock-source-retirement-result-v1','passed':True,'removed':list(u.OBSOLETE_NAMES),'all_obsolete_sources_absent':True,
     'source_commit':inv['source_commit'],'obsolete_sources':inv['obsolete_sources'],'manifest_sha256':r.MANIFESTS,
     'external_bindings':{**external,'check_sha256':aa.retirement_check_sha256},'historical_inventory':inv['historical_inventory'],
     'sources':{name:{'manifest_sha256':r.MANIFESTS[name],'tree_sha256':'a'*64,'archive_sha256':'b'*64,'archive_bytes':225000000} for name in u.OBSOLETE_NAMES},
     'at':'2026-10-10T00:00:00+00:00','finished_at':'2026-10-10T00:00:01+00:00'}
 documents={original:prior,aa.source_audit:audit,aa.archive_proof:proof,aa.archive_review:review,
            aa.retirement_check:check,aa.retirement_receipt:receipt}
 def reconcile():
  check.update(inventory_canonical_json_sha256=r.digest_bytes(r.canonical(inv)),archive_proof_canonical_json_sha256=r.digest_bytes(r.canonical(proof)))
  receipt.update(archive_proof_canonical_json_sha256=r.digest_bytes(r.canonical(proof)),
       check_canonical_json_sha256=r.digest_bytes(r.canonical(check)),reviewed_snapshot_sha256=r.digest_bytes(r.canonical(inv['snapshot'])))
 reconcile()
 def read(path,expected=None,**kwargs):
  body=u.canonical(documents[str(path)]);return body,{'sha256':u.digest(body),'synthetic':True}
 bindings=types.SimpleNamespace(p=p,retirement=r,units=types.SimpleNamespace(UNIT_NAMES=('oasis-production-player-certificate.service','oasis-production-player-certificate.timer')),
    members={'platform/deploy/retire-mock-sources.py':'c'*64})
 return aa,bindings,inv,documents,reconcile,read


class RetiredProtectionContracts(unittest.TestCase):
 def test_only_two_obsolete_refs_leave_original_18_and_evidence_pins_intact(self):
  aa,b,inv,docs,_,reader=retired_fixture()
  with patch.object(u,'read_file',side_effect=reader):derived,files,retired=u.retirement_evidence(aa,b,inv,{'synthetic':True})
  self.assertEqual(set(p.REQUIRED_PINS)-set(derived['paths']),set(u.OBSOLETE_REFS));self.assertEqual(len(p.REQUIRED_PINS),20)
  self.assertEqual(len(files),7);self.assertEqual(retired['obsolete_paths'],list(u.OBSOLETE_REFS))
  self.assertNotIn('/etc/systemd/system/oasis-production-api.service',derived['snapshot']['files'])
  self.assertIn('/opt/oasis/acme/config/live/oasis-production-player/fullchain.pem',derived['snapshot']['files'])
  self.assertEqual(derived['snapshot']['services'],inv['snapshot']['protected']['services'])

 def test_third_public_path_cannot_be_silently_dropped(self):
  aa,b,inv,docs,reconcile,reader=retired_fixture();inv['protected_paths'].remove('/opt/oasis/private/postgres.env');reconcile()
  with patch.object(u,'read_file',side_effect=reader),self.assertRaisesRegex(u.Refusal,'PROTECTION_REMOVED|SILENTLY_DROPPED'):u.retirement_evidence(aa,b,inv,{})

 def test_added_third_obsolete_ref_never_widens_allowlist(self):
  aa,b,inv,docs,_,reader=retired_fixture();inv['historical_inventory']['obsolete_paths'].append('/opt/oasis/releases/20261009-02/RELEASE-MANIFEST.json')
  with patch.object(u,'read_file',side_effect=reader),self.assertRaisesRegex(u.Refusal,'EXACT_RETIRED'):u.retirement_evidence(aa,b,inv,{})

 def test_fake_receipt_missing_check_or_raw_recovery_pin_is_refused(self):
  for mutate in (lambda aa,docs:docs[aa.retirement_receipt].update(passed=False),
                 lambda aa,docs:docs[aa.retirement_receipt].update(removed=['20261008-23']),
                 lambda aa,docs:docs[aa.retirement_check].update(passed=False),
                 lambda aa,docs:setattr(aa,'archive_proof_sha256','0'*64),
                 lambda aa,docs:docs[aa.archive_review]['archives']['20261008-23'].update(gzip_eof_crc_and_exact_zero_tail_verified=False)):
   aa,b,inv,docs,_,reader=retired_fixture();mutate(aa,docs)
   with patch.object(u,'read_file',side_effect=reader),self.assertRaises(u.Refusal):u.retirement_evidence(aa,b,inv,{})

 def test_receipt_tool_sha_must_equal_target_manifest_bound_tool(self):
  aa,b,inv,docs,_,reader=retired_fixture();b.members['platform/deploy/retire-mock-sources.py']='0'*64
  with patch.object(u,'read_file',side_effect=reader),self.assertRaisesRegex(u.Refusal,'RECEIPT_REQUIRED'):u.retirement_evidence(aa,b,inv,{})

 def test_owned_path_in_public_paths_is_rejected_and_original_guard_is_not_modified(self):
  aa,b,inv,docs,reconcile,reader=retired_fixture();inv['protected_paths'].append('/opt/oasis/production-instance-private/runtime.env');reconcile()
  with patch.object(u,'read_file',side_effect=reader),self.assertRaisesRegex(u.Refusal,'SCOPE_MIXED'):u.retirement_evidence(aa,b,inv,{})

 def test_cached_unknown_execstartpre_blocks_stop_before_any_service_mutation(self):
  controller=object.__new__(u.Controller);controller.b=types.SimpleNamespace(oldp=None)
  controller.p=types.SimpleNamespace(unit_templates=lambda release,cid:{'oasis-production-api.service':'expected'},
      unit_namespace_guard=lambda templates:None,expected_commands=lambda body:{'ExecStartPre':[]})
  controller.runtime=types.SimpleNamespace(service=lambda name:{'FragmentPath':'/etc/systemd/system/'+name,'DropInPaths':'','NeedDaemonReload':'no'},
      loaded_commands=lambda name:{'ExecStartPre':['unknown']},command=Mock())
  controller.fresh=Mock();controller.event=Mock()
  with patch.object(u,'pin',return_value={'st_uid':0,'st_gid':0,'st_mode':stat.S_IFREG|0o644,'sha256':u.digest(b'expected')}), \
       self.assertRaisesRegex(u.Refusal,'CACHED_COMMAND_CHANGED'):controller.stop_writers({'release':str(u.TARGET)})
  controller.runtime.command.assert_not_called()

 def test_unretired_original_inventory_uses_original_guard_without_exceptions(self):
  aa=args();aa.protected_inventory='/opt/oasis/private/original.json'
  inventory={'kind':'production-protected-inventory','paths':list(p.REQUIRED_PINS),'current':'/opt/oasis/releases/20261009-03',
             'previous':'/opt/oasis/releases/20261009-02','retirement_receipt_sha256':p.RETIRE_SHA}
  guardian,files,retired=u.make_guardian(aa,types.SimpleNamespace(p=p),object(),inventory,{'synthetic':True})
  self.assertIs(guardian.__class__.guard,p.Provisioner.guard);self.assertEqual(guardian.protected,inventory)
  self.assertIsNone(retired);self.assertEqual(len(files),1);self.assertEqual(len(p.REQUIRED_PINS),20)
  inventory['paths'].remove(u.OBSOLETE_REFS[0])
  with self.assertRaises(p.Refusal):u.make_guardian(aa,types.SimpleNamespace(p=p),object(),inventory,{})

 def test_missing_receipt_cannot_authorize_retired_sources(self):
  aa,b,inv,docs,_,reader=retired_fixture();aa.retirement_receipt=None
  with patch.object(u,'read_file',side_effect=reader),self.assertRaisesRegex(u.Refusal,'RAW_EVIDENCE_REQUIRED'):u.retirement_evidence(aa,b,inv,{})


class FailureContracts(unittest.TestCase):
 def test_approve_retains_original_closed_configuration_and_other_three_secrets(self):
  controller=object.__new__(u.Controller);controller.args=args('approve');controller.args.approval_sha256='e'*64
  data=db('approve');approval=proof('approve')[0];_,snapshot=u.policy_transaction_sql('approve',data,approval,'e'*64)
  closed={'profile':'closed','public_origin':controller.args.origin,'app_id':None,'release':None,'manifest_sha256':None}
  marker={'private_pins':copy.deepcopy(u.INITIAL_PRIVATE),'release_history':[{'release':str(u.TARGET),
      'private_pins':copy.deepcopy(u.INITIAL_PRIVATE),'runtime_profile':closed,'policy_approvals':[]}]}
  original=copy.deepcopy(marker);controller.capsule={'audit':{'state':{'marker':marker},'database':data},'approval':approval}
  controller.receipt={};controller.authored_paths={};controller.runtime=object()
  controller.fresh=Mock();controller.event=Mock();controller.stop_writers=Mock();controller.restart_writers=Mock()
  controller.run_inspection=Mock();controller.marker_replace=Mock()
  changed={**u.INITIAL_PRIVATE['runtime.env'],'sha256':'0'*64,'inode':1025155}
  controller.p=types.SimpleNamespace(PRIVATE=u.PRIVATE,DATABASE='oasis_production',fingerprint=lambda path:changed)
  controller.b=types.SimpleNamespace(a=a,ops=types.SimpleNamespace(sql=Mock(return_value=json.dumps(snapshot))))
  raw=('NODE_ENV=production\nOASIS_PRODUCTION_ADMISSION_ENABLED=0\nOASIS_ADMISSION_PROFILE=closed\nOASIS_PUBLIC_ORIGIN='+controller.args.origin+'\n').encode()
  with patch.object(u,'read_file',return_value=(raw,{'synthetic':True})),patch.object(u,'atomic_replace',return_value={'synthetic':True}):controller.change_policy()
  result=controller.marker_replace.call_args.args[0];entry=result['release_history'][0]
  self.assertEqual(entry['configuration_history'],[{name:original['release_history'][0][name] for name in ('private_pins','runtime_profile','policy_approvals')}])
  for name in u.INITIAL_PRIVATE:
   if name!='runtime.env':self.assertEqual(result['private_pins'][name],original['private_pins'][name])
  self.assertEqual(entry['policy_approvals'][0]['state'],'closed');self.assertEqual(entry['runtime_profile']['app_id'],controller.args.app_id)
  controller.stop_writers.assert_called_once();controller.restart_writers.assert_called_once()

 def test_completed_then_lock_failure_cannot_keep_passed_true(self):
  controller=object.__new__(u.Controller);controller.receipt={'passed':True,'phase':'complete_free_open'}
  controller.safe_stop_api=Mock(return_value={'api_stopped':True,'data_deleted':False});controller.event=Mock()
  controller.fail_closed(u.Refusal('ADMISSION_LOCK_REPLACED'))
  self.assertFalse(controller.receipt['passed']);self.assertEqual(controller.receipt['failed_at_phase'],'complete_free_open')
  self.assertEqual(controller.receipt['error_code'],'ADMISSION_LOCK_REPLACED');controller.event.assert_called_once_with('failed_closed')

 def test_primary_and_cleanup_errors_are_separate_and_no_database_deletion(self):
  controller=object.__new__(u.Controller);controller.receipt={'passed':False,'phase':'policy_open_committed'}
  controller.safe_stop_api=Mock(side_effect=u.Refusal('ADMISSION_OWN_UNIT_CHANGED'));controller.event=Mock()
  controller.fail_closed(u.Refusal('ADMISSION_POLICY_HISTORY_WRITE_FAILED'))
  self.assertEqual(controller.receipt['error_code'],'ADMISSION_POLICY_HISTORY_WRITE_FAILED')
  self.assertEqual(controller.receipt['cleanup_error_code'],'ADMISSION_OWN_UNIT_CHANGED')
  self.assertNotIn('cleanup',controller.receipt)

 def test_restore_failure_blocks_stop_migration_and_source_changes(self):
  controller=object.__new__(u.Controller);controller.args=args();controller.capsule={'audit':{'state':{'marker':{'release':str(u.OLD)}}}}
  controller.fresh=Mock();controller.event=Mock();controller.receipt={};controller.runtime=object()
  oldops=types.SimpleNamespace(backup=Mock(return_value={'path':'/isolated/backup'}),restore=Mock(return_value={'passed':False}))
  controller.b=types.SimpleNamespace(oldops=oldops);controller.stop_writers=Mock()
  with self.assertRaisesRegex(u.Refusal,'RESTORE_NOT_CLEAN'):controller.upgrade()
  controller.stop_writers.assert_not_called()

 def test_close_never_rewrites_runtime_env_or_pauses_existing_room(self):
  controller=object.__new__(u.Controller);controller.args=args('close');data=db('close')
  policy=copy.deepcopy(data['policy']);policy.update(state='closed',revision='3')
  marker={'release_history':[{'release':str(u.TARGET),'policy_approvals':[copy.deepcopy(data['policy'])]}]}
  controller.capsule={'audit':{'state':{'marker':marker},'database':data},'approval':proof('close')[0]}
  controller.args.approval_sha256='e'*64;controller.receipt={};controller.fresh=Mock();controller.event=Mock()
  controller.runtime=object();controller.p=types.SimpleNamespace(DATABASE='oasis_production')
  controller.b=types.SimpleNamespace(a=a,ops=types.SimpleNamespace(sql=Mock(return_value=json.dumps(policy))))
  controller.marker_replace=Mock();controller.run_inspection=Mock();controller.stop_writers=Mock();controller.restart_writers=Mock()
  with patch.object(u,'edit_runtime',side_effect=AssertionError('must never rewrite env')):controller.change_policy()
  controller.stop_writers.assert_not_called();controller.restart_writers.assert_not_called()
  approvals=controller.marker_replace.call_args.args[0]['release_history'][0]['policy_approvals']
  self.assertEqual([item['revision'] for item in approvals],['2','3'])


if __name__=='__main__':unittest.main()

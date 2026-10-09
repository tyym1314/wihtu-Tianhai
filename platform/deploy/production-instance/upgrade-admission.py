#!/usr/bin/python3
"""Upgrade one witnessed production source; independently approve free BOT admission."""
import argparse
import ast
import copy
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
import types
from contextlib import contextmanager

OLD = Path('/opt/oasis/releases/20261010-03')
TARGET = Path('/opt/oasis/releases/20261010-04')
OLD_MANIFEST = '901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d'
RUNTIME_MANIFEST = '4b8c3b2820c271198563180983c72f25d088c63c872463704af632929adf3c0f'
RUNTIME_SOURCE_COMMIT = '63e44d330cf09c60eab0a08c03150b5f38d26ea7'
PACKAGED_CONTROLLER_SHA = '9149342b52872518ff1372f398afa8d25526369820bc4fe6f4befa47281848c5'
PROC_ROOT = Path('/proc')
NODE_EXE = Path('/usr/bin/node')
NODE_SHA = '6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd'
ESBUILD_SHA = 'e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100'
API_CGROUP = '0::/system.slice/oasis-production-api.service\n'
OWN_TIMERS = ('oasis-production-instance-backup.timer','oasis-production-instance-monitor.timer',
              'oasis-production-player-certificate.timer')
OWN_JOBS = tuple(name.replace('.timer','.service') for name in OWN_TIMERS)
ONESHOT_WAIT_SECONDS = 60
HISTORICAL_INVENTORY_SHA = 'ac5c5769946b8ea08695c56d0106bb6c8d1f562b9e7ec152f3e83fb05375eeac'
OBSOLETE_NAMES = ('20261008-23','20261008-24')
OBSOLETE_REFS = tuple('/opt/oasis/releases/'+name+'/RELEASE-MANIFEST.json' for name in OBSOLETE_NAMES)
ARCHIVE_PROOF_SHA = '6fe2c6b0e4092a779653a6c895f3011b03dd54c9e46f16e6757ce2a4149e03bf'
SOURCE_AUDIT_SHA = '4f49ee228ee1e753f3cf744bdd98e8d9ca53de8f56ed4a2aefe2d100b889b9bf'
ARCHIVE_REVIEW_SHA = 'ffde3575ca87dc950bdb1a696f365993491117203a79c0f31d67059107edbd5e'
TOOL = Path('/opt/oasis/private/production-admission-20261010/upgrade-admission.py')
PRIVATE = Path('/opt/oasis/production-instance-private')
OPERATIONS = PRIVATE / 'admission-upgrades'
CID = '2ee98b7bb89bb14a0772f5bed1b6783024241664c367531ee6b52fc22fd86af6'
OWNER = 'f35571b2005dbe05ee68a41e72d11b75'
NETWORK = 'e50c45372afb7783737e5b64d32355d0d7702ac3fa9335da4d7c99e08da1d2fc'
IMAGE = 'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb'
OID = 16384
OLD_HELPERS = {
 'provision.py':'00203af2bf2c727fcbcee2b5288da91af584f5fb4dd252de56e18e7c3be1e5cd',
 'operations.py':'9631ba7693914ec08a11d8bb1c42c6a6b001cf9b2985b5a4ba2c3ac51ba2da76',
 'bootstrap.mjs':'754397b8b4604a66bbcaf5010e1a13ae21675dd024f00b729289019e301abe5a',
 'inspect-backup.mjs':'07adc794f4fdceb393ca9c59f0a70235a34bb444ba3f4e16a2559e1211350c23',
 'monitor.mjs':'a846a8958d1e29ad8ee4785512642ffc52ce709816a685166c4d95685005afa5'}
INITIAL_PRIVATE = {
 'runtime.env':{'uid':0,'gid':0,'mode':384,'device':64515,'inode':1025151,'kind':'file','bytes':1314,'sha256':'fbb0183f48f12ded3691d4209ed3cfd7047c86f83d04a52e0e8bc06f0d10388a'},
 'postgres.env':{'uid':0,'gid':0,'mode':384,'device':64515,'inode':1025150,'kind':'file','bytes':143,'sha256':'cc982fae7a2d9e75e1c72656e4549884ea6a3914d2868a6eca9131c56eccc4bc'},
 'operator-credentials.json':{'uid':0,'gid':0,'mode':384,'device':64515,'inode':1025152,'kind':'file','bytes':102,'sha256':'fef47affc281cbc2ce75742b886aa17f9523c56c7c37f391508d29283384421c'},
 'state/master.key':{'uid':997,'gid':999,'mode':384,'device':64515,'inode':1025149,'kind':'file','bytes':32,'sha256':'1d5da6c1aba28f6ccfdab053cf0f991ebe8db61196b53d5bcba8d233050fb27a'}}
ACTIONS = ('upgrade','approve','open','close')
FREE_FIELDS = ('OASIS_ADMISSION_PROFILE','OASIS_FIRSTPARTY_APP_ID',
               'OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256')
POLICY_FIELDS = ('app_id','profile','state','revision','scope','currency_scale','allowed_origins',
                 'game_ids','release','manifest_sha256','proof_sha256','approved_by','approved_at')
APP_FIELDS = ('id','partner_id','environment','wallet_scope_id','currency_id','currency_scale','status',
              'wallet_url','allowed_origins','game_ids','competitive_fee_bps','math_profile')
SAFE_ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}


class Refusal(Exception):
 pass


def require(condition, code):
 if not condition: raise Refusal(code)


def digest(body): return hashlib.sha256(body).hexdigest()
def canonical(value): return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def utcnow(): return dt.datetime.now(dt.timezone.utc).isoformat()
def sha(value): return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None
def literal(value): return "'"+value.replace("'","''")+"'"


def stable_capsule(value):
 result=copy.deepcopy(value);result.pop('at',None);result.pop('capacity',None)
 if isinstance(result.get('audit'),dict):result['audit'].pop('at',None);result['audit'].pop('capacity',None)
 return result


def capacity_guard(p,budget):
 require(type(budget) is int and budget>=1<<30,'ADMISSION_CAPACITY_BUDGET_TOO_SMALL')
 disk=os.statvfs(p.BASE);available=disk.f_bavail*disk.f_frsize;total=disk.f_blocks*disk.f_frsize
 require(available-budget>=max(3<<30,total*0.15),'ADMISSION_CAPACITY_RESERVE_FAILED')
 return {'available_bytes':available,'total_bytes':total,'budget_bytes':budget}


def pin(path, *, symlink=False):
 path=Path(path);s=path.lstat()
 require(s.st_nlink==1 if not stat.S_ISDIR(s.st_mode) else True,'ADMISSION_FILE_LINK_COUNT_CHANGED')
 result={name:getattr(s,name) for name in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')}
 if stat.S_ISLNK(s.st_mode):
  require(symlink,'ADMISSION_SYMLINK_REJECTED');result['target']=os.readlink(path)
 elif stat.S_ISREG(s.st_mode):
  result['sha256']=digest(read_file(path,limit=16<<20)[0])
 else: require(stat.S_ISDIR(s.st_mode),'ADMISSION_SPECIAL_FILE_REJECTED')
 return result


def read_file(path, expected=None, *, private=False, limit=8<<20):
 path=Path(path)
 require(not any(parent.is_symlink() for parent in path.parents),'ADMISSION_PARENT_SYMLINK_REJECTED')
 if private:
  for parent in path.parents:
   value=parent.lstat()
   require(stat.S_ISDIR(value.st_mode) and not value.st_mode&0o022
           and (value.st_uid==0 or (parent==Path('/opt/oasis/private') and value.st_uid==value.st_gid==998
                                  and value.st_dev==64515 and value.st_ino==934465
                                  and stat.S_IMODE(value.st_mode)==0o700)),
           'ADMISSION_PRIVATE_PARENT_UNSAFE')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd)
  require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<=before.st_size<=limit,'ADMISSION_REGULAR_FILE_REQUIRED')
  if private: require(before.st_uid==0 and stat.S_IMODE(before.st_mode)==0o600,'ADMISSION_PRIVATE_FILE_UNSAFE')
  body=bytearray()
  while True:
   block=os.read(fd,65536)
   if not block: break
   body.extend(block);require(len(body)<=limit,'ADMISSION_FILE_TOO_LARGE')
  after=os.fstat(fd);leaf=path.lstat()
  fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
  require(all(getattr(before,key)==getattr(after,key)==getattr(leaf,key) for key in fields)
          and len(body)==before.st_size,'ADMISSION_FILE_CHANGED_DURING_READ')
  result={key:getattr(before,key) for key in fields};result['sha256']=digest(body)
  require(expected is None or digest(body)==expected,'ADMISSION_EXTERNAL_HASH_MISMATCH')
  return bytes(body),result
 finally: os.close(fd)


def module_bytes(path, expected, *, inject=None, strip_loaders=False):
 body,identity=read_file(path,expected)
 tree=ast.parse(body,filename=str(path))
 if strip_loaders:
  known=[("spec=importlib.util.spec_from_file_location('oasis_provision',Path(__file__).with_name('provision.py'))\np=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(p)",'p'),
         ("admission_spec=importlib.util.spec_from_file_location('oasis_admission_runtime',Path(__file__).with_name('admission-runtime.py'))\na=importlib.util.module_from_spec(admission_spec)\nadmission_spec.loader.exec_module(a)",'a')]
  for source,key in known:
   signature=[ast.dump(node,include_attributes=False) for node in ast.parse(source).body]
   matches=[i for i in range(len(tree.body)-2) if [ast.dump(node,include_attributes=False) for node in tree.body[i:i+3]]==signature]
   if key in (inject or {}):
    require(len(matches)==1,'ADMISSION_HELPER_LOADER_SHAPE_CHANGED');del tree.body[matches[0]:matches[0]+3]
   else: require(not matches,'ADMISSION_UNBOUND_HELPER_IMPORT')
 module=types.ModuleType('oasis_admission_verified_'+Path(path).stem.replace('-','_'))
 module.__file__=str(path);module.__dict__.update(inject or {})
 exec(compile(tree,str(path),'exec'),module.__dict__)
 require(pin(path)==identity,'ADMISSION_HELPER_REPLACED_AFTER_IMPORT')
 return module,identity


def manifest_bytes(release, expected):
 require(release in (OLD,TARGET) and not release.is_symlink(),'ADMISSION_EXACT_RELEASE_REQUIRED')
 raw,identity=read_file(release/'RELEASE-MANIFEST.json',expected)
 members=json.loads(raw)
 require(isinstance(members,dict) and members and all(isinstance(name,str) and not Path(name).is_absolute()
         and '..' not in Path(name).parts and sha(value) for name,value in members.items()),'ADMISSION_MANIFEST_INVALID')
 return members,identity


def complete_members(p,release,members):
 for name,expected in members.items():
  path=release/name
  require(not any(parent.is_symlink() for parent in path.parents),'ADMISSION_RELEASE_PARENT_SYMLINK')
  value=p.fingerprint(path)
  require(value.get('kind')=='file' and value['uid']==0 and not value['mode']&0o022
          and value['sha256']==expected,'ADMISSION_COMPLETE_RELEASE_MEMBER_CHANGED')
 return {'member_count':len(members),'manifest_members_sha256':digest(canonical(members))}


def dependency_tree(p,release):
 root=release/'platform/node_modules';p.no_mount(root)
 require(root.is_dir() and not root.is_symlink(),'ADMISSION_DEPENDENCY_ROOT_UNSAFE')
 result={}
 for path in [root,*sorted(root.rglob('*'))]:
  s=path.lstat();require(s.st_uid==0,'ADMISSION_DEPENDENCY_OWNER_CHANGED')
  value={'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}
  if stat.S_ISLNK(s.st_mode):
   target=path.resolve(strict=True);require(root in target.parents,'ADMISSION_DEPENDENCY_EXTERNAL_SYMLINK')
   value.update(kind='symlink',target=os.readlink(path))
  else:
   require(not s.st_mode&0o022,'ADMISSION_DEPENDENCY_WRITABLE')
   if stat.S_ISDIR(s.st_mode):value['kind']='directory'
   else:
    require(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'ADMISSION_DEPENDENCY_SPECIAL_OR_LINKED')
    fp=p.fingerprint(path);value.update(kind='file',bytes=fp['bytes'],sha256=fp['sha256'])
  result[str(path.relative_to(root))]=value
 require(0<len(result)<=30000 and (root/'tsx/dist/loader.mjs').is_file(),'ADMISSION_DEPENDENCY_CLOSURE_INVALID')
 return {'entries':len(result),'sha256':digest(canonical(result))}


def runtime_controller_binding(args,members):
 require(args.manifest_sha256==RUNTIME_MANIFEST and args.source_commit==RUNTIME_SOURCE_COMMIT
         and members.get('platform/deploy/production-instance/upgrade-admission.py')==PACKAGED_CONTROLLER_SHA,
         'ADMISSION_FROZEN_RUNTIME_CONTROLLER_OR_SOURCE_CHANGED')
 return PACKAGED_CONTROLLER_SHA


def load_bindings(args):
 require(Path(args.release)==TARGET and sha(args.manifest_sha256),'ADMISSION_TARGET_REQUIRED')
 old,oldpin=manifest_bytes(OLD,OLD_MANIFEST);new,newpin=manifest_bytes(TARGET,args.manifest_sha256)
 prefix='platform/deploy/production-instance/'
 require(all(old.get(prefix+name)==value for name,value in OLD_HELPERS.items()),'ADMISSION_ORIGINAL_SOURCE_CHANGED')
 packaged_sha=runtime_controller_binding(args,new)
 _,packaged_pin=read_file(TARGET/(prefix+'upgrade-admission.py'),packaged_sha)
 p,ppin=module_bytes(TARGET/(prefix+'provision.py'),new[prefix+'provision.py']);p.Refusal=Refusal
 a,apin=module_bytes(TARGET/(prefix+'admission-runtime.py'),new[prefix+'admission-runtime.py'])
 ops,opin=module_bytes(TARGET/(prefix+'operations.py'),new[prefix+'operations.py'],inject={'p':p,'a':a},strip_loaders=True)
 op,oldppin=module_bytes(OLD/(prefix+'provision.py'),OLD_HELPERS['provision.py']);op.Refusal=Refusal
 oldops,oldopin=module_bytes(OLD/(prefix+'operations.py'),OLD_HELPERS['operations.py'],inject={'p':op},strip_loaders=True)
 ingress,ipin=module_bytes(TARGET/'platform/deploy/production-ingress.py',new['platform/deploy/production-ingress.py'])
 units,upin=module_bytes(TARGET/'platform/deploy/production-ingress-units.py',new['platform/deploy/production-ingress-units.py'])
 retirement,rpin=module_bytes(TARGET/'platform/deploy/retire-mock-sources.py',new['platform/deploy/retire-mock-sources.py']);retirement.Refusal=Refusal
 pins={str(TARGET/(prefix+'provision.py')):ppin,str(TARGET/(prefix+'admission-runtime.py')):apin,
       str(TARGET/(prefix+'operations.py')):opin,str(OLD/(prefix+'provision.py')):oldppin,
       str(OLD/(prefix+'operations.py')):oldopin,str(TARGET/'platform/deploy/production-ingress.py'):ipin,
       str(TARGET/'platform/deploy/production-ingress-units.py'):upin,str(TARGET/'platform/deploy/retire-mock-sources.py'):rpin,
       str(OLD/'RELEASE-MANIFEST.json'):oldpin,str(TARGET/'RELEASE-MANIFEST.json'):newpin,
       str(TARGET/(prefix+'upgrade-admission.py')):packaged_pin}
 p.verify_release(TARGET,args.manifest_sha256);p.verify_historical_release(OLD,OLD_MANIFEST,OLD_HELPERS)
 complete_members(p,TARGET,new);complete_members(p,OLD,old)
 dependencies=dependency_tree(p,OLD)
 require(dependency_tree(p,TARGET)==dependencies,'ADMISSION_RUNTIME_DEPENDENCIES_CHANGED')
 job_executables={str(path):executable_guard(path,expected) for path,expected in
                  ((NODE_EXE,NODE_SHA),(Path('/usr/bin/python3').resolve(strict=True),None))}
 return types.SimpleNamespace(p=p,a=a,ops=ops,oldp=op,oldops=oldops,ingress=ingress,units=units,retirement=retirement,
                              members=new,old_members=old,pins=pins,dependencies=dependencies,job_executables=job_executables)


def controller_guard(args, bindings):
 require(Path(__file__).absolute()==TOOL and sha(args.controller_sha256)
         and args.source_commit==RUNTIME_SOURCE_COMMIT and args.manifest_sha256==RUNTIME_MANIFEST
         and isinstance(args.controller_origin_commit,str) and re.fullmatch('[a-f0-9]{40}',args.controller_origin_commit),
         'ADMISSION_CONTROLLER_LOCATION_OR_PROVENANCE_INVALID')
 body,identity=read_file(TOOL,args.controller_sha256,private=True)
 directory=pin(TOOL.parent)
 require(stat.S_ISDIR(directory['st_mode']) and directory['st_uid']==directory['st_gid']==0
         and stat.S_IMODE(directory['st_mode'])==0o700,'ADMISSION_CONTROLLER_DIRECTORY_UNSAFE')
 bindings.p.no_mount(TOOL.parent)
 require(all(pin(Path(path))==value for path,value in bindings.pins.items()),'ADMISSION_EXECUTING_HELPER_CHANGED')
 require(all(executable_guard(Path(path),value['sha256'])==value for path,value in bindings.job_executables.items()),
         'ADMISSION_JOB_EXECUTABLE_CHANGED')
 return {'tool_sha256':digest(body),'tool_pin':identity,'directory_pin':directory,'source_commit':args.source_commit,
         'runtime_source_commit':args.source_commit,'controller_origin_commit':args.controller_origin_commit,
         'packaged_controller_sha256':PACKAGED_CONTROLLER_SHA,
         'bindings':bindings.pins,'job_executables':bindings.job_executables}


def edit_runtime(original, fields):
 """Keep every byte outside the four public admission lines unchanged."""
 require(isinstance(original,bytes) and original.endswith(b'\n') and set(fields)<=set(FREE_FIELDS),
         'ADMISSION_RUNTIME_EDIT_INVALID')
 require(all(isinstance(value,str) and '\n' not in value and '\r' not in value and '\0' not in value for value in fields.values()),
         'ADMISSION_RUNTIME_EDIT_INVALID')
 lines=original.splitlines(keepends=True)
 kept=[line for line in lines if line.split(b'=',1)[0].decode('ascii',errors='ignore') not in FREE_FIELDS]
 result=b''.join(kept)+''.join(name+'='+fields[name]+'\n' for name in FREE_FIELDS if name in fields).encode()
 require([line for line in result.splitlines(keepends=True) if line.split(b'=',1)[0].decode('ascii',errors='ignore') not in FREE_FIELDS]==kept,
         'ADMISSION_NON_PROFILE_CONFIG_CHANGED')
 return result


def atomic_replace(path, body, expected, *, mode=0o600):
 path=Path(path);require(pin(path)==expected,'ADMISSION_REPLACEMENT_TARGET_CHANGED')
 require(stat.S_ISREG(expected['st_mode']) and expected['st_nlink']==1,'ADMISSION_REPLACEMENT_TARGET_UNSAFE')
 temporary=path.with_name('.admission-'+secrets.token_hex(16))
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  os.fchmod(fd,mode);os.fchown(fd,expected['st_uid'],expected['st_gid'])
  with os.fdopen(fd,'wb',closefd=False) as stream: stream.write(body);stream.flush();os.fsync(fd)
  require(pin(path)==expected,'ADMISSION_REPLACEMENT_TARGET_CHANGED')
  created=pin(temporary);require(created['sha256']==digest(body),'ADMISSION_REPLACEMENT_BYTES_CHANGED')
  os.replace(temporary,path)
  actual=pin(path)
  require(all(actual[key]==created[key] for key in created if key not in ('st_mtime_ns','st_ctime_ns')),
          'ADMISSION_REPLACEMENT_READBACK_CHANGED')
  return actual
 finally:
  os.close(fd)
  if temporary.exists():
   require(pin(temporary).get('sha256')==digest(body),'ADMISSION_TEMPORARY_REPLACED');temporary.unlink()


@contextmanager
def locked_files(p, expected=None):
 paths=(p.BASE/'private/release.lock',p.PRIVATE/'operations.lock');opened=[];identities={}
 try:
  for path in paths:
   before=pin(path);require(stat.S_ISREG(before['st_mode']) and before['st_uid']==before['st_gid']==0
                            and before['st_size']==0 and stat.S_IMODE(before['st_mode'])==(0o644 if path==paths[0] else 0o600),
                            'ADMISSION_LOCK_UNSAFE')
   require(expected is None or expected[str(path)]==before,'ADMISSION_LOCK_CAPSULE_CHANGED')
   fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW);opened.append((fd,path,before))
   lock_guard(fd,path,before);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);lock_guard(fd,path,before)
   identities[str(path)]=before
  yield identities
  for fd,path,before in opened: lock_guard(fd,path,before)
 finally:
  for fd,_,_ in reversed(opened): os.close(fd)


def lock_guard(fd,path,expected):
 s=os.fstat(fd)
 require(stat.S_ISREG(s.st_mode) and all(getattr(s,key)==expected[key] for key in
         ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))
         and pin(path)==expected,'ADMISSION_LOCK_REPLACED')


def directory_lock_guard(fd,path,expected):
 actual=os.fstat(fd)
 require(stat.S_ISDIR(actual.st_mode) and actual.st_uid==actual.st_gid==0
         and stat.S_IMODE(actual.st_mode)==0o700 and all(getattr(actual,key)==expected[key] for key in expected)
         and pin(path)==expected,'ADMISSION_DIRECTORY_LOCK_REPLACED')


@contextmanager
def controller_directory_lock(args,bindings):
 controller_guard(args,bindings);path=TOOL.parent;expected=pin(path)
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  directory_lock_guard(fd,path,expected)
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);directory_lock_guard(fd,path,expected)
  yield fd,path,expected
  directory_lock_guard(fd,path,expected)
 finally:os.close(fd)


def make_runtime(p):
 class OperatorRuntime(p.Runtime):
  diagnostics=None
  def service(self,name):
   if name not in OWN_JOBS:return super().service(name)
   for attempt in range(3):
    try:result=super().service(name)
    except FileNotFoundError:continue
    raw=self.command(['systemctl','show',name,'--no-pager','--property=MainPID,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode,ControlPID'])
    rows=[line.split('=',1) for line in raw.splitlines() if '=' in line]
    extra=dict(rows)
    require(len(rows)==len(extra) and set(extra)=={'MainPID','ActiveState','SubState','Result','ExecMainStatus','ExecMainCode','ControlPID'},
            'ADMISSION_ONESHOT_STATUS_INVALID')
    if all(result.get(key)==extra[key] for key in ('MainPID','ActiveState')):return {**result,**extra}
   raise Refusal('ADMISSION_ONESHOT_TRANSITION')
  def command(self,args,*,input=None,env=None,timeout=60,binary=False):
   executables={'docker':'/usr/bin/docker','systemctl':'/usr/bin/systemctl',
                '/usr/bin/node':'/usr/bin/node','/usr/sbin/runuser':'/usr/sbin/runuser'}
   require(args and args[0] in executables,'ADMISSION_UNKNOWN_OPERATOR_COMMAND')
   clean=dict(SAFE_ENV)
   if env: clean.update(env)
   require(not any(key in clean for key in ('NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','LD_PRELOAD','LD_LIBRARY_PATH',
            'DBUS_SYSTEM_BUS_ADDRESS','PYTHONPATH','PYTHONHOME')),'ADMISSION_UNSAFE_CHILD_ENVIRONMENT')
   try:
    result=subprocess.run([executables[args[0]],*args[1:]],input=input,capture_output=True,
                          text=not binary,timeout=timeout,env=clean,check=False)
   except (OSError,subprocess.TimeoutExpired): raise Refusal('ADMISSION_COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
   if result.returncode:
    if args[0]=='/usr/bin/node' and self.diagnostics:
     token=secrets.token_hex(8)
     for name,value in (('stdout',result.stdout),('stderr',result.stderr)):
      body=value if isinstance(value,bytes) else value.encode()
      p.exclusive(self.diagnostics/('node-'+token+'.'+name),body[:8<<20])
    raise Refusal('ADMISSION_COMMAND_FAILED_'+Path(args[0]).name.upper())
   return result.stdout
 return OperatorRuntime()


def policy_projection(alias='q'):
 values=[]
 for name in POLICY_FIELDS:
  value=f'{alias}.{name}'
  if name=='revision': value+='::text'
  if name=='approved_at': value=f"to_char({value} AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
  values.extend((literal(name),value))
 return 'json_build_object('+','.join(values)+')'


def snapshot_sql(app_id, *, policy_exists=True):
 require(re.fullmatch('app_[A-Za-z0-9_-]{1,124}',app_id or ''),'ADMISSION_APP_ID_INVALID')
 app='json_build_object('+','.join(literal(name)+',a.'+name for name in APP_FIELDS)+')'
 policy='(SELECT '+policy_projection()+' FROM gp_production_admission q WHERE q.app_id='+literal(app_id)+')' if policy_exists else 'null'
 financial_tables=('wallet_ledger','wallet_operations','wallet_matches','wallet_reservations','wallet_probability','wallet_events',
                   'wallet_operation_ids','gp_cycles','gp_operations','gp_plays','gp_transfers','gp_transfer_accounts',
                   'gp_transfer_outbox','wallet_transfer_clearing','gp_transfer_bindings')
 financial='+'.join('(SELECT count(*) FROM '+name+')' for name in financial_tables)
 return """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT json_build_object(
 'database',current_database(),'database_oid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),
 'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),
 'apps',(SELECT count(*)::int FROM gp_apps),
 'app',(SELECT {app} FROM gp_apps a WHERE a.id={app_id}),
 'binding',(SELECT json_build_object('app_id',b.app_id,'provider',b.provider,'wallet_url',b.wallet_url,'wallet_key_id',b.wallet_key_id,'scope',b.scope) FROM gp_wallet_bindings b WHERE b.app_id={app_id}),
 'wallet_scope',(SELECT to_jsonb(w)-'created_at'-'updated_at' FROM wallet_scopes w WHERE w.app_id={app_id}),
 'policy',{policy},
 'counts',json_build_object('players',(SELECT count(*)::int FROM gp_players),'logins',(SELECT count(*)::int FROM gp_player_sessions),
 'sessions',(SELECT count(*)::int FROM gp_sessions),'wallet_users',(SELECT count(*)::int FROM wallet_users),
 'rooms',(SELECT count(*)::int FROM pvp_rooms),'transfers',(SELECT count(*)::int FROM gp_transfers)),
 'financial_rows',{financial},
 'nonzero_money',(SELECT count(*) FROM wallet_users WHERE available<>0 OR reserved<>0 OR credit_pending<>0)
  +(SELECT count(*) FROM wallet_scopes WHERE treasury_available<>0 OR treasury_reserved<>0 OR treasury_inbound<>0 OR fee_available<>0 OR fee_pending<>0 OR ledger_version<>0),
 'pending_rooms',(SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')),
 'pending_pvp_operations',(SELECT count(*) FROM pvp_operations WHERE state='PENDING'),
 'active_users',(SELECT count(*) FROM pvp_active_users)
);
COMMIT;
""".format(app=app,app_id=literal(app_id),policy=policy,financial=financial)


def validate_database(value, a, args, *, action):
 require(value.get('database')=='oasis_production' and type(value.get('database_oid')) is int and value['database_oid']==OID
         and value.get('environment')=='production' and type(value.get('apps')) is int and value['apps']==1,'ADMISSION_DATABASE_IDENTITY_CHANGED')
 app=value.get('app');require(isinstance(app,dict) and app.get('id')==args.app_id
         and app.get('partner_id')=='partner_oasis_platform' and app.get('environment')=='production'
         and app.get('wallet_url')=='' and app.get('status') in ('active','paused'),'ADMISSION_APP_CHANGED')
 require(type(app.get('currency_scale')) is int and 0<=app['currency_scale']<=6
         and isinstance(app.get('game_ids'),list) and len(app['game_ids'])==11 and set(app['game_ids'])==a.ARENA_GAMES,
         'ADMISSION_GAME_OR_CURRENCY_SCOPE_CHANGED')
 scope={name:app['id'] if name=='app_id' else app[name] for name in a.SCOPE_FIELDS}
 require(all(a.identifier(item) for item in scope.values()) and isinstance(app.get('allowed_origins'),list)
         and len(set(app['allowed_origins']))==len(app['allowed_origins']) and args.origin in app['allowed_origins']
         and all(a.public_origin(origin) for origin in app['allowed_origins']),'ADMISSION_APP_SCOPE_CHANGED')
 binding=value.get('binding');wallet=value.get('wallet_scope')
 require(isinstance(binding,dict) and binding.get('app_id')==app['id'] and binding.get('provider')=='platform'
         and binding.get('wallet_url') is None and binding.get('wallet_key_id') is None and binding.get('scope')==scope,
         'ADMISSION_PLATFORM_BINDING_CHANGED')
 require(isinstance(wallet,dict) and all(wallet.get(name)==scope[name] for name in a.SCOPE_FIELDS)
         and wallet.get('scope_id')==':'.join(scope[name] for name in a.SCOPE_FIELDS)
         and wallet.get('currency_scale')==app['currency_scale'],'ADMISSION_WALLET_SCOPE_CHANGED')
 require(all(str(wallet.get(name))=='0' for name in ('treasury_available','treasury_reserved','treasury_inbound',
         'fee_available','fee_pending','ledger_version')) and value.get('financial_rows')==0 and value.get('nonzero_money')==0,
         'ADMISSION_FINANCIAL_STATE_NOT_EMPTY')
 counts=value.get('counts');require(isinstance(counts,dict) and all(type(item) is int and item>=0 for item in counts.values()),
                                  'ADMISSION_DATABASE_COUNTS_INVALID')
 if action in ('upgrade','approve'):
  require(app['status']=='paused' and value.get('policy') is None and all(item==0 for item in counts.values())
          and value.get('pending_rooms')==value.get('pending_pvp_operations')==value.get('active_users')==0,
          'ADMISSION_INITIAL_CLOSED_STATE_CHANGED')
 else:
  policy=a.normalize_policy(value.get('policy'));require(policy['scope']==scope and policy['currency_scale']==app['currency_scale']
          and set(policy['game_ids'])==set(app['game_ids']) and set(policy['allowed_origins'])==set(app['allowed_origins'])
          and policy['release']==str(TARGET) and policy['manifest_sha256']==args.manifest_sha256,
          'ADMISSION_POLICY_SCOPE_CHANGED')
  require((policy['state']=='open' and app['status']=='active') or (policy['state']=='closed' and app['status']=='paused'),
          'ADMISSION_APP_POLICY_STATE_CHANGED')
  require(policy['state']==('closed' if action=='open' else 'open'),'ADMISSION_ACTION_STATE_CHANGED')
 return {'scope':scope,'currency_scale':app['currency_scale'],'allowed_origins':sorted(app['allowed_origins']),
         'game_ids':sorted(app['game_ids'])}


def approve_proof(value, audit_raw, audit, args):
 required={'schema','kind','passed','action','scope_kind','audit_sha256','release','manifest_sha256','source_commit',
           'app_id','scope','currency_scale','allowed_origins','game_ids','profile','financial_admission_enabled',
           'probability_admission_enabled','thirdparty_financial_admission_enabled','approved_by','approved_at'}
 require(isinstance(value,dict) and set(value)==required and type(value.get('schema')) is int and value['schema']==1
         and value.get('kind')=='production-firstparty-admission-approval' and value.get('passed') is True,
         'ADMISSION_ROOT_APPROVAL_REQUIRED')
 require(value['action']==args.action and value['scope_kind']==('source-upgrade' if args.action=='upgrade' else 'firstparty-free-only')
         and value['audit_sha256']==digest(audit_raw) and audit.get('passed') is True
         and value['release']==str(TARGET) and value['manifest_sha256']==args.manifest_sha256
         and value['source_commit']==args.source_commit and value['app_id']==args.app_id
         and value['profile']=='firstparty-free-v1','ADMISSION_ROOT_APPROVAL_SCOPE_CHANGED')
 require(all(value[name] is False for name in ('financial_admission_enabled','probability_admission_enabled',
                                             'thirdparty_financial_admission_enabled')),'ADMISSION_ROOT_APPROVAL_FINANCIAL_FORBIDDEN')
 require(re.fullmatch('[A-Za-z0-9_-]{1,128}',value['approved_by'] or ''),'ADMISSION_ROOT_APPROVAL_ACTOR_INVALID')
 try:
  approved=dt.datetime.fromisoformat(value['approved_at'].replace('Z','+00:00'))
  require(approved.tzinfo is not None and 0<=(dt.datetime.now(dt.timezone.utc)-approved).total_seconds()<=600,
          'ADMISSION_ROOT_APPROVAL_NOT_FRESH')
 except (ValueError,TypeError,AttributeError): raise Refusal('ADMISSION_ROOT_APPROVAL_TIME_INVALID') from None
 require(all(value[name]==audit['policy_scope'][name] for name in ('scope','currency_scale','allowed_origins','game_ids')),
         'ADMISSION_ROOT_APPROVAL_METADATA_CHANGED')
 return value


def policy_transaction_sql(action,data,approval,proof_sha):
 """App → policy → binding → wallet scope, identical to request admission locks."""
 require(action in ('approve','open','close') and sha(proof_sha),'ADMISSION_POLICY_TRANSACTION_INVALID')
 app=data['app'];require(isinstance(app,dict) and set(app)==set(APP_FIELDS),'ADMISSION_APP_COLUMNS_CHANGED')
 app_id=app['id'];require(re.fullmatch('app_[A-Za-z0-9_-]{1,124}',app_id or ''),'ADMISSION_APP_ID_INVALID');q=literal(app_id)
 app_expression='jsonb_build_object('+','.join(literal(name)+',a.'+name for name in APP_FIELDS)+')'
 expected=literal(json.dumps(app,separators=(',',':')))+'::jsonb'
 before=data.get('policy')
 if action=='approve':
  require(before is None and app['status']=='paused','ADMISSION_APPROVE_REQUIRES_NO_POLICY')
  policy={'app_id':app_id,'profile':'firstparty-free-v1','state':'closed','revision':'1',
          **{name:approval[name] for name in ('scope','currency_scale','allowed_origins','game_ids')},
          'release':str(TARGET),'manifest_sha256':approval['manifest_sha256'],'proof_sha256':proof_sha,
          'approved_by':approval['approved_by'],'approved_at':approval['approved_at']}
  guard=f"IF EXISTS(SELECT 1 FROM gp_production_admission WHERE app_id={q}) THEN RAISE EXCEPTION 'POLICY_ALREADY_EXISTS'; END IF;"
  columns=','.join(POLICY_FIELDS)
  values=[]
  for name in POLICY_FIELDS:
   value=policy[name]
   values.append(literal(json.dumps(value,separators=(',',':'))) +'::jsonb' if isinstance(value,(dict,list)) else literal(str(value)))
  change=f'INSERT INTO gp_production_admission({columns}) VALUES('+','.join(values)+');'
 else:
  require(isinstance(before,dict) and before['state']==('closed' if action=='open' else 'open'),
          'ADMISSION_POLICY_TRANSACTION_STATE_CHANGED')
  require(int(before['revision'])<9223372036854775807,'ADMISSION_POLICY_REVISION_EXHAUSTED')
  policy=copy.deepcopy(before);policy.update(state='open' if action=='open' else 'closed',revision=str(int(before['revision'])+1))
  guard=f"IF (SELECT {policy_projection()}::jsonb FROM gp_production_admission q WHERE q.app_id={q}) IS DISTINCT FROM {literal(json.dumps(before,separators=(',',':')))}::jsonb THEN RAISE EXCEPTION 'POLICY_CHANGED_AFTER_CHECK'; END IF;"
  status=literal('active' if action=='open' else 'paused')
  change=f"UPDATE gp_apps SET status={status} WHERE id={q}; UPDATE gp_production_admission SET state={literal(policy['state'])},revision=revision+1,updated_at=now() WHERE app_id={q};"
 binding=literal(json.dumps(data['binding'],separators=(',',':')))+'::jsonb'
 wallet=literal(json.dumps(data['wallet_scope'],separators=(',',':')))+'::jsonb'
 sql=f"""BEGIN;
SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='15s';
SELECT id FROM gp_apps WHERE id={q} FOR UPDATE;
SELECT app_id FROM gp_production_admission WHERE app_id={q} FOR UPDATE;
SELECT app_id FROM gp_wallet_bindings WHERE app_id={q} FOR SHARE;
SELECT scope_id FROM wallet_scopes WHERE app_id={q} FOR SHARE;
DO $admission_guard$ BEGIN
 IF current_database()!='oasis_production' OR (SELECT oid FROM pg_database WHERE datname=current_database())!={OID} THEN RAISE EXCEPTION 'DATABASE_IDENTITY_CHANGED'; END IF;
 IF (SELECT {app_expression} FROM gp_apps a WHERE a.id={q}) IS DISTINCT FROM {expected} THEN RAISE EXCEPTION 'APP_CHANGED_AFTER_CHECK'; END IF;
 {guard}
 IF (SELECT jsonb_build_object('app_id',b.app_id,'provider',b.provider,'wallet_url',b.wallet_url,'wallet_key_id',b.wallet_key_id,'scope',b.scope) FROM gp_wallet_bindings b WHERE b.app_id={q}) IS DISTINCT FROM {binding} THEN RAISE EXCEPTION 'BINDING_CHANGED_AFTER_CHECK'; END IF;
 IF (SELECT to_jsonb(w)-'created_at'-'updated_at' FROM wallet_scopes w WHERE w.app_id={q}) IS DISTINCT FROM {wallet} THEN RAISE EXCEPTION 'WALLET_SCOPE_CHANGED_AFTER_CHECK'; END IF;
 IF EXISTS(SELECT 1 FROM wallet_users WHERE available<>0 OR reserved<>0 OR credit_pending<>0) OR EXISTS(SELECT 1 FROM wallet_ledger) OR EXISTS(SELECT 1 FROM gp_transfers) THEN RAISE EXCEPTION 'FINANCIAL_STATE_CHANGED_AFTER_CHECK'; END IF;
END $admission_guard$;
{change}
SELECT {policy_projection()} FROM gp_production_admission q WHERE q.app_id={q};
COMMIT;
"""
 return sql,policy


def app_probe_script(release):
 root=json.dumps(str(release/'platform'))
 return f"""import{{pathToFileURL}}from'node:url';
const root={root};const imp=name=>import(pathToFileURL(root+'/'+name).href);
const{{runtime}}=await imp('server/runtime-mode.mjs');const{{pool,closePools}}=await imp('server/db.mjs');
try{{const client=await pool.connect();try{{await client.query('BEGIN READ ONLY');
 const row=(await client.query("SELECT current_database() AS database,current_user AS role,(SELECT oid::int FROM pg_database WHERE datname=current_database()) AS database_oid,(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname=current_user) AS privileged,host(inet_server_addr()) AS server_host,family(inet_server_addr()) AS server_family,masklen(inet_server_addr()) AS server_mask,inet_server_port() AS server_port")).rows[0];
 await client.query('COMMIT');process.stdout.write(JSON.stringify({{row,runtime:{{environment:runtime.environment,admissionEnabled:runtime.admissionEnabled,admissionProfile:runtime.admissionProfile,firstpartyAppId:runtime.firstpartyAppId,admissionRelease:runtime.admissionRelease,admissionManifest:runtime.admissionManifest,publicOrigin:runtime.publicOrigin}}}}));
 }}finally{{client.release();}}}}finally{{await closePools();}}
"""


def migration_script(release):
 root=json.dumps(str(release/'platform'))
 return f"""import{{pathToFileURL}}from'node:url';const root={root};const imp=name=>import(pathToFileURL(root+'/'+name).href);
const{{pool,closePools}}=await imp('server/db.mjs');const mode=await imp('server/runtime-mode.mjs');
try{{if(!mode.runtime.production||mode.runtime.admissionEnabled||mode.runtime.admissionProfile!=='closed')throw Error('SOURCE_UPGRADE_MIGRATION_REQUIRES_CLOSED');
 await mode.preflightRuntime(pool);await(await imp('server/wallet/index.mjs')).migrateWallet(pool);
 await(await imp('server/platform.mjs')).migratePlatform();await mode.migrateRuntime(pool);
 await(await imp('server/portal.mjs')).migratePortal();await(await imp('server/credentials.mjs')).migrateCredentials();
 await(await imp('server/pvp/index.mjs')).migratePvp(pool);await(await imp('server/overview-activity.mjs')).migrateOverviewActivity();
 await(await imp('server/wallet-binding.mjs')).migrateWalletBindings(pool);await(await imp('server/integration-checks.mjs')).migrateIntegrationChecks();
 await(await imp('server/transfers/index.mjs')).migrateTransfers(pool);process.stdout.write('{{"passed":true,"seeded":false}}');
}}finally{{try{{await(await imp('server/pvp/engine-pool.mjs')).closeEnginePool();}}finally{{await closePools();}}}}
"""


def source_entry(marker, release, manifest, helpers, profile, approvals):
 return {'release':str(release),'manifest_sha256':manifest,'helpers':dict(helpers),
         'private_pins':copy.deepcopy(marker['private_pins']),
         'inspection_contract':'production-closed-v1' if release==OLD else 'production-free-v2',
         'runtime_profile':copy.deepcopy(profile),'policy_approvals':copy.deepcopy(approvals)}


def process_uids(status):
 rows=[line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')]
 require(len(rows)==1 and len(rows[0])==4 and all(re.fullmatch('[0-9]+',value) for value in rows[0]),
         'ADMISSION_PROCESS_UID_INVALID')
 return [int(value) for value in rows[0]]


def process_identity(item):
 """A PID name never substitutes for a stable Linux process identity."""
 try:
  before=(item/'stat').read_text();fields=before.rsplit(')',1)[1].split()
  require(before.split(' ',1)[0]==item.name and len(fields)>19 and re.fullmatch('[0-9]+',fields[1])
          and re.fullmatch('[0-9]+',fields[19]),'ADMISSION_PROCESS_STAT_INVALID')
  command=(item/'cmdline').read_bytes()
  require(command.endswith(b'\0') and not b'\0\0' in command,'ADMISSION_PROCESS_ARGV_INVALID')
  result={'pid':int(item.name),'ppid':int(fields[1]),'start_ticks':fields[19],
          'uids':process_uids((item/'status').read_text()),'cwd':os.readlink(item/'cwd'),
          'exe':os.readlink(item/'exe'),'argv':command[:-1].decode('utf-8').split('\0'),
          'cgroup':(item/'cgroup').read_text()}
  after=(item/'stat').read_text();after_fields=after.rsplit(')',1)[1].split()
  require(after.split(' ',1)[0]==item.name and len(after_fields)>19
          and (after_fields[1],after_fields[19])==(fields[1],fields[19]),
          'ADMISSION_PROCESS_CHANGED_DURING_READ')
  return result
 except (OSError,ValueError,UnicodeError,IndexError):raise Refusal('ADMISSION_PROCESS_CONSUMER_UNREADABLE') from None


def executable_guard(path,expected):
 _,identity=read_file(path,expected,limit=256<<20)
 require(identity['st_uid']==identity['st_gid']==0 and identity['st_nlink']==1
         and stat.S_IMODE(identity['st_mode'])==0o755,'ADMISSION_PROCESS_EXECUTABLE_UNSAFE')
 return identity


def consumer_snapshot():
 result={}
 for item in PROC_ROOT.iterdir():
  if not re.fullmatch('[1-9][0-9]*',item.name):continue
  try:uids=process_uids((item/'status').read_text());cwd=os.readlink(item/'cwd')
  except FileNotFoundError:continue # Unrelated processes may exit during enumeration.
  except OSError:raise Refusal('ADMISSION_PROCESS_CONSUMER_UNREADABLE') from None
  own_source=any(cwd==str(release) or cwd.startswith(str(release)+'/') for release in (OLD,TARGET))
  if 997 in uids or own_source:
   row=process_identity(item)
   require(row['uids']==uids and row['cwd']==cwd,'ADMISSION_PROCESS_CHANGED_DURING_READ')
   result[row['pid']]=row
 return result


def consumer_guard(units,release):
 require(release in (OLD,TARGET),'ADMISSION_PROCESS_RELEASE_INVALID')
 api=units['states']['oasis-production-api.service'];process=api.get('process')
 if api.get('ActiveState')=='active':
  require(isinstance(process,dict) and type(process.get('pid')) is int and process['pid']>0
          and isinstance(process.get('start_ticks'),str) and re.fullmatch('[0-9]+',process['start_ticks'])
          and process.get('uid')=='997' and process.get('cwd')==str(release/'platform')
          and process.get('exe')==str(NODE_EXE),'ADMISSION_API_PROCESS_CHANGED')
 else:require(not process and api.get('MainPID') in ('0',None),'ADMISSION_INACTIVE_API_HAS_PROCESS')
 before=consumer_snapshot();executables={}
 if process:
  main=before.get(process['pid'])
  require(main is not None and main['start_ticks']==process['start_ticks'] and main['ppid']==1
          and main['uids']==[997]*4 and main['cwd']==process['cwd'] and main['exe']==str(NODE_EXE)
          and main['argv']==[str(NODE_EXE),'--import','tsx','server/index.mjs'] and main['cgroup']==API_CGROUP,
          'ADMISSION_API_PROCESS_CHANGED')
  executables[str(NODE_EXE)]=executable_guard(NODE_EXE,NODE_SHA)
  esbuild=release/'platform/node_modules/@esbuild/linux-x64/bin/esbuild'
  for pid,row in before.items():
   if pid==main['pid']:continue
   # EnginePool uses worker_threads, so no standalone Node descendant is valid.
   require(row['uids']==[997]*4 and row['ppid']==main['pid'] and int(row['start_ticks'])>=int(main['start_ticks'])
           and row['cwd']==main['cwd'] and row['cgroup']==main['cgroup'] and row['exe']==str(esbuild)
           and row['argv']==[str(esbuild),'--service=0.28.2','--ping'],
           'ADMISSION_FOREIGN_SOURCE_OR_UID_CONSUMER')
   if str(esbuild) not in executables:executables[str(esbuild)]=executable_guard(esbuild,ESBUILD_SHA)
 else:require(not before,'ADMISSION_FOREIGN_SOURCE_OR_UID_CONSUMER')
 for pid,row in before.items():
  try:mapped=os.stat(PROC_ROOT/str(pid)/'exe')
  except OSError:raise Refusal('ADMISSION_PROCESS_CHANGED_DURING_READ') from None
  require(all(getattr(mapped,key)==executables[row['exe']][key] for key in
              ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')),
          'ADMISSION_PROCESS_EXECUTABLE_MAPPING_CHANGED')
 require(consumer_snapshot()==before,'ADMISSION_PROCESS_CHANGED_DURING_READ')
 require(all(executable_guard(Path(path),identity['sha256'])==identity for path,identity in executables.items()),
         'ADMISSION_PROCESS_EXECUTABLE_CHANGED')
 return {'processes':[before[pid] for pid in sorted(before)],'executables':executables}


def oneshot_guard(name,state,body,release,executables,*,cleanup=False):
 """Busy is an unfinished exact job, never successful operation evidence."""
 require(name in OWN_JOBS and state.get('ControlPID')=='0'
         and state.get('ExecMainCode') in ('0','1','2','3') and isinstance(state.get('ExecMainStatus'),str)
         and re.fullmatch('[0-9]+',state['ExecMainStatus']), 'ADMISSION_ONESHOT_STATUS_INVALID')
 idle=state.get('MainPID')=='0' and not state.get('process')
 failed=state.get('ActiveState')=='failed' or state.get('Result')!='success' or state['ExecMainStatus']!='0'
 if failed:
  require(cleanup and idle and (state.get('ActiveState'),state.get('SubState')) in (('inactive','dead'),('failed','failed')),
          'ADMISSION_OWN_ONESHOT_FAILED')
  return False
 if state.get('ActiveState')=='inactive':
  require(idle and state.get('SubState')=='dead','ADMISSION_ONESHOT_STATUS_INVALID');return False
 require(state.get('ActiveState')=='activating' and state.get('SubState')=='start', 'ADMISSION_ONESHOT_STATUS_INVALID')
 process=state.get('process')
 require(isinstance(process,dict) and type(process.get('pid')) is int and process['pid']>0
         and state.get('MainPID')==str(process['pid']), 'ADMISSION_ONESHOT_TRANSITION')
 commands=[line.partition('=')[2] for line in body.splitlines() if line.startswith('ExecStart=')]
 cwd=[line.partition('=')[2] for line in body.splitlines() if line.startswith('WorkingDirectory=')]
 require(len(commands)==1 and len(cwd)<=1,'ADMISSION_ONESHOT_COMMAND_INVALID')
 # Unit templates are already disk- and typed-command-verified; these arguments
 # contain no shell syntax and all three witnessed commands are space separated.
 argv=commands[0].split();exe=Path(argv[0]).resolve(strict=True)
 require(str(exe) in executables,'ADMISSION_ONESHOT_EXECUTABLE_UNBOUND')
 require(executable_guard(exe,executables[str(exe)]['sha256'])==executables[str(exe)],
         'ADMISSION_JOB_EXECUTABLE_CHANGED')
 try:row=process_identity(PROC_ROOT/str(process['pid']));mapped=os.stat(PROC_ROOT/str(process['pid'])/'exe')
 except Refusal as error:
  if str(error)=='ADMISSION_PROCESS_CONSUMER_UNREADABLE':raise Refusal('ADMISSION_ONESHOT_TRANSITION') from None
  raise
 except FileNotFoundError:raise Refusal('ADMISSION_ONESHOT_TRANSITION') from None
 expected=executables[str(exe)]
 require(row['start_ticks']==process.get('start_ticks') and row['ppid']==1 and row['uids']==[0]*4
         and process.get('uid')=='0' and row['cwd']==(cwd[0] if cwd else '/') and row['argv']==argv
         and row['exe']==str(exe) and process.get('exe')==str(exe) and process.get('cwd')==row['cwd']
         and row['cgroup']=='0::/system.slice/'+name+'\n'
         and all(getattr(mapped,key)==expected[key] for key in
                 ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')),
         'ADMISSION_ONESHOT_PROCESS_CHANGED')
 return True


def source_history_guard(marker, bindings):
 a=bindings.a
 if marker['release']==str(OLD):
  require(not marker.get('release_history'),'ADMISSION_INITIAL_HISTORY_UNEXPECTED')
  require(marker['private_pins']==INITIAL_PRIVATE,'ADMISSION_INITIAL_PRIVATE_PINS_CHANGED')
  return
 history=marker.get('release_history');require(isinstance(history,list) and len(history)==2,'ADMISSION_APPROVED_HISTORY_REQUIRED')
 original=a.approved_source(marker,str(OLD),OLD_MANIFEST)
 require(original['helpers']==OLD_HELPERS and original['private_pins']==INITIAL_PRIVATE
         and original['runtime_profile']['profile']=='closed' and not original['policy_approvals'],
         'ADMISSION_ORIGINAL_HISTORY_CHANGED')
 current=a.approved_source(marker,str(TARGET),marker['manifest_sha256'])
 require(current['private_pins']==marker['private_pins'] and current['helpers']=={
         name:bindings.members['platform/deploy/production-instance/'+name] for name in a.CURRENT_HELPERS},
         'ADMISSION_CURRENT_HISTORY_CHANGED')


def assert_marker(marker, args, *, post=False):
 require(marker.get('kind')=='isolated-production-instance' and marker.get('schema')==1
         and marker.get('container_id')==CID and marker.get('owner')==OWNER and marker.get('network_id')==NETWORK
         and marker.get('pg_image')==IMAGE and type(marker.get('uid')) is int and marker['uid']==997
         and type(marker.get('gid')) is int and marker['gid']==999,'ADMISSION_ORIGINAL_RESOURCES_CHANGED')
 require(marker.get('release') in (str(OLD),str(TARGET))
         and marker.get('manifest_sha256')==(OLD_MANIFEST if marker['release']==str(OLD) else args.manifest_sha256),
         'ADMISSION_CURRENT_SOURCE_CHANGED')
 require(set(marker.get('private_pins',{}))==set(INITIAL_PRIVATE)
         and all(marker['private_pins'][name]==value for name,value in INITIAL_PRIVATE.items() if name!='runtime.env'),
         'ADMISSION_ORIGINAL_SECRETS_CHANGED')
 require(marker['release']==(str(OLD) if args.action=='upgrade' and not post else str(TARGET)),
         'ADMISSION_WRONG_SOURCE_FOR_ACTION')


def retirement_evidence(args, bindings, inventory, inventory_pin):
 """The original 20 references remain historical authority; only two can retire."""
 r=bindings.retirement;p=bindings.p
 historical=inventory.get('historical_inventory',{})
 require(isinstance(historical,dict) and set(historical)=={'path','sha256','obsolete_paths'}
         and historical['sha256']==HISTORICAL_INVENTORY_SHA
         and set(historical['obsolete_paths'])==set(OBSOLETE_REFS)
         and len(historical['obsolete_paths'])==2,'ADMISSION_EXACT_RETIRED_INVENTORY_REQUIRED')
 files={str(Path(args.protected_inventory)):inventory_pin};values={}
 for name,fixed in (('source_audit',SOURCE_AUDIT_SHA),('archive_proof',ARCHIVE_PROOF_SHA),
                    ('archive_review',ARCHIVE_REVIEW_SHA),('retirement_check',None),('retirement_receipt',None)):
  path=getattr(args,name,None);expected=getattr(args,name+'_sha256',None)
  require(path is not None and sha(expected) and (fixed is None or expected==fixed),'ADMISSION_RETIRED_RAW_EVIDENCE_REQUIRED')
  raw,identity=read_file(path,expected,private=True,limit=16<<20)
  require(str(Path(path)) not in files,'ADMISSION_RETIRED_EVIDENCE_PATH_ALIAS')
  files[str(Path(path))]=identity;values[name]=json.loads(raw)
 raw,original_pin=read_file(historical['path'],historical['sha256'],private=True)
 require(historical['path'] not in files,'ADMISSION_RETIRED_EVIDENCE_PATH_ALIAS')
 files[historical['path']]=original_pin;prior=json.loads(raw);p.validate_protected(prior)
 require(set(OBSOLETE_REFS)<=set(prior['paths']) and len(p.REQUIRED_PINS)==20,
         'ADMISSION_ORIGINAL_TWENTY_PINS_REQUIRED')
 r.validate_inputs(inventory,values['source_audit'],values['archive_proof'])
 r.validate_root_archive_review(values['archive_review'],values['archive_proof'])
 independent=inventory.get('root_independent_archive_review',{})
 require(independent=={'path':str(Path(args.archive_review)),'sha256':ARCHIVE_REVIEW_SHA}
         and inventory.get('helpers')==OLD_HELPERS and inventory.get('production_release')==str(OLD)
         and inventory.get('production_manifest_sha256')==OLD_MANIFEST,
         'ADMISSION_RETIREMENT_HISTORICAL_SOURCE_CHANGED')
 check=values['retirement_check'];receipt=values['retirement_receipt'];proof=values['archive_proof']
 expected={'inventory_sha256':args.protected_inventory_sha256,'source_audit_sha256':SOURCE_AUDIT_SHA,
           'archive_proof_sha256':ARCHIVE_PROOF_SHA,'root_independent_archive_review_sha256':ARCHIVE_REVIEW_SHA,
           'historical_inventory_sha256':HISTORICAL_INVENTORY_SHA,
           'tool_sha256':bindings.members['platform/deploy/retire-mock-sources.py']}
 external={**expected,'retirement_receipt_sha256':args.retirement_receipt_sha256,'check_sha256':args.retirement_check_sha256}
 replacement=r.validate_retirement_replacement(prior,inventory,receipt,check,proof,values['archive_review'],external_sha256=external)
 require(replacement['obsolete_manifest_paths']==historical['obsolete_paths'],'ADMISSION_RETIRED_APPROVED_PATHS_CHANGED')
 for name in OBSOLETE_NAMES:
  root=Path('/opt/oasis/releases')/name;tree=proof['trees'][name]
  require(not os.path.lexists(root) and tree['entry_count']==9571
          and tree['entries']['.']['inode']==r.ROOT_INODES[name]
          and tree['entries']['RELEASE-MANIFEST.json']['sha256']==r.MANIFESTS[name],
          'ADMISSION_RETIREMENT_SOURCE_OR_ARCHIVE_IDENTITY_CHANGED')
 paths=replacement['retained_paths']
 # Changes to these exact owned paths have separate audited transition guards.
 authored={str(p.PIN),str(p.PRIVATE/'installation.json'),str(p.PRIVATE/'runtime.env'),
           *[str(Path('/etc/systemd/system')/name) for name in (*p.UNITS,*bindings.units.UNIT_NAMES)]}
 additional=inventory.get('additional_paths',[])
 require(isinstance(additional,list) and len(additional)==len(set(additional)),'ADMISSION_RETIRED_ADDITIONAL_PATHS_INVALID')
 public_paths=list(dict.fromkeys([*paths,*[path for path in additional if path not in authored]]))
 require(not set(paths)&authored and all(isinstance(path,str) and path.startswith(('/opt/oasis/','/etc/nginx/','/etc/systemd/system/'))
          and '..' not in Path(path).parts for path in additional),'ADMISSION_PUBLIC_OWNED_SCOPE_MIXED')
 snapshot=copy.deepcopy(inventory['snapshot']['protected'])
 require(set(public_paths)<=set(snapshot['files']),'ADMISSION_RETIRED_SNAPSHOT_PATH_MISSING')
 snapshot['files']={path:snapshot['files'][path] for path in public_paths}
 derived={'kind':'production-protected-inventory','current':prior['current'],'previous':prior['previous'],
          'retirement_receipt_sha256':prior['retirement_receipt_sha256'],'paths':public_paths,'snapshot':snapshot}
 require(set(prior['paths'])-set(derived['paths'])==set(OBSOLETE_REFS)
         and set(p.REQUIRED_PINS)-set(derived['paths'])==set(OBSOLETE_REFS),
         'ADMISSION_PUBLIC_PIN_SILENTLY_DROPPED')
 # Evidence is immutable across all actions and is independently FD-pinned,
 # including files created after the reviewed retirement snapshot.
 return derived,files,{'historical_inventory_sha256':HISTORICAL_INVENTORY_SHA,
         'retirement_receipt_sha256':args.retirement_receipt_sha256,'retirement_check_sha256':args.retirement_check_sha256,
         'archive_proof_sha256':ARCHIVE_PROOF_SHA,'source_audit_sha256':SOURCE_AUDIT_SHA,
         'archive_review_sha256':ARCHIVE_REVIEW_SHA,'obsolete_paths':list(OBSOLETE_REFS)}


def make_guardian(args,bindings,runtime,inventory,inventory_pin):
 p=bindings.p
 if inventory.get('kind')=='production-protected-inventory':
  p.validate_protected(inventory)
  guardian=p.Provisioner.__new__(p.Provisioner);guardian.args=args;guardian.runtime=runtime
  guardian.release=TARGET;guardian.protected=inventory;guardian.receipt=None
  return guardian,{str(Path(args.protected_inventory)):inventory_pin},None
 derived,evidence,retired=retirement_evidence(args,bindings,inventory,inventory_pin)
 guardian=p.Provisioner.__new__(p.Provisioner);guardian.args=args;guardian.runtime=runtime
 guardian.release=TARGET;guardian.protected=derived;guardian.receipt=None
 # Execute the original guard unchanged, including public DB, proxy, static,
 # TLS, current/previous releases and strict retired-Mock 410 routes.
 return guardian,evidence,retired


class Controller:
 def __init__(self,args,bindings,runtime=None):
  self.args=args;self.b=bindings;self.p=bindings.p;self.runtime=runtime or make_runtime(self.p)
  self.receipt=None;self.receipt_pin=None;self.directory=None;self.expected=None
  self.authored_marker=None;self.authored_pin=None
  self.locks={}
  self.global_locks_held=False;self.directory_lease=None;self.waited_jobs={}
  protected_raw,self.protected_pin=read_file(args.protected_inventory,args.protected_inventory_sha256,private=True)
  self.guardian,self.protection_files,self.retired_protection=make_guardian(args,bindings,self.runtime,json.loads(protected_raw),self.protected_pin)
  require(pin(args.protected_inventory)==self.protected_pin,'ADMISSION_PROTECTED_INPUT_CHANGED')

 def source_guard(self):
  self.p.verify_release(TARGET,self.args.manifest_sha256)
  self.p.verify_historical_release(OLD,OLD_MANIFEST,OLD_HELPERS)
  complete_members(self.p,TARGET,self.b.members);complete_members(self.p,OLD,self.b.old_members)
  require(dependency_tree(self.p,OLD)==self.b.dependencies and dependency_tree(self.p,TARGET)==self.b.dependencies,
          'ADMISSION_RUNTIME_DEPENDENCY_PIN_CHANGED')
  require(pin(self.args.protected_inventory)==self.protected_pin,'ADMISSION_PROTECTED_INPUT_CHANGED')
  require(all(pin(path)==expected for path,expected in self.protection_files.items()),'ADMISSION_RETIRED_EVIDENCE_CHANGED')
  require(all(pin(Path(path))==value for path,value in self.b.pins.items()),'ADMISSION_SOURCE_PIN_CHANGED')
  return {**controller_guard(self.args,self.b),'runtime_dependencies':self.b.dependencies,
          'retired_protection':self.retired_protection,'protection_files':self.protection_files}

 def installed_units(self,marker,*,pending_jobs=False,cleanup=False):
  require(not pending_jobs or not self.global_locks_held,'ADMISSION_TIMER_TAIL_REQUIRES_UNLOCKED')
  release=Path(marker['release']);provision=self.b.oldp if release==OLD else self.p
  templates=provision.unit_templates(release,CID);self.p.unit_namespace_guard(templates)
  states={};files={};bodies=dict(templates)
  for name,body in templates.items():
   path=Path('/etc/systemd/system')/name;files[name]=pin(path)
   require(files[name]['st_uid']==files[name]['st_gid']==0 and stat.S_IMODE(files[name]['st_mode'])==0o644
           and files[name]['sha256']==digest(body.encode()),'ADMISSION_OWN_UNIT_CHANGED')
   state=self.runtime.service(name)
   require(state.get('FragmentPath')==str(path) and state.get('DropInPaths')=='' and state.get('NeedDaemonReload')=='no',
           'ADMISSION_OWN_UNIT_FRAGMENT_CHANGED')
   require(self.runtime.loaded_commands(name)==(self.p.expected_commands(body) if name.endswith('.service') else {}),
           'ADMISSION_OWN_UNIT_CACHED_COMMAND_CHANGED')
   states[name]=state
  binding={'release':str(release),'manifest_sha256':marker['manifest_sha256']}
  configs=self.b.ingress.configurations(binding)
  cert={name:configs[str(Path('/etc/systemd/system')/name)] for name in self.b.units.UNIT_NAMES}
  bodies.update({name:body.decode() if isinstance(body,bytes) else body for name,body in cert.items()})
  try:self.b.units.namespace_guard(cert,self.runtime,installed=True);self.b.units.loaded_guard(cert,self.runtime)
  except RuntimeError as error:raise Refusal(str(error)) from None
  for name in cert:files[name]=pin(Path('/etc/systemd/system')/name);states[name]=self.runtime.service(name)
  busy=[name for name in OWN_JOBS if oneshot_guard(name,states[name],bodies[name],release,self.b.job_executables,cleanup=cleanup)]
  require(not busy or pending_jobs,'ADMISSION_OWN_ONESHOT_BUSY')
  api=states['oasis-production-api.service'];process=api.get('process',{})
  require(api.get('ActiveState') in ('active','inactive','failed'),'ADMISSION_API_STATE_UNKNOWN')
  if api.get('ActiveState')=='active':
   require(process.get('uid')=='997' and process.get('cwd')==str(release/'platform')
           and process.get('exe')=='/usr/bin/node','ADMISSION_API_PROCESS_CHANGED')
  units={'files':files,'states':states}
  # No process receives a consumer exemption. During a bounded read-only wait,
  # complete consumer acceptance is deferred until all exact jobs are idle.
  return {**units,'pending_jobs':busy,'consumers':{'pending':True} if busy else consumer_guard(units,release)}

 def scope(self, *, public_expected=None, require_active=True):
  source=self.source_guard()
  raw,marker_pin=read_file(self.p.PRIVATE/'installation.json',private=True)
  marker=json.loads(raw);assert_marker(marker,self.args,post=self.authored_marker is not None);source_history_guard(marker,self.b)
  require(self.authored_marker is None or marker==self.authored_marker,'ADMISSION_AUTHORED_MARKER_CHANGED')
  production_pin=pin(self.p.PIN,symlink=True)
  require(production_pin['st_uid']==production_pin['st_gid']==0 and production_pin['target']==marker['release'],
          'ADMISSION_PRODUCTION_PIN_CHANGED')
  resources=(self.b.oldops if marker['release']==str(OLD) else self.b.ops).owned_resources(marker,self.runtime)
  require(resources['running'] is True,'ADMISSION_PG_NOT_RUNNING')
  env_raw,env_pin=read_file(self.p.PRIVATE/'runtime.env',private=True)
  env=self.b.a.parse_env_text(env_raw.decode());profile=self.b.a.runtime_profile(env,expected_release=marker['release'],expected_manifest=marker['manifest_sha256'])
  require(env.get('OASIS_PRODUCTION_ADMISSION_ENABLED')=='0' and profile['public_origin']==self.args.origin,
          'ADMISSION_GENERIC_GATE_OR_ORIGIN_CHANGED')
  require(profile['profile']=='closed' or profile['app_id']==self.args.app_id,'ADMISSION_CONFIG_APP_CHANGED')
  units=self.installed_units(marker)
  if require_active:require(units['states']['oasis-production-api.service']['ActiveState']=='active','ADMISSION_API_NOT_ACTIVE')
  bootstrap_raw,bootstrap_pin=read_file(self.p.PRIVATE/'bootstrap.json',private=True)
  bootstrap=json.loads(bootstrap_raw)
  require(bootstrap.get('kind')=='isolated-production-bootstrap' and bootstrap.get('passed') is True
          and bootstrap.get('app_id')==self.args.app_id and bootstrap.get('admission_enabled') is False
          and bootstrap.get('players_created')==0 and bootstrap.get('coins_funded')=='0','ADMISSION_ORIGINAL_BOOTSTRAP_CHANGED')
  volume=self.runtime.inspect('volume',self.p.VOLUME)
  s=Path(volume['Mountpoint']).lstat();volume_pin={name:getattr(s,name) for name in ('st_dev','st_ino','st_uid','st_gid','st_mode')}
  require(stat.S_ISDIR(s.st_mode) and volume_pin=={'st_dev':64515,'st_ino':378617,'st_uid':70,'st_gid':70,'st_mode':stat.S_IFDIR|0o700},
          'ADMISSION_ORIGINAL_VOLUME_INODE_CHANGED')
  self.p.no_mount(Path(volume['Mountpoint']))
  self.p.require_pg_host_tcp()
  probe=json.loads(self.runtime.command(['/usr/bin/node','--input-type=module','-e',app_probe_script(TARGET)],env=env,timeout=30))
  row=probe.get('row',{});container=self.runtime.inspect('container',CID)
  address=container['NetworkSettings']['Networks'][self.p.NETWORK]['IPAddress']
  require(row.get('database')==self.p.DATABASE and row.get('database_oid')==OID and row.get('role')==self.p.DB_APP
          and row.get('privileged') is False and row.get('server_host')==address and row.get('server_family')==4
          and row.get('server_mask')==32 and row.get('server_port')==5432,'ADMISSION_APP_TCP_DATABASE_CHANGED')
  require(probe.get('runtime')=={'environment':'production','admissionEnabled':False,'admissionProfile':profile['profile'],
          'firstpartyAppId':profile['app_id'],'admissionRelease':profile['release'],'admissionManifest':profile['manifest_sha256'],
          'publicOrigin':profile['public_origin']},'ADMISSION_ACTUAL_RUNTIME_CONFIG_CHANGED')
  protected=self.guardian.guard(public_expected)
  return {'source':source,'marker':marker,'marker_pin':marker_pin,'production_pin':production_pin,
          'env_pin':env_pin,'runtime_profile':profile,'resources':resources,'volume_pin':volume_pin,'units':units,
          'protected':protected,'app_tcp':row,'bootstrap_pin':bootstrap_pin,'protected_inventory_pin':self.protected_pin}

 def database(self,marker):
  ops=self.b.oldops if marker['release']==str(OLD) else self.b.ops
  exists=ops.sql(self.runtime,marker,self.p.DATABASE,"SELECT to_regclass('public.gp_production_admission') IS NOT NULL;").strip()
  require(exists in ('t','f'),'ADMISSION_POLICY_SCHEMA_UNKNOWN')
  rows=[json.loads(row) for row in ops.sql(self.runtime,marker,self.p.DATABASE,
          snapshot_sql(self.args.app_id,policy_exists=exists=='t')).splitlines() if row.startswith('{')]
  require(len(rows)==1,'ADMISSION_DATABASE_SNAPSHOT_INVALID')
  scope=validate_database(rows[0],self.b.a,self.args,action=self.args.action)
  return rows[0],scope

 def audit(self):
  capacity=capacity_guard(self.p,self.args.capacity_budget_bytes)
  before=self.scope();data,scope=self.database(before['marker'])
  if before['marker']['release']==str(OLD):inspection=self.legacy_inspection(before['marker'])
  else:inspection=self.run_inspection(before['marker'],allow_free_active=self.args.action in ('open','close'))
  after=self.scope(public_expected=before['protected'])
  require(before==after,'ADMISSION_STATE_CHANGED_DURING_AUDIT')
  if self.args.action in ('upgrade','approve'):require(before['runtime_profile']['profile']=='closed','ADMISSION_INITIAL_PROFILE_NOT_CLOSED')
  else:require(before['runtime_profile']['profile']=='firstparty-free-v1','ADMISSION_APPROVED_PROFILE_REQUIRED')
  return {'schema':1,'kind':'production-admission-audit','passed':True,'at':utcnow(),'action':self.args.action,
          'scope_kind':'source-upgrade' if self.args.action=='upgrade' else 'firstparty-free-only',
          'tool_sha256':self.args.controller_sha256,'source_commit':self.args.source_commit,
          'runtime_source_commit':self.args.source_commit,'controller_origin_commit':self.args.controller_origin_commit,'release':str(TARGET),
          'manifest_sha256':self.args.manifest_sha256,'app_id':self.args.app_id,'state':before,'database':data,
          'locks':self.locks,
          'capacity':capacity,
          'policy_scope':scope,'inspection':inspection,'state_digest':digest(canonical({'state':before,'database':data,'inspection':inspection})),
          'acceptance_scope':'This audit does not approve financial, paid, probability, third-party, performance or device launch.'}

 def check(self):
  audit_raw,audit_pin=read_file(self.args.audit,self.args.audit_sha256,private=True)
  original=json.loads(audit_raw);self.p.fresh_time(original.get('at'))
  proof_raw,proof_pin=read_file(self.args.approval,self.args.approval_sha256,private=True)
  approval=approve_proof(json.loads(proof_raw),audit_raw,original,self.args)
  actual=self.audit()
  require(stable_capsule(actual)==stable_capsule(original),'ADMISSION_AUDIT_STATE_CHANGED')
  return {'schema':1,'kind':'production-admission-check','passed':True,'at':utcnow(),'action':self.args.action,
          'tool_sha256':self.args.controller_sha256,'source_commit':self.args.source_commit,
          'runtime_source_commit':self.args.source_commit,'controller_origin_commit':self.args.controller_origin_commit,'release':str(TARGET),
          'manifest_sha256':self.args.manifest_sha256,'audit_sha256':digest(audit_raw),'audit_pin':audit_pin,
          'approval_sha256':digest(proof_raw),'approval_pin':proof_pin,'approval':approval,'audit':actual}

 def event(self,phase,**fields):
  self.receipt['phase']=phase;self.receipt['history'].append({'at':utcnow(),'phase':phase,**fields})
  path=self.directory/'receipt.json'
  if self.receipt_pin is None:self.p.exclusive(path,canonical(self.receipt))
  else:atomic_replace(path,canonical(self.receipt),self.receipt_pin)
  self.receipt_pin=pin(path)

 def fresh(self):
  self.source_guard();capacity_guard(self.p,self.args.capacity_budget_bytes);self.guardian.guard(self.capsule['audit']['state']['protected'])
  if self.directory_lease:directory_lock_guard(*self.directory_lease)
  for path,expected in self.locks.items():require(pin(path)==expected,'ADMISSION_LOCK_REPLACED')
  for path,expected in self.immutable_evidence.items():require(pin(Path(path))==expected,'ADMISSION_OPERATION_EVIDENCE_CHANGED')
  for path,expected in self.authored_paths.items():require(pin(Path(path),symlink=path==str(self.p.PIN))==expected,
                                                         'ADMISSION_AUTHORED_FILE_CHANGED')
  for name,expected in INITIAL_PRIVATE.items():
   if name!='runtime.env':require(self.p.fingerprint(self.p.PRIVATE/name)==expected,'ADMISSION_ORIGINAL_SECRET_CHANGED')

 def preserve(self):
  if not OPERATIONS.exists():
   OPERATIONS.mkdir(mode=0o700);os.chmod(OPERATIONS,0o700)
  self.p.no_mount(OPERATIONS)
  parent=OPERATIONS.lstat();require(stat.S_ISDIR(parent.st_mode) and parent.st_uid==parent.st_gid==0
                                  and stat.S_IMODE(parent.st_mode)==0o700,'ADMISSION_RECEIPT_PARENT_UNSAFE')
  self.directory=OPERATIONS/(self.args.action+'-'+self.args.check_sha256)
  require(not os.path.lexists(self.directory),'ADMISSION_OPERATION_ALREADY_ATTEMPTED')
  self.directory.mkdir(mode=0o700);os.chmod(self.directory,0o700)
  self.runtime.diagnostics=self.directory
  current=self.capsule['audit']['state']
  self.receipt={'schema':1,'kind':'production-admission-operation','passed':False,'at':utcnow(),
       'action':self.args.action,'scope_kind':self.capsule['approval']['scope_kind'],
       'check_sha256':self.args.check_sha256,'audit_sha256':self.args.audit_sha256,
       'approval_sha256':self.args.approval_sha256,'controller_sha256':self.args.controller_sha256,
       'source_commit':self.args.source_commit,'runtime_source_commit':self.args.source_commit,
       'controller_origin_commit':self.args.controller_origin_commit,'packaged_controller_sha256':PACKAGED_CONTROLLER_SHA,
       'target_release':str(TARGET),
       'target_manifest_sha256':self.args.manifest_sha256,'container_id':CID,'owner':OWNER,'network_id':NETWORK,
       'history':[],'original':current,
       'acceptance_scope':'This operation grants neither financial nor paid/probability/third-party/performance/device admission.'}
  for label,path in [('audit-original.json',Path(self.args.audit)),('approval-original.json',Path(self.args.approval)),
                     ('check-original.json',Path(self.args.check)),('installation-original.json',self.p.PRIVATE/'installation.json'),
                     ('runtime-original.env',self.p.PRIVATE/'runtime.env')]:
   raw,identity=read_file(path,private=True);require(pin(path)==identity,'ADMISSION_PRESERVE_SOURCE_CHANGED')
   self.p.exclusive(self.directory/label,raw)
  units=self.directory/'units-original';units.mkdir(mode=0o700)
  for name,identity in current['units']['files'].items():
   raw,_=read_file(Path('/etc/systemd/system')/name);require(pin(Path('/etc/systemd/system')/name)==identity,
                                                       'ADMISSION_PRESERVE_UNIT_CHANGED')
   self.p.exclusive(units/name,raw)
  self.event('original_evidence_preserved')

 def marker_replace(self,marker):
  path=self.p.PRIVATE/'installation.json';before=pin(path)
  require(before==self.authored_paths.get(str(path),self.capsule['audit']['state']['marker_pin']),
          'ADMISSION_MARKER_BEFORE_WRITE_CHANGED')
  value=atomic_replace(path,canonical(marker),before)
  self.authored_paths[str(path)]=value;self.authored_marker=copy.deepcopy(marker)
  return value

 def stop_writers(self,marker):
  self.installed_units(marker);self.fresh()
  names=['oasis-production-instance-backup.timer','oasis-production-instance-monitor.timer',
         'oasis-production-player-certificate.timer','oasis-production-api.service']
  self.runtime.command(['systemctl','stop',*names],timeout=90)
  for name in names:
   state=self.runtime.service(name);require(state.get('ActiveState')=='inactive' and state.get('MainPID') in ('0',None),
                                          'ADMISSION_WRITER_NOT_STOPPED')
  self.installed_units(marker);self.event('owned_writers_stopped')

 def stop_timers(self,marker):
  self.installed_units(marker);self.fresh()
  self.runtime.command(['systemctl','stop',*OWN_TIMERS],timeout=60)
  for name in OWN_TIMERS:
   state=self.runtime.service(name)
   require(state.get('ActiveState')=='inactive' and state.get('MainPID') in ('0',None),'ADMISSION_TIMER_NOT_STOPPED')
  self.installed_units(marker);self.event('owned_timers_stopped_api_preserved')

 def replace_units(self,marker):
  old_files=self.capsule['audit']['state']['units']['files']
  templates={name:body.encode() for name,body in self.p.unit_templates(TARGET,CID).items()}
  configurations=self.b.ingress.configurations({'release':str(TARGET),'manifest_sha256':self.args.manifest_sha256})
  templates.update({name:configurations[str(Path('/etc/systemd/system')/name)] for name in self.b.units.UNIT_NAMES})
  for name,body in templates.items():
   path=Path('/etc/systemd/system')/name;expected=old_files[name]
   require(pin(path)==expected,'ADMISSION_UNIT_BEFORE_WRITE_CHANGED')
   if expected['sha256']!=digest(body):value=atomic_replace(path,body,expected,mode=0o644)
   else:value=expected
   self.authored_paths[str(path)]=value
  self.runtime.command(['systemctl','daemon-reload'])
  self.installed_units(marker);self.event('target_units_loaded')

 def run_inspection(self,marker, *, allow_free_active=False):
  source=self.b.ops.backup_source(marker,marker['release'],marker['manifest_sha256'])
  if not allow_free_active:
   return self.b.ops.inspect_database(marker,self.runtime,self.p.DATABASE,source,self.p.PRIVATE/'state/master.key')
  helper=TARGET/'platform/deploy/production-instance/inspect-backup.mjs'
  expected=self.b.a.inspection_expectation(source)
  query=self.runtime.command(['/usr/bin/node',str(helper),'sql'],input=json.dumps({'expected':expected}))
  rows=[json.loads(row) for row in self.b.ops.sql(self.runtime,marker,self.p.DATABASE,query).splitlines() if row.startswith('{')]
  require(len(rows)==2 and rows[1].get('database')==self.p.DATABASE,'ADMISSION_PROFILE_INSPECTION_RESPONSE_INVALID')
  verified=json.loads(self.runtime.command(['/usr/bin/node',str(helper),'verify',str(self.p.PRIVATE/'state/master.key')],
                       input=json.dumps({'data':rows[0],'identity':rows[1],'expected':expected})))
  allowed={'active_rooms','pending_pvp_operations'}
  require(verified.get('environment')=='production' and verified.get('master_key_sha256')==INITIAL_PRIVATE['state/master.key']['sha256']
          and verified.get('inspection_contract')=='production-free-v2' and isinstance(verified.get('audit'),dict)
          and all(type(value) is int and value>=0 and (name in allowed or value==0) for name,value in verified['audit'].items()),
          'ADMISSION_PROFILE_INTEGRITY_OR_FINANCIAL_OBLIGATION')
  self.b.ops.backup_source(marker,marker['release'],marker['manifest_sha256'])
  return verified

 def legacy_inspection(self,marker):
  helper=OLD/'platform/deploy/production-instance/inspect-backup.mjs'
  query=self.runtime.command(['/usr/bin/node',str(helper),'sql'])
  rows=[json.loads(row) for row in self.b.oldops.sql(self.runtime,marker,self.p.DATABASE,query).splitlines() if row.startswith('{')]
  require(len(rows)==2 and rows[1].get('database')==self.p.DATABASE,'ADMISSION_LEGACY_INSPECTION_RESPONSE_INVALID')
  verified=json.loads(self.runtime.command(['/usr/bin/node',str(helper),'verify',str(self.p.PRIVATE/'state/master.key')],
                       input=json.dumps({'data':rows[0],'identity':rows[1]})))
  require(verified.get('environment')=='production' and verified.get('master_key_sha256')==INITIAL_PRIVATE['state/master.key']['sha256']
          and isinstance(verified.get('audit'),dict) and verified['audit']
          and all(type(value) is int and value==0 for value in verified['audit'].values()),'ADMISSION_ORIGINAL_LEDGER_OR_OBLIGATION')
  return verified

 def restart_writers(self,marker):
  self.installed_units(marker);self.fresh()
  self.runtime.command(['systemctl','start','oasis-production-api.service'],timeout=60)
  for attempt in range(20):
   try:self.runtime.http('http://127.0.0.1:18891/health/ready',200,'production');break
   except Refusal:
    if attempt==19:raise
    time.sleep(0.5)
  self.installed_units(marker)
  self.event('owned_api_ready_timers_deferred')

 def wait_owned_jobs(self,marker,deadline):
  require(not self.global_locks_held,'ADMISSION_TIMER_TAIL_REQUIRES_UNLOCKED')
  while True:
   require(time.monotonic()<deadline,'ADMISSION_OWN_ONESHOT_TIMEOUT')
   self.fresh()
   self.b.ops.owned_resources(marker,self.runtime)
   try:units=self.installed_units(marker,pending_jobs=True)
   except Refusal as error:
    if str(error)!='ADMISSION_ONESHOT_TRANSITION':raise
    units=None
   require(time.monotonic()<deadline,'ADMISSION_OWN_ONESHOT_TIMEOUT')
   if units is not None:
    for name in units['pending_jobs']:
     observed=units['states'][name]['process']
     self.waited_jobs.setdefault(name,[])
     if observed not in self.waited_jobs[name]:self.waited_jobs[name].append(copy.deepcopy(observed))
   if units is not None and not units['pending_jobs']:
    require(all(units['states'][name].get('ActiveState')=='active' and units['states'][name].get('MainPID') in ('0',None)
                for name in OWN_TIMERS),'ADMISSION_TIMER_NOT_ACTIVE')
    return units
   # No more mutations or completion are allowed while a verified job is busy.
   time.sleep(min(0.25,max(0,deadline-time.monotonic())))

 def finish_after_unlock(self):
  require(not self.global_locks_held and self.directory_lease is not None,'ADMISSION_TIMER_TAIL_REQUIRES_UNLOCKED')
  marker=self.authored_marker or self.capsule['audit']['state']['marker']
  self.verify_finished(complete=False)
  self.event('shared_operation_locks_released_timers_pending')
  self.waited_jobs={}
  deadline=time.monotonic()+ONESHOT_WAIT_SECONDS
  self.runtime.command(['systemctl','start',*OWN_TIMERS],timeout=30)
  self.event('owned_timers_started_completion_pending')
  while True:
   jobs=self.wait_owned_jobs(marker,deadline)
   self.receipt['timer_tail']={'timers_active':list(OWN_TIMERS),'max_wait_seconds':ONESHOT_WAIT_SECONDS,
       'shared_operation_locks_released':True,'observed_running_invocations':copy.deepcopy(self.waited_jobs),
       'idle_job_status':{name:{key:jobs['states'][name].get(key) for key in
                              ('ActiveState','SubState','MainPID','Result','ExecMainCode','ExecMainStatus')} for name in OWN_JOBS},
       'claim':'Timers are active and exact jobs are idle. Only observed running invocations are fresh execution evidence; never-fired calendar jobs are not fresh backup or certificate proof.'}
   self.event('owned_jobs_idle_final_verification_pending')
   try:self.verify_finished(complete=True);break
   except Refusal as error:
    if str(error) not in ('ADMISSION_OWN_ONESHOT_BUSY','ADMISSION_ONESHOT_TRANSITION'):raise
    require(time.monotonic()<deadline,'ADMISSION_OWN_ONESHOT_TIMEOUT')
  directory_lock_guard(*self.directory_lease)
  return self.receipt

 def upgrade(self):
  marker=copy.deepcopy(self.capsule['audit']['state']['marker'])
  self.fresh();backup=self.b.oldops.backup(marker,self.runtime)
  require(backup.get('path'),'ADMISSION_ORIGINAL_BACKUP_FAILED');self.receipt['backup']=backup
  self.event('original_backup_created',backup=backup)
  restore=self.b.oldops.restore(marker,Path(backup['path']),self.runtime)
  require(restore.get('passed') is True and restore.get('cleanup',{}).get('database_removed') is True
          and restore.get('cleanup',{}).get('temporary_removed') is True,'ADMISSION_ORIGINAL_RESTORE_NOT_CLEAN')
  self.receipt['restore']=restore;self.event('original_restore_drill_proved')
  self.stop_writers(marker)
  state=self.scope(public_expected=self.capsule['audit']['state']['protected'],require_active=False)
  data,_=self.database(state['marker']);require(data==self.capsule['audit']['database'],'ADMISSION_DATABASE_CHANGED_AFTER_STOP')
  env_raw,env_pin=read_file(self.p.PRIVATE/'runtime.env',private=True)
  replacement=edit_runtime(env_raw,{'OASIS_ADMISSION_PROFILE':'closed'})
  new_env=atomic_replace(self.p.PRIVATE/'runtime.env',replacement,env_pin)
  self.authored_paths[str(self.p.PRIVATE/'runtime.env')]=new_env
  env=self.b.a.parse_env_text(replacement.decode());self.event('target_closed_environment_written')
  result=json.loads(self.runtime.command(['/usr/bin/node','--import',str(TARGET/'platform/node_modules/tsx/dist/loader.mjs'),
              '--input-type=module','-e',migration_script(TARGET)],env=env,timeout=180))
  require(result=={'passed':True,'seeded':False},'ADMISSION_MIGRATION_PROOF_INVALID');self.event('official_closed_migration_proved')
  old_profile=self.b.a.runtime_profile(self.b.a.parse_env_text(env_raw.decode()))
  original=source_entry(marker,OLD,OLD_MANIFEST,OLD_HELPERS,old_profile,[])
  marker.update(release=str(TARGET),manifest_sha256=self.args.manifest_sha256)
  marker['private_pins']['runtime.env']=self.p.fingerprint(self.p.PRIVATE/'runtime.env')
  helpers={name:self.b.members['platform/deploy/production-instance/'+name] for name in self.p.HELPERS}
  current=source_entry(marker,TARGET,self.args.manifest_sha256,helpers,self.b.a.runtime_profile(env),[])
  marker['release_history']=[original,current]
  self.advance_pin();self.marker_replace(marker);self.event('target_closed_source_advanced')
  self.replace_units(marker);self.run_inspection(marker);self.event('target_closed_database_verified')
  self.restart_writers(marker)

 def advance_pin(self):
  expected=self.capsule['audit']['state']['production_pin'];require(pin(self.p.PIN,symlink=True)==expected,'ADMISSION_PIN_BEFORE_WRITE_CHANGED')
  temporary=self.p.PIN.with_name('.production-admission-pin-'+secrets.token_hex(16))
  os.symlink(str(TARGET),temporary)
  created=pin(temporary,symlink=True)
  try:
   require(pin(self.p.PIN,symlink=True)==expected,'ADMISSION_PIN_BEFORE_WRITE_CHANGED');os.replace(temporary,self.p.PIN)
   actual=pin(self.p.PIN,symlink=True)
   require(all(actual[key]==created[key] for key in created if key not in ('st_ctime_ns','st_mtime_ns')),
           'ADMISSION_PIN_READBACK_CHANGED');self.authored_paths[str(self.p.PIN)]=actual
  finally:
   if temporary.is_symlink():require(pin(temporary,symlink=True)==created,'ADMISSION_PIN_TEMP_CHANGED');temporary.unlink()

 def change_policy(self):
  marker=copy.deepcopy(self.capsule['audit']['state']['marker']);data=self.capsule['audit']['database']
  approval=self.capsule['approval'];action=self.args.action
  if action=='approve':self.stop_writers(marker)
  self.fresh()
  query,expected=policy_transaction_sql(action,data,approval,self.args.approval_sha256)
  rows=[json.loads(row) for row in self.b.ops.sql(self.runtime,marker,self.p.DATABASE,query).splitlines() if row.startswith('{')]
  require(len(rows)==1 and self.b.a.normalize_policy(rows[0])==self.b.a.normalize_policy(expected),
          'ADMISSION_POLICY_COMMIT_RESPONSE_CHANGED')
  snapshot=self.b.a.normalize_policy(rows[0]);self.receipt['committed_policy']=snapshot
  self.event('policy_'+snapshot['state']+'_committed',revision=snapshot['revision'])
  current=next(entry for entry in marker['release_history'] if entry['release']==str(TARGET))
  if action=='approve':
   closed={name:copy.deepcopy(current[name]) for name in ('private_pins','runtime_profile','policy_approvals')}
   require(current['runtime_profile']['profile']=='closed' and not current['policy_approvals'],
           'ADMISSION_APPROVE_ORIGINAL_CONFIGURATION_CHANGED')
   configs=current.setdefault('configuration_history',[]);require(isinstance(configs,list) and not configs,
                                                                 'ADMISSION_CONFIGURATION_HISTORY_UNEXPECTED')
   configs.append(closed)
   raw,identity=read_file(self.p.PRIVATE/'runtime.env',private=True)
   replacement=edit_runtime(raw,dict(zip(FREE_FIELDS,('firstparty-free-v1',self.args.app_id,str(TARGET),self.args.manifest_sha256))))
   value=atomic_replace(self.p.PRIVATE/'runtime.env',replacement,identity)
   self.authored_paths[str(self.p.PRIVATE/'runtime.env')]=value
   marker['private_pins']['runtime.env']=self.p.fingerprint(self.p.PRIVATE/'runtime.env')
   current['private_pins']=copy.deepcopy(marker['private_pins'])
   current['runtime_profile']=self.b.a.runtime_profile(self.b.a.parse_env_text(replacement.decode()),
                                   expected_release=str(TARGET),expected_manifest=self.args.manifest_sha256)
  approvals=current['policy_approvals'];require(isinstance(approvals,list) and len(approvals)<256,'ADMISSION_POLICY_HISTORY_LIMIT')
  require(not any(item['revision']==snapshot['revision'] for item in approvals),'ADMISSION_POLICY_HISTORY_REVISION_DUPLICATE')
  approvals.append(snapshot);self.marker_replace(marker);self.event('policy_history_preserved')
  self.run_inspection(marker,allow_free_active=action in ('open','close'))
  if action=='approve':self.restart_writers(marker)

 def verify_finished(self,*,complete=True):
  require(type(complete) is bool and (not complete or (not self.global_locks_held and self.directory_lease is not None)),
          'ADMISSION_COMPLETION_REQUIRES_UNLOCKED')
  self.fresh();state=self.scope(public_expected=self.capsule['audit']['state']['protected'])
  require(all(state['units']['states'][name].get('ActiveState')==('active' if complete else 'inactive')
              and state['units']['states'][name].get('MainPID') in ('0',None) for name in OWN_TIMERS),
          'ADMISSION_FINAL_TIMER_STATE_CHANGED')
  expected_profile='closed' if self.args.action=='upgrade' else 'firstparty-free-v1'
  require(state['runtime_profile']['profile']==expected_profile,'ADMISSION_FINAL_PROFILE_CHANGED')
  ops=self.b.ops;exists=ops.sql(self.runtime,state['marker'],self.p.DATABASE,"SELECT to_regclass('public.gp_production_admission') IS NOT NULL;").strip()
  require(exists=='t','ADMISSION_TARGET_POLICY_SCHEMA_MISSING')
  rows=[json.loads(row) for row in ops.sql(self.runtime,state['marker'],self.p.DATABASE,snapshot_sql(self.args.app_id)).splitlines() if row.startswith('{')]
  require(len(rows)==1,'ADMISSION_FINAL_DATABASE_RESPONSE_INVALID');data=rows[0]
  if self.args.action=='upgrade':validate_database(data,self.b.a,self.args,action='approve')
  else:
   wanted='open' if self.args.action=='open' else 'closed'
   require(data['app']['status']==('active' if wanted=='open' else 'paused')
           and self.b.a.normalize_policy(data.get('policy'))==self.receipt['committed_policy']
           and data['policy']['state']==wanted and data['nonzero_money']==data['financial_rows']==0,
           'ADMISSION_FINAL_POLICY_CHANGED')
  self.runtime.http(self.args.origin+'/health/ready',200,'production')
  self.fresh()
  require(self.scope(public_expected=self.capsule['audit']['state']['protected'])==state,'ADMISSION_FINAL_STATE_CHANGED')
  self.receipt['final']={'state':state,'database':data,'financial_admission_enabled':False,
                         'probability_admission_enabled':False,'thirdparty_financial_admission_enabled':False}
  self.receipt['passed']=complete
  self.event(('complete_'+('closed' if self.args.action in ('upgrade','approve','close') else 'free_open'))
             if complete else 'verified_pending_owned_timers')

 def safe_stop_api(self):
  self.source_guard();self.guardian.guard(self.capsule['audit']['state']['protected'])
  if self.directory_lease:directory_lock_guard(*self.directory_lease)
  for path,expected in self.locks.items():require(pin(path)==expected,'ADMISSION_LOCK_REPLACED')
  marker=self.authored_marker or copy.deepcopy(self.capsule['audit']['state']['marker'])
  # Reconcile only a file this operation itself wrote; no newly observed pin
  # becomes authority. Original secrets, CID/network/volume and loaded units
  # are still verified by the normal helper before any stop.
  env_path=str(self.p.PRIVATE/'runtime.env')
  if env_path in self.authored_paths:
   require(pin(env_path)==self.authored_paths[env_path],'ADMISSION_FAILURE_ENV_CHANGED')
   marker['private_pins']['runtime.env']=self.p.fingerprint(Path(env_path))
  production_pin=pin(self.p.PIN,symlink=True)
  require(production_pin==self.authored_paths.get(str(self.p.PIN),self.capsule['audit']['state']['production_pin']),
          'ADMISSION_FAILURE_PIN_CHANGED')
  marker['release']=production_pin['target']
  marker['manifest_sha256']=OLD_MANIFEST if marker['release']==str(OLD) else self.args.manifest_sha256
  (self.b.oldops if marker['release']==str(OLD) else self.b.ops).owned_resources(marker,self.runtime)
  self.installed_units(marker,cleanup=True)
  self.runtime.command(['systemctl','stop',*OWN_TIMERS,'oasis-production-api.service'],timeout=90)
  stopped=self.runtime.service('oasis-production-api.service')
  require(stopped.get('ActiveState')=='inactive' and stopped.get('MainPID') in ('0',None),'ADMISSION_FAILURE_API_NOT_STOPPED')
  return {'api_stopped':True,'timers_stopped':True,'database_container_stopped':False,'data_deleted':False,
          'database_policy_may_be_committed':bool(self.receipt.get('committed_policy'))}

 def fail_closed(self,error):
  self.receipt['passed']=False;self.receipt['failed_at_phase']=self.receipt.get('phase')
  self.receipt['closed_runtime_confirmed']=False
  self.receipt['error_code']=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'ADMISSION_OPERATION_FAILED'
  try:
   self.receipt['cleanup']=self.safe_stop_api()
   self.receipt['closed_runtime_confirmed']=self.receipt['cleanup'].get('api_stopped') is True
  except Exception as cleanup:
   self.receipt['cleanup_error_code']=str(cleanup) if isinstance(cleanup,Refusal) and re.fullmatch('[A-Z0-9_]+',str(cleanup)) else 'ADMISSION_FAILURE_STOP_REFUSED'
  self.event('failed_closed')

 def apply(self):
  raw,check_pin=read_file(self.args.check,self.args.check_sha256,private=True)
  capsule=json.loads(raw);self.p.fresh_time(capsule.get('at'))
  require(capsule.get('kind')=='production-admission-check' and capsule.get('passed') is True
          and capsule.get('action')==self.args.action and capsule.get('tool_sha256')==self.args.controller_sha256,
          'ADMISSION_CHECK_CONTROLLER_OR_ACTION_CHANGED')
  actual=self.check()
  require(stable_capsule(actual)==stable_capsule(capsule),
          'ADMISSION_CHECK_STATE_CHANGED')
  self.capsule=capsule;self.authored_paths={}
  self.immutable_evidence={str(Path(self.args.check)):check_pin,str(Path(self.args.audit)):capsule['audit_pin'],
           str(Path(self.args.approval)):capsule['approval_pin'],str(self.p.PRIVATE/'bootstrap.json'):capsule['audit']['state']['bootstrap_pin']}
  self.preserve()
  try:
   if self.args.action=='upgrade':self.upgrade()
   else:
    if self.args.action in ('open','close'):self.stop_timers(self.capsule['audit']['state']['marker'])
    self.change_policy()
   self.verify_finished(complete=False)
  except Exception as error:
   self.fail_closed(error);raise
  return self.receipt


def parser():
 value=argparse.ArgumentParser(description=__doc__)
 value.add_argument('mode',choices=('audit','check','apply'));value.add_argument('--action',choices=ACTIONS,required=True)
 for name in ('release','manifest-sha256','controller-sha256','source-commit','controller-origin-commit','app-id','origin',
              'protected-inventory','protected-inventory-sha256'):value.add_argument('--'+name,required=True)
 for name in ('audit','audit-sha256','approval','approval-sha256','check','check-sha256'):value.add_argument('--'+name)
 for name in ('source-audit','archive-proof','archive-review','retirement-check','retirement-receipt'):
  value.add_argument('--'+name);value.add_argument('--'+name+'-sha256')
 value.add_argument('--capacity-budget-bytes',type=int,required=True)
 return value


def execute_lifecycle(controller,args,bindings,expected):
 with controller_directory_lock(args,bindings) as lease:
  controller.directory_lease=lease
  try:
   with locked_files(bindings.p,expected) as locks:
    controller.locks=locks;controller.global_locks_held=True
    result=controller.audit() if args.mode=='audit' else controller.check() if args.mode=='check' else controller.apply()
  finally:controller.global_locks_held=False
  if args.mode=='apply':
   try:result=controller.finish_after_unlock()
   except Exception as error:
    controller.fail_closed(error);raise
 return result


def main(argv=None):
 args=parser().parse_args(argv);os.umask(0o077);controller=None
 try:
  require(os.getuid()==0 and sys.flags.isolated==1 and sys.dont_write_bytecode,'ADMISSION_ISOLATED_ROOT_REQUIRED');require(args.release==str(TARGET),'ADMISSION_EXACT_TARGET_REQUIRED')
  require(sha(args.controller_sha256) and sha(args.manifest_sha256) and sha(args.protected_inventory_sha256),
          'ADMISSION_EXTERNAL_SHA_REQUIRED')
  if args.mode!='audit':require(args.audit and sha(args.audit_sha256) and args.approval and sha(args.approval_sha256),
                              'ADMISSION_AUDIT_AND_ROOT_PROOF_REQUIRED')
  if args.mode=='apply':require(args.check and sha(args.check_sha256),'ADMISSION_CHECK_SHA_REQUIRED')
  bindings=load_bindings(args);bindings.p.validate_origin(args.origin);controller=Controller(args,bindings)
  expected=None
  if args.mode=='apply':
   raw,_=read_file(args.check,args.check_sha256,private=True);expected=json.loads(raw).get('audit',{}).get('locks')
   require(isinstance(expected,dict) and len(expected)==2,'ADMISSION_CHECK_LOCK_PINS_REQUIRED')
  result=execute_lifecycle(controller,args,bindings,expected)
  if args.mode=='apply':
   print(json.dumps({'passed':result['passed'],'phase':result['phase'],'action':args.action,
                     'receipt':str(controller.directory/'receipt.json'),'receipt_sha256':pin(controller.directory/'receipt.json')['sha256']}))
  else:print(json.dumps(result,sort_keys=True))
  return 0
 except Exception as error:
  # A final lock identity failure must invalidate an already-complete receipt.
  if controller and controller.receipt and controller.receipt.get('passed') is True:
   try:controller.fail_closed(error)
   except Exception:pass
  result={'passed':False,'error_code':str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'ADMISSION_CONTROLLER_FAILED'}
  if controller and controller.directory:
   result.update(receipt=str(controller.directory/'receipt.json'),phase=controller.receipt.get('phase'),
                 cleanup_error_code=controller.receipt.get('cleanup_error_code'))
  print(json.dumps(result,sort_keys=True));return 2


if __name__=='__main__':raise SystemExit(main())

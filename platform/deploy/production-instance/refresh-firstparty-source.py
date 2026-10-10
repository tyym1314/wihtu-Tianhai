#!/usr/bin/python3
"""Preserve real free-training data while advancing one witnessed 04 source to 05.

Root executes audit/check/apply. This controller grants no financial or performance
admission, does not bootstrap, and never changes the frozen predecessor or T6.
"""
import argparse
import ast
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import time
import types
import urllib.request
import urllib.error
from contextlib import contextmanager

SOURCE = Path('/opt/oasis/releases/20261010-04')
SOURCE_MANIFEST = '4b8c3b2820c271198563180983c72f25d088c63c872463704af632929adf3c0f'
SOURCE_COMMIT = '63e44d330cf09c60eab0a08c03150b5f38d26ea7'
TARGET = Path('/opt/oasis/releases/20261010-05')
SELF_MEMBER = 'platform/deploy/production-instance/refresh-firstparty-source.py'
POLICY_KEYS = ('app_id','profile','state','revision','scope','currency_scale','allowed_origins',
               'game_ids','release','manifest_sha256','proof_sha256','approved_by','approved_at')
APPROVAL_KEYS = {'schema','kind','passed','action','scope_kind','audit_sha256','release','manifest_sha256',
                 'source_commit','app_id','scope','currency_scale','allowed_origins','game_ids','profile',
                 'financial_admission_enabled','probability_admission_enabled',
                 'thirdparty_financial_admission_enabled','approved_by','approved_at'}
LEGACY_COMMON_FLAGS = {'--action','--release','--manifest-sha256','--controller-sha256','--source-commit',
    '--controller-origin-commit','--app-id','--origin','--protected-inventory','--protected-inventory-sha256',
    '--capacity-budget-bytes','--source-audit','--source-audit-sha256','--archive-proof','--archive-proof-sha256',
    '--archive-review','--archive-review-sha256','--retirement-check','--retirement-check-sha256',
    '--retirement-receipt','--retirement-receipt-sha256','--static-retention-review','--static-retention-review-sha256'}
MONEY_FIELDS = ('treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version')


class Refusal(Exception):
    pass


def require(value, code):
    if not value: raise Refusal(code)


def digest(body): return hashlib.sha256(body).hexdigest()
def canonical(value): return (json.dumps(value, sort_keys=True, separators=(',',':'))+'\n').encode()
def sha(value): return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None
def now(): return dt.datetime.now(dt.timezone.utc).isoformat()


def root_approval(value, raw_audit, audit, args):
    require(isinstance(value,dict) and set(value)==APPROVAL_KEYS and type(value.get('schema')) is int and value.get('schema')==1
            and value.get('kind')=='production-firstparty-admission-approval' and value.get('passed') is True,
            'REFRESH_ROOT_APPROVAL_REQUIRED')
    require(value['action']==args.action and value['scope_kind']==('source-refresh' if args.action=='refresh' else 'firstparty-free-only')
            and value['audit_sha256']==digest(raw_audit) and audit.get('passed') is True
            and value['release']==str(TARGET) and value['manifest_sha256']==args.manifest_sha256
            and value['source_commit']==args.source_commit and value['app_id']==audit['app_id']
            and value['profile']=='firstparty-free-v1', 'REFRESH_ROOT_APPROVAL_SCOPE_CHANGED')
    require(all(value[name] is False for name in ('financial_admission_enabled','probability_admission_enabled',
                                                 'thirdparty_financial_admission_enabled')),
            'REFRESH_FINANCIAL_ADMISSION_FORBIDDEN')
    require(all(value[name]==audit['policy_scope'][name] for name in ('scope','currency_scale','allowed_origins','game_ids')),
            'REFRESH_ROOT_APPROVAL_METADATA_CHANGED')
    require(re.fullmatch('[A-Za-z0-9_-]{1,128}',value['approved_by'] or ''), 'REFRESH_APPROVAL_ACTOR_INVALID')
    fresh(value['approved_at']); return value


def fresh(value):
    try:
        at=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
        require(at.tzinfo is not None and 0 <= (dt.datetime.now(dt.timezone.utc)-at).total_seconds() <= 600,
                'REFRESH_EVIDENCE_NOT_FRESH')
    except (ValueError,AttributeError,TypeError): raise Refusal('REFRESH_EVIDENCE_TIME_INVALID') from None


def legacy_args(core, argv):
    require(isinstance(argv,list) and len(argv)==2*len(LEGACY_COMMON_FLAGS)
            and all(isinstance(value,str) for value in argv)
            and set(argv[::2])==LEGACY_COMMON_FLAGS and len(set(argv[::2]))==len(argv[::2])
            and all(value and not value.startswith('--') for value in argv[1::2]),'REFRESH_COMMON_ARGV_INVALID')
    value=core.parser().parse_args(['audit',*argv])
    require(value.action=='close','REFRESH_COMMON_CLOSE_ACTION_REQUIRED')
    value.action='open';return value


def static_delta(before, after, plan):
    """Only official immutable additions, one receipt and the exact computed head."""
    require(before['registered']==plan['old_registered'] and before['head']==plan['old_head'], 'REFRESH_STATIC_PLAN_BASE_CHANGED')
    require(all(after['entries'].get(key)==value for key,value in before['entries'].items())
            and all(after['receipts'].get(key)==value for key,value in before['receipts'].items()),
            'REFRESH_EXISTING_STATIC_FILE_CHANGED')
    new_files=set(after['entries'])-set(before['entries'])
    require(new_files==set(plan['missing']) and set(after['receipts'])-set(before['receipts'])=={plan['receipt_sha256']+'.json'}
            and after['registered']=={**before['registered'],**plan['wanted']} and after['head']==plan['head']
            and after['head_pin']['sha256']==plan['head_sha256'], 'REFRESH_STATIC_ADDITIONS_NOT_EXACT')
    old_ids={(v['device'],v['inode']) for v in (*before['entries'].values(),*before['receipts'].values(),before['head_pin'])}
    added=[after['entries'][name] for name in new_files]+[after['receipts'][plan['receipt_sha256']+'.json'],after['head_pin']]
    require(len({(v['device'],v['inode']) for v in added})==len(added)
            and not old_ids & {(v['device'],v['inode']) for v in added}, 'REFRESH_STATIC_INODE_ALIAS')
    for name in new_files:
        v=after['entries'][name];require(v['uid']==v['gid']==0 and v['mode']==0o644 and v['nlink']==1
               and {key:v[key] for key in ('bytes','sha256')}==plan['wanted'][name], 'REFRESH_STATIC_NEW_FILE_UNSAFE')
    receipt=after['receipts'][plan['receipt_sha256']+'.json']
    require(receipt['uid']==receipt['gid']==0 and receipt['mode']==0o644 and receipt['nlink']==1
            and receipt['sha256']==plan['receipt_sha256'] and receipt['bytes']==plan['receipt_bytes'], 'REFRESH_STATIC_RECEIPT_UNSAFE')
    head=after['head_pin'];require(head['uid']==head['gid']==0 and head['mode']==0o600 and head['nlink']==1
            and head['bytes']==plan['head_bytes'] and head['device']==before['head_pin']['device'], 'REFRESH_STATIC_HEAD_UNSAFE')
    mutable={'.registry'}
    for name in new_files:
        parent=Path(name.lstrip('/')).parent
        while str(parent)!='.': mutable.add(parent.as_posix()); parent=parent.parent
    stable=('uid','gid','mode','device','inode','kind','nlink')
    for name,value in before['directories'].items():
        actual=after['directories'].get(name);require(actual is not None, 'REFRESH_STATIC_DIRECTORY_REMOVED')
        require(all(actual[key]==value[key] for key in stable), 'REFRESH_STATIC_DIRECTORY_IDENTITY_CHANGED')
        if name not in mutable: require(actual==value, 'REFRESH_STATIC_UNRELATED_DIRECTORY_CHANGED')
    for name in set(after['directories'])-set(before['directories']):
        value=after['directories'][name];require(name in mutable and value['uid']==value['gid']==0
               and value['mode']==0o755 and value['kind']=='directory', 'REFRESH_STATIC_NEW_DIRECTORY_UNAPPROVED')
    for name,value in before['ancestors'].items():
        actual=after['ancestors'].get(name);require(actual is not None, 'REFRESH_STATIC_ANCESTOR_REMOVED')
        require(all(actual[key]==value[key] for key in stable), 'REFRESH_STATIC_ANCESTOR_IDENTITY_CHANGED')
        if name!='/opt/oasis/private':require(actual==value,'REFRESH_STATIC_UNRELATED_ANCESTOR_CHANGED')
    require(set(before['ancestors'])==set(after['ancestors']), 'REFRESH_STATIC_ANCESTOR_SET_CHANGED')


def source_parent_delta(append_after, final, old_pin, new_pin):
    """Only this controller's witnessed production-current replace changes /opt/oasis."""
    before=copy.deepcopy(append_after);after=copy.deepcopy(final)
    name='/opt/oasis';old=before['ancestors'][name];new=after['ancestors'][name]
    require(all(new[key]==old[key] for key in old if key not in ('bytes','mtime_ns','ctime_ns')),
            'REFRESH_SOURCE_PARENT_IDENTITY_CHANGED')
    before['ancestors'][name]=new
    require(before==after,'REFRESH_STATIC_CHANGED_DURING_SOURCE_SWITCH')
    require(old_pin.get('target')==str(SOURCE) and new_pin.get('target')==str(TARGET)
            and old_pin['st_dev']==new_pin['st_dev'] and old_pin['st_ino']!=new_pin['st_ino']
            and new_pin['st_uid']==new_pin['st_gid']==0 and new_pin['st_nlink']==1
            and stat.S_ISLNK(new_pin['st_mode']), 'REFRESH_SOURCE_PIN_TRANSITION_UNPROVEN')
    return {'path':name,'before':old,'after':new,'old_production_pin':old_pin,'new_production_pin':new_pin}


def refresh_policy(before, approval, target, manifest, proof):
    require(before.get('state')=='closed' and set(before)==set(POLICY_KEYS)
            and before.get('release')==str(SOURCE) and before.get('manifest_sha256')==SOURCE_MANIFEST,
            'REFRESH_CLOSED_SOURCE_POLICY_REQUIRED')
    require(int(before['revision'])<9223372036854775807 and sha(proof), 'REFRESH_POLICY_REVISION_OR_PROOF_INVALID')
    value=copy.deepcopy(before);value.update(release=str(target),manifest_sha256=manifest,proof_sha256=proof,
        approved_by=approval['approved_by'],approved_at=approval['approved_at'],revision=str(int(before['revision'])+1))
    return value


def policy_sql(core, data, expected):
    """Reuse original locked full App/binding/wallet/old-policy predicates, replace only UPDATE."""
    original,_=core.policy_transaction_sql('open',data,{'unused':True},expected['proof_sha256'])
    q=core.literal(data['app']['id']); assignment=','.join(name+'='+core.literal(str(expected[name]))
        for name in ('state','revision','release','manifest_sha256','proof_sha256','approved_by','approved_at'))
    start=original.index('UPDATE gp_apps SET status=')
    end=original.index('\nSELECT ',start)
    return original[:start]+f"UPDATE gp_apps SET status='paused' WHERE id={q}; UPDATE gp_production_admission SET {assignment},updated_at=now() WHERE app_id={q};"+original[end:]


def refresh_runtime(admission, original, target, manifest):
    """Replace only the two declared source lines; preserve every other byte."""
    require(isinstance(original,bytes) and original.endswith(b'\n') and sha(manifest),'REFRESH_RUNTIME_EDIT_INVALID')
    env=admission.parse_env_text(original.decode())
    previous=admission.runtime_profile(env,expected_release=str(SOURCE),expected_manifest=SOURCE_MANIFEST)
    require(previous['profile']=='firstparty-free-v1','REFRESH_RUNTIME_FREE_PROFILE_REQUIRED')
    values={'OASIS_ADMISSION_RELEASE':str(target),'OASIS_ADMISSION_MANIFEST_SHA256':manifest}
    lines=original.splitlines(keepends=True);seen=set();result=[]
    for line in lines:
        name=line.split(b'=',1)[0].decode('ascii',errors='ignore')
        if name in values:
            require(name not in seen and line==(name+'='+env[name]+'\n').encode(),'REFRESH_RUNTIME_SOURCE_LINE_CHANGED')
            seen.add(name);result.append((name+'='+values[name]+'\n').encode())
        else:result.append(line)
    require(seen==set(values),'REFRESH_RUNTIME_SOURCE_LINE_MISSING')
    replacement=b''.join(result);changed=admission.parse_env_text(replacement.decode())
    require({key:value for key,value in changed.items() if key not in values}
            =={key:value for key,value in env.items() if key not in values},'REFRESH_RUNTIME_NON_SOURCE_CHANGED')
    admission.runtime_profile(changed,expected_release=str(target),expected_manifest=manifest)
    return replacement


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        raise Refusal('REFRESH_HTTPS_REDIRECT_FORBIDDEN')


def https_request(opener,url,method='GET',headers=None,limit=16<<20):
    try:response=opener.open(urllib.request.Request(url,method=method,headers=headers or {}),timeout=15)
    except urllib.error.HTTPError as error:response=error
    except (urllib.error.URLError,OSError,TimeoutError):raise Refusal('REFRESH_HTTPS_UNAVAILABLE') from None
    with response:
        require(response.geturl()==url,'REFRESH_HTTPS_URL_CHANGED')
        body=response.read(limit+1);require(len(body)<=limit,'REFRESH_HTTPS_BODY_TOO_LARGE')
        return response.status,dict(response.headers.items()),body


class HeldInputs:
    def __init__(self, core): self.core=core;self.files={};self.parents={};self.fds=[];self.bodies={}
    def read(self,path,expected,*,private=True):
        path=Path(path);require(path.is_absolute() and '..' not in path.parts and sha(expected),'REFRESH_INPUT_PATH_ALIAS')
        if str(path) in self.files:
            require(self.files[str(path)]['sha256']==expected,'REFRESH_INPUT_EXPECTATION_CHANGED')
            self.guard();return self.bodies[str(path)]
        raw,pin=self.core.read_file(path,expected,private=private,limit=16<<20)
        if private:
            parent=path.parent.lstat();require(parent.st_uid==parent.st_gid==0 and stat.S_IMODE(parent.st_mode)==0o700,'REFRESH_INPUT_PARENT_UNSAFE')
        for parent in path.parents:
            if str(parent) not in self.parents:
                s=parent.lstat();require(stat.S_ISDIR(s.st_mode) and not s.st_mode&0o022,'REFRESH_INPUT_PARENT_UNSAFE')
                fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                self.parents[str(parent)]=(fd,{key:getattr(s,key) for key in ('st_dev','st_ino','st_uid','st_gid','st_mode')})
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);self.fds.append((fd,path,pin));self.files[str(path)]=pin;self.bodies[str(path)]=raw;self.guard();return raw
    def guard(self):
        for path,(fd,value) in self.parents.items():
            require(all(getattr(os.fstat(fd),key)==getattr(Path(path).lstat(),key)==expected for key,expected in value.items()),'REFRESH_INPUT_PARENT_REPLACED')
        for fd,path,value in self.fds:self.core.lock_guard(fd,path,value)
    def close(self):
        for fd,_,_ in self.fds:os.close(fd)
        for fd,_ in self.parents.values():os.close(fd)


def read_core(path,expected):
    """Compile raw FD bytes: no import loader, pyc, shell or unbound source."""
    path=Path(path);s=path.lstat();require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0
        and stat.S_IMODE(s.st_mode)==0o600 and path.is_absolute() and sha(expected), 'REFRESH_CORE_FILE_UNSAFE')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        identity=lambda value:tuple(getattr(value,key) for key in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))
        require(identity(os.fstat(fd))==identity(s),'REFRESH_CORE_REPLACED');raw=bytearray()
        while True:
            part=os.read(fd,1<<20)
            if not part:break
            raw.extend(part);require(len(raw)<=256<<10,'REFRESH_CORE_TOO_LARGE')
        require(digest(raw)==expected and identity(path.lstat())==identity(s) and identity(os.fstat(fd))==identity(s),'REFRESH_CORE_BODY_CHANGED')
        module=types.ModuleType('oasis_refresh_verified_core');module.__file__=str(path)
        exec(compile(ast.parse(bytes(raw),filename=str(path)),str(path),'exec'),module.__dict__)
        require(module.TARGET==SOURCE and module.RUNTIME_MANIFEST==SOURCE_MANIFEST
                and module.RUNTIME_SOURCE_COMMIT==SOURCE_COMMIT and module.TOOL==path,'REFRESH_CORE_SOURCE_CONTRACT_CHANGED')
        module.Refusal=Refusal
        return module,bytes(raw),fd,module.pin(path)
    except Exception:os.close(fd);raise


class Refresh:
    def __init__(self,args):
        self.args=args;self.core,self.core_raw,self.core_fd,self.core_pin=read_core(args.legacy_controller,args.legacy_controller_sha256)
        c=self.core;self.inputs=HeldInputs(c);self.directory=None;self.receipt=None;self.receipt_pin=None;self.authored={}
        self.locks={};self.lease=None;self.global_locks_held=False;self.after_static=None;self.static_plan=None;self.public_expected=None
        raw=self.inputs.read(args.legacy_common_argv,args.legacy_common_argv_sha256)
        self.oldargs=legacy_args(c,json.loads(raw))
        require(self.oldargs.release==str(SOURCE) and self.oldargs.manifest_sha256==SOURCE_MANIFEST
                and self.oldargs.source_commit==SOURCE_COMMIT and self.oldargs.controller_sha256==args.legacy_controller_sha256,
                'REFRESH_LEGACY_IDENTITY_CHANGED')
        self.oldb=c.load_bindings(self.oldargs);self.runtime=c.make_runtime(self.oldb.p)
        self.operator=json.loads(self.inputs.read(args.operator_inventory,args.operator_inventory_sha256))
        self.operator_guard()
        self.authority=None
        self.closed_authority=None
        if args.action=='refresh':
            self.closed_authority=json.loads(self.inputs.read(args.source_receipt,args.source_receipt_sha256))
            value=self.closed_authority
            require(value.get('kind')=='production-admission-operation' and value.get('action')=='close'
                and value.get('passed') is True and value.get('phase')=='complete_closed'
                and value.get('controller_sha256')==args.legacy_controller_sha256
                and value.get('target_release')==str(SOURCE) and value.get('target_manifest_sha256')==SOURCE_MANIFEST
                and value.get('source_commit')==SOURCE_COMMIT
                and all(value['final'].get(name) is False for name in ('financial_admission_enabled','probability_admission_enabled',
                                                                     'thirdparty_financial_admission_enabled')),
                    'REFRESH_PASSED_SOURCE04_CLOSE_REQUIRED')
        if args.action!='refresh':
            self.authority=json.loads(self.inputs.read(args.source_receipt,args.source_receipt_sha256))
            self.authority_guard(self.authority)
        self._guardian(self.authority)
        self.load_candidate()
        self.base_input_pins=copy.deepcopy(self.inputs.files)
        self.context=self.oldcontext if args.action=='refresh' else self.new_context(self.authority['final']['state']['marker'])
        self.public_expected=self.context.guardian.protected['snapshot']

    def operator_guard(self):
        c=self.core;value=self.operator
        require(set(value)=={'directory_pin','files'} and isinstance(value['files'],dict) and len(value['files'])==6,
                'REFRESH_T6_INVENTORY_INVALID')
        require(c.pin(c.TOOL.parent)==value['directory_pin'],'REFRESH_T6_DIRECTORY_CHANGED')
        # The root inventory supplies exact existing names; no guessed renamed T6 is accepted.
        names=set(value['files']);require({'upgrade-admission.py','source-provenance.json','upgrade-admission-original-v1.py',
            'source-provenance-original-v1.json'}<=names and all(re.fullmatch('[A-Za-z0-9_.-]+',name) for name in names),'REFRESH_T6_NAMES_CHANGED')
        for name,identity in value['files'].items():
            path=c.TOOL.parent/name;require(c.pin(path)==identity and identity['st_uid']==identity['st_gid']==0
                and stat.S_IMODE(identity['st_mode'])==0o600 and identity['st_nlink']==1,'REFRESH_T6_FILE_CHANGED')
        require({path.name for path in c.TOOL.parent.iterdir()}==names,'REFRESH_T6_EXTRA_FILE')
        c.lock_guard(self.core_fd,Path(self.args.legacy_controller),self.core_pin)

    def authority_guard(self,value):
        require(value.get('kind')=='production-firstparty-source-operation' and value.get('passed') is True
                and value.get('phase') in ('complete_closed','complete_free_open') and value.get('action') in ('refresh','open','close')
                and value.get('target_release')==str(TARGET) and value.get('target_manifest_sha256')==self.args.manifest_sha256
                and value.get('source_commit')==self.args.source_commit and value.get('controller_sha256')==self.args.controller_sha256
                and value.get('legacy_controller_sha256')==self.args.legacy_controller_sha256
                and all(value['final'].get(name) is False for name in ('financial_admission_enabled','probability_admission_enabled',
                                                                     'thirdparty_financial_admission_enabled')),
                'REFRESH_PASSED_PREDECESSOR_RECEIPT_REQUIRED')
        require(value.get('static_before') and value.get('static_after') and value.get('static_append_after') and value.get('static_plan'),
                'REFRESH_STATIC_AUTHORITY_MISSING')
        static_delta(value['static_before'],value['static_append_after'],value['static_plan'])
        source_parent_delta(value['static_append_after'],value['static_after'],
                            value['source_parent_delta']['old_production_pin'],value['source_parent_delta']['new_production_pin'])
        require(value['final']['state']['production_pin']==value['source_parent_delta']['new_production_pin']
                and value['original']['production_pin']==value['source_parent_delta'][
                    'old_production_pin' if value['action']=='refresh' else 'new_production_pin'],
                'REFRESH_STATIC_SOURCE_PIN_AUTHORITY_CHANGED')
        require(isinstance(value.get('source_history_prefix'),list) and len(value['source_history_prefix'])==2,
                'REFRESH_ORIGINAL_HISTORY_AUTHORITY_REQUIRED')
        self.history_prefix=value['source_history_prefix']
        self.after_static=value['static_after'];self.static_plan=value['static_plan']

    def _guardian(self, authority):
        c=self.core
        if authority:
            parent=self
            class ExtendedStatic(c.StaticRetentionReview):
                def verify(self):
                    self.evidence_guard()
                    require(self.plan['after']['static']['registered']==authority['static_before']['registered'],
                            'REFRESH_STATIC_ORIGINAL_CHAIN_CHANGED')
                    actual=parent.static_snapshot(self.selector)
                    require(actual==authority['static_after'],'REFRESH_STATIC_PASSED_RECEIPT_LIVE_CHANGED')
                    self.derived=copy.deepcopy(self.derived)
                    self.derived['snapshot']['files'][str(c.STATIC_HEAD)]=c.static_guardian_pin(actual['head_pin'])
                    return {'original_review_sha256':self.review_sha,'source_receipt_sha256':parent.args.source_receipt_sha256,
                            'static_fullpins_sha256':digest(canonical(actual)),'evidence_pins':self.files}
            original=c.StaticRetentionReview;c.StaticRetentionReview=ExtendedStatic
            try:self.oldcontext=c.Controller(self.oldargs,self.oldb,self.runtime)
            finally:c.StaticRetentionReview=original
        else:self.oldcontext=c.Controller(self.oldargs,self.oldb,self.runtime)
        require(getattr(self.oldcontext.guardian,'static_retention',None) is not None,'REFRESH_APPROVED_STATIC04_CHAIN_REQUIRED')

    def load_candidate(self):
        c=self.core;args=self.args
        require(args.release==str(TARGET) and sha(args.manifest_sha256) and re.fullmatch('[a-f0-9]{40}',args.source_commit or '')
                and sha(args.controller_sha256),'REFRESH_TARGET_IDENTITY_REQUIRED')
        raw,pin=c.read_file(TARGET/'RELEASE-MANIFEST.json',args.manifest_sha256)
        self.members=json.loads(raw);require(isinstance(self.members,dict) and len(self.members)>=10,'REFRESH_MANIFEST_INVALID')
        require(self.members.get(SELF_MEMBER)==args.controller_sha256 and digest(Path(__file__).read_bytes())==args.controller_sha256,
                'REFRESH_EXECUTING_SOURCE_NOT_BOUND')
        self.self_pin=c.pin(Path(__file__));self.manifest_pin=pin
        self.self_fd=os.open(Path(__file__),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        c.lock_guard(self.self_fd,Path(__file__),self.self_pin)
        prefix='platform/deploy/production-instance/'
        p,pp=c.module_bytes(TARGET/(prefix+'provision.py'),self.members[prefix+'provision.py']);p.Refusal=Refusal
        a,ap=c.module_bytes(TARGET/(prefix+'admission-runtime.py'),self.members[prefix+'admission-runtime.py'])
        ops,op=c.module_bytes(TARGET/(prefix+'operations.py'),self.members[prefix+'operations.py'],inject={'p':p,'a':a},strip_loaders=True)
        ingress,ip=c.module_bytes(TARGET/'platform/deploy/production-ingress.py',self.members['platform/deploy/production-ingress.py'])
        units,up=c.module_bytes(TARGET/'platform/deploy/production-ingress-units.py',self.members['platform/deploy/production-ingress-units.py'])
        pins={str(TARGET/(prefix+'provision.py')):pp,str(TARGET/(prefix+'admission-runtime.py')):ap,
              str(TARGET/(prefix+'operations.py')):op,str(TARGET/'platform/deploy/production-ingress.py'):ip,
              str(TARGET/'platform/deploy/production-ingress-units.py'):up,str(TARGET/'RELEASE-MANIFEST.json'):pin}
        self.b=types.SimpleNamespace(**{**self.oldb.__dict__,'p':p,'a':a,'ops':ops,'ingress':ingress,'units':units,
            'members':self.members,'pins':pins})
        p.verify_release(TARGET,args.manifest_sha256);c.complete_members(p,TARGET,self.members)
        require(c.dependency_tree(p,TARGET)==self.oldb.dependencies,'REFRESH_DEPENDENCY_CLOSURE_CHANGED')
        old=self.oldb.members
        runtime=[name for name in set(old)|set(self.members) if name.startswith(('platform/server/','platform/shared/'))
                 or name in ('platform/package.json','platform/package-lock.json','platform/deploy/production-ingress.py',
                             'platform/deploy/production-ingress-units.py','platform/deploy/production-instance/provision.py')]
        require(all(old.get(name)==self.members.get(name) for name in runtime),'REFRESH_FRONTEND_ONLY_RUNTIME_CHANGED')
        self.selector=self.oldcontext.guardian.static_retention.selector
        # Both official selector and publisher remain the previously verified fixed public code.
        self.required,self.selected_manifest=self.selector.manifest_assets(TARGET)
        require(self.selected_manifest==args.manifest_sha256,'REFRESH_STATIC_SELECTION_MANIFEST_CHANGED')

    def source_guard(self):
        c=self.core;self.inputs.guard();self.operator_guard()
        c.lock_guard(self.self_fd,Path(__file__),self.self_pin)
        require(c.pin(Path(__file__))==self.self_pin and c.pin(TARGET/'RELEASE-MANIFEST.json')==self.manifest_pin,
                'REFRESH_CONTROLLER_OR_MANIFEST_REPLACED')
        legacy=c.controller_guard(self.oldargs,self.oldb)
        self.oldb.p.verify_historical_release(SOURCE,SOURCE_MANIFEST,{name:self.oldb.members['platform/deploy/production-instance/'+name]
                                                                   for name in self.oldb.a.CURRENT_HELPERS})
        c.complete_members(self.oldb.p,SOURCE,self.oldb.members);self.b.p.verify_release(TARGET,self.args.manifest_sha256)
        c.complete_members(self.b.p,TARGET,self.members)
        require(c.dependency_tree(self.oldb.p,SOURCE)==c.dependency_tree(self.b.p,TARGET)==self.oldb.dependencies,
                'REFRESH_DEPENDENCY_CLOSURE_CHANGED')
        require(all(c.pin(path)==pin for path,pin in self.oldcontext.protection_files.items()),'REFRESH_ORIGINAL_PROTECTION_EVIDENCE_CHANGED')
        for path,pin in self.b.pins.items(): require(c.pin(path)==pin,'REFRESH_CANDIDATE_HELPER_REPLACED')
        if self.after_static:
            require(self.static_snapshot(self.selector)==self.after_static,'REFRESH_AUTHORED_STATIC_CHANGED')
        else:self.oldcontext.guardian.static_retention.verify()
        if self.authority:
            require(c.pin(self.b.p.PIN,symlink=True)==self.authority['final']['state']['production_pin'],
                    'REFRESH_PREDECESSOR_SOURCE_PIN_REPLACED')
        return {'controller_sha256':self.args.controller_sha256,'controller_pin':self.self_pin,'legacy':legacy,
                'candidate_release':str(TARGET),'candidate_manifest_sha256':self.args.manifest_sha256,
                'runtime_source_commit':self.args.source_commit,'candidate_helpers':self.b.pins,
                'runtime_dependencies':self.oldb.dependencies,'retired_protection':self.oldcontext.retired_protection,
                'protection_files':{**self.oldcontext.protection_files,**self.base_input_pins},
                'static_after_sha256':digest(canonical(self.after_static)) if self.after_static else None}

    def new_context(self, marker):
        # A separate in-memory namespace changes only successor source dispatch.
        # The verified raw legacy source and all T6 files are left untouched.
        clone=types.ModuleType('oasis_refresh_source05_adapter');clone.__file__=self.core.__file__
        exec(compile(ast.parse(self.core_raw),self.core.__file__,'exec'),clone.__dict__)
        clone.Refusal=Refusal;clone.OLD=SOURCE;clone.TARGET=TARGET
        parent=self
        def marker_guard(actual,args,post=False):
            c=parent.core
            require(actual.get('kind')=='isolated-production-instance' and actual.get('schema')==1
                and actual.get('release')==str(TARGET) and actual.get('manifest_sha256')==parent.args.manifest_sha256
                and actual.get('container_id')==c.CID and actual.get('owner')==c.OWNER and actual.get('network_id')==c.NETWORK
                and actual.get('pg_image')==c.IMAGE and actual.get('uid')==997 and actual.get('gid')==999,'REFRESH_TARGET_MARKER_CHANGED')
            require(all(actual['private_pins'][name]==value for name,value in c.INITIAL_PRIVATE.items() if name!='runtime.env'),
                    'REFRESH_SECRET_CHANGED')
        def history_guard(actual,bindings):
            reference=parent.history_prefix
            require(actual['release_history'][:len(reference)]==reference and len(actual['release_history'])==len(reference)+1,
                    'REFRESH_PREDECESSOR_HISTORY_CHANGED')
            source=bindings.a.approved_source(actual,str(TARGET),parent.args.manifest_sha256)
            require(source['private_pins']==actual['private_pins'] and source['helpers']=={
                name:parent.members['platform/deploy/production-instance/'+name] for name in bindings.a.CURRENT_HELPERS},
                'REFRESH_TARGET_HISTORY_CHANGED')
        clone.assert_marker=marker_guard;clone.source_history_guard=history_guard
        class Context(clone.Controller):
            def source_guard(self): return parent.source_guard()
            def database(self, actual): return parent.read_database(self,actual)
        ctx=Context.__new__(Context)
        ctx.__dict__.update(self.oldcontext.__dict__)
        ctx.args=copy.copy(self.oldargs);ctx.args.release=str(TARGET);ctx.args.manifest_sha256=self.args.manifest_sha256
        ctx.args.source_commit=self.args.source_commit;ctx.args.action=self.args.action
        ctx.b=self.b;ctx.p=self.b.p;ctx.authored_marker=copy.deepcopy(marker)
        ctx.guardian=copy.copy(self.oldcontext.guardian);ctx.guardian.release=TARGET
        ctx.guardian.protected=copy.deepcopy(self.oldcontext.guardian.protected)
        if self.after_static:ctx.guardian.protected['snapshot']['files'][str(self.core.STATIC_HEAD)]=self.core.static_guardian_pin(self.after_static['head_pin'])
        self.bind_context(ctx)
        return ctx

    def bind_context(self, ctx):
        """Use original transition methods with this controller's actual journal/guards."""
        ctx.capsule={'audit':{'state':copy.deepcopy(self.before)}} if hasattr(self,'before') else None
        ctx.immutable_evidence={};ctx.authored_paths=copy.deepcopy(self.authored)
        ctx.locks=self.locks;ctx.global_locks_held=self.global_locks_held;ctx.directory_lease=self.lease
        ctx.event=lambda phase,**fields:self.event(phase,**fields)
        ctx.fresh=self.stable

    def read_database(self, ctx, marker):
        rows=[json.loads(row) for row in ctx.b.ops.sql(self.runtime,marker,ctx.p.DATABASE,self.core.snapshot_sql(self.oldargs.app_id)).splitlines() if row.startswith('{')]
        require(len(rows)==1,'REFRESH_DATABASE_RESPONSE_INVALID');data=rows[0]
        probe=copy.copy(self.oldargs);probe.manifest_sha256=marker['manifest_sha256']
        module=types.ModuleType('oasis_refresh_database_contract');module.__file__=self.core.__file__
        exec(compile(ast.parse(self.core_raw),self.core.__file__,'exec'),module.__dict__)
        module.Refusal=Refusal;module.TARGET=Path(marker['release'])
        action='open' if data.get('policy',{}).get('state')=='closed' else 'close'
        scope=module.validate_database(data,ctx.b.a,probe,action=action)
        require(data.get('pending_rooms')==data.get('pending_pvp_operations')==data.get('active_users')==0,
                'REFRESH_ACTIVE_AUTHORITY_REMAINS')
        return data,scope

    def static_snapshot(self, selector):
        c=self.core;root=c.STATIC_ROOT
        c.require(root.is_dir() and not root.is_symlink(),'REFRESH_STATIC_ROOT_UNSAFE')
        self.oldb.p.no_mount(root);self.oldb.p.no_mount(c.STATIC_HEAD)
        dirs={'.':c.static_directory_pin(root)};entries={};receipts={}
        for parent,children,files in os.walk(root,followlinks=False):
            for name in children:
                path=Path(parent)/name;c.require(not path.is_symlink(),'REFRESH_STATIC_DIRECTORY_LINK');dirs[path.relative_to(root).as_posix()]=c.static_directory_pin(path)
            for name in files:
                path=Path(parent)/name;raw,pin=c.read_file(path,limit=256<<20);meta=c.static_file_pin(pin)
                if path.parent==root/'.registry':
                    require(digest(raw)+'.json'==name,'REFRESH_STATIC_RECEIPT_NAME_INVALID');receipts[name]=meta
                else:entries['/'+path.relative_to(root).as_posix()]=meta
        raw,hpin=c.read_file(c.STATIC_HEAD,private=True);head=json.loads(raw);require(head.get('pending') is None,'REFRESH_STATIC_PENDING_TRANSACTION')
        registered,registry=selector.load_registry(root,head)
        require(set(registry)=={name[:-5] for name in receipts} and set(registered)==set(entries),'REFRESH_STATIC_UNREGISTERED_FILE')
        for name,item in registered.items():require({key:entries[name][key] for key in ('bytes','sha256')}==item,'REFRESH_STATIC_REGISTERED_BODY_CHANGED')
        ancestors={str(path):c.static_directory_pin(path) for path in dict.fromkeys((*root.parents,*c.STATIC_HEAD.parents))}
        require(all(c.static_directory_pin(root/relative)==value for relative,value in dirs.items())
                and all(c.static_directory_pin(Path(path))==value for path,value in ancestors.items()),
                'REFRESH_STATIC_DIRECTORY_CHANGED_DURING_READ')
        for name,value in entries.items():
            require(c.static_file_pin(c.pin(root/name.lstrip('/')))==value,'REFRESH_STATIC_FILE_CHANGED_DURING_READ')
        for name,value in receipts.items():
            require(c.static_file_pin(c.pin(root/'.registry'/name))==value,'REFRESH_STATIC_RECEIPT_CHANGED_DURING_READ')
        require(c.static_file_pin(c.pin(c.STATIC_HEAD))==c.static_file_pin(hpin),'REFRESH_STATIC_HEAD_CHANGED_DURING_READ')
        return {'entries':entries,'receipts':receipts,'registered':registered,'head':head,'head_pin':c.static_file_pin(hpin),
                'directories':dirs,'ancestors':ancestors}

    def plan_static(self, before):
        wanted={url:{key:value[key] for key in ('sha256','bytes')} for url,value in self.required.items()}
        require(all(url not in before['registered'] or before['registered'][url]==item for url,item in wanted.items()),'REFRESH_STATIC_URL_CONFLICT')
        receipt={'schema':'oasis-static-assets-v1','release':TARGET.name,'manifest_sha256':self.args.manifest_sha256,'assets':wanted}
        body=self.selector.json_bytes(receipt);receipt_sha=digest(body)
        require(receipt_sha+'.json' not in before['receipts'],'REFRESH_STATIC_ALREADY_PUBLISHED')
        head={'schema':'oasis-static-assets-head-v1','receipts':sorted([*before['head']['receipts'],receipt_sha]),'pending':None}
        hbody=self.selector.json_bytes(head)
        return {'old_head':before['head'],'old_registered':before['registered'],'wanted':wanted,
                'missing':sorted(set(wanted)-set(before['entries'])),'receipt':receipt,'receipt_sha256':receipt_sha,
                'receipt_bytes':len(body),'head':head,'head_sha256':digest(hbody),'head_bytes':len(hbody)}

    def observe(self, *, require_active=True):
        self.source_guard();state=self.context.scope(public_expected=self.public_expected,require_active=require_active)
        data,scope=self.read_database(self.context,state['marker'])
        inspection=self.context.run_inspection(state['marker'])
        require(all(value==0 for value in inspection['audit'].values()),'REFRESH_OBLIGATION_OR_INTEGRITY_ERROR')
        second=self.context.scope(public_expected=self.public_expected,require_active=require_active)
        require(state==second,'REFRESH_SCOPE_CHANGED_DURING_OBSERVATION')
        return state,data,scope,inspection

    def retained_graph(self,marker):
        """Hash full rows inside one real read-only snapshot; never output row bodies."""
        names=self.b.ops.sql(self.runtime,marker,self.b.p.DATABASE,
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").splitlines()
        require(names and len(names)==len(set(names)) and all(re.fullmatch('[a-z][a-z0-9_]{0,62}',name) for name in names),
                'REFRESH_RETAINED_RELATION_LIST_INVALID')
        parts=[]
        for name in names:
            if name=='gp_production_admission':continue
            row="to_jsonb(t)-'status'" if name=='gp_apps' else 'to_jsonb(t)'
            parts.append(self.core.literal(name)+",(SELECT json_build_object('rows',count(*),'sha256',"
                "encode(sha256(convert_to(COALESCE(string_agg(("+row+")::text,E'\\n' ORDER BY ("+row+")::text),''),'UTF8')),'hex')) FROM "+name+' t)')
        query="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SELECT json_build_object("+','.join(parts)+"); COMMIT;"
        values=[json.loads(row) for row in self.b.ops.sql(self.runtime,marker,self.b.p.DATABASE,query).splitlines() if row.startswith('{')]
        require(len(values)==1 and set(values[0])==set(names)-{'gp_production_admission'}
                and all(type(value['rows']) is int and value['rows']>=0 and sha(value['sha256']) for value in values[0].values()),
                'REFRESH_RETAINED_GRAPH_RESPONSE_INVALID')
        return values[0]

    def audit(self):
        state,data,scope,inspection=self.observe()
        required='closed' if self.args.action in ('refresh','open') else 'open'
        require(data['policy']['state']==required and data['app']['status']==('paused' if required=='closed' else 'active'),
                'REFRESH_ACTION_POLICY_STATE_CHANGED')
        if self.args.action=='refresh':
            closed=self.closed_authority['final']
            require(state['marker']==closed['state']['marker'] and state['marker_pin']==closed['state']['marker_pin']
                    and state['production_pin']==closed['state']['production_pin'] and state['env_pin']==closed['state']['env_pin']
                    and state['units']['files']==closed['state']['units']['files']
                    and state['protected']==closed['state']['protected'] and data==closed['database'],
                    'REFRESH_CLOSED_AUTHORITY_CURRENT_CHANGED')
        before_static=self.static_snapshot(self.selector)
        plan=self.plan_static(before_static) if self.args.action=='refresh' else self.static_plan
        return {'schema':1,'kind':'production-firstparty-source-audit','passed':True,'at':now(),'action':self.args.action,
            'controller_sha256':self.args.controller_sha256,'legacy_controller_sha256':self.args.legacy_controller_sha256,
            'source_commit':self.args.source_commit,'release':str(TARGET),'manifest_sha256':self.args.manifest_sha256,
            'app_id':self.oldargs.app_id,'state':state,'database':data,'policy_scope':scope,'inspection':inspection,
            'locks':self.locks,'retained_graph':self.retained_graph(state['marker']),
            'capacity':self.core.capacity_guard(self.b.p,self.args.capacity_budget_bytes),
            'static_before':before_static,'static_plan':plan,'financial_admission_enabled':False,
            'probability_admission_enabled':False,'thirdparty_financial_admission_enabled':False}

    def check(self):
        raw=self.inputs.read(self.args.audit,self.args.audit_sha256);audit=json.loads(raw);fresh(audit.get('at'))
        proof=json.loads(self.inputs.read(self.args.approval,self.args.approval_sha256));approval=root_approval(proof,raw,audit,self.args)
        actual=self.audit();require(self.core.stable_capsule(actual)==self.core.stable_capsule(audit),'REFRESH_AUDIT_CHANGED')
        return {'schema':1,'kind':'production-firstparty-source-check','passed':True,'at':now(),'action':self.args.action,
                'controller_sha256':self.args.controller_sha256,'audit_sha256':digest(raw),'approval_sha256':self.args.approval_sha256,
                'audit':actual,'approval':approval,'input_pins':{name:self.inputs.files[name] for name in (self.args.audit,self.args.approval)}}

    def event(self,phase,**fields):
        self.receipt['phase']=phase;self.receipt['history'].append({'at':now(),'phase':phase,**fields})
        path=self.directory/'receipt.json'
        if self.receipt_pin is None:self.b.p.exclusive(path,canonical(self.receipt))
        else:self.core.atomic_replace(path,canonical(self.receipt),self.receipt_pin)
        self.receipt_pin=self.core.pin(path)

    def stable(self):
        self.source_guard();self.core.capacity_guard(self.b.p,self.args.capacity_budget_bytes)
        for path,value in self.authored.items():require(self.core.pin(path,symlink=path==str(self.b.p.PIN))==value,'REFRESH_AUTHORED_PATH_CHANGED')
        for path,value in self.locks.items():require(self.core.pin(path)==value,'REFRESH_LOCK_PATH_CHANGED')
        self.context.guardian.guard(self.public_expected)

    def restore_timers(self):
        c=self.core;require(not self.global_locks_held,'REFRESH_TIMER_TAIL_REQUIRES_UNLOCKED')
        self.context.global_locks_held=False
        self.source_guard();self.context.guardian.guard(self.public_expected)
        raw,_=c.read_file(self.b.p.PRIVATE/'installation.json',private=True);marker=json.loads(raw)
        self.context.installed_units(marker,pending_jobs=True)
        self.context.b.ops.owned_resources(marker,self.runtime)
        self.runtime.command(['systemctl','start',*c.OWN_TIMERS],timeout=30)
        deadline=time.monotonic()+c.ONESHOT_WAIT_SECONDS
        while True:
            require(time.monotonic()<deadline,'REFRESH_OWN_JOBS_TIMEOUT')
            self.source_guard();self.context.guardian.guard(self.public_expected)
            try:
                units=self.context.installed_units(marker,pending_jobs=True)
                require(time.monotonic()<deadline,'REFRESH_OWN_JOBS_TIMEOUT')
                if not units['pending_jobs']:break
            except Refusal as error:
                if str(error) not in ('ADMISSION_OWN_ONESHOT_BUSY','ADMISSION_ONESHOT_TRANSITION'):raise
            require(time.monotonic()<deadline,'REFRESH_OWN_JOBS_TIMEOUT');time.sleep(0.25)
        require(all(units['states'][name].get('ActiveState')=='active' for name in c.OWN_TIMERS),
                'REFRESH_TIMER_NOT_RESTORED')
        self.observe()

    def publish_static(self):
        old=self.selector.deployment_lock;parent=self
        @contextmanager
        def borrowed(base):
            require(base==self.b.p.BASE and self.global_locks_held and self.lease is not None,'REFRESH_PUBLISH_LOCK_NOT_HELD')
            self.stable();yield
            self.inputs.guard();self.core.directory_lock_guard(*self.lease)
            require(all(self.core.pin(path)==value for path,value in self.locks.items()),'REFRESH_PUBLISH_LOCK_REPLACED')
        self.selector.deployment_lock=borrowed
        try:
            # Official publish rechecks all bodies and its capacity guard; only
            # the exact already-held original lock replaces a second flock.
            self.selector.publish(TARGET,self.b.p.BASE,apply=True)
        finally:self.selector.deployment_lock=old
        after=self.static_snapshot(self.selector);static_delta(self.receipt['static_before'],after,self.static_plan)
        self.after_static=after;self.receipt['static_after']=after;self.receipt['static_append_after']=after
        self.public_expected=copy.deepcopy(self.public_expected)
        self.public_expected['files'][str(self.core.STATIC_HEAD)]=self.core.static_guardian_pin(after['head_pin'])
        self.context.guardian.protected=copy.deepcopy(self.context.guardian.protected)
        self.context.guardian.protected['snapshot']=self.public_expected
        self.context.guardian.static_retention.verify=lambda: self.verify_authored_static()
        self.event('official_static05_append_verified')

    def verify_authored_static(self):
        actual=self.static_snapshot(self.selector);require(actual==self.after_static,'REFRESH_AUTHORED_STATIC_CHANGED')
        return {'static_fullpins_sha256':digest(canonical(actual)),'official_plan_sha256':digest(canonical(self.static_plan))}

    def transition(self, capsule):
        c=self.core;old=capsule['audit'];self.before=old['state'];data=old['database'];approval=capsule['approval']
        self.static_plan=old['static_plan'];self.static_before=old['static_before']
        parent=self.b.p.PRIVATE/'source-refreshes'
        if not parent.exists():parent.mkdir(mode=0o700)
        s=parent.lstat();require(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'REFRESH_OPERATION_PARENT_UNSAFE')
        self.directory=parent/(self.args.action+'-'+self.args.check_sha256);require(not os.path.lexists(self.directory),'REFRESH_OPERATION_ALREADY_ATTEMPTED')
        self.directory.mkdir(mode=0o700);self.runtime.diagnostics=self.directory
        self.receipt={'schema':1,'kind':'production-firstparty-source-operation','passed':False,'at':now(),'action':self.args.action,
            'controller_sha256':self.args.controller_sha256,'legacy_controller_sha256':self.args.legacy_controller_sha256,
            'source_commit':self.args.source_commit,'target_release':str(TARGET),'target_manifest_sha256':self.args.manifest_sha256,
            'audit_sha256':self.args.audit_sha256,'approval_sha256':self.args.approval_sha256,'check_sha256':self.args.check_sha256,
            'original':self.before,'original_database':data,'retained_graph_before':old['retained_graph'],
            'source_history_prefix':self.before['marker']['release_history'] if self.args.action=='refresh' else self.history_prefix,
            'static_before':self.authority['static_before'] if self.authority else self.static_before,
            'static_plan':self.static_plan,'static_after':self.after_static,
            'static_append_after':self.authority['static_append_after'] if self.authority else None,
            'source_parent_delta':self.authority['source_parent_delta'] if self.authority else None,'history':[],
            'acceptance_scope':'Preserved free-only source transition. No finance, probability, performance or device acceptance.'}
        self.event('original_source_and_data_preserved')
        marker=copy.deepcopy(self.before['marker'])
        if self.args.action=='refresh':
            backup=self.oldb.ops.backup(marker,self.runtime);restore=self.oldb.ops.restore(marker,Path(backup['path']),self.runtime)
            require(restore.get('passed') is True and all(restore.get('cleanup',{}).get(key) is True for key in ('database_removed','temporary_removed')),
                    'REFRESH_REAL_DATA_RESTORE_DRILL_FAILED')
            self.receipt.update(backup=backup,restore=restore);self.event('original04_backup_restore_verified')
            self.bind_context(self.context)
            self.context.stop_writers(marker)
            state,current,_,_=self.observe(require_active=False);require(current==data,'REFRESH_DATA_CHANGED_AFTER_WRITER_STOP')
            require(self.retained_graph(marker)==old['retained_graph'],'REFRESH_RETAINED_ROWS_CHANGED_AFTER_STOP')
            self.history_prefix=copy.deepcopy(marker['release_history'])
            require(len(self.history_prefix)==2,'REFRESH_EXPECTED03_04_HISTORY_REQUIRED')
            # Capture/validate the sanctioned static change before env/PIN writes
            # alter their own ancestor metadata. It grants no admission.
            self.publish_static()
            expected=refresh_policy(self.b.a.normalize_policy(data['policy']),approval,TARGET,self.args.manifest_sha256,self.args.approval_sha256)
            rows=[json.loads(row) for row in self.oldb.ops.sql(self.runtime,marker,self.b.p.DATABASE,policy_sql(c,data,expected)).splitlines() if row.startswith('{')]
            require(len(rows)==1 and self.b.a.normalize_policy(rows[0])==self.b.a.normalize_policy(expected),'REFRESH_SOURCE_POLICY_COMMIT_CHANGED')
            self.receipt['committed_policy']=self.b.a.normalize_policy(rows[0]);self.event('existing_policy_source05_closed_committed')
            raw,pin=c.read_file(self.b.p.PRIVATE/'runtime.env',private=True)
            replacement=refresh_runtime(self.b.a,raw,TARGET,self.args.manifest_sha256)
            env=self.b.a.parse_env_text(replacement.decode());self.b.a.runtime_profile(env,expected_release=str(TARGET),expected_manifest=self.args.manifest_sha256)
            value=c.atomic_replace(self.b.p.PRIVATE/'runtime.env',replacement,pin);self.authored[str(self.b.p.PRIVATE/'runtime.env')]=value
            marker['release']=str(TARGET);marker['manifest_sha256']=self.args.manifest_sha256
            marker['private_pins']['runtime.env']=self.b.p.fingerprint(self.b.p.PRIVATE/'runtime.env')
            entry={'release':str(TARGET),'manifest_sha256':self.args.manifest_sha256,
                   'helpers':{name:self.members['platform/deploy/production-instance/'+name] for name in self.b.a.CURRENT_HELPERS},
                   'private_pins':copy.deepcopy(marker['private_pins']),'inspection_contract':'production-free-v2',
                   'runtime_profile':self.b.a.runtime_profile(env),'policy_approvals':[self.receipt['committed_policy']]}
            require(not any(item['release']==str(TARGET) for item in marker['release_history']),'REFRESH_TARGET_HISTORY_EXISTS')
            marker['release_history'].append(entry)
            self.context=self.new_context(marker)
            inherited_state=copy.deepcopy(self.before);inherited_state['protected']=copy.deepcopy(self.public_expected)
            self.context.capsule={'audit':{'state':inherited_state}};self.context.authored_paths={};self.context.advance_pin()
            self.authored[str(self.b.p.PIN)]=c.pin(self.b.p.PIN,symlink=True)
            switched_static=self.static_snapshot(self.selector)
            self.receipt['source_parent_delta']=source_parent_delta(self.after_static,switched_static,
                self.before['production_pin'],self.authored[str(self.b.p.PIN)])
            self.after_static=switched_static;self.receipt['static_after']=switched_static
            self.authored[str(self.b.p.PRIVATE/'installation.json')]=c.atomic_replace(self.b.p.PRIVATE/'installation.json',canonical(marker),self.before['marker_pin'])
            self.context.capsule={'audit':{'state':inherited_state}};self.context.authored_paths={}
            self.context.replace_units(marker);self.authored.update(self.context.authored_paths)
            self.context.authored_marker=marker;self.context.authored_paths=copy.deepcopy(self.authored)
            self.context.restart_writers(marker)
        else:
            query,expected=c.policy_transaction_sql(self.args.action,data,approval,self.args.approval_sha256)
            rows=[json.loads(row) for row in self.b.ops.sql(self.runtime,marker,self.b.p.DATABASE,query).splitlines() if row.startswith('{')]
            require(len(rows)==1 and self.b.a.normalize_policy(rows[0])==self.b.a.normalize_policy(expected),'REFRESH_POLICY_COMMIT_CHANGED')
            self.receipt['committed_policy']=self.b.a.normalize_policy(rows[0])
            current=next(item for item in marker['release_history'] if item['release']==str(TARGET))
            require(not any(item['revision']==self.receipt['committed_policy']['revision'] for item in current['policy_approvals']),
                    'REFRESH_POLICY_REVISION_DUPLICATE')
            current['policy_approvals'].append(self.receipt['committed_policy'])
            self.authored[str(self.b.p.PRIVATE/'installation.json')]=c.atomic_replace(self.b.p.PRIVATE/'installation.json',canonical(marker),self.before['marker_pin'])
            self.context.authored_marker=marker
            self.event('existing_policy_'+expected['state']+'_committed')
        self.context.authored_paths=self.authored
        self.context.locks=self.locks
        self.stable()

    def final(self):
        state,data,scope,inspection=self.observe()
        wanted='open' if self.args.action=='open' else 'closed'
        require(self.b.a.normalize_policy(data['policy'])==self.receipt['committed_policy']
            and data['policy']['state']==wanted and data['app']['status']==('active' if wanted=='open' else 'paused'),
            'REFRESH_FINAL_POLICY_CHANGED')
        original=copy.deepcopy(self.receipt['original_database']);actual=copy.deepcopy(data)
        original.pop('policy');actual.pop('policy');original['app']['status']=actual['app']['status']
        require(original==actual,'REFRESH_RETAINED_DATABASE_STATE_CHANGED')
        graph=self.retained_graph(state['marker']);require(graph==self.receipt['retained_graph_before'],'REFRESH_RETAINED_FULL_ROWS_CHANGED')
        self.runtime.http(self.oldargs.origin+'/health/ready',200,'production')
        https=self.verify_https()
        self.receipt['final']={'state':state,'database':data,'inspection':inspection,'retained_graph':graph,'https':https,
            'financial_admission_enabled':False,'probability_admission_enabled':False,'thirdparty_financial_admission_enabled':False}
        self.receipt['passed']=True;self.event('complete_free_open' if wanted=='open' else 'complete_closed')

    def verify_https(self):
        """Actual strict TLS and full bodies; no redirects, proxy, account or POST."""
        origin=self.oldargs.origin;require(origin.startswith('https://'),'REFRESH_HTTPS_ORIGIN_REQUIRED')
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),
                    urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        selected=set(self.static_plan['missing'])
        selected.update(url for url in self.required if '/index-' in url and url.endswith('.js'))
        results={};immutable='public, max-age=31536000, immutable'
        for url in sorted(selected):
            require(url.startswith(('/assets/','/arena/assets/')) and '?' not in url and '#' not in url and '..' not in Path(url).parts,
                    'REFRESH_HTTPS_ASSET_URL_INVALID')
            expected=self.static_plan['wanted'][url]
            status,headers,body=https_request(opener,origin+url,limit=expected['bytes'])
            h={key.lower():value for key,value in headers.items()};media=h.get('content-type','').split(';')[0].strip()
            require(status==200 and len(body)==expected['bytes'] and digest(body)==expected['sha256']
                    and h.get('cache-control')==immutable and h.get('etag'), 'REFRESH_HTTPS_ASSET_BODY_OR_CACHE_FAILED')
            expected_media={'.js':{'application/javascript','text/javascript'},'.css':{'text/css'},'.webp':{'image/webp'},
                '.png':{'image/png'},'.jpg':{'image/jpeg'},'.glb':{'model/gltf-binary','application/octet-stream'},
                '.wasm':{'application/wasm'},'.woff2':{'font/woff2'}}.get(Path(url).suffix)
            require(expected_media and media in expected_media,'REFRESH_HTTPS_ASSET_MIME_FAILED')
            hs,hh,hb=https_request(opener,origin+url,'HEAD',limit=0);nh={key.lower():value for key,value in hh.items()}
            require(hs==200 and not hb and nh.get('etag')==h['etag'] and nh.get('content-length')==str(len(body))
                    and nh.get('cache-control')==immutable,'REFRESH_HTTPS_HEAD_FAILED')
            ns,_,nb=https_request(opener,origin+url,headers={'If-None-Match':h['etag']},limit=0)
            require(ns==304 and not nb,'REFRESH_HTTPS_304_FAILED')
            end=min(31,len(body)-1);rs,rh,rb=https_request(opener,origin+url,headers={'Range':f'bytes=0-{end}'},limit=end+1)
            require(rs==206 and rb==body[:end+1] and {key.lower():value for key,value in rh.items()}.get('content-range')
                    ==f'bytes 0-{end}/{len(body)}','REFRESH_HTTPS_RANGE_FAILED')
            results[url]={'sha256':digest(body),'bytes':len(body),'status':status,'content_type':media,
                'head_status':hs,'not_modified_status':ns,'range_status':rs,'no_redirect':True}
        index=TARGET/'platform/dist/index.html';expected=index.read_bytes()
        require(self.members.get('platform/dist/index.html')==digest(expected),'REFRESH_INDEX_SOURCE_CHANGED')
        status,headers,body=https_request(opener,origin+'/index.html',limit=len(expected))
        h={key.lower():value for key,value in headers.items()}
        require(status==200 and body==expected and 'no-store' in h.get('cache-control','')
                and h.get('content-type','').split(';')[0].strip()=='text/html','REFRESH_HTTPS_CURRENT_INDEX_FAILED')
        self.stable()
        return {'origin':origin,'assets':results,'index_sha256':digest(body),'index_no_store':True,'passed':True}

    def close(self):
        if getattr(self,'oldcontext',None) and getattr(self.oldcontext.guardian,'static_retention',None):self.oldcontext.guardian.static_retention.close()
        if getattr(self,'self_fd',None) is not None:os.close(self.self_fd)
        self.inputs.close();os.close(self.core_fd)


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode',choices=('audit','check','apply'),required=True)
    p.add_argument('--action',choices=('refresh','open','close'),required=True)
    for name in ('legacy-controller','legacy-controller-sha256','legacy-common-argv','legacy-common-argv-sha256',
                 'operator-inventory','operator-inventory-sha256','release','manifest-sha256','source-commit','controller-sha256'):
        p.add_argument('--'+name,required=True)
    for name in ('audit','audit-sha256','approval','approval-sha256','check','check-sha256','source-receipt','source-receipt-sha256'):
        p.add_argument('--'+name)
    p.add_argument('--capacity-budget-bytes',type=int,required=True)
    return p


def main(argv=None):
    args=parser().parse_args(argv);os.umask(0o077);tool=None;primary=None;cleanup=None;result=None;timers_paused=False
    try:
        require(os.getuid()==0 and __import__('sys').flags.isolated==1 and __import__('sys').dont_write_bytecode,'REFRESH_ISOLATED_ROOT_REQUIRED')
        require(args.source_receipt and sha(args.source_receipt_sha256),'REFRESH_SOURCE_RECEIPT_REQUIRED')
        require(args.mode=='audit' or all(getattr(args,name) for name in ('audit','audit_sha256','approval','approval_sha256')),
                'REFRESH_AUDIT_ROOT_APPROVAL_REQUIRED')
        require(args.mode!='apply' or args.check and sha(args.check_sha256),'REFRESH_CHECK_REQUIRED')
        tool=Refresh(args);c=tool.core
        tool.observe() # Every full guard before any maintenance mutation.
        timers_paused=True
        tool.runtime.command(['systemctl','stop',*c.OWN_TIMERS],timeout=60)
        for name in c.OWN_TIMERS:require(tool.runtime.service(name).get('ActiveState')=='inactive','REFRESH_TIMER_NOT_PAUSED')
        expected=None
        if args.mode=='apply':
            raw=tool.inputs.read(args.check,args.check_sha256);capsule=json.loads(raw);fresh(capsule.get('at'))
            require(capsule.get('kind')=='production-firstparty-source-check' and capsule.get('passed') is True
                    and capsule.get('action')==args.action and capsule.get('controller_sha256')==args.controller_sha256,
                    'REFRESH_PASSED_CHECK_REQUIRED')
            expected=capsule['audit']['locks']
        with c.controller_directory_lock(tool.oldargs,tool.oldb) as lease:
            tool.lease=lease
            with c.locked_files(tool.oldb.p,expected) as locks:
                tool.locks=locks;tool.global_locks_held=True
                try:
                    if args.mode=='audit':result=tool.audit()
                    elif args.mode=='check':result=tool.check()
                    else:
                        actual=tool.check();require(c.stable_capsule(actual)==c.stable_capsule(capsule),'REFRESH_CHECK_CHANGED')
                        tool.transition(capsule);result=tool.receipt
                finally:tool.global_locks_held=False
            # Release both global/operations locks before the three own timers.
            tool.restore_timers()
            if args.mode=='apply':tool.final();result=tool.receipt
            else:tool.observe()
        timers_paused=False
    except Exception as error:
        primary=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'REFRESH_OPERATION_FAILED'
        if tool and tool.receipt:
            tool.receipt['passed']=False;tool.receipt['error_code']=primary
            try:
                # Existing full source/unit identity must prove the API before a
                # stop; no blind rollback, database action or foreign stop.
                marker=json.loads(tool.core.read_file(tool.b.p.PRIVATE/'installation.json',private=True)[0])
                tool.context.installed_units(marker,cleanup=True)
                tool.runtime.command(['systemctl','stop',*tool.core.OWN_TIMERS,'oasis-production-api.service'],timeout=90)
                tool.receipt['closed_runtime_confirmed']=tool.runtime.service('oasis-production-api.service').get('ActiveState')=='inactive'
            except Exception:tool.receipt['cleanup_error_code']='REFRESH_FAIL_CLOSED_IDENTITY_OR_STOP_FAILED'
            try:tool.event('failed_closed')
            except Exception:cleanup='REFRESH_FAILED_RECEIPT_SAVE_FAILED'
    finally:
        if tool and timers_paused and not tool.receipt:
            try:
                tool.restore_timers()
            except Exception:cleanup='REFRESH_AUDIT_TIMER_RESTORATION_FAILED'
        if tool:
            try:tool.close()
            except Exception:cleanup='REFRESH_EVIDENCE_CLOSE_FAILED'
    if primary or cleanup:
        print(json.dumps({'passed':False,'error_code':primary,'cleanup_error_code':cleanup,
                          'receipt':str(tool.directory/'receipt.json') if tool and tool.directory else None}));return 2
    if args.mode=='apply':
        print(json.dumps({'passed':True,'phase':result['phase'],'receipt':str(tool.directory/'receipt.json'),
                          'receipt_sha256':digest((tool.directory/'receipt.json').read_bytes())}));return 0
    print(json.dumps(result,sort_keys=True));return 0


if __name__=='__main__': raise SystemExit(main())

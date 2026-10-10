#!/usr/bin/python3
"""Root-reviewed, exact incident recovery. First phase restores only source04 API/timers.

No publication, policy/DB writes, source switch, bootstrap, or financial admission.
The immutable05 controller, T6 and original failed receipt are retained unchanged.
"""
import argparse
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import types

BASE = Path('/opt/oasis/releases/20261010-05/platform/deploy/production-instance/refresh-firstparty-source.py')
BASE_SHA = '4a4b4d5a552fb3f8376fc9f4253c657ee7a4dc1de6def0fd9abcf542f0e2f6af'
FAILED_SHA = '9803771167205ca71485ae36b75caab7e2f0a15a29b68da18ff5dca27449dcef'
OBSERVATION_SHA = '86c9e1bbaef5d1ee30a1675709a47f6b47170b619b57148c3bb8dd82ff247a6a'
CLOSE_SHA = '46b0385c3b896deae63fb65321e84bc500936ee03c877a400c6a5afc9bf8f91f'
ALIAS = '/arena/assets/BowlingGame-D1rSASzC.js'
SELF = Path(__file__)
FINANCE = ('financial_admission_enabled','probability_admission_enabled','thirdparty_financial_admission_enabled')


class Refusal(Exception): pass
def require(value, code):
    if not value: raise Refusal(code)
def digest(raw): return hashlib.sha256(raw).hexdigest()
def canonical(value): return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()


def load_base():
    """Execute only the actual immutable05 manifest member through its verified FD."""
    s=BASE.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1
            and stat.S_IMODE(s.st_mode)==0o644,'RECOVER_BASE_UNSAFE')
    fd=os.open(BASE,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        raw=b''
        while True:
            part=os.read(fd,1<<20)
            if not part:break
            raw+=part;require(len(raw)<=128<<10,'RECOVER_BASE_TOO_LARGE')
        fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        require(digest(raw)==BASE_SHA and all(getattr(s,k)==getattr(os.fstat(fd),k)==getattr(BASE.lstat(),k) for k in fields),
                'RECOVER_BASE_REPLACED')
        module=types.ModuleType('oasis_verified_frozen_refresh');module.__file__=str(BASE)
        exec(compile(ast.parse(raw,filename=str(BASE)),str(BASE),'exec'),module.__dict__)
        module.Refusal=Refusal
        return module,raw,fd
    except Exception:os.close(fd);raise


def persistent_delta(base, raw, before, after, plan):
    """Only remove the already-unlinked old HEAD from the permanent-inode set.

    Every other exact original delta predicate executes byte-for-byte AST logic.
    No invented inode or held historical FD is used.
    """
    tree=ast.parse(raw)
    node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='static_delta')
    changes=0
    for statement in node.body:
        if isinstance(statement,ast.Assign) and len(statement.targets)==1 and isinstance(statement.targets[0],ast.Name) and statement.targets[0].id=='old_ids':
            value=statement.value
            require(isinstance(value,ast.SetComp) and len(value.generators)==1
                    and isinstance(value.generators[0].iter,ast.Tuple),'RECOVER_DELTA_SOURCE_CHANGED')
            items=value.generators[0].iter.elts
            require(len(items)==3 and ast.dump(items[-1])==ast.dump(ast.parse("before['head_pin']",mode='eval').body),
                    'RECOVER_DELTA_SOURCE_CHANGED')
            value.generators[0].iter.elts=items[:2];changes+=1
    require(changes==1,'RECOVER_DELTA_SOURCE_CHANGED')
    env=dict(base.__dict__);exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),str(BASE),'exec'),env)
    env['static_delta'](before,after,plan)


def incident_proof(base, raw, failed, observed):
    require(failed.get('kind')=='production-firstparty-source-operation' and failed.get('passed') is False
            and failed.get('phase')=='failed_closed' and failed.get('error_code')=='REFRESH_STATIC_INODE_ALIAS'
            and failed.get('closed_runtime_confirmed') is True and failed.get('cleanup_error_code') is None
            and failed.get('controller_sha256')==BASE_SHA and failed.get('action')=='refresh'
            and failed.get('static_after') is None and failed.get('static_append_after') is None
            and failed.get('source_parent_delta') is None and 'committed_policy' not in failed,
            'RECOVER_EXACT_FAILED_STAGE_REQUIRED')
    require([item['phase'] for item in failed['history']]==['original_source_and_data_preserved',
            'original04_backup_restore_verified','owned_writers_stopped','failed_closed']
            and failed.get('restore',{}).get('passed') is True
            and all(failed['restore']['cleanup'].get(k) is True for k in ('database_removed','temporary_removed'))
            and failed.get('backup'),'RECOVER_ORIGINAL_RESTORE_PROOF_REQUIRED')
    required=('existing_bodies_and_receipts_unchanged','new_assets_match_plan','head_matches_plan',
              'database_matches_original','env_pin_matches_original','marker_matches_original','production_pin_matches_original')
    require(all(observed.get(k) is True for k in required) and observed['database']==failed['original_database'],
            'RECOVER_ROOT_OBSERVATION_CHANGED')
    before=failed['static_before'];after=observed['static_after'];plan=failed['static_plan']
    require(len(before['entries'])==958 and len(before['receipts'])==23
            and len(after['entries'])==979 and len(after['receipts'])==24
            and len(plan['missing'])==21 and observed['old_head_pin']==before['head_pin'],
            'RECOVER_EXACT_STATIC_COUNTS_REQUIRED')
    persistent_delta(base,raw,before,after,plan)
    old=(before['head_pin']['device'],before['head_pin']['inode'])
    aliases=[name for name in plan['missing'] if (after['entries'][name]['device'],after['entries'][name]['inode'])==old]
    require(aliases==[ALIAS] and old==(64515,997085) and after['entries'][ALIAS]['bytes']==58372
            and observed['aliases']==[{'old_path':['old_head','private/static-assets-head.json'],
                                      'new_path':ALIAS,'new_pin':after['entries'][ALIAS]}],
            'RECOVER_EXACT_UNLINKED_HEAD_REUSE_REQUIRED')
    require(set(observed['new_assets'])==set(plan['missing']) and observed['new_receipts']==[plan['receipt_sha256']+'.json']
            and after['head']['pending'] is None,'RECOVER_EXACT_REGISTRATION_REQUIRED')
    return copy.deepcopy(after)


def approval(base, value, raw_audit, audit, args):
    require(isinstance(value,dict) and set(value)==base.APPROVAL_KEYS and type(value.get('schema')) is int
            and value['schema']==1 and value.get('kind')=='production-firstparty-admission-approval'
            and value.get('passed') is True and value['action']=='restore-runtime' and value['scope_kind']=='runtime-restore'
            and value['audit_sha256']==digest(raw_audit) and audit.get('passed') is True
            and value['release']==str(base.TARGET) and value['manifest_sha256']==args.manifest_sha256
            and value['source_commit']==args.source_commit and value['app_id']==audit['app_id']
            and value['profile']=='firstparty-free-v1','RECOVER_ROOT_APPROVAL_REQUIRED')
    require(all(value[k] is False for k in FINANCE),'RECOVER_FINANCIAL_ADMISSION_FORBIDDEN')
    require(all(value[k]==audit['policy_scope'][k] for k in ('scope','currency_scale','allowed_origins','game_ids'))
            and re.fullmatch('[A-Za-z0-9_-]{1,128}',value['approved_by'] or ''),'RECOVER_ROOT_APPROVAL_METADATA_CHANGED')
    base.fresh(value['approved_at']);return value


def recovery_class(base, raw):
    class Recovery(base.Refresh):
        def __init__(self,args):
            self.args=args;self.core,self.core_raw,self.core_fd,self.core_pin=base.read_core(args.legacy_controller,args.legacy_controller_sha256)
            c=self.core;self.inputs=base.HeldInputs(c);self.directory=None;self.receipt=None;self.receipt_pin=None;self.authored={}
            self.locks={};self.lease=None;self.global_locks_held=False;self.static_plan=None;self.public_expected=None;self.authority=None
            self.own_raw=self.inputs.read(SELF,args.recovery_controller_sha256)
            self.own_pin=self.inputs.files[str(SELF)]
            self.oldargs=base.legacy_args(c,json.loads(self.inputs.read(args.legacy_common_argv,args.legacy_common_argv_sha256)))
            require(self.oldargs.release==str(base.SOURCE) and self.oldargs.manifest_sha256==base.SOURCE_MANIFEST
                    and self.oldargs.source_commit==base.SOURCE_COMMIT and self.oldargs.controller_sha256==args.legacy_controller_sha256,
                    'RECOVER_LEGACY_IDENTITY_CHANGED')
            self.oldb=c.load_bindings(self.oldargs);self.runtime=c.make_runtime(self.oldb.p)
            self.operator=json.loads(self.inputs.read(args.operator_inventory,args.operator_inventory_sha256));self.operator_guard()
            require(args.failed_receipt_sha256==FAILED_SHA and args.static_observation_sha256==OBSERVATION_SHA
                    and args.source_receipt_sha256==CLOSE_SHA and args.controller_sha256==BASE_SHA,'RECOVER_EXTERNAL_INCIDENT_SHA_REQUIRED')
            self.failed=json.loads(self.inputs.read(args.failed_receipt,args.failed_receipt_sha256))
            self.observed=json.loads(self.inputs.read(args.static_observation,args.static_observation_sha256))
            self.closed_authority=json.loads(self.inputs.read(args.source_receipt,args.source_receipt_sha256))
            close=self.closed_authority
            require(close.get('passed') is True and close.get('kind')=='production-admission-operation' and close.get('action')=='close'
                    and close.get('phase')=='complete_closed' and close['final']['database']==self.failed['original_database']
                    and all(close['final'].get(k) is False for k in FINANCE),'RECOVER_GENUINE_CLOSED_PREDECESSOR_REQUIRED')
            self.after_static=incident_proof(base,raw,self.failed,self.observed);self.static_plan=self.failed['static_plan']
            self._guardian(None);self.load_candidate();self.base_input_pins=copy.deepcopy(self.inputs.files)
            require(self.failed['target_release']==str(base.TARGET) and self.failed['target_manifest_sha256']==args.manifest_sha256
                    and self.failed['source_commit']==args.source_commit,'RECOVER_TARGET_CHANGED')
            self.context=self.oldcontext;self.public_expected=self.context.guardian.protected['snapshot']

        def _guardian(self, unused):
            c=self.core;parent=self;original=c.StaticRetentionReview
            class IncidentStatic(original):
                def verify(self):
                    self.evidence_guard()
                    require(self.plan['after']['static']['registered']==parent.failed['static_before']['registered']
                            and self.plan['after']['static']['head_pin']==parent.failed['static_before']['head_pin'],
                            'RECOVER_ORIGINAL_STATIC_APPROVAL_CHANGED')
                    actual=parent.static_snapshot(self.selector)
                    require(actual==parent.after_static,'RECOVER_ACTUAL_APPEND_CHANGED')
                    self.derived=copy.deepcopy(self.derived)
                    self.derived['snapshot']['files'][str(c.STATIC_HEAD)]=c.static_guardian_pin(actual['head_pin'])
                    return {'original_review_sha256':self.review_sha,'failed_receipt_sha256':FAILED_SHA,
                            'root_observation_sha256':OBSERVATION_SHA,'static_fullpins_sha256':digest(canonical(actual)),
                            'evidence_pins':self.files}
            c.StaticRetentionReview=IncidentStatic
            try:self.oldcontext=c.Controller(self.oldargs,self.oldb,self.runtime)
            finally:c.StaticRetentionReview=original
            require(self.oldcontext.guardian.static_retention is not None,'RECOVER_ORIGINAL_PROTECTION_REQUIRED')

        def source_guard(self):
            self.inputs.guard();require(self.core.pin(SELF)==self.own_pin,'RECOVER_EXECUTING_SOURCE_REPLACED')
            result=super().source_guard()
            return {**result,'recovery_controller_sha256':self.args.recovery_controller_sha256,'recovery_controller_pin':self.own_pin,
                    'failed_receipt_sha256':FAILED_SHA,'root_observation_sha256':OBSERVATION_SHA}

        def fixed04(self,state,data,*,active):
            old=self.failed['original']
            require(data==self.failed['original_database'] and data['policy']['state']=='closed' and str(data['policy']['revision'])=='3'
                    and data['app']['status']=='paused','RECOVER_CLOSED04_DATA_CHANGED')
            for key in ('marker','marker_pin','production_pin','env_pin','runtime_profile','resources','volume_pin',
                        'app_tcp','bootstrap_pin','protected_inventory_pin'):
                require(state[key]==old[key],'RECOVER_FIXED04_'+key.upper()+'_CHANGED')
            protected=copy.deepcopy(old['protected']);protected['files'][str(self.core.STATIC_HEAD)]=self.core.static_guardian_pin(self.after_static['head_pin'])
            require(state['protected']==protected and state['units']['files']==old['units']['files'],'RECOVER_PROTECTION_OR_UNIT_CHANGED')
            source=copy.deepcopy(state['source']);prior=copy.deepcopy(old['source'])
            source.pop('static_maintenance',None);prior.pop('static_maintenance',None)
            require(source==prior,'RECOVER_ORIGINAL_SOURCE_BINDINGS_CHANGED')
            api=state['units']['states']['oasis-production-api.service']
            require(api['ActiveState']==('active' if active else 'inactive') and (active or api.get('MainPID')=='0'),
                    'RECOVER_API_STATE_CHANGED')
            require(self.retained_graph(state['marker'])==self.failed['retained_graph_before'],'RECOVER_RETAINED_FULL_ROWS_CHANGED')

        def audit(self):
            state,data,scope,inspection=self.observe(require_active=False);self.fixed04(state,data,active=False)
            require(all(state['units']['states'][name]['ActiveState']=='inactive' for name in self.core.OWN_TIMERS),
                    'RECOVER_TIMERS_NOT_INACTIVE')
            return {'schema':1,'kind':'production-firstparty-runtime-recovery-audit','passed':True,'read_only':True,
                    'at':base.now(),'action':'restore-runtime','controller_sha256':BASE_SHA,
                    'recovery_controller_sha256':self.args.recovery_controller_sha256,'failed_receipt_sha256':FAILED_SHA,
                    'root_observation_sha256':OBSERVATION_SHA,'source_commit':self.args.source_commit,'release':str(base.TARGET),
                    'manifest_sha256':self.args.manifest_sha256,'app_id':self.oldargs.app_id,'policy_scope':scope,
                    'state':state,'database':data,'inspection':inspection,'retained_graph':self.failed['retained_graph_before'],
                    'static_before':self.failed['static_before'],'static_after':self.after_static,'static_plan':self.static_plan,
                    'capacity':self.core.capacity_guard(self.b.p,self.args.capacity_budget_bytes),'locks':self.locks,
                    **{k:False for k in FINANCE}}

        def check(self):
            body=self.inputs.read(self.args.audit,self.args.audit_sha256);audit=json.loads(body);base.fresh(audit.get('at'))
            proof=json.loads(self.inputs.read(self.args.approval,self.args.approval_sha256))
            approved=approval(base,proof,body,audit,self.args);actual=self.audit()
            require(self.core.stable_capsule(actual)==self.core.stable_capsule(audit),'RECOVER_AUDIT_CHANGED')
            return {'schema':1,'kind':'production-firstparty-runtime-recovery-check','passed':True,'read_only':True,
                    'at':base.now(),'action':'restore-runtime','controller_sha256':BASE_SHA,
                    'recovery_controller_sha256':self.args.recovery_controller_sha256,'audit_sha256':digest(body),
                    'approval_sha256':self.args.approval_sha256,'audit':actual,'approval':approved,
                    'input_pins':{path:self.inputs.files[path] for path in (self.args.audit,self.args.approval)}}

        def restore_api(self,capsule):
            self.before=capsule['audit']['state'];self.bind_context(self.context)
            parent=self.b.p.PRIVATE/'runtime-recoveries'
            if not parent.exists():parent.mkdir(mode=0o700)
            s=parent.lstat();require(s.st_uid==s.st_gid==0 and stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700,
                                    'RECOVER_OPERATION_PARENT_UNSAFE')
            self.directory=parent/('restore-runtime-'+self.args.check_sha256)
            require(not os.path.lexists(self.directory),'RECOVER_ALREADY_ATTEMPTED');self.directory.mkdir(mode=0o700)
            self.runtime.diagnostics=self.directory
            self.receipt={'schema':1,'kind':'production-firstparty-runtime-recovery-operation','passed':False,'read_only':False,
                'at':base.now(),'action':'restore-runtime','controller_sha256':BASE_SHA,
                'recovery_controller_sha256':self.args.recovery_controller_sha256,'failed_receipt_sha256':FAILED_SHA,
                'root_observation_sha256':OBSERVATION_SHA,'target_release':str(base.TARGET),'target_manifest_sha256':self.args.manifest_sha256,
                'source_commit':self.args.source_commit,'audit_sha256':self.args.audit_sha256,'approval_sha256':self.args.approval_sha256,
                'check_sha256':self.args.check_sha256,'original':self.before,'original_database':capsule['audit']['database'],
                'static_before':self.failed['static_before'],'static_after':self.after_static,'static_plan':self.static_plan,'history':[],
                'acceptance_scope':'Only exact source04 paused API and three timers restored. No publication, policy/source/DB change or game acceptance.'}
            self.event('verified_closed04_incident_takeover')
            self.context.restart_writers(self.before['marker'])

        def final_restore(self):
            state,data,scope,inspection=self.observe();self.fixed04(state,data,active=True)
            require(all(state['units']['states'][name]['ActiveState']=='active' for name in self.core.OWN_TIMERS)
                    and not state['units'].get('pending_jobs'),'RECOVER_FINAL_TIMER_OR_JOB_CHANGED')
            self.runtime.http(self.oldargs.origin+'/health/ready',200,'production')
            self.receipt['final']={'state':state,'database':data,'inspection':inspection,
                    'retained_graph':self.retained_graph(state['marker']),**{k:False for k in FINANCE}}
            self.receipt['passed']=True;self.event('complete_source04_runtime_restored')
    return Recovery


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode',choices=('audit','check','apply'),required=True)
    p.add_argument('--action',choices=('restore-runtime',),required=True)
    for name in ('legacy-controller','legacy-controller-sha256','legacy-common-argv','legacy-common-argv-sha256',
        'operator-inventory','operator-inventory-sha256','release','manifest-sha256','source-commit','controller-sha256',
        'recovery-controller-sha256','source-receipt','source-receipt-sha256','failed-receipt','failed-receipt-sha256',
        'static-observation','static-observation-sha256'):p.add_argument('--'+name,required=True)
    for name in ('audit','audit-sha256','approval','approval-sha256','check','check-sha256'):p.add_argument('--'+name)
    p.add_argument('--capacity-budget-bytes',type=int,required=True)
    return p


def main(argv=None):
    args=parser().parse_args(argv);os.umask(0o077);tool=None;base_fd=None;primary=None;cleanup=None;result=None
    try:
        import sys
        require(os.getuid()==0 and sys.flags.isolated==1 and sys.dont_write_bytecode,'RECOVER_ISOLATED_ROOT_REQUIRED')
        require(args.mode=='audit' or all(getattr(args,k) for k in ('audit','audit_sha256','approval','approval_sha256')),
                'RECOVER_AUDIT_ROOT_APPROVAL_REQUIRED')
        require(args.mode!='apply' or args.check and args.check_sha256,'RECOVER_CHECK_REQUIRED')
        base,raw,base_fd=load_base();tool=recovery_class(base,raw)(args);c=tool.core
        tool.observe(require_active=False)
        capsule=None;expected=None
        if args.mode=='apply':
            capsule=json.loads(tool.inputs.read(args.check,args.check_sha256));base.fresh(capsule.get('at'))
            require(capsule.get('kind')=='production-firstparty-runtime-recovery-check' and capsule.get('passed') is True
                    and capsule.get('action')=='restore-runtime' and capsule.get('controller_sha256')==BASE_SHA
                    and capsule.get('recovery_controller_sha256')==args.recovery_controller_sha256,'RECOVER_PASSED_CHECK_REQUIRED')
            expected=capsule['audit']['locks']
        with c.controller_directory_lock(tool.oldargs,tool.oldb) as lease:
            tool.lease=lease
            with c.locked_files(tool.oldb.p,expected) as locks:
                tool.locks=locks;tool.global_locks_held=True
                try:
                    if args.mode=='audit':result=tool.audit()
                    elif args.mode=='check':result=tool.check()
                    else:
                        actual=tool.check();require(c.stable_capsule(actual)==c.stable_capsule(capsule),'RECOVER_CHECK_CHANGED')
                        tool.restore_api(capsule)
                finally:tool.global_locks_held=False
            if args.mode=='apply':tool.restore_timers();tool.final_restore();result=tool.receipt
    except Exception as error:
        primary=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'RECOVER_OPERATION_FAILED'
        if tool and tool.receipt:
            tool.receipt['passed']=False;tool.receipt['error_code']=primary
            try:
                tool.source_guard();tool.context.installed_units(tool.before['marker'],cleanup=True)
                tool.runtime.command(['systemctl','stop',*tool.core.OWN_TIMERS,'oasis-production-api.service'],timeout=90)
                tool.receipt['closed_runtime_confirmed']=tool.runtime.service('oasis-production-api.service').get('ActiveState')=='inactive'
            except Exception:tool.receipt['cleanup_error_code']='RECOVER_FAIL_CLOSED_IDENTITY_OR_STOP_FAILED'
            try:tool.event('failed_closed')
            except Exception:cleanup='RECOVER_FAILED_RECEIPT_SAVE_FAILED'
    finally:
        if tool:
            try:tool.close()
            except Exception:cleanup='RECOVER_EVIDENCE_CLOSE_FAILED'
        if base_fd is not None:os.close(base_fd)
    if primary or cleanup:
        print(json.dumps({'passed':False,'error_code':primary,'cleanup_error_code':cleanup,
            'receipt':str(tool.directory/'receipt.json') if tool and tool.directory else None}));return 2
    if args.mode=='apply':
        print(json.dumps({'passed':True,'phase':result['phase'],'receipt':str(tool.directory/'receipt.json'),
                          'receipt_sha256':digest((tool.directory/'receipt.json').read_bytes())}));return 0
    print(json.dumps(result,sort_keys=True));return 0


if __name__=='__main__':raise SystemExit(main())

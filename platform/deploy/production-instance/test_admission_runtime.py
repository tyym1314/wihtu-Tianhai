"""Local pure contracts, real archive bytes and historical helper selection. No services."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

a=load('admission_contract_test','admission-runtime.py')
o=load('operations_admission_test','operations.py');p=o.p
OLD='/opt/oasis/releases/20261010-03';NEW='/opt/oasis/releases/20261010-04'
MANIFEST='a'*64;OWNER='b'*32;CID='c'*64

def env():
    return {'NODE_ENV':'production','OASIS_ENVIRONMENT':'production','OASIS_START_WALLET':'0',
            'OASIS_PRODUCTION_ADMISSION_ENABLED':'0','OASIS_API_PORT':'18891',
            'OASIS_PUBLIC_ORIGIN':'https://stage.example.test',
            'OASIS_LOCAL_DIR':'/opt/oasis/production-instance-private/state/',
            'OASIS_DATABASE_URL':'postgres://oasis_prod_app:testPassword@127.0.0.1:18893/oasis_production'}

def free_env():
    return {**env(),'OASIS_ADMISSION_PROFILE':a.FREE_PROFILE,'OASIS_FIRSTPARTY_APP_ID':'app_actual',
            'OASIS_ADMISSION_RELEASE':NEW,'OASIS_ADMISSION_MANIFEST_SHA256':MANIFEST}

def policy(state='open',revision='1'):
    return {'app_id':'app_actual','profile':a.FREE_PROFILE,'state':state,'revision':revision,
            'scope':{'partner_id':'partner_oasis_platform','app_id':'app_actual','environment':'production','wallet_scope_id':'wallet_actual','currency_id':'COIN'},
            'currency_scale':0,'allowed_origins':[env()['OASIS_PUBLIC_ORIGIN']],'game_ids':sorted(a.ARENA_GAMES),
            'release':NEW,'manifest_sha256':MANIFEST,'proof_sha256':'e'*64,'approved_by':'admin_actual','approved_at':'2026-10-10T00:00:00.000Z'}

def pin(body):
    return {'uid':0,'gid':0,'mode':0o600,'device':1,'inode':2,'kind':'file','bytes':len(body),'sha256':p.digest(body)}

def history():
    bodies={'runtime.env':(''.join(k+'='+v+'\n' for k,v in env().items())).encode(),
            'postgres.env':b'POSTGRES_USER=oasis_prod_owner\nPOSTGRES_DB=oasis_production\nPOSTGRES_PASSWORD=testOwnerPassword\n',
            'operator-credentials.json':b'{"username":"operator","password":"synthetic-only"}',
            'state/master.key':b'x'*32}
    private={name:pin(body) for name,body in bodies.items()}
    entry={'release':OLD,'manifest_sha256':MANIFEST,'helpers':{name:p.digest(name.encode()) for name in a.LEGACY_HELPERS},
           'private_pins':copy.deepcopy(private),'inspection_contract':'production-closed-v1',
           'runtime_profile':a.runtime_profile(env()),'policy_approvals':[]}
    current=copy.deepcopy(private);current['runtime.env']=pin((''.join(k+'='+v+'\n' for k,v in free_env().items())).encode())
    marker={'release':NEW,'manifest_sha256':'d'*64,'owner':OWNER,'container_id':CID,'private_pins':current,'release_history':[entry]}
    return marker,entry,bodies

def free_history():
    marker,_,bodies=history();bodies['runtime.env']=(''.join(k+'='+v+'\n' for k,v in free_env().items())).encode()
    private={name:pin(body) for name,body in bodies.items()};marker.update(manifest_sha256=MANIFEST,private_pins=copy.deepcopy(private))
    entry={'release':NEW,'manifest_sha256':MANIFEST,'helpers':{name:p.digest(name.encode()) for name in a.CURRENT_HELPERS},
           'private_pins':private,'inspection_contract':'production-free-v2','runtime_profile':a.runtime_profile(free_env()),
           'policy_approvals':[policy(),policy('closed','2')]};marker['release_history'].append(entry)
    return marker,entry,bodies

def closed_configuration(marker,source):
    saved={name:copy.deepcopy(source[name]) for name in ('private_pins','runtime_profile','policy_approvals')}
    body=(''.join(k+'='+v+'\n' for k,v in env().items())).encode()
    saved['private_pins']['runtime.env']=pin(body);saved['runtime_profile']=a.runtime_profile(env());saved['policy_approvals']=[]
    source['configuration_history']=[saved]
    return saved,body

def archive(path,bodies,*,member_override=None):
    with tarfile.open(path,'w:gz') as tar:
        for name,source in o.ARCHIVE_MEMBERS.items():
            body=bodies[source];member=tarfile.TarInfo(name);member.mode=0o600;member.uid=member.gid=0;member.size=len(body)
            if member_override:member_override(member)
            tar.addfile(member,io.BytesIO(body))

class RuntimeContract(unittest.TestCase):
    def test_closed_and_four_explicit_free_fields_are_public_only(self):
        self.assertEqual(a.runtime_profile(env())['profile'],'closed')
        actual=a.runtime_profile(free_env(),expected_release=NEW,expected_manifest=MANIFEST)
        self.assertEqual(actual['app_id'],'app_actual');self.assertNotIn('testPassword',json.dumps(actual))
    def test_generic_flags_missing_fields_and_source_drift_fail(self):
        for value in ('1','true','False','',True):
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'GENERIC'):
                a.runtime_profile({**env(),'OASIS_PRODUCTION_ADMISSION_ENABLED':value})
        for field in a.FREE_FIELDS[1:]:
            candidate=free_env();candidate.pop(field)
            with self.subTest(field=field),self.assertRaises(ValueError):a.runtime_profile(candidate)
        with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):a.runtime_profile(free_env(),expected_release=OLD)
        with self.assertRaisesRegex(ValueError,'AMBIGUOUS'):a.runtime_profile({**env(),'OASIS_FIRSTPARTY_APP_ID':'app_actual'})
    def test_archive_can_differ_in_only_the_four_admission_fields(self):
        a.archive_runtime(env(),free_env(),a.runtime_profile(env()))
        for field,value in [('OASIS_DATABASE_URL','postgres://foreign:changed@127.0.0.1:18893/oasis_production'),
                            ('OASIS_PUBLIC_ORIGIN','https://other.example.test'),('OASIS_ENGINE_WORKERS','9')]:
            with self.subTest(field=field),self.assertRaises(ValueError):a.archive_runtime({**env(),field:value},free_env(),a.runtime_profile(env()))
    def test_env_parser_rejects_duplicate_and_shell_is_never_executed(self):
        with self.assertRaises(ValueError):a.parse_env_text('NODE_ENV=production\nNODE_ENV=sandbox\n')
        self.assertEqual(a.parse_env_text('VALUE=$(never_execute)\n')['VALUE'],'$(never_execute)')

class HistoryContract(unittest.TestCase):
    def test_old_source_approved_independently_of_current_source(self):
        marker,entry,_=history();self.assertEqual(a.approved_source(marker,OLD,MANIFEST),entry)
        with self.assertRaisesRegex(ValueError,'NOT_APPROVED'):a.approved_source(marker,NEW,MANIFEST)
    def test_missing_duplicate_self_approved_history_and_secret_replacement_fail(self):
        for mutate in [lambda m:m.pop('release_history'),lambda m:m['release_history'].append(copy.deepcopy(m['release_history'][0])),
                       lambda m:m['release_history'][0]['private_pins']['postgres.env'].update(sha256='e'*64),
                       lambda m:m['release_history'][0]['private_pins']['runtime.env'].pop('inode'),
                       lambda m:m['release_history'][0]['helpers'].update({'fake.py':'f'*64})]:
            marker,_,_=history();mutate(marker)
            with self.assertRaises(ValueError):a.approved_source(marker,OLD,MANIFEST)
    def test_policy_approval_normalizes_state_revision_and_requires_all_real_arena_ids(self):
        policy={'app_id':'app_actual','profile':a.FREE_PROFILE,'state':'open','revision':'1','scope':{'partner_id':'partner_oasis_platform','app_id':'app_actual','environment':'production','wallet_scope_id':'wallet_actual','currency_id':'COIN'},'currency_scale':0,'allowed_origins':[env()['OASIS_PUBLIC_ORIGIN']],'game_ids':sorted(a.ARENA_GAMES),'release':NEW,'manifest_sha256':MANIFEST,'proof_sha256':'e'*64,'approved_by':'admin_actual','approved_at':'2026-10-10T00:00:00+00:00'}
        self.assertEqual(a.normalize_policy(policy)['approved_at'],'2026-10-10T00:00:00.000Z')
        for mutate in [lambda v:v.update(revision=True),lambda v:v.update(game_ids=['olympus']),lambda v:v.update(game_ids=['run']),lambda v:v['scope'].update(extra='bypass'),lambda v:v.update(approved_at='2026-10-10T00:00:00')]:
            candidate=copy.deepcopy(policy);mutate(candidate)
            with self.assertRaises(ValueError):a.normalize_policy(candidate)
    def test_free_history_requires_independent_exact_policy_source_scope_and_helper_contract(self):
        marker,entry,_=free_history();self.assertEqual(a.approved_source(marker,NEW,MANIFEST),entry)
        for mutate in [lambda e:e.update(policy_approvals=[]),lambda e:e['policy_approvals'][0].update(release=OLD),
                       lambda e:e['policy_approvals'][0].update(app_id='app_foreign'),lambda e:e['policy_approvals'].append(copy.deepcopy(e['policy_approvals'][0])),
                       lambda e:e['helpers'].pop('admission-runtime.py'),lambda e:e['runtime_profile'].update(manifest_sha256='c'*64)]:
            marker,_,_=free_history();mutate(marker['release_history'][1])
            with self.subTest(mutation=mutate),self.assertRaises(ValueError):a.approved_source(marker,NEW,MANIFEST)
    def test_same_source_closed_configuration_survives_free_approval_without_overwriting_history(self):
        marker,source,_=free_history();saved,_=closed_configuration(marker,source)
        self.assertEqual(a.approved_source(marker,NEW,MANIFEST)['runtime_profile']['profile'],a.FREE_PROFILE)
        restored=a.approved_source(marker,NEW,MANIFEST,runtime_env_sha=saved['private_pins']['runtime.env']['sha256'],runtime_profile_selector=saved['runtime_profile'])
        self.assertEqual(restored['runtime_profile']['profile'],'closed');self.assertEqual(restored['policy_approvals'],[]);self.assertEqual(restored['helpers'],source['helpers'])
        with self.assertRaisesRegex(ValueError,'NOT_APPROVED'):a.approved_source(marker,NEW,MANIFEST,runtime_env_sha='f'*64,runtime_profile_selector=saved['runtime_profile'])
        for mutate in [lambda e:e['configuration_history'].append(copy.deepcopy(e['configuration_history'][0])),
                       lambda e:e['configuration_history'][0]['private_pins']['postgres.env'].update(sha256='d'*64),
                       lambda e:e['configuration_history'][0].update(extra='unapproved')]:
            marker,source,_=free_history();saved,_=closed_configuration(marker,source);mutate(source)
            with self.assertRaises(ValueError):a.approved_source(marker,NEW,MANIFEST,runtime_env_sha=saved['private_pins']['runtime.env']['sha256'],runtime_profile_selector=saved['runtime_profile'])

class ArchiveContract(unittest.TestCase):
    def test_real_archive_binds_historical_key_and_config_with_current_nonfree_config_preserved(self):
        _,source,bodies=history()
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'private.tar.gz';archive(path,bodies)
            proof=o.archive_identity(path,source,free_env())
            self.assertEqual(proof['master_key_sha256'],p.digest(b'x'*32));self.assertNotIn('testPassword',json.dumps(proof))
    def test_changed_key_config_link_and_member_owner_are_refused(self):
        for kind in ('key','env','link','uid'):
            _,source,bodies=history()
            if kind=='key':bodies['state/master.key']=b'y'*32
            if kind=='env':bodies['runtime.env']=b'OASIS_ENVIRONMENT=sandbox\n'
            def change(member):
                if kind=='link':member.type=tarfile.SYMTYPE;member.linkname='/opt/oasis/private/state/master.key'
                if kind=='uid':member.uid=8
            with tempfile.TemporaryDirectory() as temp:
                path=Path(temp)/'private.tar.gz';archive(path,bodies,member_override=change)
                with self.subTest(kind=kind),self.assertRaises(p.Refusal):o.archive_identity(path,source,free_env())

class BoundBackup(unittest.TestCase):
    def test_actual_checksums_allow_approved_old_backup_after_current_source_switch(self):
        marker,source,bodies=history()
        with tempfile.TemporaryDirectory() as temp:
            parent=Path(temp)/'backups';parent.mkdir();directory=parent/'20261010T000000Z';directory.mkdir(mode=0o700)
            archive(directory/'private-config.tar.gz',bodies)
            identity={'schema':1,'environment':'production','database':p.DATABASE,'owner':OWNER,'container_id':CID,
                      'release':OLD,'manifest_sha256':MANIFEST,'master_key_sha256':p.digest(b'x'*32)}
            for name,body in {'database.dump':b'PGDMP'+b'x'*2048,'release.txt':(OLD+'\n').encode(),
                              'database-contents.txt':b'synthetic table listing','runtime-identity.json':p.canonical(identity)}.items():(directory/name).write_bytes(body)
            for path in directory.iterdir():path.chmod(0o600)
            def checks():
                (directory/'SHA256SUMS').write_text(''.join(p.digest((directory/name).read_bytes())+'  '+name+'\n' for name in o.BACKUP_FILES));(directory/'SHA256SUMS').chmod(0o600)
            checks();original=p.fingerprint;closure={'inspect':p.digest(b'inspect')};calls=[]
            def verification(release,manifest,helpers):calls.append((str(release),manifest,helpers));return {'helpers':helpers,'inspection_closure':closure}
            def fingerprint(path,**kw):return {**original(path,**kw),'uid':0}
            with patch.object(p,'BACKUPS',parent),patch.object(p,'no_mount'),patch.object(p,'fingerprint',side_effect=fingerprint),patch.object(p,'parse_env',return_value=free_env()),patch.object(p,'verify_historical_release',side_effect=verification),patch.object(p.Path,'lstat',autospec=True,side_effect=lambda path: type('Info',(),{'st_mode':stat.S_IFDIR|0o700,'st_uid':0})() if path==directory else Path.stat(path,follow_symlinks=False)):
                restored=o.validate_backup(marker,directory)
                self.assertEqual(restored['approved_source']['release'],OLD);self.assertEqual(calls[0][:2],(OLD,MANIFEST))
                identity.update(release='/opt/oasis/releases/20261010-99');(directory/'release.txt').write_text(identity['release']+'\n');(directory/'runtime-identity.json').write_bytes(p.canonical(identity));checks()
                with self.assertRaisesRegex(p.Refusal,'NOT_APPROVED'):o.validate_backup(marker,directory)
    def test_inspection_executes_exact_historical_helper_and_fails_pending_before_pass(self):
        _,source,_=history();source={**source,'inspection_closure':{'inspect':'a'*64}};calls=[]
        class Runtime:
            pending=0
            def command(self,args,**options):
                calls.append((args,options))
                if args[-1]=='sql':return 'READ_INSPECTION'
                return json.dumps({'environment':'production','master_key_sha256':p.digest(b'x'*32),
                                   'row_counts':{'gp_keys':1},'audit':{'active_rooms':self.pending}})
        runtime=Runtime()
        with patch.object(p,'fingerprint',return_value={'sha256':source['helpers']['inspect-backup.mjs']}),patch.object(p,'verify_historical_release',return_value={'inspection_closure':source['inspection_closure']}),patch.object(o,'sql',return_value=json.dumps({'keys':['ciphertext']})+'\n'+json.dumps({'database':p.DATABASE})):
            o.inspect_database({},runtime,p.DATABASE,source,Path('/private/own-restored-key'))
            self.assertTrue(all(args[1]==OLD+'/platform/deploy/production-instance/inspect-backup.mjs' for args,_ in calls))
            self.assertFalse(any(NEW in str(args) for args,_ in calls));self.assertNotIn('expected',calls[0][1])
            runtime.pending=1
            with self.assertRaisesRegex(p.Refusal,'PENDING_OBLIGATIONS'):o.inspect_database({},runtime,p.DATABASE,source,Path('/private/own-restored-key'))

class BackupPipeline(unittest.TestCase):
    def scenario(self,*,changed=False):
        marker,source,bodies=free_history();closure={'inspect':'a'*64};snap='f'*64
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);private=root/'private';private.mkdir();backups=root/'backups';backups.mkdir(mode=0o700)
            for name,body in bodies.items():
                file=private/name;file.parent.mkdir(exist_ok=True);file.write_bytes(body);file.chmod(0o600)
            # Preserve genuine on-disk member metadata, except no test requires
            # privileged chown or claims these Mac temp files are production.
            pins={name:p.fingerprint(private/name) for name in a.PRIVATE_NAMES}
            source['private_pins']=copy.deepcopy(pins);marker['private_pins']=copy.deepcopy(pins)
            inspection={'environment':'production','inspection_contract':'production-free-v2','profile_snapshot':{'runtime_profile':source['runtime_profile']},'profile_snapshot_sha256':snap,'audit':{'active_rooms':0}}
            class Runtime:
                def command(self,args,**options):
                    if 'pg_dump' in args:return b'PGDMP'+b'x'*2048
                    if 'pg_restore' in args:return b'synthetic actual member listing'
                    raise AssertionError('UNKNOWN_COMMAND')
            class LinuxRenameFixture:
                def renameat2(self,_base,src,_dest,dst,flags):
                    if flags!=1 or Path(os.fsdecode(dst)).exists():raise AssertionError('NONEXCLUSIVE_PUBLISH')
                    os.rename(src,dst);return 0
            native_lstat=Path.lstat
            def lstat(path):
                if path==backups:return type('Info',(),{'st_mode':stat.S_IFDIR|0o700,'st_uid':0})()
                return native_lstat(path)
            with patch.object(o,'owned_resources',return_value={'running':True}),patch.object(o,'database_identity',return_value={'database':p.DATABASE,'database_oid':7,'environment':'production'}),patch.object(o,'inspect_database',side_effect=[inspection,{**inspection,'profile_snapshot_sha256':'e'*64 if changed else snap}]),patch.object(p,'PRIVATE',private),patch.object(p,'BACKUPS',backups),patch.object(p,'no_mount'),patch.object(p.os,'fchown'),patch.object(p,'parse_env',return_value=free_env()),patch.object(p,'verify_historical_release',return_value={'helpers':source['helpers'],'inspection_closure':closure}),patch.object(Path,'lstat',lstat),patch('ctypes.CDLL',return_value=LinuxRenameFixture()):
                if changed:
                    with self.assertRaisesRegex(p.Refusal,'ADMISSION_CHANGED'):o.backup(marker,Runtime())
                    self.assertTrue(all(file.name.startswith('.building-') for file in backups.iterdir()));return
                receipt=o.backup(marker,Runtime());directory=Path(receipt['path']);identity=json.loads((directory/'runtime-identity.json').read_text())
                self.assertEqual(identity['helpers'],source['helpers']);self.assertEqual(identity['inspection_closure'],closure)
                self.assertEqual(identity['archive_identity']['runtime_env_sha256'],pins['runtime.env']['sha256']);self.assertEqual(identity['profile_snapshot_sha256'],snap)
                self.assertEqual(set(file.name for file in directory.iterdir()),set(o.BACKUP_FILES)|{'SHA256SUMS'})
                self.assertNotIn('testPassword',json.dumps(identity));self.assertIn('not the pg_dump snapshot',identity['snapshot_scope'])
                for row in (directory/'SHA256SUMS').read_text().splitlines():
                    digest,name=row.split('  ');self.assertEqual(p.digest((directory/name).read_bytes()),digest)
    def test_actual_private_archive_keeps_the_approved_source_and_publishes_complete_bound_receipt(self):self.scenario()
    def test_changed_admission_observation_does_not_publish_a_timestamp_backup(self):self.scenario(changed=True)

class FreeRestoreCleanup(unittest.TestCase):
    def scenario(self,*,drift=None,historical_closed=False):
        marker,source,bodies=free_history();source={**source,'inspection_closure':{'inspect':'a'*64}}
        if historical_closed:
            entry=marker['release_history'][1];saved,body=closed_configuration(marker,entry);bodies['runtime.env']=body
            source={**a.approved_source(marker,NEW,MANIFEST,runtime_env_sha=saved['private_pins']['runtime.env']['sha256'],runtime_profile_selector=saved['runtime_profile']),'inspection_closure':source['inspection_closure']}
        expected=a.inspection_expectation(source);helper=Path(__file__).with_name('inspect-backup.mjs').resolve();calls=[]
        # A real local Node helper creates AES fixture bytes and verifies them.
        # SQL/containers are modeled here; actual PG/pg_dump is independently
        # tested in production-admission-backup.integration.test.mjs.
        script="""import{createCipheriv}from'node:crypto';import{PRODUCTION_TABLES,PRODUCTION_AUDIT_KEYS}from './inspect-backup.mjs';
const e=JSON.parse(process.argv[1]),policy=e.policy_approvals[1]||JSON.parse(process.argv[2]),scope=policy.scope,master=Buffer.alloc(32,120),iv=Buffer.alloc(12,7),cipher=createCipheriv('aes-256-gcm',master,iv),body=Buffer.concat([cipher.update(JSON.stringify(Buffer.alloc(32,9).toString('base64'))),cipher.final()]),key=Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
const rows=Object.fromEntries(PRODUCTION_TABLES.map(t=>[t,0]));for(const t of['gp_apps','gp_keys','gp_runtime_identity','gp_wallet_bindings','gp_production_admission','wallet_scopes'])rows[t]=1;
const legacy=['balance_mismatches','scope_mismatches','unbalanced_transactions','ledger_version_mismatches','orphan_records','invalid_constraints','pending_cycles','pending_probability_operations','pending_pvp_operations','active_rooms','pending_wallet_operations','clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches','pending_transfers'];
const data={inspection_contract:'production-free-v2',transfer_schema:'present',rows,audit:Object.fromEntries([...legacy,...PRODUCTION_AUDIT_KEYS].map(k=>[k,0])),keys:[key],profiles:{apps:[{id:policy.app_id,...scope,currency_scale:0,wallet_url:'',status:'paused',allowed_origins:policy.allowed_origins,game_ids:policy.game_ids}],policies:[policy],bindings:[{app_id:policy.app_id,provider:'platform',wallet_url:null,wallet_key_id:null,scope}],wallet_scopes:[{...scope,scope_id:Object.values(scope).join(':'),currency_scale:0,...Object.fromEntries(['treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version'].map(k=>[k,'0']))}],rooms:[]}};if(e.runtime_profile.profile==='closed'){rows.gp_production_admission=0;data.profiles.policies=[];}process.stdout.write(JSON.stringify(data));"""
        data=json.loads(subprocess.check_output(['node','--input-type=module','-e',script,json.dumps(expected),json.dumps(policy('closed','2'))],cwd=helper.parent))
        def node(mode,input,master=None):
            args=['node',str(helper),mode]+([str(master)] if master else [])
            result=subprocess.run(args,input=json.dumps(input),text=True,capture_output=True)
            if result.returncode:raise p.Refusal(result.stderr.strip())
            return result.stdout
        created=False
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);parent=root/'backups';parent.mkdir();backup=parent/'20261010T000000Z';backup.mkdir(mode=0o700);archive(backup/'private-config.tar.gz',bodies);(backup/'database.dump').write_bytes(b'PGDMPsynthetic')
            key=root/'original.key';key.write_bytes(b'x'*32);baseline=json.loads(node('verify',{'data':data,'identity':{'database':p.DATABASE,'environment':'production','sandbox_apps':0,'reference_keys':0},'expected':expected},key))
            identity={'schema':2,'environment':'production','database':p.DATABASE,'owner':OWNER,'container_id':CID,'release':NEW,'manifest_sha256':MANIFEST,'master_key_sha256':p.digest(b'x'*32),'inspection_contract':source['inspection_contract'],'helpers':source['helpers'],'inspection_closure':source['inspection_closure'],'runtime_profile':source['runtime_profile'],'archive_identity':o.archive_identity(backup/'private-config.tar.gz',source,free_env()),'profile_snapshot_sha256':baseline['profile_snapshot_sha256']}
            if drift=='receipt':identity['profile_snapshot_sha256']='f'*64
            if drift=='unapproved_configuration':identity['archive_identity']['runtime_env_sha256']='f'*64
            if drift=='unapproved_profile':identity['runtime_profile']={**identity['runtime_profile'],'public_origin':'https://unapproved.example.test'}
            if drift=='policy':data['profiles']['policies'][0]['revision']='3'
            if drift=='pending':data['audit']['active_rooms']=1
            for name,body in {'release.txt':(NEW+'\n').encode(),'database-contents.txt':b'synthetic members','runtime-identity.json':p.canonical(identity)}.items():(backup/name).write_bytes(body)
            for file in backup.iterdir():file.chmod(0o600)
            (backup/'SHA256SUMS').write_text(''.join(p.digest((backup/name).read_bytes())+'  '+name+'\n' for name in o.BACKUP_FILES));(backup/'SHA256SUMS').chmod(0o600)
            def sql(runtime,mark,database,body):
                nonlocal created
                calls.append(('sql',database,body))
                if body.startswith('CREATE'):created=True;return ''
                if 'DROP DATABASE' in body:created=False;return ''
                if 'json_build_object' in body and 'pg_stat_activity' in body:return json.dumps({'oid':7,'active':0})
                if body.startswith('SELECT oid'):return '7' if created else ''
                self.assertIn('REPEATABLE READ READ ONLY',body)
                return json.dumps(data)+'\n'+json.dumps({'database':database,'environment':'production','sandbox_apps':0,'reference_keys':0})
            class Runtime:
                def command(self,args,**options):
                    calls.append(('command',args))
                    if 'pg_restore' in args:return b''
                    if args[0]=='/usr/bin/node':
                        if args[1]!=NEW+'/platform/deploy/production-instance/inspect-backup.mjs':raise AssertionError('WRONG_HELPER')
                        return node(args[2],json.loads(options['input']),Path(args[3]) if len(args)>3 else None)
                    raise AssertionError('UNKNOWN_COMMAND')
            native_lstat=Path.lstat
            def lstat(path):return type('Info',(),{'st_mode':stat.S_IFDIR|0o700,'st_uid':0})() if path==backup else native_lstat(path)
            with patch.object(o,'owned_resources'),patch.object(o,'sql',side_effect=sql),patch.object(p,'PRIVATE',root),patch.object(p,'BACKUPS',parent),patch.object(p,'no_mount'),patch.object(p.os,'fchown'),patch.object(p,'parse_env',return_value=free_env()),patch.object(Path,'lstat',lstat),patch.object(p,'fingerprint',side_effect=lambda path,**kw:{'sha256':source['helpers']['inspect-backup.mjs']} if str(path).startswith(NEW) else {**original(path,**kw),'uid':0}),patch.object(p,'verify_historical_release',return_value={'helpers':source['helpers'],'inspection_closure':source['inspection_closure']}):
                if drift in ('unapproved_configuration','unapproved_profile'):
                    with self.assertRaisesRegex(p.Refusal,'CONFIGURATION_NOT_APPROVED'):o.restore(marker,backup,Runtime())
                    self.assertFalse(calls);self.assertFalse(created);return {'passed':False}
                result=o.restore(marker,backup,Runtime())
            self.assertTrue(result['cleanup']['database_removed']);self.assertTrue(result['cleanup']['temporary_removed']);self.assertFalse(created)
            for kind,*arguments in calls:
                if kind=='sql' and 'DROP DATABASE' in arguments[1]:
                    self.assertNotIn('DROP DATABASE '+p.DATABASE,arguments[1]);self.assertIn('oid=7',arguments[1]);self.assertNotIn('FORCE',arguments[1])
            return result
    def test_real_free_helper_and_aes_pass_then_remove_only_exact_owned_restore_oid(self):
        result=self.scenario();self.assertTrue(result['passed']);self.assertEqual(result['source_release'],NEW)
    def test_profile_receipt_policy_or_pending_failure_still_cleans_owned_oid(self):
        for drift,code in [('receipt','PROFILE_SNAPSHOT_CHANGED'),('policy','NOT_INDEPENDENTLY_APPROVED'),('pending','OBLIGATION_OR_INTEGRITY')]:
            with self.subTest(drift=drift):
                result=self.scenario(drift=drift);self.assertFalse(result['passed']);self.assertIn(code,result['error_code'])
    def test_same_source_closed_backup_restores_through_actual_archive_and_helper_after_free_approval(self):
        result=self.scenario(historical_closed=True);self.assertTrue(result['passed']);self.assertEqual(result['checks']['profile_snapshot']['runtime_profile']['profile'],'closed')
    def test_recomputed_backup_checksums_cannot_approve_unknown_historical_configuration_or_profile(self):
        for drift in ('unapproved_configuration','unapproved_profile'):
            with self.subTest(drift=drift):self.scenario(historical_closed=True,drift=drift)

original=p.fingerprint

if __name__=='__main__':unittest.main()

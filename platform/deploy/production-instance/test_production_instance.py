"""Local synthetic/temp-FS adversarial fixtures; never invokes a real service or Docker."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
import sys
import types
from unittest.mock import patch

HERE=Path(__file__).parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
p=load('provision_test','provision.py')
o=load('operations_test','operations.py')

class Guards(unittest.TestCase):
    def test_explicit_mode_survives_private_umask(self):
        with tempfile.TemporaryDirectory() as temp:
            old=os.umask(0o077)
            try:
                with patch.object(p.os,'fchown'):
                    p.exclusive(Path(temp)/'unit',b'[Service]\n',0o644)
                self.assertEqual(stat.S_IMODE((Path(temp)/'unit').stat().st_mode),0o644)
            finally:os.umask(old)

    def test_existing_file_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'unit';file.write_bytes(b'foreign')
            with self.assertRaises(FileExistsError):p.exclusive(file,b'ours')
            self.assertEqual(file.read_bytes(),b'foreign')

    def test_symlink_and_hardlink_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            leaf=Path(temp)/'leaf';leaf.write_bytes(b'data')
            link=Path(temp)/'link';link.symlink_to(leaf)
            with self.assertRaisesRegex(p.Refusal,'SYMLINK'):p.fingerprint(link)
            os.link(leaf,Path(temp)/'hard')
            with self.assertRaisesRegex(p.Refusal,'SINGLE_LINK'):p.fingerprint(leaf)

    def test_bound_leaf_detects_cert_symlink_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            a=Path(temp)/'a';b=Path(temp)/'b';a.write_bytes(b'a');b.write_bytes(b'b')
            link=Path(temp)/'leaf.pem';link.symlink_to(a);first=p.fingerprint(link,links=True)
            link.unlink();link.symlink_to(b)
            self.assertNotEqual(first,p.fingerprint(link,links=True))

    def test_shared_lock_descriptor_rejects_same_path_rebuild(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'release.lock';file.write_bytes(b'');file.chmod(0o600)
            before=p.fingerprint(file);fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                p.lock_descriptor_guard(fd,file,before)
                file.unlink();file.write_bytes(b'');file.chmod(0o600)
                with self.assertRaisesRegex(p.Refusal,'LOCK_REPLACED'):p.lock_descriptor_guard(fd,file,before)
            finally:os.close(fd)

    def test_same_filesystem_bind_mount_rejected(self):
        data='46 1 8:1 /public/private /opt/oasis/production-instance-private/state rw - ext4 /dev/sda rw'
        with self.assertRaisesRegex(p.Refusal,'MOUNTED'):p.no_mount(Path('/opt/oasis/production-instance-private'),data)

    def test_escaped_mount_target_rejected(self):
        data='46 1 8:1 /source /tmp/owned\\040dir/state rw - ext4 /dev/sda rw'
        with self.assertRaisesRegex(p.Refusal,'MOUNTED'):p.no_mount(Path('/tmp/owned dir'),data)

    def test_neighbor_mount_not_adopted(self):
        p.no_mount(Path('/tmp/owned'),'46 1 8:1 /source /tmp/owned-foreign rw - ext4 /dev/sda rw')

    def test_fresh_only_current_authorization(self):
        clock=dt.datetime(2026,10,10,tzinfo=dt.timezone.utc)
        p.fresh_time((clock-dt.timedelta(seconds=599)).isoformat(),now=clock)
        for seconds in (-1,601):
            with self.assertRaisesRegex(p.Refusal,'NOT_FRESH'):p.fresh_time((clock-dt.timedelta(seconds=seconds)).isoformat(),now=clock)

    def test_exact_https_origins(self):
        for value in ('https://game.tianyahuyu.com','https://oasis-player.43.98.202.236.sslip.io'):self.assertEqual(p.validate_origin(value),value)
        for value in ('http://x.com','https://x.com/','https://secret@x.com','https://x.com?q=1','https://x.com#x','https://x.com/../'):
            with self.assertRaises(p.Refusal):p.validate_origin(value)

    def test_not_yet_listening_readiness_is_bounded_probe_refusal(self):
        class Opener:
            def open(self,*args,**kwargs):raise p.urllib.error.URLError('not listening')
        with patch.object(p.urllib.request,'build_opener',return_value=Opener()),self.assertRaisesRegex(p.Refusal,'HTTP_UNAVAILABLE'):
            p.Runtime().http('http://127.0.0.1:18891/health/ready',200,'production')

    def test_protected_inventory_missing_master_refused(self):
        value={'kind':'production-protected-inventory','paths':[x for x in p.REQUIRED_PINS if not x.endswith('/master.key')]+['/opt/oasis/postgres.env'],'current':'/opt/oasis/releases/20261009-03','previous':'/opt/oasis/releases/20261009-02','retirement_receipt_sha256':p.RETIRE_SHA}
        with self.assertRaisesRegex(p.Refusal,'INVENTORY_INVALID'):p.validate_protected(value)

    def test_protected_inventory_cannot_include_new_owned_tree(self):
        value={'kind':'production-protected-inventory','paths':list(p.REQUIRED_PINS)+['/opt/oasis/private/state/master.key','/opt/oasis/postgres.env',str(p.PRIVATE/'state/master.key')],'current':'/opt/oasis/releases/20261009-03','previous':'/opt/oasis/releases/20261009-02','retirement_receipt_sha256':p.RETIRE_SHA}
        with self.assertRaisesRegex(p.Refusal,'INVENTORY_INVALID'):p.validate_protected(value)

    def test_service_templates_fixed_id_and_separate_namespace(self):
        templates=p.unit_templates(Path('/opt/oasis/releases/20261010-01'),'c'*64)
        self.assertEqual(set(templates),set(p.UNITS))
        self.assertIn('User=oasis-prod',templates['oasis-production-api.service'])
        self.assertIn('ExecStop=/usr/bin/docker stop --time 30 '+'c'*64,templates['oasis-production-db.service'])
        self.assertNotIn('User=oasis\n',''.join(templates.values()))
        self.assertNotIn('/opt/oasis/current',''.join(templates.values()))
        self.assertNotIn('oasis-postgres',''.join(templates.values()))
        self.assertIn('Group=oasis-prod',templates['oasis-production-instance-monitor.service'])

    def test_template_rejects_mutable_container_name(self):
        with self.assertRaises(p.Refusal):p.unit_templates(Path('/opt/oasis/releases/20261010-01'),'oasis-postgres')

    def test_environment_is_data_not_shell(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'runtime.env';file.write_text('OASIS_X=$(echo not-executed)\n');file.chmod(0o600)
            self.assertEqual(p.parse_env(file)['OASIS_X'],'$(echo not-executed)')
            file.write_text('OASIS_X=1\nOASIS_X=2\n')
            with self.assertRaisesRegex(p.Refusal,'FORMAT'):p.parse_env(file)

    def test_transient_unknown_unit_dependency_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'foreign.service';file.write_text('[Unit]\nPartOf=oasis-production-api.service\n')
            with patch.object(p,'SYSTEMD_ROOTS',(temp,)),self.assertRaisesRegex(p.Refusal,'DEPENDENCY'):p.unit_namespace_guard()

    def test_control_dropin_and_namespace_symlink_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'oasis-production-api.service.d').mkdir()
            with patch.object(p,'SYSTEMD_ROOTS',(temp,)),self.assertRaisesRegex(p.Refusal,'DIRECTORY'):p.unit_namespace_guard()
            (root/'oasis-production-api.service.d').rmdir();(root/'foreign.service').symlink_to('/etc/systemd/system/oasis-production-api.service')
            with patch.object(p,'SYSTEMD_ROOTS',(temp,)),self.assertRaisesRegex(p.Refusal,'LINK'):p.unit_namespace_guard()

    def test_other_owned_certificate_namespace_does_not_conflict(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp)/'oasis-production-player-certificate.service').write_text('[Service]\nExecStart=/path/production-ingress.py renew\n')
            with patch.object(p,'SYSTEMD_ROOTS',(temp,)):p.unit_namespace_guard()

    def test_real_timer_service_enable_links_bind_exact_parent(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();templates=p.unit_templates(Path('/opt/oasis/releases/20261010-01'),'c'*64)
            for directory in ('timers.target.wants','multi-user.target.wants','foreign.target.wants'):(root/directory).mkdir()
            for name in ('oasis-production-api.service','oasis-production-instance-backup.timer'):
                (root/name).write_text(templates[name])
                parent='timers.target.wants' if name.endswith('.timer') else 'multi-user.target.wants'
                link=root/parent/name;link.symlink_to(root/name)
                p.enabled_link_guard(link,templates,root)
                wrong=root/'foreign.target.wants'/name;wrong.symlink_to(root/name)
                with self.assertRaisesRegex(p.Refusal,'UNIT_LINK'):p.enabled_link_guard(wrong,templates,root)
            wrong=root/'multi-user.target.wants/oasis-production-instance-backup.timer';wrong.symlink_to(root/'oasis-production-instance-backup.timer')
            with self.assertRaisesRegex(p.Refusal,'UNIT_LINK'):p.enabled_link_guard(wrong,templates,root)

    def test_loaded_bad_command_cannot_trigger_stop(self):
        tool=object.__new__(p.Provisioner);tool.release=Path('/opt/oasis/releases/20261010-01');tool.marker={'container_id':'c'*64}
        calls=[]
        class Runtime:
            def service(self,name):return {'FragmentPath':'/etc/systemd/system/'+name,'NeedDaemonReload':'no','DropInPaths':''}
            def loaded_commands(self,name):return {'ExecStart':[['/bin/unsafe',['/bin/unsafe'],False]]}
            def command(self,args):calls.append(args)
        tool.runtime=Runtime()
        with patch.object(p,'unit_namespace_guard'),self.assertRaisesRegex(p.Refusal,'COMMAND_CHANGED'):tool.loaded_unit_guard()
        self.assertEqual(calls,[])

    def test_duplicate_gid_alias_is_not_exclusive(self):
        user=types.SimpleNamespace(pw_name=p.OWNER,pw_uid=123,pw_gid=456,pw_dir=str(p.PRIVATE),pw_shell='/usr/sbin/nologin')
        group=types.SimpleNamespace(gr_name=p.OWNER,gr_gid=456,gr_mem=[])
        alias=types.SimpleNamespace(gr_name='foreign',gr_gid=456,gr_mem=['outside'])
        with patch.object(p.pwd,'getpwnam',return_value=user),patch.object(p.pwd,'getpwall',return_value=[user]),patch.object(p.grp,'getgrnam',return_value=group),patch.object(p.grp,'getgrall',return_value=[group,alias]):
            with self.assertRaisesRegex(p.Refusal,'NOT_EXCLUSIVE'):p.account_guard({'uid':123,'gid':456})

class Resources(unittest.TestCase):
    def setUp(self):
        self.cid='c'*64;self.marker={'container_id':self.cid,'owner':'a'*32,'pg_image':'sha256:'+'b'*64,'gid':12,'uid':11,'network_id':'n'*64,'origins':['https://stage.example.com'],
            'volume_identity':{'Name':p.VOLUME,'CreatedAt':'2026-10-10T00:00:00Z','Driver':'local','Options':None,'Mountpoint':'/docker/own'}}
        self.c={'Id':self.cid,'Name':'/'+p.CONTAINER,'Image':self.marker['pg_image'],'Config':{'Labels':{p.LABEL:self.marker['owner']}},
            'Mounts':[{'Name':p.VOLUME,'Type':'volume','Destination':'/var/lib/postgresql/data','RW':True}],
            'NetworkSettings':{'Networks':{p.NETWORK:{'NetworkID':self.marker['network_id']}}},'HostConfig':{'PortBindings':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'18893'}]}},'State':{'Running':True}}
        self.v={**self.marker['volume_identity'],'Labels':{p.LABEL:self.marker['owner']}}
        self.n={'Id':self.marker['network_id'],'Internal':True,'Labels':{p.LABEL:self.marker['owner']},'Containers':{self.cid:{}}}
        self.other={'Id':'d'*64,'Mounts':[],'NetworkSettings':{'Networks':{}}}
        self.r=type('Runtime',(),{'inspect':lambda _,kind,name:self.c if kind=='container' and name==self.cid else self.other if kind=='container' else self.v if kind=='volume' else self.n,
             'command':lambda _,args:self.cid+'\n'+'d'*64+'\n'})()
        self.stack=[]
        self.add(patch.object(o.p,'account_guard'))
        self.add(patch.object(o.p.Path,'lstat',return_value=type('Stat',(),{'st_mode':stat.S_IFDIR|0o750,'st_uid':0,'st_gid':12})()))
        self.add(patch.object(o.p,'no_mount'))
        self.add(patch.object(o.p,'fingerprint',side_effect=lambda file: {'uid':11 if str(file).endswith('master.key') else 0,'gid':12,'mode':0o600,'bytes':32}))
        self.marker['private_pins']={name:o.p.fingerprint(o.p.PRIVATE/name) for name in ('runtime.env','postgres.env','operator-credentials.json','state/master.key')}
        self.env={'OASIS_ENVIRONMENT':'production','OASIS_START_WALLET':'0','OASIS_PRODUCTION_ADMISSION_ENABLED':'0','OASIS_PUBLIC_ORIGIN':self.marker['origins'][0],'OASIS_DATABASE_URL':'postgres://oasis_prod_app:random@127.0.0.1:18893/oasis_production','OASIS_API_PORT':'18891','OASIS_LOCAL_DIR':str(o.p.PRIVATE/'state')+'/'}
        self.add(patch.object(o.p,'parse_env',return_value=self.env))
    def add(self,item):self.stack.append(item);item.start()
    def tearDown(self):
        for item in reversed(self.stack):item.stop()
    def test_owned_identity_positive(self):self.assertTrue(o.owned_resources(self.marker,self.r)['running'])
    def test_foreign_volume_consumer_refused(self):
        self.other['Mounts']=[{'Name':p.VOLUME}]
        with self.assertRaisesRegex(o.p.Refusal,'FOREIGN_CONSUMER'):o.owned_resources(self.marker,self.r)
    def test_stopped_foreign_network_consumer_refused(self):
        self.other['NetworkSettings']['Networks']={p.NETWORK:{}}
        with self.assertRaisesRegex(o.p.Refusal,'FOREIGN_CONSUMER'):o.owned_resources(self.marker,self.r)
    def test_wrong_label_refused(self):
        self.v['Labels'][p.LABEL]='foreign'
        with self.assertRaisesRegex(o.p.Refusal,'OWNERSHIP'):o.owned_resources(self.marker,self.r)
    def test_recreated_same_volume_name_refused(self):
        self.v['CreatedAt']='2026-10-11T00:00:00Z'
        with self.assertRaisesRegex(o.p.Refusal,'REPLACED'):o.owned_resources(self.marker,self.r)
    def test_recreated_network_id_refused(self):
        self.n['Id']='foreign'
        with self.assertRaisesRegex(o.p.Refusal,'SCOPE|REPLACED'):o.owned_resources(self.marker,self.r)
    def test_public_pg_exposure_refused(self):
        self.c['HostConfig']['PortBindings']['5432/tcp'][0]['HostIp']='0.0.0.0'
        with self.assertRaisesRegex(o.p.Refusal,'PORT'):o.owned_resources(self.marker,self.r)
    def test_foreign_additional_mount_refused(self):
        self.c['Mounts'].append({'Type':'bind','Source':'/opt/oasis/private'})
        with self.assertRaisesRegex(o.p.Refusal,'SCOPE'):o.owned_resources(self.marker,self.r)
    def test_same_mode_master_body_changed_refused(self):
        self.marker['private_pins']['state/master.key']['sha256']='old'
        with self.assertRaisesRegex(o.p.Refusal,'PRIVATE_CONFIG'):o.owned_resources(self.marker,self.r)
    def test_runtime_other_database_refused(self):
        self.env['OASIS_DATABASE_URL']='postgres://oasis_prod_app:random@127.0.0.1:18883/oasis_platform'
        with self.assertRaisesRegex(o.p.Refusal,'RUNTIME_CONFIG'):o.owned_resources(self.marker,self.r)

class Archives(unittest.TestCase):
    def archive(self,root,names):
        file=root/'private.tar.gz'
        with tarfile.open(file,'w:gz') as tar:
            for name,kind in names:
                import io
                member=tarfile.TarInfo(name);member.mode=0o600;member.size=32 if name.endswith('master.key') else 4
                if kind=='symlink':member.type=tarfile.SYMTYPE;member.linkname='/opt/oasis/private/state/master.key';member.size=0
                tar.addfile(member,io.BytesIO(b'x'*member.size) if member.isfile() else None)
        return file
    def test_real_known_archive_extracts_only_master(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=self.archive(root,[(n,'file') for n in o.ARCHIVE_MEMBERS]);dest=root/'key'
            with patch.object(o.p.os,'fchown'):o.extract_master(file,dest)
            self.assertEqual(dest.read_bytes(),b'x'*32);self.assertEqual(set(x.name for x in root.iterdir()),{'private.tar.gz','key'})
    def test_link_archive_refused_without_extract(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);names=[(n,'symlink' if n.endswith('master.key') else 'file') for n in o.ARCHIVE_MEMBERS]
            file=self.archive(root,names)
            with self.assertRaisesRegex(o.p.Refusal,'ARCHIVE'):o.extract_master(file,root/'key')
            self.assertFalse((root/'key').exists())
    def test_unknown_backup_archive_member_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=self.archive(root,[(n,'file') for n in o.ARCHIVE_MEMBERS]+[('../private/runtime.env','file')])
            with self.assertRaisesRegex(o.p.Refusal,'ARCHIVE'):o.extract_master(file,root/'key')

class RestoreCleanup(unittest.TestCase):
    def scenario(self,*,restore_failure=False,active=0,replaced=False,existing=False,unknown_create=False,archive_failure=False):
        self.calls=[]
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);backup=root/'backup';backup.mkdir();(backup/'database.dump').write_bytes(b'PGDMPdata')
            marker={'release':str(root),'container_id':'c'*64,'owner':'a'*32,'manifest_sha256':'f'*64}
            identity={'master_key_sha256':p.digest(b'x'*32)}
            db_created=False
            def sql(runtime,mark,database,body):
                nonlocal db_created
                self.calls.append(body)
                if body.startswith('CREATE'):
                    db_created=True
                    if unknown_create:raise o.p.Refusal('CREATE_INTERRUPTED')
                    return ''
                if 'DROP DATABASE' in body:db_created=False;return ''
                if 'json_build_object' in body:return json.dumps({'oid':8 if replaced else 7,'active':active})
                if 'SELECT oid' in body:return '7' if db_created or existing else ''
                if body=='INSPECT':return json.dumps({'keys':['encrypted']})+'\n'+json.dumps({'database':database})
                raise AssertionError('Unknown fixture SQL')
            class Runtime:
                def command(self,args,**kw):
                    if 'pg_restore' in args:
                        if restore_failure:raise o.p.Refusal('RESTORE_INTERRUPTED')
                        return b''
                    if args[-1]=='sql':return 'INSPECT'
                    return json.dumps({'environment':'production','master_key_sha256':identity['master_key_sha256']})
            def extract(archive,destination):
                if archive_failure:raise o.p.Refusal('ARCHIVE_INVALID')
                with patch.object(o.p.os,'fchown'):o.p.exclusive(destination,b'x'*32)
            with patch.object(o,'owned_resources'),patch.object(o,'validate_backup',return_value=identity),patch.object(o,'extract_master',side_effect=extract),patch.object(o,'sql',side_effect=sql),patch.object(o.p,'PRIVATE',root),patch.object(o.p,'no_mount'),patch.object(o.p.os,'fchown'):
                result=o.restore(marker,backup,Runtime())
            return result,db_created
    def test_actual_restore_success_drops_own_oid(self):
        value,present=self.scenario();self.assertTrue(value['passed']);self.assertFalse(present);self.assertTrue(value['cleanup']['database_removed']);self.assertTrue(value['cleanup']['temporary_removed'])
    def test_restore_failure_still_drops_own_database(self):
        value,present=self.scenario(restore_failure=True);self.assertFalse(value['passed']);self.assertFalse(present);self.assertTrue(value['cleanup']['database_removed'])
    def test_foreign_existing_database_never_touched(self):
        value,present=self.scenario(existing=True);self.assertFalse(value['passed']);self.assertFalse(any(x.startswith(('CREATE','DROP')) for x in self.calls))
    def test_active_consumer_prevents_force_drop(self):
        value,present=self.scenario(active=1);self.assertFalse(value['passed']);self.assertTrue(present);self.assertFalse(any(x.startswith('DROP') for x in self.calls))
    def test_replaced_oid_not_dropped(self):
        value,present=self.scenario(replaced=True);self.assertFalse(value['passed']);self.assertTrue(present);self.assertFalse(any(x.startswith('DROP') for x in self.calls))
    def test_unconfirmed_create_not_guessed_or_dropped(self):
        value,present=self.scenario(unknown_create=True);self.assertFalse(value['passed']);self.assertTrue(present);self.assertEqual(value['cleanup_error'],'PRODUCTION_RESTORE_CREATE_UNCONFIRMED');self.assertFalse(any(x.startswith('DROP') for x in self.calls))
    def test_unsafe_archive_removes_empty_owned_temporary(self):
        value,present=self.scenario(archive_failure=True);self.assertFalse(value['passed']);self.assertFalse(present);self.assertTrue(value['cleanup']['temporary_removed']);self.assertFalse(any(x.startswith('CREATE') for x in self.calls))

class PersistentDBus(unittest.TestCase):
    def fake(self,fail=False,wrong_path=False):
        events=[]
        class String(str):pass
        class ObjectPath(str):pass
        class Boolean(int):pass
        class UInt64(int):pass
        class UInt32(int):pass
        class Int32(int):pass
        class Array(list):
            def __init__(self,values=(),signature='s'):super().__init__(values);self.signature=signature
        class Struct(tuple):pass
        module=types.SimpleNamespace(String=String,ObjectPath=ObjectPath,Boolean=Boolean,UInt64=UInt64,UInt32=UInt32,Int32=Int32,Array=Array,Struct=Struct)
        class Manager:
            def RefUnit(self,name,**kw):events.append('ref')
            def GetUnit(self,name,**kw):
                if events!=['ref']:raise AssertionError('GC window without ref')
                events.append('get');return ObjectPath('/wrong' if wrong_path else p.unit_object_path(name))
            def UnrefUnit(self,name,**kw):events.append('unref')
        class Props:
            def Get(self,interface,key,**kw):
                if key=='NeedDaemonReload':return Boolean(0)
                if key in ('PartOf','BindsTo','DropInPaths'):return Array()
                if fail:raise RuntimeError('transport')
                if key=='ExecStop':
                    return Array([Struct((String('/usr/bin/docker'),Array([String(x) for x in ['/usr/bin/docker','stop','--time','30','c'*64]]),Boolean(0),UInt64(1),UInt64(2),UInt64(3),UInt64(4),UInt32(5),Int32(0),Int32(0)))],'(sasbttttuii)')
                return Array([], '(sasbttttuii)')
        class Bus:
            def __init__(self,**kw):events.append('connect')
            def get_object(self,destination,name):return 'manager' if name=='/org/freedesktop/systemd1' else 'props'
            def close(self):events.append('close')
        # GetUnit requires ref first on this persistent connection; omit connect in protocol list.
        module.SystemBus=lambda **kw:Bus()
        manager=Manager();module.Interface=lambda obj,interface:manager if obj=='manager' else Props()
        original_get=manager.GetUnit
        def get(name,**kw):
            self.assertEqual(events,['connect','ref']);events.remove('connect');return original_get(name,**kw)
        manager.GetUnit=get
        return module,events
    def test_reference_first_typed_commands_history_removed(self):
        module,events=self.fake()
        with patch.dict(sys.modules,{'dbus':module}):value=p.Runtime().loaded_commands('oasis-production-db.service')
        self.assertEqual(events,['ref','get','unref','close']);self.assertEqual(value['ExecStop'],[['/usr/bin/docker',['/usr/bin/docker','stop','--time','30','c'*64],False]])
    def test_property_failure_always_unrefs_closes(self):
        module,events=self.fake(fail=True)
        with patch.dict(sys.modules,{'dbus':module}),self.assertRaises(RuntimeError):p.Runtime().loaded_commands('oasis-production-db.service')
        self.assertEqual(events[-2:],['unref','close'])
    def test_wrong_dbus_object_identity_refused(self):
        module,events=self.fake(wrong_path=True)
        with patch.dict(sys.modules,{'dbus':module}),self.assertRaisesRegex(p.Refusal,'IDENTITY'):p.Runtime().loaded_commands('oasis-production-db.service')
        self.assertEqual(events[-2:],['unref','close'])

if __name__=='__main__':unittest.main()

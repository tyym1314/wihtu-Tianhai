"""Adversarial real temp-FS/archive/FD checks; no server or device actions."""
import copy
from contextlib import contextmanager
import datetime as dt
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('retire_owned_test',Path(__file__).with_name('retire-mock-sources.py'))
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)

@contextmanager
def root_authority_fixture(root):
    """Model root ownership only; real inode/FD/body/mode/race operations remain actual."""
    native_lstat=os.lstat;native_fstat=os.fstat
    def owned(s,path=None):
        values={key:getattr(s,key) for key in t.HeldFile.fields};values['st_uid']=0
        if path is not None and not Path(path).is_relative_to(root):values['st_mode']=s.st_mode & ~0o022
        return SimpleNamespace(**values)
    with patch.object(t.os,'lstat',side_effect=lambda path,*args,**kwargs:owned(native_lstat(path,*args,**kwargs),path)),patch.object(t.os,'fstat',side_effect=lambda fd:owned(native_fstat(fd))):yield

def tree(root):
    with patch.object(t,'no_mount'):return t.tree_snapshot(root)
def archive(path,root,*,mutate=None):
    data=tree(root)
    with tarfile.open(path,'w:gz',format=tarfile.PAX_FORMAT) as tar:
        for name,pin in data['entries'].items():
            member=tarfile.TarInfo(root.name if name=='.' else root.name+'/'+name);member.uid=pin['uid'];member.gid=pin['gid'];member.mode=pin['mode'];member.mtime=pin['mtime_ns']/1e9;member.pax_headers={'mtime':str(t.Decimal(pin['mtime_ns'])/1000000000)}
            body=None
            if pin['kind']=='directory':member.type=tarfile.DIRTYPE
            elif pin['kind']=='symlink':member.type=tarfile.SYMTYPE;member.linkname=pin['target']
            else:member.size=pin['bytes'];body=(root/name).read_bytes()
            if mutate:body=mutate(member,body)
            tar.addfile(member,io.BytesIO(body) if body is not None else None)
    path.chmod(0o600);return data
class LinuxXattrFixture(unittest.TestCase):
    def setUp(self):
        # macOS's Python lacks Linux listxattr; this test protocol deliberately
        # models empty Linux xattrs. The actual remote before/after uses Linux.
        self.xattrs=patch.object(t.os,'listxattr',return_value=[],create=True);self.xattrs.start();self.addCleanup(self.xattrs.stop)
class FilesystemArchive(LinuxXattrFixture):
    def fixture(self,temp):
        root=Path(temp)/t.ALLOW[0];root.mkdir();(root/'platform').mkdir();(root/'platform/node_modules').mkdir();(root/'platform/node_modules/code.js').write_bytes(b'official recovery body\n'*9);(root/'platform/node_modules/tool').symlink_to('code.js');(root/'RELEASE-MANIFEST.json').write_text('{"files":{}}');return root
    def test_entire_real_archive_and_internal_dependency_link_preserve_every_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.fixture(temp);path=Path(temp)/'source.tar.gz';expected=archive(path,root);proof=t.verify_archive(path,t.ALLOW[0],expected)
            self.assertEqual(proof['entry_count'],len(expected['entries']));self.assertEqual(proof['archive_sha256'],t.file_digest(path));self.assertTrue(proof['full_gzip_eof_verified']);self.assertTrue((root/'platform/node_modules/code.js').exists())
    def test_body_mode_unknown_entry_link_device_and_traversal_refused(self):
        for kind in ('body','mode','unknown','link','device','traversal'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                root=self.fixture(temp);path=Path(temp)/'source.tar.gz'
                def mutate(member,body):
                    if member.name.endswith('code.js'):
                        if kind=='body':return b'x'*member.size
                        if kind=='mode':member.mode=0o777
                        if kind=='unknown':member.name=root.name+'/unknown.js'
                        if kind=='device':member.type=tarfile.CHRTYPE;member.size=0;return None
                        if kind=='traversal':member.name=root.name+'/../../private/master.key'
                    if kind=='link' and member.issym():member.linkname='../../../../../private/master.key'
                    return body
                expected=archive(path,root,mutate=mutate)
                with self.assertRaises(t.Refusal):t.verify_archive(path,t.ALLOW[0],expected)
    def test_duplicate_missing_or_hidden_trailing_member_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.fixture(temp);good=Path(temp)/'good.tar.gz';expected=archive(good,root)
            for kind in ('duplicate','missing','trailing'):
                path=Path(temp)/(kind+'.tar.gz')
                with tarfile.open(good,'r:gz') as source,tarfile.open(path,'w:gz',format=tarfile.PAX_FORMAT) as output:
                    for member in source:
                        if kind=='missing' and member.issym():continue
                        body=source.extractfile(member).read() if member.isfile() else None;output.addfile(member,io.BytesIO(body) if body is not None else None)
                        if kind=='duplicate' and member.issym():output.addfile(member)
                if kind=='trailing':
                    raw=gzip.decompress(path.read_bytes());path.write_bytes(gzip.compress(raw+b'not a tar member'+b'\0'*2048))
                path.chmod(0o600)
                with self.subTest(kind=kind),self.assertRaises(t.Refusal):t.verify_archive(path,t.ALLOW[0],expected)
    def test_gzip_footer_crc_and_truncation_do_not_count_as_complete_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.fixture(temp);good=Path(temp)/'good.tar.gz';expected=archive(good,root);original=good.read_bytes()
            for name,raw in [('truncated',original[:-8]),('crc',original[:-8]+bytes([original[-8]^255])+original[-7:])]:
                path=Path(temp)/name;path.write_bytes(raw);path.chmod(0o600)
                with self.subTest(name=name),self.assertRaises((t.Refusal,OSError,EOFError)):t.verify_archive(path,t.ALLOW[0],expected)
    def test_symlink_escape_hardlink_private_paths_and_mounts_refused_before_archive(self):
        for kind in ('absolute','escape','hardlink','private','mount'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                root=self.fixture(temp)
                if kind=='absolute':(root/'absolute').symlink_to('/etc/passwd')
                if kind=='escape':(root/'escape').symlink_to('../foreign');(root.parent/'foreign').write_text('foreign')
                if kind=='hardlink':os.link(root/'platform/node_modules/code.js',root/'hardlink')
                if kind=='private':(root/'runtime.env').write_text('secret must never be archived')
                if kind=='mount':
                    info=Path(temp)/'mountinfo';info.write_text('1 2 0:1 / '+str(root)+'/platform rw - ext4 /dev/mock rw\n')
                    with self.assertRaisesRegex(t.Refusal,'MOUNT'):t.tree_snapshot(root,mountinfo=info)
                else:
                    with self.assertRaises(t.Refusal):tree(root)
    def test_during_hash_replacement_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.fixture(temp);native=t.file_digest
            def mutate(path):
                value=native(path)
                if path.name=='code.js':path.write_text('changed while hash was read')
                return value
            with patch.object(t,'no_mount'),patch.object(t,'file_digest',side_effect=mutate),self.assertRaisesRegex(t.Refusal,'CHANGED_DURING_READ'):t.tree_snapshot(root)

class LockAndDelete(LinuxXattrFixture):
    def test_original_lock_fd_cannot_adopt_replaced_path_or_contending_descriptor(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'lock';path.write_bytes(b'');path.chmod(0o600);expected=t.metadata(path)
            with t.locked(path,expected) as fd:
                with self.assertRaises(BlockingIOError):
                    with t.locked(path,expected):pass
                path.rename(Path(temp)/'oldlock');path.write_bytes(b'');path.chmod(0o600)
                with self.assertRaisesRegex(t.Refusal,'LOCK_REPLACED'):t.lock_guard(fd,path,expected)
    def test_exact_tree_deletion_preserves_other_releases_private_key_and_link_target(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);releases=base/'releases';releases.mkdir();selected=releases/t.ALLOW[0];selected.mkdir();(selected/'nested').mkdir();(selected/'nested/file').write_text('source');(selected/'nested/link').symlink_to('file')
            public=releases/'20261009-03';public.mkdir();(public/'keep').write_text('public');private=base/'private';private.mkdir();key=private/'master.key';key.write_text('private retained')
            expected=tree(selected)
            with patch.object(t,'BASE',base),patch.object(t,'no_mount'):t.remove_bound_tree(selected,expected)
            self.assertFalse(selected.exists());self.assertEqual((public/'keep').read_text(),'public');self.assertEqual(key.read_text(),'private retained')
    def test_unknown_or_changed_entry_and_foreign_target_never_deleted(self):
        for kind in ('changed','unknown','foreign'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                base=Path(temp);releases=base/'releases';releases.mkdir();root=releases/(t.ALLOW[0] if kind!='foreign' else '20261009-03');root.mkdir();file=root/'file';file.write_text('old');expected=tree(root)
                if kind=='changed':file.write_text('new')
                if kind=='unknown':(root/'unknown').write_text('new')
                with patch.object(t,'BASE',base),patch.object(t,'no_mount'),self.assertRaises(t.Refusal):t.remove_bound_tree(root,expected)
                self.assertTrue(file.exists())
    def test_apply_holds_both_original_locks_and_reports_partial_failure_honestly(self):
        for failure in (False,True):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as temp:
                base=Path(temp);(base/'releases').mkdir();roots={}
                for name in t.ALLOW:
                    root=base/'releases'/name;root.mkdir();(root/'code').write_text(name);roots[name]=tree(root)
                global_lock=base/'release.lock';ops_lock=base/'operations.lock'
                for lock in (global_lock,ops_lock):lock.write_bytes(b'');lock.chmod(0o600)
                snapshot={'locks':{'global':t.metadata(global_lock),'operations':t.metadata(ops_lock)}};inventory={'snapshot':snapshot,'source_commit':'a'*40,'historical_inventory':{'path':'original','sha256':'b'*64}};proof={'trees':roots,'archives':{name:{'archive_sha256':'c'*64,'archive_bytes':19} for name in t.ALLOW}};capsule={'kind':'mock-source-retirement-check-v1','passed':True,'at':t.now(),'snapshot':snapshot};count=0
                authority=SimpleNamespace(bindings={'check_sha256':'d'*64},recheck=lambda:None)
                def guard(*args):
                    nonlocal count;count+=1
                    for lock in (global_lock,ops_lock):
                        with self.assertRaises(BlockingIOError):
                            with t.locked(lock,t.metadata(lock)):pass
                    if failure and count==2:raise t.Refusal('SOURCE_REACTIVATED')
                    return snapshot
                runtime=SimpleNamespace(Runtime=lambda:None);report=base/'retirement-result.json'
                with patch.object(t,'BASE',base),patch.object(t,'TASK',base),patch.object(t,'trusted_parents',side_effect=lambda path,**kwargs:Path(path)),patch.object(t,'GLOBAL_LOCK',global_lock),patch.object(t,'OPERATIONS_LOCK',ops_lock),patch.object(t,'no_mount'),patch.object(t,'check',return_value=capsule),patch.object(t,'protection_snapshot',side_effect=guard),patch.object(t,'consumer_snapshot',return_value={}):result=t.apply(inventory,{},proof,capsule,runtime,None,report,authority)
                saved=json.loads(report.read_text());self.assertEqual(saved,result);self.assertEqual(result['passed'],not failure);self.assertEqual(result['removed'],list(t.ALLOW) if not failure else [t.ALLOW[0]])
                if failure:self.assertTrue((base/'releases'/t.ALLOW[1]/'code').exists())
    def test_stale_failed_or_changed_check_never_reaches_deletion(self):
        for capsule in [{'at':(dt.datetime.now(dt.timezone.utc)-dt.timedelta(minutes=11)).isoformat(),'kind':'mock-source-retirement-check-v1','passed':True},{'at':t.now(),'kind':'mock-source-retirement-check-v1','passed':False}]:
            with patch.object(t,'remove_bound_tree') as mutation,self.assertRaises(t.Refusal):t.apply({'snapshot':{}},{},{},capsule,None,None,Path('/never/report'),SimpleNamespace(recheck=lambda:None))
            mutation.assert_not_called()

class ConsumersAndAuthority(unittest.TestCase):
    def test_pure_replacement_requires_entire_external_receipt_check_recovery_chain(self):
        obsolete=[str(t.BASE/'releases'/name/'RELEASE-MANIFEST.json') for name in t.ALLOW]
        kept=[path for path in t.ORIGINAL_PATHS if path not in obsolete];original=str(t.ORIGINAL_INVENTORY_PATH)
        external={'historical_inventory_sha256':t.ORIGINAL_INVENTORY_SHA,'inventory_sha256':'2'*64,'retirement_receipt_sha256':'3'*64,'check_sha256':'4'*64,
                  'archive_proof_sha256':t.ARCHIVE_PROOF_SHA,'root_independent_archive_review_sha256':t.ROOT_ARCHIVE_REVIEW_SHA,'tool_sha256':'5'*64,'source_audit_sha256':t.SOURCE_AUDIT_SHA}
        prior={'kind':'production-protected-inventory','paths':list(t.ORIGINAL_PATHS),'snapshot':{'files':{str(t.PUBLIC_PRIVATE_PARENT):{**t.PUBLIC_PRIVATE_PARENT_IDENTITY,'kind':'directory'}}}};inventory={'protected_paths':[*kept,original],'historical_inventory':{'path':original,'sha256':t.ORIGINAL_INVENTORY_SHA,'obsolete_paths':obsolete},
                    'source_commit':'a'*40,'source_audit_sha256':t.SOURCE_AUDIT_SHA,'archive_proof_sha256':t.ARCHIVE_PROOF_SHA,
                    'root_independent_archive_review':{'path':'/opt/oasis/private/review.json','sha256':t.ROOT_ARCHIVE_REVIEW_SHA},'snapshot':{'actual':'modeled-unit-fixture'}}
        proof={'trees':{name:{'entry_count':9571,'total_file_bytes':357000000,'entries_sha256':'6'*64,'entries':{'.':{'inode':t.ROOT_INODES[name]},'RELEASE-MANIFEST.json':{'sha256':t.MANIFESTS[name]}}} for name in t.ALLOW},'archives':{name:{'archive_sha256':'7'*64,'archive_bytes':225000000} for name in t.ALLOW}}
        review={'kind':'root-independent-mock-archive-review-v1','passed':True,'proof_sha256':t.ARCHIVE_PROOF_SHA,'archives':{name:{'archive_sha256':'7'*64,'archive_bytes':225000000,'members':9571,'file_bytes':357000000,'source_tree_sha256':'6'*64,'full_body_and_metadata_verified':True,'gzip_eof_crc_and_exact_zero_tail_verified':True} for name in t.ALLOW}}
        bindings={k:v for k,v in external.items() if k!='retirement_receipt_sha256'}
        capsule={'kind':'mock-source-retirement-check-v1','passed':True,'source_commit':'a'*40,'external_bindings':{k:v for k,v in bindings.items() if k!='check_sha256'},
                 'inventory_canonical_json_sha256':t.digest_bytes(t.canonical(inventory)),'archive_proof_canonical_json_sha256':t.digest_bytes(t.canonical(proof)),
                 'snapshot':inventory['snapshot'],'trees':proof['trees']}
        receipt={'kind':'mock-source-retirement-result-v1','passed':True,'removed':list(t.ALLOW),'all_obsolete_sources_absent':True,
                 'obsolete_sources':[str(t.BASE/'releases'/name) for name in t.ALLOW],'manifest_sha256':t.MANIFESTS,'external_bindings':bindings,'source_commit':'a'*40,
                 'archive_proof_canonical_json_sha256':t.digest_bytes(t.canonical(proof)),'check_canonical_json_sha256':t.digest_bytes(t.canonical(capsule)),
                 'historical_inventory':inventory['historical_inventory'],'reviewed_snapshot_sha256':t.digest_bytes(t.canonical(inventory['snapshot'])),
                 'sources':{name:{'manifest_sha256':t.MANIFESTS[name],'tree_sha256':'6'*64,'archive_sha256':'7'*64,'archive_bytes':225000000} for name in t.ALLOW},'at':t.now(),'finished_at':t.now()}
        result=t.validate_retirement_replacement(prior,inventory,receipt,capsule,proof,review,external_sha256=external)
        self.assertEqual(len(result['retained_paths']),19);self.assertEqual(result['obsolete_manifest_paths'],obsolete)
        # This unit models independent raw pins; the caller's actual raw FD
        # hashing and root approval are intentionally outside this pure policy.
        def verify(i=inventory,r=receipt,c=capsule,p=proof,v=review,e=external):return t.validate_retirement_replacement(prior,i,r,c,p,v,external_sha256=e)
        for field,value in [('passed',False),('removed',[t.ALLOW[0]]),('all_obsolete_sources_absent',False),('source_commit','b'*40),('check_canonical_json_sha256','0'*64)]:
            changed=copy.deepcopy(receipt);changed[field]=value
            with self.subTest(field=field),self.assertRaises(t.Refusal):verify(r=changed)
        changed=copy.deepcopy(receipt);changed['external_bindings']['archive_proof_sha256']=t.digest_bytes(t.canonical(proof))
        with self.assertRaises(t.Refusal):verify(r=changed)
        changed=copy.deepcopy(proof);changed['trees'][t.ALLOW[0]]['entries']['.']['inode']+=1
        with self.assertRaises(t.Refusal):verify(p=changed)
        changed=copy.deepcopy(inventory);changed['protected_paths'].remove(kept[0])
        with self.assertRaises(t.Refusal):verify(i=changed)
        changed=copy.deepcopy(external);changed['root_independent_archive_review_sha256']='0'*64
        with self.assertRaises(t.Refusal):verify(e=changed)
    def test_original_inventory_only_explicit_two_obsolete_paths_can_be_replaced(self):
        obsolete=[str(t.BASE/'releases'/name/'RELEASE-MANIFEST.json') for name in t.ALLOW];kept=['/opt/oasis/private/state/master.key','/opt/oasis/private/postgres.env','/opt/oasis/releases/20261009-03/RELEASE-MANIFEST.json']
        prior={'paths':[*kept,*obsolete]};path='/opt/oasis/private/original-reviewed-inventory.json';inventory={'protected_paths':[*kept,path],'historical_inventory':{'path':path,'obsolete_paths':obsolete}}
        self.assertEqual(t.retained_protection_paths(prior,inventory),inventory['protected_paths'])
        for mutate in [lambda value:value['protected_paths'].remove(kept[0]),lambda value:value['historical_inventory']['obsolete_paths'].append(kept[0]),lambda value:value['protected_paths'].append(obsolete[0]),lambda value:value['protected_paths'].remove(path)]:
            current=copy.deepcopy(inventory);mutate(current)
            with self.assertRaisesRegex(t.Refusal,'SILENTLY_DROPPED'):t.retained_protection_paths(prior,current)
    def test_all_consumer_types_and_external_release_dependency_alias_refuse(self):
        class Runtime:
            kind='none'
            def command(self,args,**kw):
                if args[:3]==['docker','container','ls']:return 'container' if self.kind=='docker' else ''
                if args[:2]==['systemctl','list-units']:return 'oasis-api.service loaded active running\n'
                if args[:2]==['systemctl','show']:return '/opt/oasis/releases/20261008-23/code' if self.kind=='unit' else 'no obsolete references'
                if args[:2]==['docker','exec']:return '/etc/nginx/obsolete.conf' if self.kind=='proxy' else ''
                raise AssertionError(args)
            def inspect(self,kind,name):return {'Id':'container','Mounts':[{'Source':'/opt/oasis/releases/20261008-23'}] if self.kind=='docker' else [],'Config':{}}
        runtime=Runtime()
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);(base/'releases').mkdir();proc=base/'proc';proc.mkdir();configs=base/'configs';configs.mkdir();roots=[Path('/opt/oasis/releases/'+name) for name in t.ALLOW]
            for kind in ('process','docker','unit','proxy','config','alias'):
                runtime.kind=kind;file=configs/'site';file.write_text(str(roots[0]) if kind=='config' else 'ordinary config')
                alias=base/'alias'
                if alias.is_symlink():alias.unlink()
                if kind=='alias':alias.symlink_to(roots[0])
                with self.subTest(kind=kind),patch.object(t,'BASE',base),patch.object(t,'process_consumers',return_value=[{'pid':'1','kind':'maps'}] if kind=='process' else []),self.assertRaisesRegex(t.Refusal,'HAS_CONSUMER'):t.consumer_snapshot(runtime,roots,proc,(configs,))
    def test_external_document_hash_and_root_mode_are_required_not_self_asserted(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();file=root/'input.json';file.write_text('{"approved":true}');file.chmod(0o600)
            with root_authority_fixture(root),patch.object(t,'TASK',root):
                self.assertEqual(t.read_json_pinned(file,t.file_digest(file)),{'approved':True})
                with self.assertRaisesRegex(t.Refusal,'EXTERNAL_PIN'):t.read_json_pinned(file,'0'*64)
                file.chmod(0o644)
                with self.assertRaisesRegex(t.Refusal,'EXTERNAL_PIN'):t.read_json_pinned(file,t.file_digest(file))

class RetainedAuthority(unittest.TestCase):
    def test_parent_exception_requires_fixed_original20_raw_pin_and_complete_retained_protection(self):
        obsolete={str(t.BASE/'releases'/name/'RELEASE-MANIFEST.json') for name in t.ALLOW}
        prior={'kind':'production-protected-inventory','paths':list(t.ORIGINAL_PATHS),'snapshot':{'files':{str(t.PUBLIC_PRIVATE_PARENT):{**t.PUBLIC_PRIVATE_PARENT_IDENTITY,'kind':'directory'}}}}
        inventory={'historical_inventory':{'path':str(t.ORIGINAL_INVENTORY_PATH),'sha256':t.ORIGINAL_INVENTORY_SHA},
                   'protected_paths':[path for path in t.ORIGINAL_PATHS if path not in obsolete]+[str(t.ORIGINAL_INVENTORY_PATH)]}
        t.authorize_original_parent(prior,inventory)
        for field,value in [('path','/opt/oasis/private/foreign-inventory.json'),('sha256','0'*64)]:
            changed=copy.deepcopy(inventory);changed['historical_inventory'][field]=value
            with self.subTest(field=field),self.assertRaises(t.Refusal):t.authorize_original_parent(prior,changed)
        for field,value in [('inode',934466),('uid',0),('gid',0),('mode',0o755),('device',1)]:
            changed=copy.deepcopy(prior);changed['snapshot']['files'][str(t.PUBLIC_PRIVATE_PARENT)][field]=value
            with self.subTest(field=field),self.assertRaises(t.Refusal):t.authorize_original_parent(changed,inventory)
        for path in (str(t.PUBLIC_PRIVATE_PARENT),'/opt/oasis/private/state/master.key','/opt/oasis/private/postgres.env',str(t.ORIGINAL_INVENTORY_PATH)):
            changed=copy.deepcopy(inventory);changed['protected_paths'].remove(path)
            with self.subTest(path=path),self.assertRaises(t.Refusal):t.authorize_original_parent(prior,changed)
        changed=copy.deepcopy(prior);changed['paths'].remove('/opt/oasis/private/state/master.key')
        with self.assertRaises(t.Refusal):t.authorize_original_parent(changed,inventory)
    def test_only_exact_protected_public_private_parent_identity_is_an_exception(self):
        expected=t.PUBLIC_PRIVATE_PARENT_IDENTITY
        actual=SimpleNamespace(st_uid=expected['uid'],st_gid=expected['gid'],st_mode=0o40700,st_dev=expected['device'],st_ino=expected['inode'])
        self.assertTrue(t.parent_identity_allowed(t.PUBLIC_PRIVATE_PARENT,actual))
        for field,value in [('st_uid',0),('st_uid',999),('st_gid',999),('st_mode',0o40755),('st_mode',0o120700),('st_dev',1),('st_ino',expected['inode']+1)]:
            changed=SimpleNamespace(**vars(actual));setattr(changed,field,value)
            with self.subTest(field=field,value=value):self.assertFalse(t.parent_identity_allowed(t.PUBLIC_PRIVATE_PARENT,changed))
        for path in ('/opt/oasis/private-other','/opt/foreign/private','/opt/oasis/private/child','/opt/oasis/private/../private'):
            with self.subTest(path=path):self.assertFalse(t.parent_identity_allowed(Path(path),actual))
        root=SimpleNamespace(st_uid=0,st_gid=0,st_mode=0o40755,st_dev=1,st_ino=1)
        self.assertTrue(t.parent_identity_allowed(Path('/opt/oasis'),root))
        root.st_mode=0o40777;self.assertFalse(t.parent_identity_allowed(Path('/opt/oasis'),root))
    def test_original_fd_refuses_same_byte_replacement_and_in_place_change(self):
        for kind in ('same-bytes-new-inode','new-bytes-original-inode'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                root=Path(temp).resolve();file=root/'approved.json';file.write_bytes(b'{"approved":true}');file.chmod(0o600)
                with root_authority_fixture(root),t.HeldFile(file,t.file_digest(file),private=True,private_root=root) as held:
                    original=held.identity['st_ino']
                    if kind=='same-bytes-new-inode':file.rename(root/'prior.json');file.write_bytes(held.body);file.chmod(0o600);self.assertNotEqual(os.stat(file).st_ino,original)
                    else:file.write_bytes(b'{"approved":null}');self.assertEqual(os.stat(file).st_ino,original)
                    with self.assertRaisesRegex(t.Refusal,'AUTHORITY_'):held.recheck()
    def test_private_parent_symlink_writable_and_same_inode_leaf_in_replaced_parent_refuse(self):
        for kind in ('symlink','writable','replacement'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                root=Path(temp).resolve();task=root/'task';task.mkdir(mode=0o700);file=task/'approved.json';file.write_bytes(b'{}');file.chmod(0o600)
                with root_authority_fixture(root):
                    if kind=='symlink':alias=root/'alias';alias.symlink_to(task);candidate=alias/'approved.json'
                    else:candidate=file
                    if kind=='writable':task.chmod(0o777)
                    if kind!='replacement':
                        with self.assertRaisesRegex(t.Refusal,'PARENT'):t.HeldFile(candidate,t.file_digest(file),private=True,private_root=candidate.parent)
                    else:
                        with t.HeldFile(candidate,t.file_digest(file),private=True,private_root=task) as held:
                            task.rename(root/'oldtask');task.mkdir(mode=0o700);(root/'oldtask/approved.json').rename(file)
                            self.assertEqual(os.stat(file).st_ino,held.identity['st_ino'])
                            with self.assertRaisesRegex(t.Refusal,'PARENT_REPLACED'):held.recheck()
    def test_raw_source_compilation_ignores_poisoned_pyc_and_injects_exact_bound_provision(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();file=root/'operations.py'
            file.write_text("import importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('oasis_provision',Path(__file__).with_name('provision.py'))\np=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)\nvalue=p.identity\n")
            file.chmod(0o600);(root/'__pycache__').mkdir();(root/'__pycache__/operations.cpython-313.pyc').write_bytes(b'poisoned bytecode never read')
            native_import=__import__('importlib.util',fromlist=['util'])
            with root_authority_fixture(root),t.HeldFile(file,t.file_digest(file)) as held,patch.object(native_import,'spec_from_file_location',side_effect=AssertionError('loader forbidden')),patch.object(native_import,'module_from_spec',side_effect=AssertionError('loader forbidden')):
                module=t.module_from_held(held,'actual_raw_fixture',provision=SimpleNamespace(identity='approved-original-source'))
                self.assertEqual(module.value,'approved-original-source')
                replacement=file.read_text().replace("'oasis_provision'","'unapproved_provision'");file.write_text(replacement);file.chmod(0o600)
            with root_authority_fixture(root),t.HeldFile(file,t.file_digest(file)) as changed,self.assertRaisesRegex(t.Refusal,'LOADER_SHAPE'):t.module_from_held(changed,'changed_fixture',provision=SimpleNamespace(identity='approved'))
    def test_other_top_level_loader_is_refused_before_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();file=root/'unsafe.py';file.write_text('import importlib.util\nspec=importlib.util.spec_from_file_location("unapproved","/unapproved/foreign.py")\n');file.chmod(0o600)
            with root_authority_fixture(root),t.HeldFile(file,t.file_digest(file)) as held,self.assertRaisesRegex(t.Refusal,'UNBOUND_TOPLEVEL'):t.module_from_held(held,'unsafe_fixture')
    def test_authority_replacement_prevents_apply_before_lock_or_any_delete(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();file=root/'tool.py';file.write_text('approved tool');file.chmod(0o600)
            with root_authority_fixture(root),t.AuthorityFiles() as authority:
                authority.hold(file,t.file_digest(file),private=True,private_root=root);file.rename(root/'original.py');file.write_text('approved tool');file.chmod(0o600)
                with patch.object(t,'locked') as lock,patch.object(t,'remove_bound_tree') as mutation,self.assertRaisesRegex(t.Refusal,'AUTHORITY_'):t.apply({}, {}, {}, {}, None, None, root/'retirement.json',authority)
                lock.assert_not_called();mutation.assert_not_called();self.assertFalse((root/'retirement.json').exists())
    def test_root_independent_review_exact_archive_tree_body_and_eof_are_required(self):
        proof={'trees':{name:{'entry_count':9571,'total_file_bytes':357000000,'entries_sha256':name*5} for name in t.ALLOW},'archives':{name:{'archive_sha256':name*5,'archive_bytes':225000000} for name in t.ALLOW}}
        review={'kind':'root-independent-mock-archive-review-v1','passed':True,'proof_sha256':t.ARCHIVE_PROOF_SHA,'archives':{name:{'archive_sha256':name*5,'archive_bytes':225000000,'members':9571,'file_bytes':357000000,'source_tree_sha256':name*5,'full_body_and_metadata_verified':True,'gzip_eof_crc_and_exact_zero_tail_verified':True} for name in t.ALLOW}}
        t.validate_root_archive_review(review,proof)
        for field,value in [('passed',False),('proof_sha256','0'*64)]:
            changed=copy.deepcopy(review);changed[field]=value
            with self.assertRaises(t.Refusal):t.validate_root_archive_review(changed,proof)
        for field,value in [('archive_sha256','0'*64),('source_tree_sha256','0'*64),('members',9020),('gzip_eof_crc_and_exact_zero_tail_verified',False)]:
            changed=copy.deepcopy(review);changed['archives'][t.ALLOW[0]][field]=value
            with self.assertRaises(t.Refusal):t.validate_root_archive_review(changed,proof)

if __name__=='__main__':unittest.main()

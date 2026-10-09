#!/usr/bin/env python3
"""Retire only already retired Mock23/24 source after externally reviewed local recovery proof."""
import argparse
import ast
from contextlib import contextmanager, ExitStack
from decimal import Decimal
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import types

ALLOW=('20261008-23','20261008-24')
BASE=Path('/opt/oasis')
TASK=BASE/'private/mock-source-retirement-20261010'
GLOBAL_LOCK=BASE/'private/release.lock'
OPERATIONS_LOCK=BASE/'production-instance-private/operations.lock'
GLOBAL_IDENTITY={'uid':0,'gid':0,'mode':0o644,'device':64515,'inode':956423,'kind':'file','bytes':0,'sha256':hashlib.sha256(b'').hexdigest(),'nlink':1}
MANIFESTS={'20261008-23':'4b224fff7df8a71dc1d24b581159e8351a8581341218045b85a3bf4895982e5c','20261008-24':'3bed7e9ac08c3cab8191e3e936b0769a47aee9b10ce8516276ed567ab9c66536'}
ROOT_INODES={'20261008-23':948678,'20261008-24':949574}
RETIREMENT_SHA='931dfadda3577244b434ee86c74f95cf3e66053362ff61ac10f207d69737c920'
SOURCE_AUDIT_SHA='4f49ee228ee1e753f3cf744bdd98e8d9ca53de8f56ed4a2aefe2d100b889b9bf'
ARCHIVE_PROOF_SHA='6fe2c6b0e4092a779653a6c895f3011b03dd54c9e46f16e6757ce2a4149e03bf'
ROOT_ARCHIVE_REVIEW_SHA='ffde3575ca87dc950bdb1a696f365993491117203a79c0f31d67059107edbd5e'
PRODUCTION_UNITS={'oasis-production-db.service','oasis-production-api.service','oasis-production-instance-backup.service','oasis-production-instance-backup.timer','oasis-production-instance-monitor.service','oasis-production-instance-monitor.timer','oasis-production-player-certificate.service','oasis-production-player-certificate.timer'}
PUBLIC_PRIVATE_PARENT=BASE/'private'
PUBLIC_PRIVATE_PARENT_IDENTITY={'uid':998,'gid':998,'mode':0o700,'device':64515,'inode':934465}
ORIGINAL_INVENTORY_PATH=PUBLIC_PRIVATE_PARENT/'production-stage-20261010-v2/protected-reviewed.json'
ORIGINAL_INVENTORY_SHA='ac5c5769946b8ea08695c56d0106bb6c8d1f562b9e7ec152f3e83fb05375eeac'
ORIGINAL_PATHS=(
 '/opt/oasis/current','/opt/oasis/private','/opt/oasis/private/runtime.env','/opt/oasis/private/state/master.key',
 '/opt/oasis/private/postgres.env','/opt/oasis/private/release.lock','/opt/oasis/private/last-release.json',
 '/opt/oasis/private/static-assets-head.json','/etc/nginx/conf.d/oasis.conf','/etc/nginx/conf.d/oasis-android-mock.conf',
 '/opt/oasis/private/mock-retirement-20261010/receipt.json','/opt/oasis/private/mock-retirement-20261010/failed-v5-receipt.json',
 '/opt/oasis/private/mock-retirement-20261010/failed-v6-receipt.json','/opt/oasis/acme/config/live/oasis-android-mock/fullchain.pem',
 '/opt/oasis/acme/config/live/oasis-android-mock/privkey.pem','/opt/oasis/backups/20261009T155133Z',
 '/opt/oasis/releases/20261009-02/RELEASE-MANIFEST.json','/opt/oasis/releases/20261009-03/RELEASE-MANIFEST.json',
 '/opt/oasis/releases/20261008-23/RELEASE-MANIFEST.json','/opt/oasis/releases/20261008-24/RELEASE-MANIFEST.json')

class Refusal(Exception):pass
def require(value,code):
    if not value:raise Refusal(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def digest_bytes(value):return hashlib.sha256(value).hexdigest()
def file_digest(path):
    hasher=hashlib.sha256()
    with open(path,'rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):hasher.update(block)
    return hasher.hexdigest()
def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def fresh(value,seconds=600):
    try:age=(dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(value)).total_seconds()
    except (ValueError,TypeError):raise Refusal('CHECK_TIME_INVALID') from None
    require(0<=age<=seconds,'CHECK_NOT_FRESH')
def metadata(path):
    s=os.lstat(path);kind='file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'special'
    result={'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'device':s.st_dev,'inode':s.st_ino,'kind':kind,'bytes':s.st_size,'nlink':s.st_nlink,'mtime_ns':s.st_mtime_ns,'ctime_ns':s.st_ctime_ns}
    if kind=='file':
        require(s.st_nlink==1,'HARDLINK_REFUSED');result['sha256']=file_digest(path)
    elif kind=='symlink':result['target']=os.readlink(path)
    after=os.lstat(path)
    require(all(getattr(after,key)==getattr(s,key) for key in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')), 'ENTRY_CHANGED_DURING_READ')
    return result
def parent_identity_allowed(parent,s):
    if Path(parent)==PUBLIC_PRIVATE_PARENT:
        expected=PUBLIC_PRIVATE_PARENT_IDENTITY
        return stat.S_ISDIR(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_dev,s.st_ino)==(expected['uid'],expected['gid'],expected['mode'],expected['device'],expected['inode'])
    return stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not stat.S_IMODE(s.st_mode)&0o022
def authorize_original_parent(prior,inventory):
    historical=inventory.get('historical_inventory',{})
    require(historical.get('path')==str(ORIGINAL_INVENTORY_PATH) and historical.get('sha256')==ORIGINAL_INVENTORY_SHA,
            'ORIGINAL_PARENT_AUTHORITY_EXTERNAL_PIN_REQUIRED')
    require(prior.get('kind')=='production-protected-inventory' and prior.get('paths')==list(ORIGINAL_PATHS)
            and prior.get('snapshot',{}).get('files',{}).get(str(PUBLIC_PRIVATE_PARENT))=={**PUBLIC_PRIVATE_PARENT_IDENTITY,'kind':'directory'},
            'ORIGINAL_PARENT_PROTECTION_REQUIRED')
    require(all(path in inventory.get('protected_paths',[]) for path in ORIGINAL_PATHS if not references(path,[BASE/'releases'/name for name in ALLOW]))
            and str(ORIGINAL_INVENTORY_PATH) in inventory.get('protected_paths',[]),'ORIGINAL_PARENT_PROTECTION_REMOVED')
def trusted_parents(path, *, private_root=None):
    path=Path(path);require(path.is_absolute() and '..' not in path.parts,'AUTHORITY_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        s=os.lstat(parent)
        require(parent_identity_allowed(parent,s),'AUTHORITY_PARENT_UNSAFE')
    if private_root is not None:
        root=Path(private_root);s=os.lstat(root)
        require(path.parent==root and stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700
                and (s.st_uid==0 or root==PUBLIC_PRIVATE_PARENT and parent_identity_allowed(root,s)),'AUTHORITY_PRIVATE_PARENT_REQUIRED')
    return path
class HeldFile:
    """Retain the original no-follow FD and verify identity, bytes and parents at every guard."""
    fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
    def __init__(self,path,sha,*,private=False,private_root=None,limit=33554432):
        self.path=trusted_parents(path,private_root=private_root);self.private_root=private_root;self.limit=limit
        self.parent_identity={str(parent):(os.lstat(parent).st_dev,os.lstat(parent).st_ino,os.lstat(parent).st_uid,os.lstat(parent).st_gid,os.lstat(parent).st_mode) for parent in self.path.parents}
        self.fd=os.open(self.path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            before=os.fstat(self.fd)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid==0
                    and not stat.S_IMODE(before.st_mode)&0o022 and 0<=before.st_size<=limit,'AUTHORITY_FILE_UNSAFE')
            if private:require(stat.S_IMODE(before.st_mode)==0o600,'INPUT_EXTERNAL_PIN_MISMATCH')
            self.identity={key:getattr(before,key) for key in self.fields};self.body=self._body()
            self.sha=digest_bytes(self.body);require(self.sha==sha,'INPUT_EXTERNAL_PIN_MISMATCH');self.recheck()
        except BaseException:self.close();raise
    def _body(self):
        os.lseek(self.fd,0,os.SEEK_SET);body=bytearray()
        for block in iter(lambda:os.read(self.fd,65536),b''):
            body.extend(block);require(len(body)<=self.limit,'INPUT_TOO_LARGE')
        return bytes(body)
    def recheck(self):
        trusted_parents(self.path,private_root=self.private_root)
        require(all((os.lstat(parent).st_dev,os.lstat(parent).st_ino,os.lstat(parent).st_uid,os.lstat(parent).st_gid,os.lstat(parent).st_mode)==pin
                    for parent,pin in self.parent_identity.items()),'AUTHORITY_PARENT_REPLACED')
        before=os.fstat(self.fd);leaf=os.lstat(self.path)
        require(all(getattr(before,key)==getattr(leaf,key)==value for key,value in self.identity.items()),'AUTHORITY_FD_OR_PATH_REPLACED')
        body=self._body();after=os.fstat(self.fd);leaf=os.lstat(self.path)
        require(len(body)==self.identity['st_size'] and digest_bytes(body)==self.sha
                and all(getattr(after,key)==getattr(leaf,key)==value for key,value in self.identity.items()),'AUTHORITY_BYTES_CHANGED')
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
    def __enter__(self):return self
    def __exit__(self,*exc):self.close()
class AuthorityFiles:
    def __init__(self):self.stack=ExitStack();self.files=[]
    def hold(self,path,sha,**options):
        held=self.stack.enter_context(HeldFile(path,sha,**options));self.files.append(held);return held
    def read_json(self,path,sha):return json.loads(self.hold(path,sha,private=True,private_root=TASK).body)
    def recheck(self):
        for held in self.files:held.recheck()
    def __enter__(self):return self
    def __exit__(self,*exc):return self.stack.__exit__(*exc)
def module_from_held(held,name,*,provision=None):
    """Execute authenticated raw Python, never a loader or cached pyc."""
    tree=ast.parse(held.body,filename=str(held.path))
    if provision is not None:
        loader="spec=importlib.util.spec_from_file_location('oasis_provision',Path(__file__).with_name('provision.py'))\np=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(p)"
        signature=[ast.dump(node,include_attributes=False) for node in ast.parse(loader).body]
        matches=[i for i in range(len(tree.body)-2) if [ast.dump(node,include_attributes=False) for node in tree.body[i:i+3]]==signature]
        require(len(matches)==1,'LEGACY_HELPER_LOADER_SHAPE_CHANGED');del tree.body[matches[0]:matches[0]+3]
    # Historical provision contains deferred operational imports inside methods;
    # only its separately bound read-only verification methods are used here.
    # Reject any remaining module-execution loader in top-level source.
    for node in tree.body:
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):continue
        require(not any(isinstance(item,ast.Call) and isinstance(item.func,ast.Attribute)
                        and item.func.attr in ('exec_module','load_module','get_code','get_source','spec_from_file_location','module_from_spec')
                        for item in ast.walk(node)),'UNBOUND_TOPLEVEL_HELPER_LOADER')
    module=types.ModuleType(name);module.__file__=str(held.path)
    if provision is not None:module.p=provision
    exec(compile(tree,str(held.path),'exec'),module.__dict__);held.recheck();return module
def no_mount(root,mountinfo=Path('/proc/self/mountinfo')):
    for row in mountinfo.read_text().splitlines():
        fields=row.split();require(len(fields)>5,'MOUNTINFO_INVALID')
        path=fields[4]
        for escaped,value in [('\\040',' '),('\\011','\t'),('\\012','\n'),('\\134','\\')]:path=path.replace(escaped,value)
        require(not(Path(path)==root or root in Path(path).parents),'SOURCE_MOUNT_REFUSED')
def safe_relative(name):
    p=PurePosixPath(name)
    require(bool(name) and not p.is_absolute() and p.as_posix()==name and all(part not in ('','..','.') for part in p.parts),'RELATIVE_PATH_UNSAFE')
    require(not any(part in ('private','.local','backups','.git') for part in p.parts)
            and p.name not in ('runtime.env','postgres.env','operator-credentials.json','master.key','auth.json')
            and p.suffix not in ('.pem','.key','.keystore','.jks','.p12') and not p.name.startswith('.env'), 'PRIVATE_SOURCE_PATH_REFUSED')
    return p
def tree_snapshot(root,*,mountinfo=Path('/proc/self/mountinfo')):
    root=Path(root);no_mount(root,mountinfo);before=metadata(root)
    require(hasattr(os,'listxattr'),'LINUX_XATTR_INSPECTION_REQUIRED')
    require(not os.listxattr(root,follow_symlinks=False),'SOURCE_XATTR_REFUSED')
    require(before['kind']=='directory','SOURCE_ROOT_UNSAFE')
    entries={'.':before}
    def walk(folder):
        for path in sorted(folder.iterdir()):
            name=path.relative_to(root).as_posix();safe_relative(name);pin=metadata(path)
            require(pin['kind'] in ('directory','file','symlink'),'SOURCE_SPECIAL_FILE_REFUSED')
            require(not os.listxattr(path,follow_symlinks=False),'SOURCE_XATTR_REFUSED')
            if pin['kind']=='symlink':
                require(not os.path.isabs(pin['target']) and path.resolve(strict=True).is_relative_to(root.resolve(strict=True)), 'SOURCE_SYMLINK_ESCAPE')
            entries[name]=pin
            if pin['kind']=='directory':walk(path)
    walk(root);require(metadata(root)==before,'SOURCE_ROOT_CHANGED')
    return {'entries':entries,'entries_sha256':digest_bytes(canonical(entries)),'entry_count':len(entries),'total_file_bytes':sum(pin['bytes'] for pin in entries.values() if pin['kind']=='file')}
def audit_members(tree):
    return {name:dict(pin)
            for name,pin in tree['entries'].items() if pin['kind']!='directory'}
def validate_source_audit(tree,audit,name):
    source=audit['releases'].get(str(BASE/'releases'/name));require(source,'AUDIT_SOURCE_MISSING')
    members=audit_members(tree)
    require(members==source['entries'],'SOURCE_CHANGED_FROM_REVIEWED_AUDIT')
    manifest=tree['entries'].get('RELEASE-MANIFEST.json',{})
    require(manifest.get('sha256')==MANIFESTS[name]==source.get('manifest_sha256'), 'SOURCE_MANIFEST_CHANGED')
    root=tree['entries']['.'];require(root['uid']==root['gid']==0 and root['mode']==0o755 and root['device']==64515 and root['inode']==ROOT_INODES[name], 'SOURCE_ROOT_IDENTITY_CHANGED')
def verify_archive(path,name,tree):
    """Read only; authenticate every body and typed link, complete gzip EOF and tar tail."""
    require(name in ALLOW,'SOURCE_NOT_ALLOWLISTED');path=Path(path);pin=metadata(path)
    require(pin['kind']=='file' and pin['mode']==0o600,'LOCAL_ARCHIVE_UNSAFE')
    upper=tree['total_file_bytes']+tree['entry_count']*8192+1048576;produced=0
    with gzip.open(path,'rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):
            produced+=len(block);require(produced<=upper,'ARCHIVE_UNCOMPRESSED_TOO_LARGE')
    seen={};end=0
    with tarfile.open(path,'r:gz') as tar:
        for member in tar:
            parts=PurePosixPath(member.name.rstrip('/')).parts
            require(parts and parts[0]==name and all(part not in ('','..','.') for part in parts),'ARCHIVE_PATH_ESCAPE')
            relative='.' if len(parts)==1 else PurePosixPath(*parts[1:]).as_posix()
            if relative!='.':safe_relative(relative)
            require(relative not in seen and relative in tree['entries'],'ARCHIVE_UNKNOWN_OR_DUPLICATE_ENTRY')
            expected=tree['entries'][relative];kind='directory' if member.isdir() else 'file' if member.isfile() else 'symlink' if member.issym() else 'special'
            require(kind==expected['kind'] and member.uid==expected['uid'] and member.gid==expected['gid'] and member.mode==expected['mode'],'ARCHIVE_ENTRY_METADATA_MISMATCH')
            mtime=int(Decimal(member.pax_headers.get('mtime',str(member.mtime)))*1000000000)
            require(mtime==expected['mtime_ns'],'ARCHIVE_ENTRY_MTIME_MISMATCH')
            if kind=='file':
                require(member.size==expected['bytes'],'ARCHIVE_ENTRY_SIZE_MISMATCH');h=hashlib.sha256()
                with tar.extractfile(member) as stream:
                    for block in iter(lambda:stream.read(1048576),b''):h.update(block)
                require(h.hexdigest()==expected['sha256'],'ARCHIVE_ENTRY_BODY_MISMATCH')
            elif kind=='symlink':require(member.linkname==expected['target'],'ARCHIVE_SYMLINK_MISMATCH')
            else:require(kind=='directory','ARCHIVE_SPECIAL_ENTRY_REFUSED')
            seen[relative]=True;end=max(end,member.offset_data+((member.size+511)//512)*512)
    require(set(seen)==set(tree['entries']),'ARCHIVE_INCOMPLETE')
    expected_bytes=((end+1024+tarfile.RECORDSIZE-1)//tarfile.RECORDSIZE)*tarfile.RECORDSIZE
    require(produced==expected_bytes,'ARCHIVE_TAR_STREAM_LENGTH')
    with gzip.open(path,'rb') as stream:
        stream.seek(end);tail=stream.read();require(len(tail)>=1024 and not any(tail),'ARCHIVE_TRAILING_DATA')
    require(produced%512==0 and metadata(path)==pin,'ARCHIVE_CHANGED_DURING_VERIFY')
    return {'archive_sha256':pin['sha256'],'archive_bytes':pin['bytes'],'archive_local_pin':pin,'entry_count':len(seen),'tree_sha256':tree['entries_sha256'],'full_gzip_eof_verified':True,'each_entry_verified':True}

def read_json_pinned(path,sha):
    with HeldFile(path,sha,private=True,private_root=TASK) as held:return json.loads(held.body)
def write_exclusive(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(canonical(value)+b'\n');stream.flush();os.fsync(stream.fileno())
def lock_guard(fd,path,expected):
    s=os.fstat(fd)
    require(stat.S_ISREG(s.st_mode) and (s.st_dev,s.st_ino)==(expected['device'],expected['inode'])
            and metadata(path)==expected,'LOCK_REPLACED')
@contextmanager
def locked(path,expected):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        lock_guard(fd,path,expected);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);lock_guard(fd,path,expected);yield fd
    finally:os.close(fd)
def references(value,roots):
    if isinstance(value,dict):return any(references(item,roots) for item in value.values())
    if isinstance(value,list):return any(references(item,roots) for item in value)
    return isinstance(value,str) and any(value==str(root) or value.startswith(str(root)+'/') or str(root) in value for root in roots)
def process_consumers(roots,proc=Path('/proc')):
    consumers=[]
    for pid in sorted(proc.iterdir()):
        if not pid.name.isdigit():continue
        try:
            start=(pid/'stat').read_text().rsplit(')',1)[1].split()[19]
            for field in ('cwd','exe'):
                try:target=os.readlink(pid/field)
                except FileNotFoundError:continue
                if references(target,roots):consumers.append({'pid':pid.name,'kind':field})
            for descriptor in (pid/'fd').iterdir():
                try:target=os.readlink(descriptor)
                except FileNotFoundError:continue
                if references(target,roots):consumers.append({'pid':pid.name,'kind':'fd'})
            if references((pid/'maps').read_text(),roots):consumers.append({'pid':pid.name,'kind':'maps'})
            if any(str(root).encode() in (pid/'cmdline').read_bytes() for root in roots):consumers.append({'pid':pid.name,'kind':'command'})
            require((pid/'stat').read_text().rsplit(')',1)[1].split()[19]==start,'PROCESS_REPLACED_DURING_CHECK')
        except (FileNotFoundError,ProcessLookupError):
            require(not pid.exists(),'PROCESS_INSPECTION_INCOMPLETE')
        except PermissionError:raise Refusal('PROCESS_INSPECTION_DENIED') from None
    return consumers
def consumer_snapshot(runtime,roots,proc=Path('/proc'),config_roots=(Path('/etc/nginx'),Path('/etc/systemd/system'),BASE/'nginx')):
    processes=process_consumers(roots,proc);containers=[];configuration=[];units=[];source_links=[]
    for path in [*BASE.glob('*'),*(BASE/'releases').rglob('*')]:
        if not any(path==root or root in path.parents for root in roots) and path.is_symlink() and references(str(path.resolve(strict=False)),roots):source_links.append(str(path))
    ids=runtime.command(['docker','container','ls','-aq']).splitlines()
    for cid in ids:
        value=runtime.inspect('container',cid)
        for mount in value.get('Mounts',[]):
            source=mount.get('Source','')
            if references(source,roots) or source and Path(source).exists() and references(str(Path(source).resolve()),roots):containers.append({'container_id':value['Id'],'kind':'mount'})
        if references(value.get('Config',{}).get('WorkingDir',''),roots) or references(value.get('Config',{}).get('Cmd',[]),roots) or references(value.get('Config',{}).get('Entrypoint',[]),roots):containers.append({'container_id':value['Id'],'kind':'command'})
    for root in config_roots:
        if not root.exists():continue
        for path in sorted(root.rglob('*')):
            if path.is_file():
                require(path.stat().st_size<=16777216,'CONFIGURATION_TOO_LARGE')
                if any(str(source).encode() in path.read_bytes() for source in roots):configuration.append(str(path))
    loaded=runtime.command(['systemctl','list-units','--all','--plain','--no-legend','--no-pager']).splitlines()
    names=[row.split()[0] for row in loaded if row.split()]
    require(len(names)<=4096 and all(re.fullmatch(r'[A-Za-z0-9@_.:\\-]+',name) for name in names),'LOADED_UNIT_LIST_INVALID')
    if names:
        state=runtime.command(['systemctl','show','--no-pager','--property=Id,ExecStartPre,ExecStart,ExecStartPost,ExecStop,ExecStopPost,WorkingDirectory,RootDirectory,FragmentPath,DropInPaths','--',*names])
        if references(state,roots):units.append('loaded-unit-reference')
    proxy=runtime.inspect('container','proxy-nginx')['Id']
    scan=runtime.command(['docker','exec',proxy,'sh','-c',"find /etc/nginx -type f -exec sh -c 'for path do grep -F -l -e /opt/oasis/releases/20261008-23 -e /opt/oasis/releases/20261008-24 \"$path\"; rc=$?; [ \"$rc\" -le 1 ] || exit \"$rc\"; done' sh {} +"])
    if scan.strip():configuration.extend('proxy:'+line for line in scan.splitlines())
    require(not(processes or containers or configuration or units or source_links),'OBSOLETE_SOURCE_HAS_CONSUMER')
    return {'processes':processes,'containers':containers,'configuration':configuration,'loaded_units':units,'source_links':source_links}
def load_legacy_helpers(inventory,authority):
    sys.dont_write_bytecode=True
    source=Path(inventory['production_release']);require(source==BASE/'releases/20261010-03','PRODUCTION_SOURCE_NOT_FIXED03')
    expected=inventory['helpers'];require(set(expected)=={'provision.py','operations.py','bootstrap.mjs','inspect-backup.mjs','monitor.mjs'},'LEGACY_HELPER_CLOSURE_INVALID')
    held={name:authority.hold(source/'platform/deploy/production-instance'/name,sha) for name,sha in expected.items()}
    p=module_from_held(held['provision.py'],'retire_fixed03_provision')
    ops=module_from_held(held['operations.py'],'retire_fixed03_operations',provision=p)
    verification=p.verify_release(source,inventory['production_manifest_sha256']);require(verification['helpers']==expected,'LEGACY_SOURCE_CHANGED')
    authority.recheck()
    return p,ops
def retained_protection_paths(prior,inventory):
    paths=inventory['protected_paths'];require(isinstance(paths,list) and len(paths)==len(set(paths))
            and all(isinstance(path,str) and path.startswith(('/opt/oasis/','/etc/nginx/')) and '..' not in Path(path).parts for path in paths),'PROTECTION_PATHS_INVALID')
    roots=[BASE/'releases'/name for name in ALLOW]
    removed=[path for path in prior['paths'] if any(Path(path)==root or root in Path(path).parents for root in roots)]
    retained=[path for path in prior['paths'] if path not in removed]
    exact={str(root/'RELEASE-MANIFEST.json') for root in roots}
    require(set(removed)==exact==set(inventory['historical_inventory']['obsolete_paths'])
            and all(path in paths for path in retained) and inventory['historical_inventory']['path'] in paths
            and not any(references(path,roots) for path in paths),'ORIGINAL_PROTECTION_SILENTLY_DROPPED')
    return paths
def protection_snapshot(inventory,p,ops):
    marker=json.loads((p.PRIVATE/'installation.json').read_text());runtime=p.Runtime()
    require(marker['release']==inventory['production_release'] and marker['manifest_sha256']==inventory['production_manifest_sha256'],'PRODUCTION_MARKER_SOURCE_CHANGED')
    owned=ops.owned_resources(marker,runtime);require(owned['running'],'PRODUCTION_DATABASE_NOT_RUNNING')
    original=Path(inventory['historical_inventory']['path']);raw=original.read_bytes()
    require(digest_bytes(raw)==inventory['historical_inventory']['sha256'],'ORIGINAL_INVENTORY_CHANGED')
    prior=json.loads(raw);p.validate_protected(prior)
    paths=retained_protection_paths(prior,inventory)
    protected=runtime.protect(paths)
    private={name:metadata(p.PRIVATE/name) for name in ('runtime.env','postgres.env','operator-credentials.json','state/master.key','installation.json','receipt.json')}
    units={}
    require(set(inventory['production_units'])==PRODUCTION_UNITS and len(inventory['production_units'])==len(PRODUCTION_UNITS),'PRODUCTION_UNIT_CLOSURE_REQUIRED')
    for name in inventory['production_units']:
        require(re.fullmatch(r'oasis-production-[A-Za-z0-9_.-]+\.(service|timer)',name),'PRODUCTION_UNIT_SCOPE_INVALID')
        units[name]={'file':metadata(Path('/etc/systemd/system')/name),'loaded':runtime.loaded_commands(name),'service':runtime.service(name)}
    for path in inventory['additional_paths']:protected['files'][path]=p.fingerprint(path,links=True)
    for name in ('fullchain.pem','privkey.pem'):
        leaf=BASE/'acme/config/live/oasis-production-player'/name
        require(str(leaf) in inventory['additional_paths'] and str(leaf.resolve(strict=True)) in inventory['additional_paths'],'PRODUCTION_CERTIFICATE_CLOSURE_REQUIRED')
    query="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='20s'; SELECT json_build_object('database',current_database(),'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),'apps',(SELECT json_agg(json_build_object('id',id,'status',status,'environment',environment)) FROM gp_apps),'players',(SELECT count(*) FROM gp_players),'sessions',(SELECT count(*) FROM gp_sessions),'rooms',(SELECT count(*) FROM pvp_rooms),'pending_rooms',(SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')),'ledger',(SELECT count(*) FROM wallet_ledger),'nonzero_wallets',(SELECT count(*) FROM wallet_users WHERE available<>0 OR reserved<>0 OR credit_pending<>0),'nonzero_scopes',(SELECT count(*) FROM wallet_scopes WHERE treasury_available<>0 OR treasury_reserved<>0 OR treasury_inbound<>0 OR fee_available<>0 OR fee_pending<>0 OR ledger_version<>0),'pending_transfers',(SELECT count(*) FROM gp_transfers WHERE state='PENDING')); COMMIT;"
    rows=[json.loads(row) for row in ops.sql(runtime,marker,p.DATABASE,query).splitlines() if row.startswith('{')]
    require(len(rows)==1 and rows[0]['environment']=='production' and rows[0]['database']==p.DATABASE
            and all(app['status']=='paused' and app['environment']=='production' for app in rows[0]['apps'])
            and all(rows[0][name]==0 for name in ('players','sessions','rooms','pending_rooms','ledger','nonzero_wallets','nonzero_scopes','pending_transfers')),'PRODUCTION_CLOSED_STATE_CHANGED')
    return {'protected':protected,'production':{'marker_sha256':digest_bytes(canonical(marker)),'resources':owned,'private':private,'units':units,'database':rows[0]},'links':{str(BASE/name):p.fingerprint(BASE/name,links=True) for name in ('current','production-current')},'locks':{'global':metadata(GLOBAL_LOCK),'operations':metadata(OPERATIONS_LOCK)}}

def validate_inputs(inventory,audit,proof):
    require(inventory.get('kind')=='mock-source-retirement-reviewed-inventory-v1' and inventory.get('obsolete_sources')==[str(BASE/'releases'/name) for name in ALLOW]
            and inventory.get('explicit_obsolete_archive_review') is True and re.fullmatch('[a-f0-9]{40}',inventory.get('source_commit','')),'REVIEWED_INVENTORY_REQUIRED')
    require(audit.get('kind')=='retired-mock-source-readonly-audit' and audit.get('passed') is True and audit.get('retirement_receipt_sha256')==RETIREMENT_SHA,'ORIGINAL_RETIREMENT_NOT_PROVED')
    require(proof.get('kind')=='retired-mock-complete-local-archive-proof-v1' and proof.get('remote_before_after_equal') is True
            and proof.get('source_audit_sha256')==inventory.get('source_audit_sha256')
            and re.fullmatch('[a-f0-9]{64}',proof.get('source_audit_sha256','')),'ARCHIVE_AUDIT_IDENTITY_MISMATCH')
    require(set(proof.get('archives',{}))==set(ALLOW) and set(proof.get('trees',{}))==set(ALLOW),'COMPLETE_ARCHIVES_REQUIRED')
    for name in ALLOW:
        tree=proof['trees'][name];validate_source_audit(tree,audit,name);archive=proof['archives'][name]
        require(archive.get('full_gzip_eof_verified') is True and archive.get('each_entry_verified') is True
                and archive.get('tree_sha256')==tree['entries_sha256'] and archive.get('entry_count')==tree['entry_count']
                and re.fullmatch('[a-f0-9]{64}',archive.get('archive_sha256','')) and archive.get('archive_bytes',0)>1048576,'FULL_LOCAL_ARCHIVE_PROOF_REQUIRED')
def validate_root_archive_review(review,proof):
    require(review.get('kind')=='root-independent-mock-archive-review-v1' and review.get('passed') is True
            and review.get('proof_sha256')==ARCHIVE_PROOF_SHA and set(review.get('archives',{}))==set(ALLOW),'INDEPENDENT_ARCHIVE_REVIEW_REQUIRED')
    for name in ALLOW:
        actual=review['archives'][name];archive=proof['archives'][name];tree=proof['trees'][name]
        require(actual.get('full_body_and_metadata_verified') is True and actual.get('gzip_eof_crc_and_exact_zero_tail_verified') is True
                and actual.get('archive_sha256')==archive['archive_sha256'] and actual.get('archive_bytes')==archive['archive_bytes']
                and actual.get('members')==tree['entry_count'] and actual.get('file_bytes')==tree['total_file_bytes']
                and actual.get('source_tree_sha256')==tree['entries_sha256'],'INDEPENDENT_ARCHIVE_REVIEW_MISMATCH')
def validate_retirement_replacement(prior,inventory,receipt,capsule,proof,review,*,external_sha256):
    """Pure policy: caller must independently approve and raw-FD hash all documents first.

    This neither reads files nor changes protected inventory, source, DB or units.
    Original20 still goes through the original guard; only its exact obsolete two
    source-manifest pins may be replaced after a separately authorized retirement.
    """
    required={'historical_inventory_sha256','inventory_sha256','retirement_receipt_sha256','check_sha256',
              'archive_proof_sha256','root_independent_archive_review_sha256','tool_sha256','source_audit_sha256'}
    require(set(external_sha256)==required and all(re.fullmatch('[a-f0-9]{64}',value or '') for value in external_sha256.values()),'REPLACEMENT_EXTERNAL_PINS_REQUIRED')
    authorize_original_parent(prior,inventory)
    require(external_sha256['historical_inventory_sha256']==ORIGINAL_INVENTORY_SHA
            and external_sha256['source_audit_sha256']==SOURCE_AUDIT_SHA and external_sha256['archive_proof_sha256']==ARCHIVE_PROOF_SHA
            and external_sha256['root_independent_archive_review_sha256']==ROOT_ARCHIVE_REVIEW_SHA,'REPLACEMENT_RECOVERY_PIN_MISMATCH')
    paths=retained_protection_paths(prior,inventory);validate_root_archive_review(review,proof)
    expected={key:value for key,value in external_sha256.items() if key!='retirement_receipt_sha256'}
    require(receipt.get('kind')=='mock-source-retirement-result-v1' and receipt.get('passed') is True
            and receipt.get('removed')==list(ALLOW) and receipt.get('all_obsolete_sources_absent') is True
            and receipt.get('obsolete_sources')==[str(BASE/'releases'/name) for name in ALLOW]
            and receipt.get('manifest_sha256')==MANIFESTS and receipt.get('external_bindings')==expected,'ACTUAL_RETIREMENT_RECEIPT_REQUIRED')
    require(capsule.get('kind')=='mock-source-retirement-check-v1' and capsule.get('passed') is True
            and capsule.get('external_bindings')=={key:value for key,value in expected.items() if key!='check_sha256'}
            and receipt.get('source_commit')==capsule.get('source_commit')==inventory.get('source_commit')
            and re.fullmatch('[a-f0-9]{40}',inventory.get('source_commit',''))
            and capsule.get('inventory_canonical_json_sha256')==digest_bytes(canonical(inventory))
            and capsule.get('archive_proof_canonical_json_sha256')==receipt.get('archive_proof_canonical_json_sha256')==digest_bytes(canonical(proof))
            and receipt.get('check_canonical_json_sha256')==digest_bytes(canonical(capsule)),'RETIREMENT_CHECK_CHAIN_MISMATCH')
    require(receipt.get('historical_inventory')==inventory.get('historical_inventory')
            and inventory['historical_inventory']['sha256']==external_sha256['historical_inventory_sha256']
            and inventory.get('source_audit_sha256')==SOURCE_AUDIT_SHA and inventory.get('archive_proof_sha256')==ARCHIVE_PROOF_SHA
            and inventory.get('root_independent_archive_review',{}).get('sha256')==ROOT_ARCHIVE_REVIEW_SHA
            and inventory.get('snapshot')==capsule.get('snapshot')
            and receipt.get('reviewed_snapshot_sha256')==digest_bytes(canonical(inventory['snapshot'])),'RETIREMENT_INVENTORY_CHAIN_MISMATCH')
    for name in ALLOW:
        tree=proof['trees'][name];archive=proof['archives'][name]
        require(capsule['trees'][name]==tree and tree['entries']['RELEASE-MANIFEST.json']['sha256']==MANIFESTS[name]
                and tree['entries']['.']['inode']==ROOT_INODES[name]
                and receipt.get('sources',{}).get(name)=={'manifest_sha256':MANIFESTS[name],'tree_sha256':tree['entries_sha256'],
                    'archive_sha256':archive['archive_sha256'],'archive_bytes':archive['archive_bytes']},'RETIREMENT_SOURCE_CHAIN_MISMATCH')
    for field in ('at','finished_at'):
        try:value=dt.datetime.fromisoformat(receipt[field]);require(value.tzinfo is not None,'RETIREMENT_TIME_INVALID')
        except (KeyError,ValueError,TypeError):raise Refusal('RETIREMENT_TIME_INVALID') from None
    require(dt.datetime.fromisoformat(receipt['finished_at'])>=dt.datetime.fromisoformat(receipt['at']), 'RETIREMENT_TIME_INVALID')
    return {'retained_paths':paths,'obsolete_manifest_paths':list(inventory['historical_inventory']['obsolete_paths']),
            'approved_document_sha256':dict(external_sha256),'source_commit':inventory['source_commit']}
def check(inventory,audit,proof,p,ops,authority):
    authority.recheck()
    validate_inputs(inventory,audit,proof)
    roots=[BASE/'releases'/name for name in ALLOW];runtime=p.Runtime();consumers=consumer_snapshot(runtime,roots)
    trees={name:tree_snapshot(BASE/'releases'/name) for name in ALLOW}
    for name,tree in trees.items():require(tree==proof['trees'][name],'SOURCE_CHANGED_AFTER_ARCHIVE')
    snapshot=protection_snapshot(inventory,p,ops)
    expected=inventory.get('snapshot');require(expected is not None and snapshot==expected,'REVIEWED_PROTECTION_CHANGED')
    global_pin=snapshot['locks']['global'];require(all(global_pin.get(key)==value for key,value in GLOBAL_IDENTITY.items()),'GLOBAL_LOCK_NOT_ORIGINAL')
    ops_pin=snapshot['locks']['operations'];require(ops_pin['kind']=='file' and ops_pin['uid']==0 and ops_pin['mode']==0o600 and ops_pin['bytes']==0,'OPERATIONS_LOCK_UNSAFE')
    authority.recheck()
    return {'kind':'mock-source-retirement-check-v1','at':now(),'passed':True,'source_commit':inventory['source_commit'],
            'external_bindings':dict(authority.bindings),'inventory_canonical_json_sha256':digest_bytes(canonical(inventory)),
            'archive_proof_canonical_json_sha256':digest_bytes(canonical(proof)),'trees':trees,'snapshot':snapshot,'consumers':consumers}

def remove_bound_tree(root,expected):
    """No shell/rmtree: unlink only exact observed inodes through no-follow directory descriptors."""
    require(root==BASE/'releases'/root.name and root.name in ALLOW,'SOURCE_NOT_ALLOWLISTED')
    require(tree_snapshot(root)==expected,'SOURCE_CHANGED_BEFORE_DELETE')
    def bound_identity(pin,s):return (s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(pin['device'],pin['inode'],pin['uid'],pin['gid'],pin['mode'])
    def walk(fd,relative):
        pin=expected['entries'][relative];require(bound_identity(pin,os.fstat(fd)),'DELETE_DIRECTORY_REPLACED')
        for name in sorted(os.listdir(fd)):
            child=name if relative=='.' else relative+'/'+name;require(child in expected['entries'],'DELETE_UNKNOWN_ENTRY')
            wanted=expected['entries'][child];current=os.stat(name,dir_fd=fd,follow_symlinks=False);require(bound_identity(wanted,current),'DELETE_ENTRY_REPLACED')
            if wanted['kind']=='directory':
                childfd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                try:walk(childfd,child)
                finally:os.close(childfd)
                require(bound_identity(wanted,os.stat(name,dir_fd=fd,follow_symlinks=False)),'DELETE_DIRECTORY_REPLACED');os.rmdir(name,dir_fd=fd)
            else:
                require(metadata(root/child)==wanted,'DELETE_ENTRY_CHANGED');os.unlink(name,dir_fd=fd)
        require(not os.listdir(fd),'DELETE_DIRECTORY_NOT_EMPTY')
    parent=os.open(root.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        fd=os.open(root.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:walk(fd,'.')
        finally:os.close(fd)
        require(bound_identity(expected['entries']['.'],os.stat(root.name,dir_fd=parent,follow_symlinks=False)),'DELETE_ROOT_REPLACED');os.rmdir(root.name,dir_fd=parent)
    finally:os.close(parent)
def apply(inventory,audit,proof,capsule,p,ops,report,authority):
    authority.recheck()
    fresh(capsule.get('at'));require(capsule.get('kind')=='mock-source-retirement-check-v1' and capsule.get('passed') is True,'CHECK_REQUIRED')
    expected=inventory['snapshot']['locks'];result={'kind':'mock-source-retirement-result-v1','at':now(),'passed':False,'removed':[],
      'source_commit':inventory['source_commit'],'obsolete_sources':[str(BASE/'releases'/name) for name in ALLOW],
      'manifest_sha256':MANIFESTS,'external_bindings':dict(authority.bindings),
      'archive_proof_canonical_json_sha256':digest_bytes(canonical(proof)),'check_canonical_json_sha256':digest_bytes(canonical(capsule)),
      'historical_inventory':inventory['historical_inventory'],'reviewed_snapshot_sha256':digest_bytes(canonical(inventory['snapshot'])),
      'sources':{name:{'manifest_sha256':MANIFESTS[name],'tree_sha256':proof['trees'][name]['entries_sha256'],
                      'archive_sha256':proof['archives'][name]['archive_sha256'],'archive_bytes':proof['archives'][name]['archive_bytes']} for name in ALLOW}}
    with locked(GLOBAL_LOCK,expected['global']) as globalfd,locked(OPERATIONS_LOCK,expected['operations']) as opsfd:
        # The check file cannot bind its own raw SHA. That binding is added only
        # to the receipt after its original FD has been independently pinned.
        check_binding=authority.bindings.pop('check_sha256')
        try:before=check(inventory,audit,proof,p,ops,authority)
        finally:authority.bindings['check_sha256']=check_binding
        require({key:value for key,value in before.items() if key!='at'}=={key:value for key,value in capsule.items() if key!='at'},'CHECK_STATE_CHANGED')
        usage=os.statvfs(BASE);result['available_before']=usage.f_bavail*usage.f_frsize
        try:
            for name in ALLOW:
                fresh(capsule['at']);authority.recheck();lock_guard(globalfd,GLOBAL_LOCK,expected['global']);lock_guard(opsfd,OPERATIONS_LOCK,expected['operations'])
                require(protection_snapshot(inventory,p,ops)==before['snapshot'],'PROTECTION_CHANGED_BEFORE_DELETE')
                consumer_snapshot(p.Runtime(),[BASE/'releases'/entry for entry in ALLOW]);remove_bound_tree(BASE/'releases'/name,proof['trees'][name]);result['removed'].append(name)
            authority.recheck();require(protection_snapshot(inventory,p,ops)==before['snapshot'],'PROTECTION_CHANGED_AFTER_DELETE')
            require(all(not os.path.lexists(BASE/'releases'/name) for name in ALLOW),'SOURCE_DELETE_INCOMPLETE')
            result['all_obsolete_sources_absent']=True
            usage=os.statvfs(BASE);result['available_after']=usage.f_bavail*usage.f_frsize;result['passed']=True
        except Exception as error:result['error_code']=str(error) if isinstance(error,Refusal) else 'SOURCE_RETIREMENT_FAILED'
        finally:
            result['finished_at']=now();trusted_parents(report,private_root=TASK);write_exclusive(report,result)
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('capture','check','apply'))
    for name in ('inventory','source-audit','archive-proof','tool'):
        if name!='tool':parser.add_argument('--'+name,required=True)
        parser.add_argument('--'+name+'-sha256',required=True)
    parser.add_argument('--check');parser.add_argument('--check-sha256');parser.add_argument('--report');args=parser.parse_args();os.umask(0o077)
    try:
        require(os.geteuid()==0 and sys.flags.isolated==1 and sys.dont_write_bytecode,'ISOLATED_ROOT_AND_EXTERNAL_TOOL_PIN_REQUIRED')
        require(args.source_audit_sha256==SOURCE_AUDIT_SHA and args.archive_proof_sha256==ARCHIVE_PROOF_SHA,'FIXED_INDEPENDENT_RECOVERY_PROOF_REQUIRED')
        with AuthorityFiles() as authority:
            authority.hold(Path(__file__).absolute(),args.tool_sha256,private=True,private_root=TASK)
            inventory=authority.read_json(args.inventory,args.inventory_sha256);audit=authority.read_json(args.source_audit,args.source_audit_sha256);proof=authority.read_json(args.archive_proof,args.archive_proof_sha256)
            authority.bindings={'inventory_sha256':args.inventory_sha256,'source_audit_sha256':args.source_audit_sha256,'archive_proof_sha256':args.archive_proof_sha256,'tool_sha256':args.tool_sha256}
            require(inventory['source_audit_sha256']==args.source_audit_sha256 and proof['source_audit_sha256']==args.source_audit_sha256
                    and inventory['archive_proof_sha256']==args.archive_proof_sha256,'INPUT_EXTERNAL_PIN_MISMATCH')
            independent=inventory['root_independent_archive_review'];require(independent['sha256']==ROOT_ARCHIVE_REVIEW_SHA,'INDEPENDENT_REVIEW_EXTERNAL_PIN_REQUIRED')
            review=authority.read_json(independent['path'],independent['sha256']);validate_root_archive_review(review,proof)
            authority.bindings['root_independent_archive_review_sha256']=independent['sha256']
            historical=inventory['historical_inventory']
            require(historical['path']==str(ORIGINAL_INVENTORY_PATH) and historical['sha256']==ORIGINAL_INVENTORY_SHA,'ORIGINAL_PARENT_AUTHORITY_EXTERNAL_PIN_REQUIRED')
            original=authority.hold(historical['path'],historical['sha256'],private=True,private_root=Path(historical['path']).parent)
            authorize_original_parent(json.loads(original.body),inventory);authority.recheck()
            authority.bindings['historical_inventory_sha256']=historical['sha256']
            validate_inputs(inventory,audit,proof);p,ops=load_legacy_helpers(inventory,authority)
            if args.mode=='capture':
                result={'kind':'mock-source-retirement-protection-observation-v1','at':now(),'passed':False,'snapshot':protection_snapshot(inventory,p,ops),'approval':'Observation only; root must independently review and pin a new inventory.'};authority.recheck()
            elif args.mode=='check':result=check(inventory,audit,proof,p,ops,authority)
            else:
                require(args.check and args.check_sha256 and args.report,'CHECK_AND_EXCLUSIVE_REPORT_REQUIRED')
                require(TASK.is_dir() and not TASK.is_symlink() and metadata(TASK)['uid']==0 and metadata(TASK)['mode']==0o700,'TASK_DIRECTORY_UNSAFE')
                no_mount(TASK)
                report=Path(args.report);require(report.parent==TASK and re.fullmatch(r'retirement-[A-Za-z0-9_-]{1,80}\.json',report.name) and not os.path.lexists(report),'REPORT_SCOPE_INVALID')
                capsule=authority.read_json(args.check,args.check_sha256);authority.bindings['check_sha256']=args.check_sha256
                result=apply(inventory,audit,proof,capsule,p,ops,report,authority)
        print(json.dumps(result,sort_keys=True));return 0 if result.get('passed') else 2
    except Exception as error:print(json.dumps({'passed':False,'error_code':str(error) if isinstance(error,Refusal) else 'SOURCE_RETIREMENT_FAILED'}));return 2
if __name__=='__main__':raise SystemExit(main())


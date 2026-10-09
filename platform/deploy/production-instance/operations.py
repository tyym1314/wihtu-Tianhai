#!/usr/bin/python3
"""Backup and genuinely restore only the marked independent production container."""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import tarfile
import tempfile
from contextlib import contextmanager

spec=importlib.util.spec_from_file_location('oasis_provision',Path(__file__).with_name('provision.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
admission_spec=importlib.util.spec_from_file_location('oasis_admission_runtime',Path(__file__).with_name('admission-runtime.py'))
a=importlib.util.module_from_spec(admission_spec);admission_spec.loader.exec_module(a)

def contract(call,*args,**kwargs):
    try:return call(*args,**kwargs)
    except ValueError as error:raise p.Refusal(str(error)) from None

def load_marker():
    marker=json.loads((p.PRIVATE/'installation.json').read_text())
    p.require(marker.get('kind')=='isolated-production-instance' and re.fullmatch('[a-f0-9]{32}',marker.get('owner',''))
              and re.fullmatch('[a-f0-9]{64}',marker.get('container_id','')),'PRODUCTION_MARKER_INVALID')
    p.require(str(p.PIN.resolve(strict=True))==marker.get('release'),'PRODUCTION_PIN_CHANGED')
    p.verify_release(Path(marker['release']),marker['manifest_sha256'])
    return marker

@contextmanager
def operations_lock():
    file=p.PRIVATE/'operations.lock'
    if not file.exists() and not file.is_symlink():p.exclusive(file,b'')
    before=p.fingerprint(file)
    p.require(before['uid']==0 and before['mode']==0o600 and before['bytes']==0,'PRODUCTION_OPERATIONS_LOCK_UNSAFE')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd);p.require(s.st_ino==before['inode'] and s.st_dev==before['device'],'PRODUCTION_OPERATIONS_LOCK_CHANGED')
        p.fcntl.flock(fd,p.fcntl.LOCK_EX|p.fcntl.LOCK_NB)
        yield
    finally:os.close(fd)

def owned_resources(marker,runtime,*,created_prestart=False):
    p.require(type(created_prestart) is bool,'PRODUCTION_PRESTART_FLAG_INVALID')
    p.account_guard(marker)
    cid=marker['container_id'];owner=marker['owner']
    c=runtime.inspect('container',cid);v=runtime.inspect('volume',p.VOLUME);n=runtime.inspect('network',p.NETWORK)
    p.require(c['Id']==cid and c['Name']=='/'+p.CONTAINER and c['Image']==marker['pg_image']
              and c['Config'].get('Labels',{}).get(p.LABEL)==owner
              and v.get('Labels',{}).get(p.LABEL)==owner and n.get('Labels',{}).get(p.LABEL)==owner
              and v.get('Driver')=='local' and not v.get('Options')
              and n.get('Driver')=='bridge' and n.get('Internal') is False
              and n.get('Options')==p.NETWORK_OPTIONS,'PRODUCTION_RESOURCE_OWNERSHIP_CHANGED')
    mounts=c['Mounts'];networks=c['NetworkSettings']['Networks']
    p.require(len(mounts)==1 and mounts[0].get('Type')=='volume' and mounts[0].get('Name')==p.VOLUME
              and mounts[0].get('Destination')=='/var/lib/postgresql/data' and mounts[0].get('RW') is True
              and set(networks)=={p.NETWORK},'PRODUCTION_RESOURCE_SCOPE_CHANGED')
    attachment=networks[p.NETWORK]
    if created_prestart:
        # Docker has no assigned endpoint until the exact created container starts.
        # This is permitted only by the explicit first pre-start checkpoint caller.
        state=c.get('State',{})
        p.require(state.get('Status')=='created'
                  and all(state.get(key) is False for key in ('Running','Paused','Restarting','Dead','OOMKilled'))
                  and type(state.get('Pid')) is int and state['Pid']==0
                  and type(state.get('ExitCode')) is int and state['ExitCode']==0 and state.get('Error')==''
                  and state.get('StartedAt')==state.get('FinishedAt')=='0001-01-01T00:00:00Z'
                  and type(c.get('RestartCount')) is int and c['RestartCount']==0
                  and c['HostConfig'].get('NetworkMode')==p.NETWORK
                  and all(attachment.get(key)=='' for key in ('NetworkID','EndpointID','IPAddress'))
                  and all(key not in attachment or attachment[key]==''
                          for key in ('Gateway','GlobalIPv6Address','IPv6Gateway','MacAddress'))
                  and all(key not in attachment or type(attachment[key]) is int and attachment[key]==0
                          for key in ('IPPrefixLen','GlobalIPv6PrefixLen','GwPriority'))
                  and all(key not in attachment or attachment[key] is None
                          for key in ('IPAMConfig','Links','DriverOpts','Aliases','DNSNames'))
                  and n.get('Containers',{})=={},'PRODUCTION_CREATED_PRESTART_STATE_CHANGED')
    else:
        p.require(c.get('State',{}).get('Status')!='created'
                  and c['HostConfig'].get('NetworkMode')==p.NETWORK
                  and attachment.get('NetworkID')==n['Id'],'PRODUCTION_RESOURCE_SCOPE_CHANGED')
    p.require(set(n.get('Containers',{}))<= {cid},'PRODUCTION_NETWORK_FOREIGN_CONSUMER')
    p.require(marker.get('network_id')==n['Id'] and marker.get('volume_identity')=={key:v.get(key) for key in ('Name','CreatedAt','Driver','Options','Mountpoint')},'PRODUCTION_VOLUME_OR_NETWORK_REPLACED')
    ids=runtime.command(['docker','container','ls','-aq']).splitlines()
    for item in ids:
        other=runtime.inspect('container',item)
        if other['Id']!=cid:
            p.require(not any(row.get('Name')==p.VOLUME for row in other.get('Mounts',[]))
                      and p.NETWORK not in other.get('NetworkSettings',{}).get('Networks',{}),'PRODUCTION_FOREIGN_CONSUMER')
    ports=c['HostConfig'].get('PortBindings',{})
    p.require(ports==p.PG_PORT_BINDINGS,'PRODUCTION_PG_PORT_CHANGED')
    # Requested publish settings are not proof that Docker created the host
    # listener. In particular an internal bridge can keep Ports[5432/tcp]=null.
    actual_ports=c['NetworkSettings'].get('Ports')
    p.require(type(c['State'].get('Running')) is bool
              and (actual_ports==p.PG_PORT_BINDINGS if c['State']['Running']
                   else actual_ports in ({},{'5432/tcp':None},p.PG_PORT_BINDINGS)),
              'PRODUCTION_PG_ACTUAL_PORT_CHANGED')
    s=p.PRIVATE.lstat();p.require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_gid==marker['gid'] and stat.S_IMODE(s.st_mode)==0o750,'PRODUCTION_PRIVATE_OWNERSHIP_CHANGED')
    p.require(set(marker.get('private_pins',{}))=={'runtime.env','postgres.env','operator-credentials.json','state/master.key'}
              and all(p.fingerprint(p.PRIVATE/name)==expected for name,expected in marker['private_pins'].items()),'PRODUCTION_PRIVATE_CONFIG_CHANGED')
    p.no_mount(p.PRIVATE);p.no_mount(p.BACKUPS)
    for name in ('runtime.env','postgres.env','operator-credentials.json','installation.json'):
        meta=p.fingerprint(p.PRIVATE/name);p.require(meta['uid']==0 and meta['mode']==0o600,'PRODUCTION_PRIVATE_FILE_UNSAFE')
    key=p.fingerprint(p.PRIVATE/'state/master.key');p.require(key['uid']==marker['uid'] and key['gid']==marker['gid'] and key['mode']==0o600 and key['bytes']==32,'PRODUCTION_MASTER_KEY_UNSAFE')
    env=p.parse_env(p.PRIVATE/'runtime.env')
    from urllib.parse import urlsplit,unquote
    url=urlsplit(env.get('OASIS_DATABASE_URL',''))
    profile=contract(a.runtime_profile,env,expected_release=marker.get('release'),expected_manifest=marker.get('manifest_sha256'))
    p.require(env['OASIS_ENVIRONMENT']=='production' and env['OASIS_START_WALLET']=='0'
              and env['OASIS_PUBLIC_ORIGIN']==marker['origins'][0]
              and env['OASIS_API_PORT']=='18891' and env['OASIS_LOCAL_DIR']==str(p.PRIVATE/'state')+'/'
              and url.scheme=='postgres' and url.hostname=='127.0.0.1' and url.port==18893 and url.path=='/'+p.DATABASE
              and unquote(url.username or '')==p.DB_APP and url.password and not url.query and not url.fragment,
              'PRODUCTION_RUNTIME_CONFIG_CHANGED')
    return {'container_id':cid,'volume':{'name':v['Name'],'created_at':v['CreatedAt'],'driver':v['Driver'],'options':v.get('Options')},
            'network_id':n['Id'],'image':c['Image'],'running':c['State']['Running'],
            'created_prestart':created_prestart,'runtime_profile':profile}

def sql(runtime,marker,database,body):
    p.require(database==p.DATABASE or re.fullmatch(r'oasis_prod_restore_\d{8}_[a-f0-9]{16}',database),'PRODUCTION_DATABASE_NAME_INVALID')
    return runtime.command(['docker','exec','-i',marker['container_id'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',p.DB_OWNER,'-d',database],input=body,timeout=90)

def database_identity(marker,runtime,database=p.DATABASE):
    body="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='15s'; SELECT json_build_object('database',current_database(),'database_oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),'sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment!='production')); COMMIT;"
    rows=[json.loads(row) for row in sql(runtime,marker,database,body).splitlines() if row.startswith('{')]
    p.require(len(rows)==1 and rows[0]['database']==database and rows[0]['environment']=='production' and rows[0]['sandbox_apps']==0,'PRODUCTION_DATABASE_IDENTITY_CHANGED')
    return rows[0]

ARCHIVE_MEMBERS={'production-instance-private/state/master.key':'state/master.key',
                 'production-instance-private/runtime.env':'runtime.env',
                 'production-instance-private/postgres.env':'postgres.env'}
BACKUP_FILES=('database.dump','private-config.tar.gz','release.txt','database-contents.txt','runtime-identity.json')

def backup_source(marker,release,manifest,**selector):
    source=contract(a.approved_source,marker,release,manifest,**selector)
    verification=p.verify_historical_release(Path(release),manifest,source['helpers'])
    p.require(verification['helpers']==source['helpers'] and verification.get('inspection_closure'),
              'PRODUCTION_BACKUP_HELPER_CLOSURE_CHANGED')
    return {**source,'inspection_closure':verification['inspection_closure']}

def inspect_database(marker,runtime,database,source,master):
    helper=Path(source['release'])/'platform/deploy/production-instance/inspect-backup.mjs'
    p.require(p.fingerprint(helper)['sha256']==source['helpers']['inspect-backup.mjs'],'PRODUCTION_INSPECTION_HELPER_CHANGED')
    expected=contract(a.inspection_expectation,source)
    options={'input':json.dumps({'expected':expected})} if source['inspection_contract']=='production-free-v2' else {}
    query=runtime.command(['/usr/bin/node',str(helper),'sql'],**options)
    rows=[json.loads(row) for row in sql(runtime,marker,database,query).splitlines() if row.startswith('{')]
    p.require(len(rows)==2 and rows[1].get('database')==database,'PRODUCTION_RESTORE_RESPONSE_INVALID')
    payload={'data':rows[0],'identity':rows[1]}
    if source['inspection_contract']=='production-free-v2':payload['expected']=expected
    verified=json.loads(runtime.command(['/usr/bin/node',str(helper),'verify',str(master)],input=json.dumps(payload)))
    p.require(verified['environment']=='production' and verified['master_key_sha256']==source['private_pins']['state/master.key']['sha256'],
              'PRODUCTION_RESTORE_VERIFY_IDENTITY_INVALID')
    p.require(isinstance(verified.get('audit'),dict) and verified['audit']
              and all(type(value) is int and value==0 for value in verified['audit'].values()),
              'PRODUCTION_RESTORE_PENDING_OBLIGATIONS')
    if source['inspection_contract']=='production-free-v2':
        p.require(verified.get('inspection_contract')==source['inspection_contract']
                  and verified.get('profile_snapshot',{}).get('runtime_profile')==source['runtime_profile']
                  and re.fullmatch('[a-f0-9]{64}',verified.get('profile_snapshot_sha256','')),
                  'PRODUCTION_RESTORE_PROFILE_VERIFY_INVALID')
    again=p.verify_historical_release(Path(source['release']),source['manifest_sha256'],source['helpers'])
    p.require(again.get('inspection_closure')==source['inspection_closure'], 'PRODUCTION_INSPECTION_SOURCE_CHANGED')
    return verified

def archive_identity(archive,source,current_env):
    """Return only public proof; archive bytes/secrets stay in this process."""
    with tarfile.open(archive,'r:gz') as tar:
        members=tar.getmembers();p.require(len(members)==3 and {member.name for member in members}==set(ARCHIVE_MEMBERS),
                                        'PRODUCTION_BACKUP_PRIVATE_ARCHIVE_INVALID')
        saved={}
        for member in members:
            private_name=ARCHIVE_MEMBERS[member.name];pin=source['private_pins'][private_name]
            p.require(member.isfile() and member.mode==0o600 and 0<member.size<=16384
                      and member.size==pin['bytes'] and member.uid==pin['uid'] and member.gid==pin['gid'],
                      'PRODUCTION_BACKUP_PRIVATE_ARCHIVE_INVALID')
            body=tar.extractfile(member).read();p.require(p.digest(body)==pin['sha256'],'PRODUCTION_BACKUP_ARCHIVED_CONFIG_CHANGED')
            saved[private_name]=body
        p.require(len(saved['state/master.key'])==32,'PRODUCTION_BACKUP_MASTER_INVALID')
        env=contract(a.parse_env_text,saved['runtime.env'].decode('utf8'))
        contract(a.archive_runtime,env,current_env,source['runtime_profile'])
        postgres=contract(a.parse_env_text,saved['postgres.env'].decode('utf8'))
        p.require(postgres.get('POSTGRES_USER')==p.DB_OWNER and postgres.get('POSTGRES_DB')==p.DATABASE
                  and bool(postgres.get('POSTGRES_PASSWORD')),'PRODUCTION_ARCHIVE_POSTGRES_SCOPE_INVALID')
        return {'master_key_sha256':p.digest(saved['state/master.key']),
                'runtime_env_sha256':p.digest(saved['runtime.env']),'postgres_env_sha256':p.digest(saved['postgres.env']),
                'runtime_profile':source['runtime_profile']}

def backup(marker,runtime):
    resources=owned_resources(marker,runtime);p.require(resources['running'],'PRODUCTION_PG_NOT_RUNNING')
    identity=database_identity(marker,runtime)
    source=backup_source(marker,marker['release'],marker['manifest_sha256'])
    p.require(source['private_pins']==marker['private_pins'],'PRODUCTION_CURRENT_HISTORY_PINS_CHANGED')
    before=inspect_database(marker,runtime,p.DATABASE,source,p.PRIVATE/'state/master.key')
    timestamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    final=p.BACKUPS/timestamp
    backupdir=p.BACKUPS/('.building-'+timestamp+'-'+secrets.token_hex(8))
    p.no_mount(p.BACKUPS)
    root=p.BACKUPS.lstat();p.require(root.st_uid==0 and stat.S_IMODE(root.st_mode)==0o700,'PRODUCTION_BACKUP_PARENT_UNSAFE')
    backupdir.mkdir(mode=0o700)
    # pg_dump and private key form the complete restore pair; never archive /opt/oasis/private.
    dump=runtime.command(['docker','exec',marker['container_id'],'pg_dump','-U',p.DB_OWNER,'-d',p.DATABASE,'--format=custom','--no-owner','--no-acl'],binary=True,timeout=180)
    p.require(len(dump)>1024 and dump.startswith(b'PGDMP'),'PRODUCTION_BACKUP_DUMP_INVALID')
    p.exclusive(backupdir/'database.dump',dump)
    archive=backupdir/'private-config.tar.gz'
    with tarfile.open(archive,'x:gz') as tar:
        for name,private_name in ARCHIVE_MEMBERS.items():
            file=p.PRIVATE/private_name;meta=p.fingerprint(file)
            p.require(meta['mode']==0o600,'PRODUCTION_BACKUP_PRIVATE_MODE_INVALID')
            tar.add(file,arcname=name,recursive=False)
    os.chmod(archive,0o600)
    p.exclusive(backupdir/'release.txt',(marker['release']+'\n').encode())
    contents=runtime.command(['docker','exec','-i',marker['container_id'],'pg_restore','--list'],input=dump,binary=True,timeout=60)
    p.require(contents,'PRODUCTION_BACKUP_CONTENTS_EMPTY');p.exclusive(backupdir/'database-contents.txt',contents)
    after=inspect_database(marker,runtime,p.DATABASE,source,p.PRIVATE/'state/master.key')
    p.require(before.get('profile_snapshot_sha256')==after.get('profile_snapshot_sha256'),
              'PRODUCTION_BACKUP_ADMISSION_CHANGED')
    archived=archive_identity(archive,source,p.parse_env(p.PRIVATE/'runtime.env'))
    receipt={'schema':2,'at':p.now(),'environment':'production','database':p.DATABASE,**identity,
             'owner':marker['owner'],'container_id':marker['container_id'],'release':marker['release'],
             'manifest_sha256':marker['manifest_sha256'],'master_key_sha256':p.fingerprint(p.PRIVATE/'state/master.key')['sha256'],
             'inspection_contract':source['inspection_contract'],'helpers':source['helpers'],
             'inspection_closure':source['inspection_closure'],'runtime_profile':source['runtime_profile'],
             'archive_identity':archived,'profile_snapshot_sha256':after.get('profile_snapshot_sha256'),
             'live_before':before,'live_after':after,
             'snapshot_scope':'Live before/after observations are not the pg_dump snapshot; the restored dump must independently pass its bound inspection.'}
    p.exclusive(backupdir/'runtime-identity.json',p.canonical(receipt))
    checks=''.join(p.fingerprint(backupdir/name)['sha256']+'  '+name+'\n' for name in BACKUP_FILES)
    owned_resources(marker,runtime)
    p.exclusive(backupdir/'SHA256SUMS',checks.encode())
    # Only a completely verified backup becomes a monitor-visible timestamp.
    # Linux renameat2(NO_REPLACE) cannot overwrite even an empty unknown directory.
    import ctypes,errno
    libc=ctypes.CDLL(None,use_errno=True)
    rename=getattr(libc,'renameat2',None);p.require(rename is not None,'PRODUCTION_BACKUP_ATOMIC_PUBLISH_UNAVAILABLE')
    code=rename(-100,os.fsencode(backupdir),-100,os.fsencode(final),1)
    p.require(code==0,'PRODUCTION_BACKUP_TIMESTAMP_EXISTS' if ctypes.get_errno()==errno.EEXIST else 'PRODUCTION_BACKUP_PUBLISH_FAILED')
    return {'path':str(final),'environment':'production','database':p.DATABASE,'runtime_identity_sha256':p.fingerprint(final/'runtime-identity.json')['sha256'],'checksums_sha256':p.fingerprint(final/'SHA256SUMS')['sha256']}

def validate_backup(marker,backupdir):
    p.require(re.fullmatch(re.escape(str(p.BACKUPS))+r'/\d{8}T\d{6}Z',str(backupdir)),'PRODUCTION_BACKUP_PATH_INVALID')
    p.no_mount(backupdir)
    s=backupdir.lstat();p.require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'PRODUCTION_BACKUP_DIRECTORY_UNSAFE')
    p.require({x.name for x in backupdir.iterdir()}==set(BACKUP_FILES)|{'SHA256SUMS'},'PRODUCTION_BACKUP_UNKNOWN_MEMBER')
    checksum_meta=p.fingerprint(backupdir/'SHA256SUMS')
    p.require(checksum_meta['uid']==0 and checksum_meta['mode']==0o600 and checksum_meta['bytes']>0,
              'PRODUCTION_BACKUP_CHECKSUM_FILE_UNSAFE')
    checks={}
    for row in (backupdir/'SHA256SUMS').read_text().splitlines():
        m=re.fullmatch('([a-f0-9]{64})  ([a-zA-Z0-9.-]+)',row)
        p.require(m and m[2] in BACKUP_FILES and m[2] not in checks,'PRODUCTION_BACKUP_CHECKSUM_MANIFEST_INVALID')
        checks[m[2]]=m[1]
    p.require(set(checks)==set(BACKUP_FILES),'PRODUCTION_BACKUP_CHECKSUM_MANIFEST_INVALID')
    for name,expected in checks.items():
        meta=p.fingerprint(backupdir/name);p.require(meta['sha256']==expected and meta['mode']==0o600 and meta['uid']==0,'PRODUCTION_BACKUP_CHECKSUM_OR_MODE_INVALID')
    identity=json.loads((backupdir/'runtime-identity.json').read_text())
    p.require(identity.get('schema') in (1,2) and identity['environment']=='production' and identity['database']==p.DATABASE
              and identity['owner']==marker['owner'] and identity['container_id']==marker['container_id']
              and identity['master_key_sha256']==marker['private_pins']['state/master.key']['sha256'],
              'PRODUCTION_BACKUP_IDENTITY_MISMATCH')
    p.require((backupdir/'release.txt').read_text()==identity['release']+'\n','PRODUCTION_BACKUP_RELEASE_FILE_CHANGED')
    selector={}
    if identity['schema']==2:
        archived_selector=identity.get('archive_identity')
        p.require(isinstance(archived_selector,dict),'PRODUCTION_BACKUP_CONFIGURATION_SELECTOR_REQUIRED')
        selector={'runtime_env_sha':archived_selector.get('runtime_env_sha256'),
                  'runtime_profile_selector':identity.get('runtime_profile')}
    source=backup_source(marker,identity['release'],identity['manifest_sha256'],**selector)
    archived=archive_identity(backupdir/'private-config.tar.gz',source,p.parse_env(p.PRIVATE/'runtime.env'))
    p.require(archived['master_key_sha256']==identity['master_key_sha256'],'PRODUCTION_BACKUP_MASTER_MISMATCH')
    if identity['schema']==1:p.require(source['inspection_contract']=='production-closed-v1','PRODUCTION_LEGACY_BACKUP_CONTRACT_CHANGED')
    else:
        p.require(identity.get('inspection_contract')==source['inspection_contract'] and identity.get('helpers')==source['helpers']
                  and identity.get('inspection_closure')==source['inspection_closure'] and identity.get('runtime_profile')==source['runtime_profile']
                  and identity.get('archive_identity')==archived,'PRODUCTION_BACKUP_PROFILE_OR_HELPER_CHANGED')
    return {**identity,'approved_source':source}

def extract_master(archive,destination):
    with tarfile.open(archive,'r:gz') as tar:
        members=tar.getmembers();p.require(len(members)==3 and {m.name for m in members}==set(ARCHIVE_MEMBERS),'PRODUCTION_BACKUP_PRIVATE_ARCHIVE_INVALID')
        p.require(all(m.isfile() and m.mode==0o600 and 0<m.size<=16384 for m in members),'PRODUCTION_BACKUP_PRIVATE_ARCHIVE_INVALID')
        m=next(m for m in members if m.name.endswith('/master.key'))
        body=tar.extractfile(m).read();p.require(len(body)==32,'PRODUCTION_BACKUP_MASTER_INVALID')
        p.exclusive(destination,body)

def restore(marker,backupdir,runtime):
    owned_resources(marker,runtime);identity=validate_backup(marker,backupdir)
    name='oasis_prod_restore_'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')+'_'+secrets.token_hex(8)
    result={'schema':1,'at':p.now(),'kind':'isolated-production-restore','passed':False,'database':name,'backup':str(backupdir),'cleanup':{'database_created':False,'database_removed':False,'temporary_removed':False}}
    created_oid=None;temporary=None;create_attempted=False
    try:
        existing=sql(runtime,marker,p.DATABASE,f"SELECT oid FROM pg_database WHERE datname='{name}';").strip()
        p.require(not existing,'PRODUCTION_RESTORE_DATABASE_EXISTS')
        temporary=Path(tempfile.mkdtemp(prefix='oasis-prod-drill-',dir='/tmp'));os.chmod(temporary,0o700)
        extract_master(backupdir/'private-config.tar.gz',temporary/'master.key')
        p.require(p.fingerprint(temporary/'master.key')['sha256']==identity['master_key_sha256'],'PRODUCTION_RESTORE_MASTER_MISMATCH')
        create_attempted=True
        sql(runtime,marker,p.DATABASE,f'CREATE DATABASE {name} OWNER {p.DB_OWNER} TEMPLATE template0; REVOKE CONNECT ON DATABASE {name} FROM PUBLIC;')
        created_oid=sql(runtime,marker,p.DATABASE,f"SELECT oid FROM pg_database WHERE datname='{name}';").strip()
        p.require(re.fullmatch('[0-9]+',created_oid),'PRODUCTION_RESTORE_CREATE_UNCONFIRMED');result['cleanup']['database_created']=True
        runtime.command(['docker','exec','-i',marker['container_id'],'pg_restore','--exit-on-error','--single-transaction','--no-owner','--no-acl','-U',p.DB_OWNER,'-d',name],input=(backupdir/'database.dump').read_bytes(),binary=True,timeout=180)
        source=identity['approved_source'];verified=inspect_database(marker,runtime,name,source,temporary/'master.key')
        if identity['schema']==2:p.require(verified.get('profile_snapshot_sha256')==identity.get('profile_snapshot_sha256'),
                                         'PRODUCTION_RESTORE_PROFILE_SNAPSHOT_CHANGED')
        result.update(inspection_contract=source['inspection_contract'],source_release=source['release'],
                      source_manifest_sha256=source['manifest_sha256'],inspection_closure=source['inspection_closure'])
        result['checks']=verified;result['passed']=True
    except Exception as error:
        result['error_code']=str(error) if isinstance(error,p.Refusal) else 'PRODUCTION_RESTORE_FAILED'
    finally:
        if created_oid:
            try:
                owned_resources(marker,runtime)
                current=sql(runtime,marker,p.DATABASE,f"SELECT json_build_object('oid',oid,'active',(SELECT count(*) FROM pg_stat_activity WHERE datname='{name}')) FROM pg_database WHERE datname='{name}';").strip()
                row=json.loads(current);p.require(str(row['oid'])==created_oid and row['active']==0,'PRODUCTION_RESTORE_DROP_IDENTITY_OR_CONSUMER_CHANGED')
                # Same psql connection rechecks OID, root-only owner and absence of
                # consumers immediately before DROP. No FORCE/terminate is permitted.
                guarded=f"""SELECT COALESCE((SELECT oid={created_oid} AND datdba=(SELECT oid FROM pg_roles WHERE rolname='{p.DB_OWNER}') AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='{name}') FROM pg_database WHERE datname='{name}'),false) AS can_drop
\\gset
\\if :can_drop
DROP DATABASE {name};
\\else
DO $guard$ BEGIN RAISE EXCEPTION 'RESTORE_DROP_SCOPE_CHANGED'; END $guard$;
\\endif
"""
                sql(runtime,marker,p.DATABASE,guarded)
                result['cleanup']['database_removed']=not sql(runtime,marker,p.DATABASE,f"SELECT oid FROM pg_database WHERE datname='{name}';").strip()
                p.require(result['cleanup']['database_removed'],'PRODUCTION_RESTORE_DATABASE_CLEANUP_FAILED')
            except Exception:
                result.update(passed=False,cleanup_error='PRODUCTION_RESTORE_DATABASE_CLEANUP_FAILED')
        elif create_attempted:
            result.update(passed=False,cleanup_error='PRODUCTION_RESTORE_CREATE_UNCONFIRMED')
        if temporary:
            try:
                p.no_mount(temporary)
                members={x.name for x in temporary.iterdir()}
                p.require(members<= {'master.key'},'PRODUCTION_RESTORE_TEMP_SCOPE_CHANGED')
                if 'master.key' in members:
                    p.fingerprint(temporary/'master.key');(temporary/'master.key').unlink()
                temporary.rmdir()
                result['cleanup']['temporary_removed']=not temporary.exists()
            except Exception:
                result.update(passed=False,private_cleanup_error='PRODUCTION_RESTORE_TEMP_CLEANUP_FAILED')
    result['finished_at']=p.now()
    reports=p.PRIVATE/'restore-drills'
    if not reports.exists():reports.mkdir(mode=0o700)
    p.no_mount(reports)
    p.exclusive(reports/(name+'.json'),p.canonical(result))
    return result

def main():
    args=argparse.ArgumentParser(description=__doc__);args.add_argument('mode',choices=('backup','restore'));args.add_argument('--backup');options=args.parse_args()
    os.umask(0o077)
    try:
        p.require(os.getuid()==0,'ROOT_REQUIRED');marker=load_marker();runtime=p.Runtime()
        with operations_lock():
            result=backup(marker,runtime) if options.mode=='backup' else restore(marker,Path(options.backup or ''),runtime)
        print(json.dumps(result,sort_keys=True));return 0 if result.get('passed',True) else 2
    except Exception as error:
        print(json.dumps({'passed':False,'error_code':str(error) if isinstance(error,p.Refusal) else 'PRODUCTION_OPERATIONS_FAILED'}));return 2

if __name__=='__main__':
    raise SystemExit(main())

"""Exact Mock04 -> public15 database contract, not a general migration runner.

The caller owns service/admission shutdown and the deployment lock. ``sql`` must
execute one supplied script in one fixed Mock-database psql -XqAt session with
ON_ERROR_STOP; it must never split a transaction or retry a failed call. Only two
public DDL statements are permitted. No DROP, restore or business-row write.

Snapshots contain hashes, not rows/keys. Every public ordinary/partitioned table
and sequence is covered; private Run history is hashed separately so adding a
nullable field has an exactly comparable old-row projection. Complete catalog
metadata is compared with the original guarded baseline. ``schema_kind=old``
means the additive pair is absent, not that arbitrary preexisting schema drift
has been independently authenticated against a pristine database.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat

FORMAT = 'mock-view-database-v1'
OLD_SQL_SHA = '41bcb2151c87f031f848593f03430186502adfe32810b6e2a944ee52c176e3ad'
NEW_SQL_SHA = 'eb7a9ebdf9862f4421af1941199b5ff1f07ec3fb646e03042fd4da1bae49817f'
AUDIT_SOURCE_SHA = '971679915e6bb7afd962048b4ff8b8ef5e737821441da7fcc293a1b5430a0682'
EMPTY_SHA = hashlib.sha256(b'').hexdigest()
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
INTEGRITY = ('balance_mismatches', 'scope_mismatches', 'unbalanced_transactions',
             'ledger_version_mismatches', 'orphan_records', 'invalid_constraints')
AUDIT_FIELDS = (*INTEGRITY, 'pending_cycles', 'pending_probability_operations',
                'pending_pvp_operations', 'active_rooms', 'pending_wallet_operations')
PENDING_FIELDS = ('presentations', 'integration_checks', 'reservations', 'wallet_matches',
                  'wallet_probability', 'reserved_balances')
DECISIONS = 'pvp_run_input_decisions'
NEW_COLUMN = 'run_input_state'
DDL = """ALTER TABLE public.pvp_rooms ADD COLUMN run_input_state jsonb;
CREATE TABLE public.pvp_run_input_decisions (
 room_id text NOT NULL REFERENCES public.pvp_rooms(id) ON DELETE CASCADE,
 external_user_id text NOT NULL,command_seq bigint NOT NULL CHECK(command_seq>0),
 decision jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,external_user_id,command_seq)
);"""


def require(value, code):
    if not value:
        raise RuntimeError(code)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def read_verified(root, relative, expected):
    root = Path(root)
    require(root.is_absolute(), 'VIEW_DATABASE_ABSOLUTE_SOURCE_REQUIRED')
    path = root / relative
    for part in (path, *path.parents):
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'VIEW_DATABASE_SOURCE_SYMLINK')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024,
            'VIEW_DATABASE_SOURCE_NOT_REGULAR')
    def fingerprint(value):
        return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
                value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        require(fingerprint(os.fstat(stream.fileno())) == fingerprint(info), 'VIEW_DATABASE_SOURCE_CHANGED_DURING_READ')
        raw = stream.read(1024 * 1024 + 1)
        require(fingerprint(os.fstat(stream.fileno())) == fingerprint(info), 'VIEW_DATABASE_SOURCE_CHANGED_DURING_READ')
    require(hashlib.sha256(raw).hexdigest() == expected, 'VIEW_DATABASE_SOURCE_CHANGED')
    require(fingerprint(path.lstat()) == fingerprint(info), 'VIEW_DATABASE_SOURCE_CHANGED_DURING_READ')
    return raw.decode('utf8')


def _json(raw):
    require(isinstance(raw, str) and len(raw.encode()) <= MAX_SNAPSHOT_BYTES,
            'VIEW_DATABASE_INVALID_OUTPUT')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'VIEW_DATABASE_DUPLICATE_KEY')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError) as exc:
        raise RuntimeError('VIEW_DATABASE_INVALID_JSON') from exc


# No OIDs, row bodies or unstable pg_stat counters. Internal FK triggers and
# table row/array types are represented by their owning constraints/relations;
# user triggers, functions, policies, grants and default privileges are retained.
CATALOG = """
SELECT jsonb_build_object(
 'namespace',(SELECT jsonb_build_object('owner',pg_get_userbyid(nspowner),'acl',nspacl::text)
              FROM pg_namespace WHERE nspname='public'),
 'relations',COALESCE((SELECT jsonb_object_agg(c.relname,jsonb_build_object(
   'kind',c.relkind::text,'persistence',c.relpersistence::text,'owner',pg_get_userbyid(c.relowner),
   'access_method',am.amname,'tablespace',ts.spcname,'options',c.reloptions,'acl',c.relacl::text,
   'row_security',c.relrowsecurity,'force_row_security',c.relforcerowsecurity,
   'replica_identity',c.relreplident::text,'partition',c.relispartition,
   'partition_key',pg_get_partkeydef(c.oid),'partition_bound',pg_get_expr(c.relpartbound,c.oid),
   'view',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END))
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_am am ON am.oid=c.relam LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')), '{}'::jsonb),
 'columns',COALESCE((SELECT jsonb_object_agg(name,columns) FROM (
   SELECT c.relname name,jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity::text,
    'generated',a.attgenerated::text,'collation',CASE WHEN co.oid IS NOT NULL THEN cn.nspname||'.'||co.collname ELSE NULL END,
    'storage',a.attstorage::text,'compression',a.attcompression::text,'statistics',a.attstattarget,
    'options',a.attoptions,'acl',a.attacl::text,'dropped',a.attisdropped) ORDER BY a.attnum) columns
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
   LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
   LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 GROUP BY c.relname
 ) q),'{}'::jsonb),
 'constraints',COALESCE((SELECT jsonb_object_agg(name,items) FROM (
   SELECT r.relname name,jsonb_agg(jsonb_build_object('name',c.conname,'kind',c.contype::text,
    'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated,'deferrable',c.condeferrable,
    'deferred',c.condeferred) ORDER BY c.conname) items
   FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
   WHERE n.nspname='public' GROUP BY r.relname) q),'{}'::jsonb),
 'indexes',COALESCE((SELECT jsonb_object_agg(name,items) FROM (
   SELECT r.relname name,jsonb_agg(jsonb_build_object('name',i.relname,'definition',pg_get_indexdef(i.oid),
    'valid',x.indisvalid,'ready',x.indisready,'live',x.indislive,'clustered',x.indisclustered,
    'replica_identity',x.indisreplident,'options',i.reloptions,'tablespace',s.spcname) ORDER BY i.relname) items
   FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class r ON r.oid=x.indrelid
   JOIN pg_namespace n ON n.oid=r.relnamespace LEFT JOIN pg_tablespace s ON s.oid=i.reltablespace
   WHERE n.nspname='public' GROUP BY r.relname) q),'{}'::jsonb),
 'sequences',COALESCE((SELECT jsonb_object_agg(c.relname,jsonb_build_object(
    'type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,
    'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
    'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'persistence',c.relpersistence::text,
    'owned_by',(SELECT rn.nspname||'.'||r.relname||'.'||a.attname FROM pg_depend dep
      JOIN pg_class r ON r.oid=dep.refobjid JOIN pg_namespace rn ON rn.oid=r.relnamespace
      JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=dep.refobjsubid
      WHERE dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.deptype IN ('a','i') LIMIT 1)))
   FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),'{}'::jsonb),
 'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,
    'enabled',t.tgenabled::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal),'[]'::jsonb),
 'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',r.rulename,
    'enabled',r.ev_enabled::text,'definition',pg_get_ruledef(r.oid)) ORDER BY c.relname,r.rulename)
    FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND r.rulename<>'_RETURN'),'[]'::jsonb),
 'routines',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
    'kind',p.prokind::text,'definition',CASE WHEN p.prokind<>'a' THEN pg_get_functiondef(p.oid) ELSE NULL END,
    'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'[]'::jsonb),
 'policies',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),'[]'::jsonb),
 'default_privileges',COALESCE((SELECT jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),
    'namespace',CASE WHEN d.defaclnamespace=0 THEN '*' ELSE 'public' END,
    'kind',d.defaclobjtype::text,'acl',d.defaclacl::text) ORDER BY pg_get_userbyid(d.defaclrole),d.defaclnamespace,d.defaclobjtype)
    FROM pg_default_acl d WHERE d.defaclnamespace IN (0,(SELECT oid FROM pg_namespace WHERE nspname='public'))),'[]'::jsonb),
 'extensions',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,
    'owner',pg_get_userbyid(e.extowner),'relocatable',e.extrelocatable) ORDER BY e.extname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname='public'),'[]'::jsonb),
 'event_triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.evtname,'event',e.evtevent,
    'enabled',e.evtenabled::text,'tags',e.evttags,'owner',pg_get_userbyid(e.evtowner),
    'function',e.evtfoid::regprocedure::text) ORDER BY e.evtname) FROM pg_event_trigger e),'[]'::jsonb),
 'unsupported_types',COALESCE((SELECT jsonb_agg(t.typname ORDER BY t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typtype IN ('d','e','r','m')),'[]'::jsonb),
 'unsupported_collations',COALESCE((SELECT jsonb_agg(c.collname ORDER BY c.collname) FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public'),'[]'::jsonb)
) AS value
"""


def snapshot_query(audit_sql):
    # query_to_xml executes only fixed SELECTs with identifiers formatted by %I.
    # XML exposes count/hash/sequence scalars, never raw business rows.
    return """WITH catalog AS (""" + CATALOG + """), data AS MATERIALIZED (
 SELECT c.relname,query_to_xml(format(
  'SELECT count(*) AS rows,encode(sha256(convert_to(COALESCE(string_agg((to_jsonb(t)%s)::text,E''\\n'' ORDER BY (to_jsonb(t)%s)::text),''''),''UTF8'')),''hex'') AS sha FROM public.%I t',
  CASE WHEN c.relname='pvp_rooms' THEN ' - ''run_input_state''' ELSE '' END,
  CASE WHEN c.relname='pvp_rooms' THEN ' - ''run_input_state''' ELSE '' END,c.relname),true,false,'') x
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
), sequence_data AS MATERIALIZED (
 SELECT c.relname,query_to_xml(format('SELECT last_value,is_called FROM public.%I',c.relname),true,false,'') x
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'
), audit AS (""" + audit_sql.rstrip().rstrip(';') + """), table_summary AS (
 SELECT COALESCE(jsonb_object_agg(relname,jsonb_build_object('rows',((xpath('/table/row/rows/text()',x))[1]::text)::bigint,
 'sha256',(xpath('/table/row/sha/text()',x))[1]::text)),'{}'::jsonb) value FROM data
)
SELECT jsonb_build_object('format','mock-view-database-v1',
 'database',current_database(),'schema',(SELECT value FROM catalog),'tables',(SELECT value FROM table_summary),
 'sequences',COALESCE((SELECT jsonb_object_agg(relname,jsonb_build_object('last_value',(xpath('/table/row/last_value/text()',x))[1]::text,
   'is_called',((xpath('/table/row/is_called/text()',x))[1]::text)::boolean)) FROM sequence_data),'{}'::jsonb),
 'audit',(SELECT json_build_object FROM audit),
 'pending',jsonb_build_object(
  'presentations',(SELECT count(*) FROM gp_sessions s LEFT JOIN gp_cycles c ON c.id=s.state->>'cycleId'
    WHERE s.state->>'pendingPlay' IS NOT NULL OR COALESCE((s.state->>'nextIndex')::int,0)<COALESCE(jsonb_array_length(c.result->'rounds'),0)),
  'integration_checks',(SELECT count(*) FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING')),
  'reservations',(SELECT count(*) FROM wallet_reservations WHERE state='RESERVED'),
  'wallet_matches',(SELECT count(*) FROM wallet_matches WHERE state NOT IN ('SETTLED','VOIDED','CANCELLED')),
  'wallet_probability',(SELECT count(*) FROM wallet_probability WHERE state NOT IN ('SETTLED','CANCELLED','EXPIRED')),
  'reserved_balances',(SELECT count(*) FROM wallet_users WHERE reserved<>0 OR credit_pending<>0)),
 'run_v23',jsonb_build_object(
  'rooms',(SELECT count(*) FROM pvp_rooms WHERE rule_version='pvp-run-v2.3.0'),
  'decisions',COALESCE((SELECT (value->'pvp_run_input_decisions'->>'rows')::bigint FROM table_summary),0),
  'private_histories',(SELECT count(*) FROM pvp_rooms r WHERE to_jsonb(r)->'run_input_state' IS NOT NULL AND to_jsonb(r)->'run_input_state'<>'null'::jsonb),
  'private_history_sha256',(SELECT encode(sha256(convert_to(COALESCE(string_agg(jsonb_build_array(id,to_jsonb(r)->'run_input_state')::text,E'\\n' ORDER BY id),''),'UTF8')),'hex')
   FROM pvp_rooms r WHERE to_jsonb(r)->'run_input_state' IS NOT NULL AND to_jsonb(r)->'run_input_state'<>'null'::jsonb)
 )) AS snapshot"""


def expected_schema(old):
    result = copy.deepcopy(old)
    require(DECISIONS not in result['relations'] and NEW_COLUMN not in [v['name'] for v in result['columns']['pvp_rooms']],
            'VIEW_DATABASE_OLD_SCHEMA_REQUIRED')
    def column(table, name, renamed):
        value = copy.deepcopy(next(v for v in result['columns'][table] if v['name'] == name))
        value['name'] = renamed
        return value
    result['columns']['pvp_rooms'].append(column('pvp_rooms', 'game_state', NEW_COLUMN))
    relation = copy.deepcopy(result['relations']['pvp_rooms'])
    require(relation['kind'] == 'r' and not relation['partition'] and relation['options'] is None
            and relation['acl'] is None and relation['replica_identity'] == 'd'
            and not relation['row_security'] and not relation['force_row_security'], 'VIEW_DATABASE_UNREVIEWED_ROOM_STORAGE')
    result['relations'][DECISIONS] = relation
    result['columns'][DECISIONS] = [column('pvp_rooms', 'id', 'room_id'), column('pvp_actions', 'external_user_id', 'external_user_id'),
        column('pvp_actions', 'seq', 'command_seq'), column('pvp_rooms', 'terms', 'decision'), column('pvp_rooms', 'created_at', 'created_at')]
    common = {'validated': True, 'deferrable': False, 'deferred': False}
    result['constraints'][DECISIONS] = [dict(common, name=DECISIONS+'_command_seq_check', kind='c', definition='CHECK ((command_seq > 0))'),
        dict(common, name=DECISIONS+'_pkey', kind='p', definition='PRIMARY KEY (room_id, external_user_id, command_seq)'),
        dict(common, name=DECISIONS+'_room_id_fkey', kind='f', definition='FOREIGN KEY (room_id) REFERENCES pvp_rooms(id) ON DELETE CASCADE')]
    result['indexes'][DECISIONS] = [{'name': DECISIONS+'_pkey',
        'definition': 'CREATE UNIQUE INDEX pvp_run_input_decisions_pkey ON public.pvp_run_input_decisions USING btree (room_id, external_user_id, command_seq)',
        'valid': True, 'ready': True, 'live': True, 'clustered': False, 'replica_identity': False, 'options': None, 'tablespace': None}]
    return result


class ViewDatabase:
    def __init__(self, sql, old_release, new_release):
        require(callable(sql), 'VIEW_DATABASE_SQL_REQUIRED')
        self.sql = sql
        self.sources = ((Path(old_release), OLD_SQL_SHA), (Path(new_release), NEW_SQL_SHA))
        self._verify_sources()
        text = read_verified(self.sources[0][0], 'platform/deploy/restore-drill.mjs', AUDIT_SOURCE_SHA)
        matches = re.findall(r'export const RESTORE_AUDIT_SQL=`(.*?)`;', text, re.S)
        require(len(matches) == 1, 'VIEW_DATABASE_AUDIT_SOURCE_INVALID')
        self.query = snapshot_query(matches[0])

    def _verify_sources(self):
        for root, pin in self.sources:
            read_verified(root, 'platform/server/pvp/schema.sql', pin)
            read_verified(root, 'platform/deploy/restore-drill.mjs', AUDIT_SOURCE_SHA)

    @staticmethod
    def _validate(value):
        require(isinstance(value, dict) and set(value) == {'format', 'database', 'schema', 'tables', 'sequences', 'audit', 'pending', 'run_v23', 'schema_kind'}
                and value['format'] == FORMAT and isinstance(value['database'], str), 'VIEW_DATABASE_INVALID_SNAPSHOT')
        require(set(value['audit']) == set(AUDIT_FIELDS) and set(value['pending']) == set(PENDING_FIELDS), 'VIEW_DATABASE_INCOMPLETE_AUDIT')
        require(all(type(v) is int and v >= 0 for group in ('audit', 'pending') for v in value[group].values()), 'VIEW_DATABASE_INVALID_AUDIT')
        require(all(value['audit'][key] == 0 for key in INTEGRITY), 'VIEW_DATABASE_INTEGRITY_DRIFT')
        schema = value['schema']
        require(not schema['unsupported_types'] and not schema['unsupported_collations'] and not schema['event_triggers']
                and all(r['kind'] in ('r', 'p', 'v') for r in schema['relations'].values())
                and all(r['kind'] != 'a' for r in schema['routines']), 'VIEW_DATABASE_UNSUPPORTED_SCHEMA_OBJECT')
        tables = {name for name, r in schema['relations'].items() if r['kind'] in ('r', 'p')}
        require(set(value['tables']) == tables and set(value['sequences']) == set(schema['sequences']), 'VIEW_DATABASE_INCOMPLETE_DATA')
        for row in value['tables'].values():
            require(set(row) == {'rows', 'sha256'} and type(row['rows']) is int and row['rows'] >= 0
                    and isinstance(row['sha256'], str) and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'VIEW_DATABASE_INVALID_TABLE_DIGEST')
            require(row['rows'] != 0 or row['sha256'] == EMPTY_SHA, 'VIEW_DATABASE_INVALID_EMPTY_TABLE')
        for row in value['sequences'].values():
            require(set(row) == {'last_value', 'is_called'} and isinstance(row['last_value'], str)
                    and re.fullmatch('-?[0-9]+', row['last_value']) and type(row['is_called']) is bool, 'VIEW_DATABASE_INVALID_SEQUENCE')
        run = value['run_v23']
        require(set(run) == {'rooms', 'decisions', 'private_histories', 'private_history_sha256'}
                and all(type(run[k]) is int and run[k] >= 0 for k in ('rooms', 'decisions', 'private_histories'))
                and re.fullmatch('[a-f0-9]{64}', run['private_history_sha256']), 'VIEW_DATABASE_INVALID_RUN_SUMMARY')
        require(run['decisions'] == value['tables'].get(DECISIONS, {'rows': 0})['rows'], 'VIEW_DATABASE_DECISION_COUNT_CHANGED')
        require(run['rooms'] <= value['tables']['pvp_rooms']['rows']
                and run['private_histories'] <= value['tables']['pvp_rooms']['rows']
                and (run['private_histories'] != 0 or run['private_history_sha256'] == EMPTY_SHA), 'VIEW_DATABASE_INVALID_RUN_SUMMARY')
        has_table = DECISIONS in schema['relations']
        has_column = any(c['name'] == NEW_COLUMN for c in schema['columns']['pvp_rooms'])
        require(has_table == has_column, 'VIEW_DATABASE_PARTIAL_MIGRATION')
        if not has_table:
            require(value['schema_kind'] == 'old', 'VIEW_DATABASE_INVALID_SCHEMA_KIND')
            expected_schema(schema)  # Verify the supported old room shape/storage.
            require(run['private_histories'] == 0 and run['private_history_sha256'] == EMPTY_SHA,
                    'VIEW_DATABASE_PRIVATE_HISTORY_WITHOUT_SCHEMA')
        else:
            require(value['schema_kind'] == 'migrated', 'VIEW_DATABASE_INVALID_SCHEMA_KIND')
            original = copy.deepcopy(schema)
            for key in ('relations', 'columns', 'constraints', 'indexes'):
                original[key].pop(DECISIONS, None)
            original['columns']['pvp_rooms'] = [c for c in original['columns']['pvp_rooms'] if c['name'] != NEW_COLUMN]
            require(expected_schema(original) == schema, 'VIEW_DATABASE_UNREVIEWED_ADDITIVE_SCHEMA')
        return value

    def _decode(self, raw):
        value = _json(raw)
        require(isinstance(value, dict) and 'schema_kind' not in value, 'VIEW_DATABASE_INVALID_OUTPUT')
        value['schema_kind'] = 'migrated' if DECISIONS in value['schema']['relations'] else 'old'
        return self._validate(value)

    def snapshot(self):
        self._verify_sources()
        return self._decode(self.sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='45s'; SET LOCAL search_path=pg_catalog,public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO';\n" + self.query + ';\nCOMMIT;'))

    @staticmethod
    def require_quiet(snapshot):
        ViewDatabase._validate(snapshot)
        require(all(v == 0 for group in ('audit', 'pending') for v in snapshot[group].values()), 'VIEW_DATABASE_PENDING_OBLIGATIONS')

    @staticmethod
    def allow_role(snapshot, role):
        ViewDatabase._validate(snapshot)
        require(role in ('origin', 'forward', 'rollback'), 'VIEW_DATABASE_UNKNOWN_ROLE')
        if role == 'forward':
            require(snapshot['schema_kind'] == 'migrated', 'VIEW_DATABASE_FORWARD_SCHEMA_REQUIRED')
        else:
            require(all(snapshot['run_v23'][key] == 0 for key in ('rooms', 'decisions', 'private_histories')),
                    'VIEW_DATABASE_NEW_RULE_REQUIRES_FORWARD')

    @staticmethod
    def _expected(baseline):
        ViewDatabase.require_quiet(baseline)
        require(baseline['schema_kind'] == 'old', 'VIEW_DATABASE_OLD_BASELINE_REQUIRED')
        ViewDatabase.allow_role(baseline, 'origin')
        result = copy.deepcopy(baseline)
        result['schema'] = expected_schema(result['schema'])
        result['schema_kind'] = 'migrated'
        result['tables'][DECISIONS] = {'rows': 0, 'sha256': EMPTY_SHA}
        return result

    @staticmethod
    def policy(snapshot, baseline):
        ViewDatabase._validate(snapshot)
        expected = ViewDatabase._expected(baseline)
        require(snapshot['database'] == baseline['database'], 'VIEW_DATABASE_IDENTITY_CHANGED')
        require(snapshot['schema'] == (baseline['schema'] if snapshot['schema_kind'] == 'old' else expected['schema']),
                'VIEW_DATABASE_SCHEMA_DRIFT')
        if snapshot == baseline:
            return 'old'
        if snapshot == expected:
            return 'migrated_empty'
        return 'new_business'

    def migration(self, old_baseline):
        self._verify_sources()
        expected = self._expected(old_baseline)
        owner = old_baseline['schema']['relations']['pvp_rooms']['owner']
        # The administrative SQL connection is not the application's DDL owner.
        # Only the exact guarded room owner can create the additive table; reject
        # exotic/reserved names rather than broadening this fixed Mock contract.
        require(isinstance(owner, str) and re.fullmatch('[a-z_][a-z0-9_]{0,62}', owner)
                and not owner.startswith('pg_'), 'VIEW_DATABASE_UNSAFE_OWNER')
        old = {k: v for k, v in old_baseline.items() if k != 'schema_kind'}
        new = {k: v for k, v in expected.items() if k != 'schema_kind'}
        # All owned controllers serialize, then lock every business table before
        # observing. The host controller must also stop writers; arbitrary DBA
        # concurrent DDL/nextval is not neutralized by an application advisory lock.
        script = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL search_path=pg_catalog,public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO';\n"
        script += "DO $mock_view_migration$ DECLARE locked_relation record; observed jsonb; ddl_owner record; initial_role text := current_user; BEGIN\n"
        script += "PERFORM pg_advisory_xact_lock(hashtextextended('oasis:mock:view-database',0));\n"
        script += 'SELECT * INTO ddl_owner FROM pg_roles WHERE rolname=' + literal(owner) + ';\n'
        script += "IF NOT FOUND OR ddl_owner.rolsuper OR ddl_owner.rolcreatedb OR ddl_owner.rolcreaterole OR ddl_owner.rolreplication OR ddl_owner.rolbypassrls THEN RAISE EXCEPTION 'VIEW_DATABASE_UNSAFE_OWNER_ROLE'; END IF;\n"
        script += "IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member=ddl_owner.oid) THEN RAISE EXCEPTION 'VIEW_DATABASE_UNREVIEWED_OWNER_MEMBERSHIP'; END IF;\n"
        script += "IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=initial_role) THEN RAISE EXCEPTION 'VIEW_DATABASE_EXECUTOR_ROLE_UNKNOWN'; END IF;\n"
        script += "FOR locked_relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname LOOP EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',locked_relation.relname); END LOOP;\n"
        script += 'SELECT snapshot INTO observed FROM (' + self.query + ') snapshot_read;\n'
        script += 'IF observed=' + literal(encoded(new)) + "::jsonb THEN RETURN; END IF;\n"
        script += 'IF observed<>' + literal(encoded(old)) + "::jsonb THEN RAISE EXCEPTION 'VIEW_DATABASE_BASELINE_CHANGED'; END IF;\n"
        script += "EXECUTE format('SET LOCAL ROLE %I',ddl_owner.rolname);\n"
        script += DDL + '\n'
        script += "EXECUTE format('SET LOCAL ROLE %I',initial_role);\n"
        script += "IF current_user<>initial_role THEN RAISE EXCEPTION 'VIEW_DATABASE_EXECUTOR_ROLE_NOT_RESTORED'; END IF;\n"
        script += 'SELECT snapshot INTO observed FROM (' + self.query + ') snapshot_read;\n'
        script += 'IF observed<>' + literal(encoded(new)) + "::jsonb THEN RAISE EXCEPTION 'VIEW_DATABASE_MIGRATION_POSTCONDITION'; END IF;\n"
        script += 'END $mock_view_migration$;\n' + self.query + ';\nCOMMIT;'
        result = self._decode(self.sql(script))
        require(self.policy(result, old_baseline) == 'migrated_empty', 'VIEW_DATABASE_MIGRATION_POSTCONDITION')
        return result

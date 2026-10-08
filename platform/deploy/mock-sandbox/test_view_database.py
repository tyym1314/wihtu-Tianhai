"""Explicit local PostgreSQL 14+ drill, not a remote/runtime adapter test.

python3 -B deploy/mock-sandbox/test_view_database.py
Requires the ignored verified 04/15 materials and local PG 127.0.0.1:5487.
Missing inputs/tools fail. Every test owns a random DB; no FORCE or shared DB.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
PLATFORM = HERE.parents[1]
spec = importlib.util.spec_from_file_location('mock_view_database_test', HERE / 'view_database.py')
database = importlib.util.module_from_spec(spec)
spec.loader.exec_module(database)
SOURCES = PLATFORM / 'review/mock-release-views-20261008/sources'
OLD, NEW = SOURCES / 'mock04', SOURCES / 'public15'


def sql(name, query):
    if name != 'postgres':
        assert re.fullmatch(r'oasis_release_test_[0-9]+_[a-f0-9]{12}', name)
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    process = subprocess.run(['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                              '-p', '5487', '-U', 'oasis_local', '-d', name],
                             input=query, text=True, capture_output=True, timeout=75, env=env)
    if process.returncode:
        raise RuntimeError(process.stderr.strip())
    return process.stdout.strip()


class ViewDatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Authenticate material before opening an owned DB. No skip/fallback.
        database.ViewDatabase(lambda _: None, OLD, NEW)
        cls.version = sql('postgres', 'SHOW server_version;')
        cls.created_names = []
        cls.removed_names = []
        cls.created_roles = []
        cls.removed_roles = []
        cls.old_schema = '\n'.join((OLD / name).read_text() for name in (
            'platform/server/schema.sql', 'platform/server/wallet/schema.sql', 'platform/server/pvp/schema.sql'))
        integration = (OLD / 'platform/server/integration-checks.mjs').read_text()
        match = re.search(r'export async function migrateIntegrationChecks\(\)\{await pool.query\(`(.*?)`\)', integration, re.S)
        assert match is not None
        cls.old_schema += '\n' + match[1]

    @classmethod
    def tearDownClass(cls):
        assert cls.created_names == cls.removed_names, 'Owned database cleanup incomplete'
        assert cls.created_roles == cls.removed_roles, 'Owned role cleanup incomplete'
        print(json.dumps({'postgres': cls.version, 'created': cls.created_names,
                          'removed': cls.removed_names, 'all_owned_databases_removed': True,
                          'created_roles': cls.created_roles, 'removed_roles': cls.removed_roles,
                          'all_owned_roles_removed': True}))

    def setUp(self):
        self.name = f'oasis_release_test_{os.getpid()}_{secrets.token_hex(6)}'
        self.created = False
        self.owner = f'oasis_view_owner_{os.getpid()}_{secrets.token_hex(6)}'
        self.owner_created = False
        self.calls = []
        self.addCleanup(self.cleanup)
        sql('postgres', f'CREATE ROLE "{self.owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;')
        self.owner_created = True
        self.created_roles.append(self.owner)
        sql('postgres', f'CREATE DATABASE "{self.name}";')
        self.created = True
        self.created_names.append(self.name)
        sql(self.name, f'REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO "{self.owner}"; SET ROLE "{self.owner}";\n' + self.old_schema + '\nRESET ROLE;')
        sql(self.name, """
          INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,game_ids)
           VALUES('app','synthetic','partner','sandbox','scope','["run"]');
          INSERT INTO gp_sessions(id,app_id,external_user_id,game_id) VALUES('session','app','human','run');
          INSERT INTO wallet_scopes(scope_id,partner_id,app_id,environment,wallet_scope_id,currency_id,treasury_available,ledger_version)
           VALUES('partner:app:sandbox:scope:COIN','partner','app','sandbox','scope','COIN',0,2);
          INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES('partner:app:sandbox:scope:COIN','human',500);
          INSERT INTO wallet_ledger(scope_id,operation_id,transaction_id,account,delta_available)
           VALUES('partner:app:sandbox:scope:COIN','synthetic','tx','user:human',500),
           ('partner:app:sandbox:scope:COIN','synthetic','tx','reference_funding',-500);
          INSERT INTO pvp_rooms(id,code,app_id,game_id,status,capacity,practice,entry_minor,fee_bps,terms,scope,players,rule_version,seed_enc,last_tick_at,expires_at)
           VALUES('room','ROOM','app','run','cancelled',2,true,0,0,'{}','{}','[{"external_user_id":"human"}]','pvp-run-v2.2.0','synthetic-no-decrypt-needed',1,10);
        """)
        self.db = database.ViewDatabase(self.execute, OLD, NEW)
        self.baseline = self.db.snapshot()

    def execute(self, query):
        self.calls.append(query)
        return sql(self.name, query)

    def cleanup(self):
        if self.created:
            connections = int(sql('postgres', f"SELECT count(*) FROM pg_stat_activity WHERE datname='{self.name}';"))
            self.assertEqual(connections, 0, 'Do not FORCE-drop leaked sessions')
            sql('postgres', f'DROP DATABASE "{self.name}";')
            self.assertEqual(sql('postgres', f"SELECT count(*) FROM pg_database WHERE datname='{self.name}';"), '0')
            self.removed_names.append(self.name)
            self.created = False
        if self.owner_created:
            sql('postgres', f'DROP ROLE "{self.owner}";')
            self.assertEqual(sql('postgres', f"SELECT count(*) FROM pg_roles WHERE rolname='{self.owner}';"), '0')
            self.removed_roles.append(self.owner)
            self.owner_created = False

    def test_snapshot_is_readonly_and_covers_unlisted_tables_and_sequences(self):
        self.assertIn('READ ONLY', self.calls[0])
        self.assertNotIn('CREATE ', self.calls[0])
        sql(self.name, 'CREATE TABLE independently_added (id bigserial PRIMARY KEY, body text NOT NULL);')
        before = self.db.snapshot()
        self.assertIn('independently_added', before['tables'])
        self.assertIn('independently_added_id_seq', before['sequences'])
        sql(self.name, "INSERT INTO independently_added(body) VALUES('synthetic');")
        after = self.db.snapshot()
        self.assertEqual(after['tables']['independently_added']['rows'], 1)
        self.assertNotEqual(after['tables']['independently_added']['sha256'], before['tables']['independently_added']['sha256'])
        self.assertEqual(self.db.policy(after, before), 'new_business')

    def test_exact_atomic_migration_and_retry(self):
        after = self.db.migration(self.baseline)
        self.assertEqual(self.db.policy(self.baseline, self.baseline), 'old')
        self.assertEqual(self.db.policy(after, self.baseline), 'migrated_empty')
        expected_rows = dict(self.baseline['tables'], pvp_run_input_decisions={'rows': 0, 'sha256': database.EMPTY_SHA})
        self.assertEqual(after['tables'], expected_rows)
        self.assertEqual(after['sequences'], self.baseline['sequences'])
        self.assertEqual(self.db.migration(self.baseline), after)
        for role in ('origin', 'rollback', 'forward'):
            self.db.allow_role(after, role)
        self.assertEqual(len([q for q in self.calls if q.startswith('BEGIN;')]), 2)
        migration = self.calls[1]
        self.assertLess(migration.index('LOCK TABLE'), migration.index(database.DDL))
        self.assertTrue(migration.endswith('COMMIT;'))
        self.assertNotIn('DROP ', migration)

    def test_admin_migrates_as_restricted_owner_and_restores_session_identity(self):
        self.assertEqual(self.baseline['schema']['relations']['pvp_rooms']['owner'], self.owner)
        self.assertEqual(sql(self.name, 'SELECT current_user;'), 'oasis_local')
        role_before = sql(self.name, f"SELECT row(rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,rolinherit)::text FROM pg_roles WHERE rolname='{self.owner}';")
        def checked(query):
            # Same psql session, after COMMIT: LOCAL ROLE must not escape.
            if query.startswith('BEGIN;'):
                query += "\nDO $$ BEGIN IF current_user<>'oasis_local' OR session_user<>'oasis_local' THEN RAISE EXCEPTION 'TEST_ROLE_LEAKED'; END IF; END $$;"
            return self.execute(query)
        db = database.ViewDatabase(checked, OLD, NEW)
        migrated = db.migration(self.baseline)
        self.assertEqual(migrated['schema']['relations'][database.DECISIONS]['owner'], self.owner)
        self.assertIsNone(migrated['schema']['relations'][database.DECISIONS]['acl'])
        self.assertEqual(sql(self.name, f"SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.pvp_run_input_decisions'::regclass AND a.grantee<>c.relowner;"), '0')
        # Exact application owner can use the new table without an added GRANT.
        sql(self.name, f'''BEGIN; SET LOCAL ROLE "{self.owner}";
          INSERT INTO pvp_run_input_decisions(room_id,external_user_id,command_seq,decision) VALUES('room','human',1,'{{}}');
          UPDATE pvp_run_input_decisions SET decision='{{"owned":true}}';
          DELETE FROM pvp_run_input_decisions; ROLLBACK;''')
        identity = sql(self.name, "SELECT oid::text||':'||relfilenode::text FROM pg_class WHERE oid='public.pvp_run_input_decisions'::regclass;")
        self.assertEqual(db.migration(self.baseline), migrated)
        self.assertEqual(sql(self.name, "SELECT oid::text||':'||relfilenode::text FROM pg_class WHERE oid='public.pvp_run_input_decisions'::regclass;"), identity)
        self.assertEqual(sql(self.name, f"SELECT row(rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,rolinherit)::text FROM pg_roles WHERE rolname='{self.owner}';"), role_before)

    def test_owner_elevated_flags_or_membership_reject_before_ddl(self):
        for flag in ('SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS'):
            with self.subTest(flag=flag):
                sql('postgres', f'ALTER ROLE "{self.owner}" {flag};')
                try:
                    with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNSAFE_OWNER_ROLE'):
                        self.db.migration(self.baseline)
                    self.assertEqual(self.db.snapshot(), self.baseline)
                finally:
                    sql('postgres', f'ALTER ROLE "{self.owner}" NO{flag};')
        sql('postgres', f'GRANT pg_read_all_data TO "{self.owner}";')
        try:
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNREVIEWED_OWNER_MEMBERSHIP'):
                self.db.migration(self.baseline)
            self.assertEqual(self.db.snapshot(), self.baseline)
        finally:
            sql('postgres', f'REVOKE pg_read_all_data FROM "{self.owner}";')

    def test_unknown_and_unsafe_owner_reject_without_ddl(self):
        for owner in ('pg_read_all_data', 'danger"; RESET ROLE; --', 'MixedCase'):
            with self.subTest(owner=owner):
                baseline = copy.deepcopy(self.baseline)
                baseline['schema']['relations']['pvp_rooms']['owner'] = owner
                count = len(self.calls)
                with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNSAFE_OWNER'):
                    self.db.migration(baseline)
                self.assertEqual(len(self.calls), count)
        baseline = copy.deepcopy(self.baseline)
        baseline['schema']['relations']['pvp_rooms']['owner'] = self.owner + '_absent'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNSAFE_OWNER_ROLE'):
            self.db.migration(baseline)
        self.assertEqual(self.db.snapshot(), self.baseline)

    def test_retry_rechecks_owner_privileges_after_complete_migration(self):
        self.db.migration(self.baseline)
        sql('postgres', f'ALTER ROLE "{self.owner}" CREATEDB;')
        try:
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNSAFE_OWNER_ROLE'):
                self.db.migration(self.baseline)
        finally:
            sql('postgres', f'ALTER ROLE "{self.owner}" NOCREATEDB;')

    def test_post_commit_response_loss_retries_against_original_baseline(self):
        lost = [False]
        def lose_once(query):
            result = self.execute(query)
            if query.startswith('BEGIN;') and not lost[0]:
                lost[0] = True
                raise RuntimeError('SYNTHETIC_LOST_COMMIT_RESPONSE')
            return result
        db = database.ViewDatabase(lose_once, OLD, NEW)
        with self.assertRaisesRegex(RuntimeError, 'LOST_COMMIT_RESPONSE'):
            db.migration(self.baseline)
        observed = db.snapshot()
        self.assertEqual(db.policy(observed, self.baseline), 'migrated_empty')
        self.assertEqual(db.migration(self.baseline), observed)

    def test_failure_after_both_ddl_statements_rolls_back_both(self):
        def inject(query):
            if query.startswith('BEGIN;'):
                query = query.replace(database.DDL, database.DDL + "\nRAISE EXCEPTION 'SYNTHETIC_AFTER_DDL';")
            return self.execute(query)
        db = database.ViewDatabase(inject, OLD, NEW)
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_AFTER_DDL'):
            db.migration(self.baseline)
        self.assertEqual(db.snapshot(), self.baseline)

    def test_business_arrives_after_baseline_before_transaction_and_is_not_overwritten(self):
        sql(self.name, "INSERT INTO gp_audit(actor,action,detail) VALUES('fixture','new-business','{}');")
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_BASELINE_CHANGED'):
            self.db.migration(self.baseline)
        after = self.db.snapshot()
        self.assertEqual(after['schema_kind'], 'old')
        self.assertEqual(after['tables']['gp_audit']['rows'], 1)
        self.assertEqual(self.db.policy(after, self.baseline), 'new_business')

    def test_partial_migration_is_rejected_without_completing_or_dropping_it(self):
        sql(self.name, 'ALTER TABLE pvp_rooms ADD COLUMN run_input_state jsonb;')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_PARTIAL_MIGRATION'):
            self.db.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_BASELINE_CHANGED'):
            self.db.migration(self.baseline)
        self.assertEqual(sql(self.name, "SELECT count(*) FROM information_schema.columns WHERE table_name='pvp_rooms' AND column_name='run_input_state';"), '1')
        self.assertEqual(sql(self.name, "SELECT to_regclass('public.pvp_run_input_decisions') IS NULL;"), 't')

    def test_changed_decision_constraint_is_not_a_supported_additive_schema(self):
        self.db.migration(self.baseline)
        sql(self.name, 'ALTER TABLE pvp_run_input_decisions DROP CONSTRAINT pvp_run_input_decisions_command_seq_check;')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNREVIEWED_ADDITIVE_SCHEMA'):
            self.db.snapshot()

    def test_unrelated_column_drift_is_not_new_business(self):
        after = self.db.migration(self.baseline)
        sql(self.name, 'ALTER TABLE wallet_users ADD COLUMN unreviewed text;')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SCHEMA_DRIFT'):
            self.db.policy(self.db.snapshot(), self.baseline)
        self.assertEqual(after['schema_kind'], 'migrated')

    def test_grant_and_function_changes_are_in_catalog(self):
        sql(self.name, 'GRANT SELECT ON gp_sessions TO PUBLIC;')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SCHEMA_DRIFT'):
            self.db.policy(self.db.snapshot(), self.baseline)
        sql(self.name, "CREATE FUNCTION public.synthetic_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';")
        after = self.db.snapshot()
        self.assertTrue(any(r['name'] == 'synthetic_fn' for r in after['schema']['routines']))
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SCHEMA_DRIFT'):
            self.db.policy(after, self.baseline)

    def test_sequence_only_changes_are_new_business(self):
        after = self.db.migration(self.baseline)
        sql(self.name, "SELECT nextval('wallet_ledger_id_seq');")
        changed = self.db.snapshot()
        self.assertEqual(changed['tables'], after['tables'])
        self.assertNotEqual(changed['sequences'], after['sequences'])
        self.assertEqual(self.db.policy(changed, self.baseline), 'new_business')

    def test_global_default_privilege_drift_is_recorded(self):
        sql(self.name, 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC;')
        after = self.db.snapshot()
        self.assertEqual(after['schema']['default_privileges'][0]['namespace'], '*')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SCHEMA_DRIFT'):
            self.db.policy(after, self.baseline)
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_BASELINE_CHANGED'):
            self.db.migration(self.baseline)

    def test_ddl_event_hooks_are_rejected_instead_of_running_side_effects(self):
        sql(self.name, """CREATE FUNCTION public.synthetic_ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
          CREATE EVENT TRIGGER synthetic_ddl_hook ON ddl_command_end EXECUTE FUNCTION public.synthetic_ddl_hook();""")
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNSUPPORTED_SCHEMA_OBJECT'):
            self.db.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_BASELINE_CHANGED'):
            self.db.migration(self.baseline)

    def test_each_new_rule_marker_independently_blocks_old_role(self):
        self.db.migration(self.baseline)
        for action, undo in (
            ("UPDATE pvp_rooms SET run_input_state='{}' WHERE id='room';", "UPDATE pvp_rooms SET run_input_state=NULL WHERE id='room';"),
            ("INSERT INTO pvp_run_input_decisions(room_id,external_user_id,command_seq,decision) VALUES('room','human',1,'{}');", 'DELETE FROM pvp_run_input_decisions;'),
            ("UPDATE pvp_rooms SET rule_version='pvp-run-v2.3.0' WHERE id='room';", "UPDATE pvp_rooms SET rule_version='pvp-run-v2.2.0' WHERE id='room';"),
        ):
            with self.subTest(action=action):
                sql(self.name, action)
                value = self.db.snapshot()
                self.db.require_quiet(value)
                self.db.allow_role(value, 'forward')
                for role in ('origin', 'rollback'):
                    with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_NEW_RULE_REQUIRES_FORWARD'):
                        self.db.allow_role(value, role)
                sql(self.name, undo)

    def test_terminal_v23_private_history_decisions_and_requests_still_forbid_old_role(self):
        after = self.db.migration(self.baseline)
        sql(self.name, """UPDATE pvp_rooms SET status='settled',rule_version='pvp-run-v2.3.0',run_input_state='{"fixture_history":1}' WHERE id='room';
          INSERT INTO pvp_run_input_decisions(room_id,external_user_id,command_seq,decision) VALUES('room','human',1,'{"outcome":"rejected"}');
          INSERT INTO pvp_requests(app_id,external_user_id,request_id,digest,room_id,response,response_status)
           VALUES('app','human','fixture-request','fixture-digest','room','{"request_id":"fixture-request"}',200);""")
        changed = self.db.snapshot()
        self.db.require_quiet(changed)
        self.db.allow_role(changed, 'forward')
        self.assertEqual(self.db.policy(changed, self.baseline), 'new_business')
        self.assertNotEqual(changed['tables']['pvp_requests'], after['tables']['pvp_requests'])
        for role in ('origin', 'rollback'):
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_NEW_RULE_REQUIRES_FORWARD'):
                self.db.allow_role(changed, role)
        # A private-only edit is not hidden by the old-column row projection.
        sql(self.name, "UPDATE pvp_rooms SET run_input_state='{" + '"fixture_history":2' + "}' WHERE id='room';")
        newest = self.db.snapshot()
        self.assertEqual(newest['tables'], changed['tables'])
        self.assertNotEqual(newest['run_v23']['private_history_sha256'], changed['run_v23']['private_history_sha256'])
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_BASELINE_CHANGED'):
            self.db.migration(self.baseline)

    def test_old_rule_activity_is_allowed_for_health_but_never_quiet(self):
        sql(self.name, "UPDATE pvp_rooms SET status='active' WHERE id='room';")
        active = self.db.snapshot()
        self.db.allow_role(active, 'origin')
        self.db.allow_role(active, 'rollback')
        self.assertEqual(self.db.policy(active, self.baseline), 'new_business')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_PENDING_OBLIGATIONS'):
            self.db.require_quiet(active)
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_PENDING_OBLIGATIONS'):
            self.db.migration(active)
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_FORWARD_SCHEMA_REQUIRED'):
            self.db.allow_role(active, 'forward')

    def test_bad_ledger_is_an_integrity_error(self):
        sql(self.name, "UPDATE wallet_users SET available=501 WHERE external_user_id='human';")
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_INTEGRITY_DRIFT'):
            self.db.snapshot()

    def test_unknown_role_wrong_database_missing_tables_and_forged_kind_fail(self):
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_UNKNOWN_ROLE'):
            self.db.allow_role(self.baseline, 'anything')
        value = copy.deepcopy(self.baseline)
        value['database'] = 'different_database'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_IDENTITY_CHANGED'):
            self.db.policy(value, self.baseline)
        value = copy.deepcopy(self.baseline)
        del value['tables']['gp_sessions']
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_INCOMPLETE_DATA'):
            self.db.policy(value, self.baseline)
        value = copy.deepcopy(self.baseline)
        value['schema_kind'] = 'migrated'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_INVALID_SCHEMA_KIND'):
            self.db.policy(value, self.baseline)

    def test_changed_or_symlinked_source_fails_before_sql(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            old = root / 'old'
            for name in ('platform/server/pvp/schema.sql', 'platform/deploy/restore-drill.mjs'):
                target = old / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(OLD / name, target)
            calls = []
            target = old / 'platform/server/pvp/schema.sql'
            target.write_bytes(target.read_bytes() + b'\n-- changed\n')
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SOURCE_CHANGED'):
                database.ViewDatabase(calls.append, old, NEW)
            target.unlink()
            target.symlink_to(OLD / 'platform/server/pvp/schema.sql')
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SOURCE_SYMLINK'):
                database.ViewDatabase(calls.append, old, NEW)
            self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)

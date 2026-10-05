CREATE TABLE IF NOT EXISTS gp_admins (id text PRIMARY KEY, username text UNIQUE NOT NULL, salt text NOT NULL, password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS gp_admin_sessions (token_hash text PRIMARY KEY, admin_id text REFERENCES gp_admins, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS gp_apps (id text PRIMARY KEY, name text NOT NULL, partner_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('sandbox','production')), wallet_scope_id text NOT NULL, currency_id text NOT NULL DEFAULT 'COIN', currency_scale int NOT NULL DEFAULT 2, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')), game_ids jsonb NOT NULL DEFAULT '["thunder","tiger"]', wallet_url text NOT NULL DEFAULT 'http://127.0.0.1:8798', math_profile text NOT NULL DEFAULT '99', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gp_keys (id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps, direction text NOT NULL, secret_enc text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gp_nonces (key_id text NOT NULL, nonce text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(key_id,nonce));
CREATE TABLE IF NOT EXISTS gp_sessions (id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps, external_user_id text NOT NULL, game_id text NOT NULL, token_hash text UNIQUE, token_expires_at timestamptz, state jsonb NOT NULL DEFAULT '{"version":0,"pendingPlay":null,"cycleId":null,"nextIndex":0}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gp_launch_intents (app_id text NOT NULL REFERENCES gp_apps, request_id text NOT NULL, digest text NOT NULL, response_enc text NOT NULL, PRIMARY KEY(app_id,request_id));
CREATE TABLE IF NOT EXISTS gp_launch_codes (code_hash text PRIMARY KEY, session_id text REFERENCES gp_sessions, expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE IF NOT EXISTS gp_cycles (id text PRIMARY KEY, session_id text NOT NULL REFERENCES gp_sessions, app_id text NOT NULL REFERENCES gp_apps, external_user_id text NOT NULL, game_id text NOT NULL, request_id text NOT NULL, stake_minor bigint NOT NULL CHECK(stake_minor>0), math_profile text NOT NULL, math_version text NOT NULL, math_hash text NOT NULL, max_payout_minor bigint NOT NULL, status text NOT NULL DEFAULT 'AUTHORIZING', seed_enc text, result jsonb, result_hash text, payout_minor bigint, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,request_id));
CREATE TABLE IF NOT EXISTS gp_operations (id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps, aggregate_id text NOT NULL, path text NOT NULL, raw_body text NOT NULL, state text NOT NULL DEFAULT 'PENDING', response jsonb, attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gp_plays (id text PRIMARY KEY, session_id text NOT NULL REFERENCES gp_sessions, request_id text NOT NULL, cycle_id text NOT NULL REFERENCES gp_cycles, round_index int NOT NULL, bet int NOT NULL, payload jsonb NOT NULL, acknowledged boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,request_id), UNIQUE(cycle_id,round_index));
CREATE TABLE IF NOT EXISTS gp_audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, app_id text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS gp_cycles_recovery ON gp_cycles(status,updated_at);

ALTER TABLE gp_apps ADD COLUMN IF NOT EXISTS competitive_fee_bps integer NOT NULL DEFAULT 500 CHECK (competitive_fee_bps IN (300,500,800,1000));
ALTER TABLE gp_apps ALTER COLUMN game_ids SET DEFAULT '["thunder","tiger","match","golf","carrom","darts","ludo","jackaroo","domino","pool","bowling","run"]';
CREATE TABLE IF NOT EXISTS gp_migrations (id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE gp_apps ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]';
ALTER TABLE gp_sessions ADD COLUMN IF NOT EXISTS host_origin text;
ALTER TABLE gp_launch_codes ADD COLUMN IF NOT EXISTS host_origin text;

-- Additive environment support. A runtime identity still forbids mixed-environment databases.
ALTER TABLE gp_apps DROP CONSTRAINT IF EXISTS gp_apps_environment_check;
ALTER TABLE gp_apps ADD CONSTRAINT gp_apps_environment_check CHECK(environment IN ('sandbox','production'));

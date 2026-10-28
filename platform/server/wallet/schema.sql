CREATE TABLE IF NOT EXISTS wallet_scopes (
 scope_id text PRIMARY KEY, partner_id text NOT NULL, app_id text NOT NULL, environment text NOT NULL,
 wallet_scope_id text NOT NULL, currency_id text NOT NULL, currency_scale integer NOT NULL DEFAULT 2,
 treasury_available bigint NOT NULL CHECK(treasury_available>=0), treasury_reserved bigint NOT NULL DEFAULT 0 CHECK(treasury_reserved>=0),
 treasury_inbound bigint NOT NULL DEFAULT 0 CHECK(treasury_inbound>=0), fee_available bigint NOT NULL DEFAULT 0 CHECK(fee_available>=0), fee_pending bigint NOT NULL DEFAULT 0 CHECK(fee_pending>=0),
 ledger_version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(partner_id,app_id,environment,wallet_scope_id,currency_id)
);
CREATE TABLE IF NOT EXISTS wallet_keys (key_id text PRIMARY KEY, scope_id text NOT NULL REFERENCES wallet_scopes, secret_base64 text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS wallet_nonces (key_id text NOT NULL REFERENCES wallet_keys, nonce text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(key_id,nonce));
CREATE TABLE IF NOT EXISTS wallet_users (scope_id text NOT NULL REFERENCES wallet_scopes, external_user_id text NOT NULL, available bigint NOT NULL CHECK(available>=0), reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0), credit_pending bigint NOT NULL DEFAULT 0 CHECK(credit_pending>=0), PRIMARY KEY(scope_id,external_user_id));
CREATE TABLE IF NOT EXISTS wallet_operations (scope_id text NOT NULL REFERENCES wallet_scopes, operation_id text NOT NULL, kind text NOT NULL, method text NOT NULL, path text NOT NULL, body_sha256 text NOT NULL, state text NOT NULL, response_status integer, response_body jsonb, operation jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,operation_id));
CREATE TABLE IF NOT EXISTS wallet_matches (scope_id text NOT NULL REFERENCES wallet_scopes, match_id text NOT NULL, state text NOT NULL, terms jsonb, participants jsonb NOT NULL DEFAULT '[]', captured_minor bigint NOT NULL DEFAULT 0, pool_minor bigint NOT NULL DEFAULT 0 CHECK(pool_minor>=0), expected_fee bigint NOT NULL DEFAULT 0, fee_minor bigint NOT NULL DEFAULT 0, payout_capacity bigint NOT NULL DEFAULT 0, payouts jsonb, result_hash text, capture_operation_id text, settlement_operation_id text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,match_id));
CREATE TABLE IF NOT EXISTS wallet_reservations (scope_id text NOT NULL REFERENCES wallet_scopes, reservation_id text NOT NULL, match_id text NOT NULL, external_user_id text NOT NULL, seat_index integer NOT NULL, amount_minor bigint NOT NULL, terms jsonb NOT NULL, state text NOT NULL, expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,reservation_id), UNIQUE(scope_id,match_id,external_user_id), UNIQUE(scope_id,match_id,seat_index));
CREATE TABLE IF NOT EXISTS wallet_math_profiles (scope_id text NOT NULL REFERENCES wallet_scopes, game_id text NOT NULL, math_version text NOT NULL, math_config_hash text NOT NULL, max_payout_multiplier bigint NOT NULL CHECK(max_payout_multiplier>=0), PRIMARY KEY(scope_id,game_id,math_version));
CREATE TABLE IF NOT EXISTS wallet_probability (scope_id text NOT NULL REFERENCES wallet_scopes, authorization_id text NOT NULL, cycle_id text NOT NULL, state text NOT NULL, external_user_id text, game_id text, math_version text, math_config_hash text, stake_minor bigint, max_payout_minor bigint, gross_payout_minor bigint, expires_at timestamptz, accepted_at timestamptz, result_hash text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,authorization_id), UNIQUE(scope_id,cycle_id));
CREATE TABLE IF NOT EXISTS wallet_events (scope_id text NOT NULL REFERENCES wallet_scopes, event_id text NOT NULL, body_sha256 text NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,event_id));
CREATE TABLE IF NOT EXISTS wallet_ledger (id bigserial PRIMARY KEY, scope_id text NOT NULL REFERENCES wallet_scopes, operation_id text NOT NULL, transaction_id text NOT NULL, account text NOT NULL, delta_available bigint NOT NULL DEFAULT 0, delta_reserved bigint NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS wallet_reservations_expiry ON wallet_reservations(scope_id,expires_at) WHERE state='RESERVED';
CREATE INDEX IF NOT EXISTS wallet_probability_expiry ON wallet_probability(scope_id,expires_at) WHERE state='AUTHORIZED';
CREATE INDEX IF NOT EXISTS wallet_ledger_operations ON wallet_ledger(scope_id,operation_id);
-- Transfer clearing audit (deploy/monitor.mjs) reads only transfer:* accounts; without this it scans the whole ledger.
CREATE INDEX IF NOT EXISTS wallet_ledger_transfer_accounts ON wallet_ledger(scope_id,account) WHERE account LIKE 'transfer:%';
CREATE TABLE IF NOT EXISTS wallet_operation_ids (partner_id text NOT NULL, app_id text NOT NULL, environment text NOT NULL, operation_id text NOT NULL, scope_id text NOT NULL REFERENCES wallet_scopes, PRIMARY KEY(partner_id,app_id,environment,operation_id));

-- Bounded nonredeemable coin issuer account; existing 47-table structure remains.
ALTER TABLE wallet_scopes ADD COLUMN IF NOT EXISTS internal_coin_issued bigint NOT NULL DEFAULT 0 CHECK(internal_coin_issued>=0);

-- Hot-path aggregates: per-player wallet operations add their App-level deltas to one of
-- 16 shard rows instead of locking wallet_scopes. Logical totals = wallet_scopes + SUM(shards);
-- a background fold moves shard deltas back into wallet_scopes.
CREATE TABLE IF NOT EXISTS wallet_scope_shards (scope_id text NOT NULL REFERENCES wallet_scopes, shard integer NOT NULL CHECK(shard>=0 AND shard<16),
 treasury_available bigint NOT NULL DEFAULT 0, treasury_reserved bigint NOT NULL DEFAULT 0, treasury_inbound bigint NOT NULL DEFAULT 0,
 fee_available bigint NOT NULL DEFAULT 0, fee_pending bigint NOT NULL DEFAULT 0, ledger_version bigint NOT NULL DEFAULT 0, PRIMARY KEY(scope_id,shard));
CREATE INDEX IF NOT EXISTS wallet_probability_user_expiry ON wallet_probability(scope_id,external_user_id,expires_at) WHERE state='AUTHORIZED';
-- Integer coins (see gp_apps.currency_scale).
ALTER TABLE wallet_scopes ALTER COLUMN currency_scale SET DEFAULT 0;

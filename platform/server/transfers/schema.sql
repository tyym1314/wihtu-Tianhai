-- Additive, disabled-by-default transfer protocol. No opening balances/grants.
CREATE TABLE IF NOT EXISTS gp_transfer_bindings (
 id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps,
 scope_id text NOT NULL REFERENCES wallet_scopes,
 issuer text NOT NULL, merchant text NOT NULL, adapter_id text NOT NULL,
 config jsonb NOT NULL, capabilities jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','active')),
 approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,app_id,scope_id)
);
CREATE TABLE IF NOT EXISTS gp_transfer_accounts (
 id text PRIMARY KEY, binding_id text NOT NULL REFERENCES gp_transfer_bindings,
 app_id text NOT NULL REFERENCES gp_apps, player_id text NOT NULL REFERENCES gp_players,
 external_user_id text NOT NULL, partner_account text NOT NULL,
 proof jsonb NOT NULL, verified_by text NOT NULL,
 active boolean NOT NULL DEFAULT false, verified_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(app_id,player_id) REFERENCES gp_player_app_ids(app_id,player_id),
 UNIQUE(binding_id,player_id), UNIQUE(binding_id,partner_account)
);
CREATE TABLE IF NOT EXISTS gp_transfers (
 id text PRIMARY KEY, request_id text NOT NULL, app_id text NOT NULL REFERENCES gp_apps,
 scope_id text NOT NULL REFERENCES wallet_scopes,
 binding_id text NOT NULL REFERENCES gp_transfer_bindings,
 account_id text NOT NULL REFERENCES gp_transfer_accounts,
 external_user_id text NOT NULL, direction text NOT NULL CHECK(direction IN ('IN','OUT')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), currency_id text NOT NULL,
 request_body text NOT NULL, request_sha256 text NOT NULL,
 binding_snapshot jsonb NOT NULL, account_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SUCCEEDED','REJECTED')),
 observation text NOT NULL DEFAULT 'QUEUED',
 receipt jsonb, ledger_transaction_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(app_id,request_id), UNIQUE(id,scope_id)
);
CREATE TABLE IF NOT EXISTS gp_transfer_outbox (
 transfer_id text PRIMARY KEY REFERENCES gp_transfers,
 operation_id text NOT NULL UNIQUE, raw_body text NOT NULL, body_sha256 text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token text, lease_until timestamptz,
 issuer text NOT NULL, merchant text NOT NULL, environment text NOT NULL,
 external_transaction_id text, result jsonb,
 UNIQUE(issuer,merchant,environment,external_transaction_id)
);
CREATE INDEX IF NOT EXISTS gp_transfer_pending ON gp_transfers(created_at,id) WHERE state='PENDING';
CREATE TABLE IF NOT EXISTS wallet_transfer_clearing (
 scope_id text NOT NULL REFERENCES wallet_scopes, issuer text NOT NULL, merchant text NOT NULL,
 account text NOT NULL, net_minor numeric NOT NULL DEFAULT 0 CHECK(net_minor=trunc(net_minor)),
 PRIMARY KEY(scope_id,issuer,merchant), UNIQUE(scope_id,account)
);

CREATE TABLE IF NOT EXISTS pvp_rooms (
 id text PRIMARY KEY,code text UNIQUE NOT NULL,app_id text NOT NULL REFERENCES gp_apps,game_id text NOT NULL,
 status text NOT NULL DEFAULT 'waiting',capacity integer NOT NULL CHECK(capacity BETWEEN 2 AND 4),practice boolean NOT NULL,
 entry_minor bigint NOT NULL,fee_bps integer NOT NULL,terms jsonb NOT NULL,scope jsonb NOT NULL,
 players jsonb NOT NULL,game_state jsonb,rule_version text NOT NULL,seed_enc text NOT NULL,captured boolean NOT NULL DEFAULT false,
 result jsonb,result_hash text,starts_at bigint,end_at bigint,last_tick_at bigint NOT NULL,fault_at bigint,error jsonb,
 ready_deadline_at bigint,expires_at bigint NOT NULL,version bigint NOT NULL DEFAULT 0,
 game_options jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pvp_rooms ADD COLUMN IF NOT EXISTS game_options jsonb NOT NULL DEFAULT '{}';
-- Private rollback history, only for explicitly opted-in free Run BOT rooms.
ALTER TABLE pvp_rooms ADD COLUMN IF NOT EXISTS run_input_state jsonb;
CREATE INDEX IF NOT EXISTS pvp_rooms_running ON pvp_rooms(status,updated_at);
CREATE TABLE IF NOT EXISTS pvp_active_users (app_id text NOT NULL REFERENCES gp_apps,external_user_id text NOT NULL,room_id text NOT NULL REFERENCES pvp_rooms,PRIMARY KEY(app_id,external_user_id));
-- Presence is deliberately separate from game state. Polling must not take a
-- gameplay lock or overwrite an action/settlement snapshot to update a clock.
CREATE TABLE IF NOT EXISTS pvp_presence (room_id text NOT NULL REFERENCES pvp_rooms(id) ON DELETE CASCADE,external_user_id text NOT NULL,last_seen_at bigint NOT NULL,PRIMARY KEY(room_id,external_user_id));
CREATE TABLE IF NOT EXISTS pvp_requests (app_id text NOT NULL,external_user_id text NOT NULL,request_id text NOT NULL,digest text NOT NULL,room_id text, response jsonb NOT NULL,response_status integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(app_id,external_user_id,request_id));
CREATE TABLE IF NOT EXISTS pvp_actions (room_id text NOT NULL REFERENCES pvp_rooms,external_user_id text NOT NULL,seq bigint NOT NULL,action jsonb NOT NULL,event jsonb,accepted_at bigint NOT NULL,PRIMARY KEY(room_id,external_user_id,seq));
-- A rejection consumes a command sequence too. These receipts are inserted in
-- the same transaction as the room and HTTP response, before history pruning.
CREATE TABLE IF NOT EXISTS pvp_run_input_decisions (
 room_id text NOT NULL REFERENCES pvp_rooms(id) ON DELETE CASCADE,
 external_user_id text NOT NULL,command_seq bigint NOT NULL CHECK(command_seq>0),
 decision jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,external_user_id,command_seq)
);
CREATE TABLE IF NOT EXISTS pvp_operations (id text PRIMARY KEY,app_id text NOT NULL REFERENCES gp_apps,room_id text NOT NULL REFERENCES pvp_rooms,path text NOT NULL,raw_body text NOT NULL,state text NOT NULL DEFAULT 'PENDING',response jsonb,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),error jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

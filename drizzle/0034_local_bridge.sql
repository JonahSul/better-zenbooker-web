-- Local optional receiver schema only; administrator initialization creates setup settings.
CREATE TABLE IF NOT EXISTS bridge_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,data_json TEXT NOT NULL,retention_floor INTEGER NOT NULL DEFAULT 0,last_probe TEXT);
CREATE TABLE IF NOT EXISTS bridge_inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,envelope_hash TEXT NOT NULL,inspection_json TEXT NOT NULL,mode TEXT NOT NULL,policy_revision INTEGER NOT NULL,schema_hash TEXT NOT NULL,created_at INTEGER NOT NULL,acked_at INTEGER);
CREATE TABLE IF NOT EXISTS bridge_jobs(account_id TEXT NOT NULL,job_id TEXT NOT NULL,created_event_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,job_id));
CREATE TABLE IF NOT EXISTS bridge_nonces(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_rates(bucket TEXT NOT NULL,window INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(bucket,window));
CREATE TABLE IF NOT EXISTS bridge_catalog(hash TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,fetched_at TEXT NOT NULL,created_at INTEGER NOT NULL);


CREATE TABLE IF NOT EXISTS bridge_captures(id TEXT PRIMARY KEY,event_key TEXT NOT NULL,body_sha256 TEXT NOT NULL,key_version TEXT NOT NULL,namespace TEXT NOT NULL,parser_policy_version TEXT NOT NULL,mode TEXT NOT NULL,config_revision INTEGER NOT NULL,byte_length INTEGER NOT NULL,captured_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,nonce TEXT NOT NULL,ciphertext TEXT NOT NULL,UNIQUE(event_key,body_sha256));
CREATE INDEX IF NOT EXISTS bridge_capture_expiry ON bridge_captures(namespace,expires_at);
CREATE TRIGGER IF NOT EXISTS bridge_capture_immutable BEFORE UPDATE ON bridge_captures BEGIN SELECT RAISE(ABORT,'Capture is immutable'); END;
CREATE TABLE IF NOT EXISTS bridge_capture_replays(capture_id TEXT NOT NULL,parser_policy_version TEXT NOT NULL,inspection_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(capture_id,parser_policy_version));
CREATE TRIGGER IF NOT EXISTS bridge_capture_replay_immutable BEFORE UPDATE ON bridge_capture_replays BEGIN SELECT RAISE(ABORT,'Replay is immutable'); END;

ALTER TABLE bridge_settings ADD COLUMN capture_maintenance_json TEXT;


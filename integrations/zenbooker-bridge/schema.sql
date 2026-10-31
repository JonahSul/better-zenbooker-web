-- Standalone receiver only. Apply to the dedicated empty operator-provisioned booking inbox database.
CREATE TABLE IF NOT EXISTS bridge_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,data_json TEXT NOT NULL,retention_floor INTEGER NOT NULL DEFAULT 0,last_probe TEXT);
INSERT OR IGNORE INTO bridge_settings(id,revision,data_json) VALUES(1,0,'{"mode":"setup","pins":{"accountId":null,"webhookIds":[],"eventScope":["job.created","job.rescheduled","job.canceled"],"schemaProfile":"unverified"},"refreshEnabled":false}');
CREATE TABLE IF NOT EXISTS bridge_inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,envelope_hash TEXT NOT NULL,inspection_json TEXT NOT NULL,mode TEXT NOT NULL,policy_revision INTEGER NOT NULL,schema_hash TEXT NOT NULL,created_at INTEGER NOT NULL,acked_at INTEGER);
CREATE TABLE IF NOT EXISTS bridge_jobs(account_id TEXT NOT NULL,job_id TEXT NOT NULL,created_event_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,job_id));
CREATE TABLE IF NOT EXISTS bridge_nonces(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_rates(bucket TEXT NOT NULL,window INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(bucket,window));
CREATE TABLE IF NOT EXISTS bridge_catalog(hash TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,fetched_at TEXT NOT NULL,created_at INTEGER NOT NULL);



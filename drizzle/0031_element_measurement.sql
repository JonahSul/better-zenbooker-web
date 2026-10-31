CREATE TABLE element_measurement_documents (
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 document_key TEXT NOT NULL,
 descriptor_hash TEXT NOT NULL,
 analytics_grant_hash TEXT NOT NULL,
 analytics_revision INTEGER NOT NULL,
 route TEXT NOT NULL,
 snapshot_hash TEXT NOT NULL,
 asset_manifest_hash TEXT NOT NULL,
 renderer_version TEXT NOT NULL,
 registry_version TEXT NOT NULL,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 retained_until INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 experiment_grant_hash TEXT,
 experiment_revision INTEGER,
 version_id TEXT,
 composition_id TEXT,
 event_write_token TEXT,
 PRIMARY KEY (workspace_id,id),
 UNIQUE (workspace_id,analytics_grant_hash,analytics_revision,document_key)
);
CREATE INDEX element_documents_retention ON element_measurement_documents(workspace_id,retained_until);
CREATE TABLE element_measurement_events (
 workspace_id TEXT NOT NULL,
 document_id TEXT NOT NULL,
 element_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 source_hash TEXT,
 UNIQUE (workspace_id,source_hash,kind)
);
CREATE INDEX element_events_received ON element_measurement_events(workspace_id,received_at);

CREATE UNIQUE INDEX element_browser_event ON element_measurement_events(workspace_id,document_id,element_id,kind) WHERE kind IN ('view','action');

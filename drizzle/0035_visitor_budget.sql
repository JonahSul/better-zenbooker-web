CREATE TABLE inference_wallets(session TEXT PRIMARY KEY, consumed_micros INTEGER NOT NULL DEFAULT 0 CHECK(consumed_micros BETWEEN 0 AND 500000),session_expires_at INTEGER NOT NULL);
CREATE TABLE inference_daily(day INTEGER PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 100),consumed_micros INTEGER NOT NULL DEFAULT 0 CHECK(consumed_micros>=0));
CREATE TABLE inference_reservations(request_key TEXT PRIMARY KEY,installation TEXT NOT NULL,security_subject TEXT NOT NULL,session TEXT NOT NULL,purpose TEXT NOT NULL,model TEXT NOT NULL,body_digest TEXT NOT NULL,policy TEXT NOT NULL,cost_micros INTEGER NOT NULL CHECK(cost_micros>0),day INTEGER NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','complete','unknown')),created_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,session_expires_at INTEGER NOT NULL);
CREATE TABLE inference_subjects(installation TEXT NOT NULL,security_subject TEXT NOT NULL,current_session TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_activity_at INTEGER NOT NULL,retain_until INTEGER NOT NULL,PRIMARY KEY(installation,security_subject));
CREATE INDEX inference_active ON inference_reservations(lease_until);
CREATE TRIGGER inference_admit BEFORE INSERT ON inference_reservations WHEN NOT EXISTS(SELECT 1 FROM inference_reservations WHERE request_key=NEW.request_key) BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM inference_reservations WHERE lease_until>NEW.created_at)>=4 THEN RAISE(ABORT,'Inference concurrency limit') END;
 INSERT OR IGNORE INTO inference_wallets(session,session_expires_at) VALUES(NEW.session,NEW.session_expires_at);
 SELECT CASE WHEN (SELECT session_expires_at FROM inference_wallets WHERE session=NEW.session)!=NEW.session_expires_at THEN RAISE(ABORT,'Inference session mismatch') END;
 INSERT OR IGNORE INTO inference_daily(day) VALUES(NEW.day);
 SELECT CASE WHEN (SELECT consumed_micros FROM inference_wallets WHERE session=NEW.session)+NEW.cost_micros>500000 THEN RAISE(ABORT,'Inference wallet exhausted') END;
 SELECT CASE WHEN (SELECT calls FROM inference_daily WHERE day=NEW.day)>=100 THEN RAISE(ABORT,'Inference daily limit') END;
 UPDATE inference_wallets SET consumed_micros=consumed_micros+NEW.cost_micros WHERE session=NEW.session;
 UPDATE inference_daily SET calls=calls+1,consumed_micros=consumed_micros+NEW.cost_micros WHERE day=NEW.day;
END;
-- Image processing is authenticated and metered separately from AI dollars.
CREATE TABLE image_transform_daily(day INTEGER PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 100));
CREATE TABLE image_transform_reservations(request_key TEXT PRIMARY KEY,installation TEXT NOT NULL,security_subject TEXT NOT NULL,session TEXT NOT NULL,purpose TEXT NOT NULL,body_digest TEXT NOT NULL,policy TEXT NOT NULL,day INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','complete','unknown')),created_at INTEGER NOT NULL,session_expires_at INTEGER NOT NULL);
CREATE TRIGGER image_transform_admit BEFORE INSERT ON image_transform_reservations WHEN NOT EXISTS(SELECT 1 FROM image_transform_reservations WHERE request_key=NEW.request_key) BEGIN
 INSERT OR IGNORE INTO image_transform_daily(day) VALUES(NEW.day);
 SELECT CASE WHEN (SELECT calls FROM image_transform_daily WHERE day=NEW.day)>=100 THEN RAISE(ABORT,'Image daily limit') END;
 UPDATE image_transform_daily SET calls=calls+1 WHERE day=NEW.day;
END;

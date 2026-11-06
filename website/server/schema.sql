CREATE TABLE IF NOT EXISTS flasher_licenses (
 namespace text NOT NULL, id text NOT NULL, key_hash text NOT NULL, key_hint text NOT NULL,
 file_id text NOT NULL, model text NOT NULL CHECK(model IN ('g3','f3')), customer text NOT NULL DEFAULT '',
 credits integer NOT NULL CHECK(credits >= 0 AND credits <= 100000), status text NOT NULL CHECK(status IN ('active','used','revoked')),
 locked_device text, legacy_meta jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(namespace,id), UNIQUE(namespace,key_hash)
);
CREATE TABLE IF NOT EXISTS flasher_sessions (
 namespace text NOT NULL, token_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','customer')),
 license_id text, expires_at timestamptz NOT NULL, PRIMARY KEY(namespace,token_hash)
);
CREATE TABLE IF NOT EXISTS flasher_limits (
 namespace text NOT NULL, bucket text NOT NULL, window_id bigint NOT NULL, count integer NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(namespace,bucket,window_id)
);
CREATE TABLE IF NOT EXISTS flasher_devices (
 namespace text NOT NULL, id text NOT NULL, model text NOT NULL CHECK(model IN ('g3','f3')),
 public_key text NOT NULL, qualified boolean NOT NULL DEFAULT false, PRIMARY KEY(namespace,id)
);
CREATE TABLE IF NOT EXISTS flasher_attempts (
 namespace text NOT NULL, id uuid NOT NULL, license_id text NOT NULL, request_id uuid NOT NULL,
 file_id text NOT NULL, device_id text NOT NULL, nonce text NOT NULL, digest text NOT NULL,
 status text NOT NULL DEFAULT 'authorized', charged boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(namespace,id), UNIQUE(namespace,license_id,request_id)
);
CREATE TABLE IF NOT EXISTS flasher_ledger (
 namespace text NOT NULL, attempt_id uuid NOT NULL, license_id text NOT NULL, delta integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace,attempt_id)
);
CREATE TABLE IF NOT EXISTS flasher_audit (
 id bigserial PRIMARY KEY, namespace text NOT NULL, action text NOT NULL, entity_id text,
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flasher_challenges (
 namespace text NOT NULL, id uuid NOT NULL, license_id text NOT NULL, nonce text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '2 minutes', used boolean NOT NULL DEFAULT false,
 PRIMARY KEY(namespace,id)
);
CREATE OR REPLACE FUNCTION flasher_charge_delivery(ns text, aid uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE a flasher_attempts%ROWTYPE; l flasher_licenses%ROWTYPE;
BEGIN
 SELECT * INTO a FROM flasher_attempts WHERE namespace=ns AND id=aid FOR UPDATE;
 IF NOT FOUND OR a.expires_at <= now() OR a.status NOT IN ('authorized','delivering','confirmed') THEN RETURN false; END IF;
 SELECT * INTO l FROM flasher_licenses WHERE namespace=ns AND id=a.license_id FOR UPDATE;
 IF NOT FOUND OR l.status='revoked' OR l.file_id<>a.file_id OR (l.locked_device IS NOT NULL AND l.locked_device<>a.device_id) THEN RETURN false; END IF;
 IF a.charged THEN RETURN true; END IF;
 IF l.status<>'active' OR l.credits<=0 THEN RETURN false; END IF;
 UPDATE flasher_licenses SET credits=credits-1, status=CASE WHEN credits=1 THEN 'used' ELSE status END,
 locked_device=a.device_id WHERE namespace=ns AND id=a.license_id;
 INSERT INTO flasher_ledger(namespace,attempt_id,license_id,delta) VALUES(ns,aid,l.id,-1);
 UPDATE flasher_attempts SET charged=true,status='delivering' WHERE namespace=ns AND id=aid;
 RETURN true;
END $$;
CREATE TABLE IF NOT EXISTS flasher_studio_credits (
 namespace text NOT NULL, key_id text NOT NULL, credits_total integer NOT NULL CHECK(credits_total >= 1 AND credits_total <= 1000),
 credits_used integer NOT NULL DEFAULT 0 CHECK(credits_used >= 0), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(namespace,key_id)
);

-- ═══════════════════════════════════════════════════════════
--  SANIX AVINEST PRO — Script SQL de mise en production
--  À exécuter dans : Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. TABLE PRINCIPALE
CREATE TABLE IF NOT EXISTS avico_records (
  id          BIGSERIAL    PRIMARY KEY,
  store       TEXT         NOT NULL,
  org_id      TEXT         NOT NULL DEFAULT 'default',
  data        JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  version     INTEGER      NOT NULL DEFAULT 1,
  CONSTRAINT avico_store_nonempty CHECK (length(trim(store)) > 0),
  CONSTRAINT avico_org_nonempty   CHECK (length(trim(org_id)) > 0)
);

-- 2. INDEX (performance)
CREATE INDEX IF NOT EXISTS idx_avico_store_org
  ON avico_records(store, org_id);

CREATE INDEX IF NOT EXISTS idx_avico_org_updated
  ON avico_records(org_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_avico_data_gin
  ON avico_records USING GIN(data jsonb_path_ops);

-- 3. TRIGGER auto-incrémentation de version
CREATE OR REPLACE FUNCTION avico_bump_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.version    = COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS avico_versioned ON avico_records;
CREATE TRIGGER avico_versioned
  BEFORE UPDATE ON avico_records
  FOR EACH ROW EXECUTE FUNCTION avico_bump_version();

-- 4. SOFT-DELETE
ALTER TABLE avico_records ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_avico_active ON avico_records(store, org_id) WHERE deleted_at IS NULL;

-- 4bis. AUDIT — trace toute écriture, y compris via service_role
CREATE TABLE IF NOT EXISTS avico_audit (
  id           BIGSERIAL    PRIMARY KEY,
  record_id    BIGINT,
  store        TEXT         NOT NULL,
  org_id       TEXT         NOT NULL,
  action       TEXT         NOT NULL CHECK (action IN ('insert','update','delete')),
  actor_org_id TEXT,
  actor_role   TEXT,
  actor_sub    TEXT,
  old_data     JSONB,
  new_data     JSONB,
  ts           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avico_audit_lookup ON avico_audit(store, record_id, ts DESC);

CREATE OR REPLACE FUNCTION avico_audit_trigger() RETURNS TRIGGER AS $$
DECLARE claims json;
BEGIN
  claims := COALESCE(NULLIF(current_setting('request.jwt.claims', true),''), '{}')::json;
  INSERT INTO avico_audit(record_id,store,org_id,action,actor_org_id,actor_role,actor_sub,old_data,new_data)
  VALUES(COALESCE(NEW.id,OLD.id), COALESCE(NEW.store,OLD.store), COALESCE(NEW.org_id,OLD.org_id),
         lower(TG_OP), claims->>'org_id', claims->>'user_role', claims->>'sub',
         CASE WHEN TG_OP<>'INSERT' THEN OLD.data END,
         CASE WHEN TG_OP<>'DELETE' THEN NEW.data END);
  RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS avico_audit_trg ON avico_records;
CREATE TRIGGER avico_audit_trg
  AFTER INSERT OR UPDATE OR DELETE ON avico_records
  FOR EACH ROW EXECUTE FUNCTION avico_audit_trigger();

-- 5. ROW LEVEL SECURITY — isolation réelle par org_id, via JWT signé par l'Edge Function staff-login
--    ⚠️ Déploiement en 2 temps obligatoire :
--    a) exécuter ce script (anon perd tout accès direct)
--    b) déployer staff-login + bootstrap-org AVANT de couper l'accès anon en prod,
--       sinon plus personne ne peut se connecter tant que les Edge Functions ne sont pas actives.
ALTER TABLE avico_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE avico_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "avico_anon_access" ON avico_records;
REVOKE ALL ON avico_records FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON avico_records TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE avico_records_id_seq TO authenticated;

CREATE POLICY "avico_org_isolation" ON avico_records
  FOR ALL TO authenticated
  USING (org_id = (current_setting('request.jwt.claims', true)::json->>'org_id'))
  WITH CHECK (org_id = (current_setting('request.jwt.claims', true)::json->>'org_id'));

-- 5bis. org_id imposé serveur — empêche l'écriture croisée même authentifié
CREATE OR REPLACE FUNCTION avico_force_org_id() RETURNS TRIGGER AS $$
BEGIN
  NEW.org_id := COALESCE(current_setting('request.jwt.claims', true)::json->>'org_id', NEW.org_id);
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS avico_force_org ON avico_records;
CREATE TRIGGER avico_force_org
  BEFORE INSERT OR UPDATE ON avico_records
  FOR EACH ROW EXECUTE FUNCTION avico_force_org_id();

-- 6. REALTIME (mises à jour temps réel entre utilisateurs)
ALTER PUBLICATION supabase_realtime ADD TABLE avico_records;

-- 7. INDEXES ADDITIONNELS pour les filtres les plus courants
CREATE INDEX IF NOT EXISTS idx_avico_data_flock
  ON avico_records ((data->>'flockId'))
  WHERE store IN ('feeding','egg_prod','growth_prod','health','mortalite');

CREATE INDEX IF NOT EXISTS idx_avico_data_date
  ON avico_records ((data->>'date'))
  WHERE store IN ('feeding','egg_prod','sales','tresorerie','charges');

-- VÉRIFICATION : doit retourner la table et ses indexes
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_name = 'avico_records';

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'avico_records';
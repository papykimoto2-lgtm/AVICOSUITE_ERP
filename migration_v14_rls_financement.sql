-- ═══════════════════════════════════════════════════════════════════════════
--  SANIX AVINEST PRO — Migration v14
--  Accès restreint par dossier de financement (RLS Supabase)
--
--  À exécuter dans : Supabase Dashboard → SQL Editor (une seule fois, idempotent).
--  Prérequis : migration_v13.sql / PROD_DDL déjà appliqués (table avico_records,
--  table avico_members, politique « avico_org_isolation »).
--
--  Objectif : faire respecter CÔTÉ BASE ce que l'application affiche déjà
--  (module Financement de bande › Documents › « Accès au dossier »).
--  Sans ce script, la restriction n'est qu'une règle d'interface : un utilisateur
--  technique pourrait lire ou modifier le dossier en appelant directement l'API.
--
--  Règles appliquées aux enregistrements du store 'financements_bande' :
--    • dossier SANS restriction (data.acl.restreint ≠ true) : comportement actuel
--      (tout membre actif de l'organisation lit et écrit) ;
--    • dossier restreint : accès pour
--        - les rôles 'admin' et 'manager' de l'organisation,
--        - le propriétaire (data.proprio = auth.uid()),
--        - data.acl.editeurs : lecture + modification,
--        - data.acl.lecteurs : lecture seule ;
--      tous les autres ne le voient pas (SELECT, y compris temps réel) et ne peuvent
--      ni le modifier ni le supprimer ;
--    • data.acl et data.proprio ne sont modifiables que par un gestionnaire du dossier
--      (admin, manager ou propriétaire) ;
--    • à la création, data.proprio doit être vide ou égal à l'utilisateur connecté
--      (sauf admin/manager).
--
--  Les autres stores ne sont pas touchés. Les politiques ajoutées sont RESTRICTIVES :
--  elles s'ajoutent (ET) à « avico_org_isolation » sans la remplacer.
--
--  Limite : les rôles « lecture seule » définis dans l'application (réglage ROLE_PERMS)
--  ne sont pas connus de la base. Pour les faire respecter aussi côté base, renseignez
--  la liste v_ro_roles de la fonction avico_fin_niveau ci-dessous.
--
--  Retour arrière : voir la section ROLLBACK en bas de fichier.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Rôle de l'utilisateur connecté dans l'organisation (NULL = non membre ou inactif)
CREATE OR REPLACE FUNCTION avico_fin_membre(p_org TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.role FROM avico_members m
   WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.actif IS NOT FALSE
   LIMIT 1
$$;

-- 2. Gestionnaire du dossier : admin, manager ou propriétaire
CREATE OR REPLACE FUNCTION avico_fin_gestionnaire(p_data JSONB, p_org TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT := avico_fin_membre(p_org);
BEGIN
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  RETURN v_role IN ('admin','manager')
      OR COALESCE(p_data->>'proprio','') = COALESCE(auth.uid()::TEXT,'#');
END $$;

-- 3. Niveau d'accès : 'edit' | 'read' | 'none'
CREATE OR REPLACE FUNCTION avico_fin_niveau(p_data JSONB, p_org TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role    TEXT   := avico_fin_membre(p_org);
  v_uid     TEXT   := COALESCE(auth.uid()::TEXT,'#');
  v_acl     JSONB  := COALESCE(p_data->'acl','{}'::JSONB);
  -- Rôles de l'application en lecture seule sur le module (ex. ARRAY['lecteur','comptable'])
  v_ro_roles TEXT[] := ARRAY[]::TEXT[];
  v_niv     TEXT;
BEGIN
  IF v_role IS NULL THEN RETURN 'none'; END IF;
  IF COALESCE(v_acl->>'restreint','false') <> 'true' THEN
    v_niv := 'edit';
  ELSIF avico_fin_gestionnaire(p_data, p_org) THEN
    v_niv := 'edit';
  ELSIF COALESCE(v_acl->'editeurs','[]'::JSONB) ? v_uid THEN
    v_niv := 'edit';
  ELSIF COALESCE(v_acl->'lecteurs','[]'::JSONB) ? v_uid THEN
    v_niv := 'read';
  ELSE
    RETURN 'none';
  END IF;
  -- Un rôle en lecture seule le reste, même avec « Modification » sur le dossier
  IF v_niv = 'edit' AND v_role = ANY(v_ro_roles) THEN v_niv := 'read'; END IF;
  RETURN v_niv;
END $$;

REVOKE ALL ON FUNCTION avico_fin_membre(TEXT), avico_fin_gestionnaire(JSONB,TEXT), avico_fin_niveau(JSONB,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION avico_fin_membre(TEXT), avico_fin_gestionnaire(JSONB,TEXT), avico_fin_niveau(JSONB,TEXT) TO authenticated;

-- 4. Politiques RESTRICTIVES (s'ajoutent à avico_org_isolation)
DROP POLICY IF EXISTS "avico_fin_acl_select" ON avico_records;
DROP POLICY IF EXISTS "avico_fin_acl_insert" ON avico_records;
DROP POLICY IF EXISTS "avico_fin_acl_update" ON avico_records;
DROP POLICY IF EXISTS "avico_fin_acl_delete" ON avico_records;

CREATE POLICY "avico_fin_acl_select" ON avico_records AS RESTRICTIVE FOR SELECT TO authenticated
  USING (store <> 'financements_bande' OR avico_fin_niveau(data, org_id) IN ('edit','read'));

CREATE POLICY "avico_fin_acl_insert" ON avico_records AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (store <> 'financements_bande' OR (
        avico_fin_niveau(data, org_id) = 'edit'
    AND (COALESCE(data->>'proprio','') IN ('', COALESCE(auth.uid()::TEXT,'#'))
         OR avico_fin_membre(org_id) IN ('admin','manager'))
  ));

CREATE POLICY "avico_fin_acl_update" ON avico_records AS RESTRICTIVE FOR UPDATE TO authenticated
  USING      (store <> 'financements_bande' OR avico_fin_niveau(data, org_id) = 'edit')
  WITH CHECK (store <> 'financements_bande' OR avico_fin_niveau(data, org_id) = 'edit');

CREATE POLICY "avico_fin_acl_delete" ON avico_records AS RESTRICTIVE FOR DELETE TO authenticated
  USING (store <> 'financements_bande' OR avico_fin_niveau(data, org_id) = 'edit');

-- 5. Déclencheur : seuls les gestionnaires peuvent modifier data.acl / data.proprio
CREATE OR REPLACE FUNCTION avico_fin_protege_acl() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.store = 'financements_bande' AND TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL THEN
    IF (NEW.data->'acl') IS DISTINCT FROM (OLD.data->'acl')
       OR (NEW.data->'proprio') IS DISTINCT FROM (OLD.data->'proprio') THEN
      IF NOT avico_fin_gestionnaire(OLD.data, OLD.org_id) THEN
        RAISE EXCEPTION 'Seul un gestionnaire du dossier (propriétaire, administrateur ou responsable) peut modifier les accès'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS avico_fin_protege_acl_trg ON avico_records;
CREATE TRIGGER avico_fin_protege_acl_trg
  BEFORE UPDATE ON avico_records
  FOR EACH ROW EXECUTE FUNCTION avico_fin_protege_acl();

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
--  VÉRIFICATION (à lancer APRÈS la migration, dans le SQL Editor)
--  Remplacez les UUID par ceux de vrais utilisateurs (table avico_members.user_id)
--  et l'identifiant par celui d'un dossier restreint. Tout est annulé par ROLLBACK.
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   -- a) Utilisateur SANS accès : doit renvoyer 0 ligne
--   SELECT set_config('request.jwt.claims', '{"sub":"<UUID_SANS_ACCES>","role":"authenticated"}', true);
--   SELECT id, data->>'nom' FROM avico_records WHERE store='financements_bande' AND id = <ID_DOSSIER>;
--   -- b) Lecteur : 1 ligne, mais la modification doit toucher 0 ligne
--   SELECT set_config('request.jwt.claims', '{"sub":"<UUID_LECTEUR>","role":"authenticated"}', true);
--   SELECT id FROM avico_records WHERE id = <ID_DOSSIER>;
--   UPDATE avico_records SET data = data || '{"x":1}' WHERE id = <ID_DOSSIER>;   -- 0 ligne
--   -- c) Éditeur : peut modifier le dossier, mais pas data.acl (erreur 42501)
--   SELECT set_config('request.jwt.claims', '{"sub":"<UUID_EDITEUR>","role":"authenticated"}', true);
--   UPDATE avico_records SET data = data || '{"x":1}' WHERE id = <ID_DOSSIER>;   -- 1 ligne
--   UPDATE avico_records SET data = jsonb_set(data,'{acl,restreint}','false') WHERE id = <ID_DOSSIER>;  -- erreur
-- ROLLBACK;

-- ═══════════════════════════════════════════════════════════════════════════
--  ROLLBACK (retour à l'état précédent : les dossiers redeviennent visibles par
--  tous les membres de l'organisation, quelle que soit la restriction affichée)
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   DROP TRIGGER IF EXISTS avico_fin_protege_acl_trg ON avico_records;
--   DROP FUNCTION IF EXISTS avico_fin_protege_acl();
--   DROP POLICY IF EXISTS "avico_fin_acl_select" ON avico_records;
--   DROP POLICY IF EXISTS "avico_fin_acl_insert" ON avico_records;
--   DROP POLICY IF EXISTS "avico_fin_acl_update" ON avico_records;
--   DROP POLICY IF EXISTS "avico_fin_acl_delete" ON avico_records;
--   DROP FUNCTION IF EXISTS avico_fin_niveau(JSONB,TEXT);
--   DROP FUNCTION IF EXISTS avico_fin_gestionnaire(JSONB,TEXT);
--   DROP FUNCTION IF EXISTS avico_fin_membre(TEXT);
-- COMMIT;

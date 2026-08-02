// supabase/functions/hard-reset/index.ts
//
// Déplace la "Réinitialisation totale" côté serveur.
// Le client (navigateur) n'a plus le pouvoir de DELETE sur avico_records :
// il doit passer par cette fonction, qui revérifie l'identité admin
// AVANT d'utiliser la clé service_role pour supprimer.
//
// Déploiement : supabase functions deploy hard-reset
// Secrets requis (supabase secrets set) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (déjà injectés automatiquement par Supabase)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ⚠️ Même algorithme de hash que le front (djb2) pour rester compatible
// avec les mots de passe existants. À MIGRER vers bcrypt/argon2 dès que possible
// (voir recommandation en fin de fichier).
function simpleHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { org_id, email, password } = await req.json();

    if (!org_id || !email || !password) {
      return new Response(
        JSON.stringify({ error: "org_id, email et password sont requis" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client "admin" avec service_role : bypass RLS, jamais exposé au navigateur.
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Retrouver l'utilisateur dans avico_records (store='users') pour cet org_id
    const { data: userRows, error: userErr } = await supabaseAdmin
      .from("avico_records")
      .select("id, data")
      .eq("store", "users")
      .eq("org_id", org_id);

    if (userErr) throw userErr;

    const userRecord = (userRows || []).find(
      (r: any) => r.data?.email === email && r.data?.actif !== false
    );

    if (!userRecord) {
      return new Response(JSON.stringify({ error: "Identifiants invalides" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Vérifier le mot de passe ET le rôle admin — CÔTÉ SERVEUR
    const pwdOk = userRecord.data.pwd === simpleHash(password);
    const isAdmin = userRecord.data.role === "admin";

    if (!pwdOk || !isAdmin) {
      return new Response(
        JSON.stringify({ error: "Identifiants invalides ou droits insuffisants" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Suppression réelle — uniquement atteignable après vérification serveur
    const { error: delErr, count } = await supabaseAdmin
      .from("avico_records")
      .delete({ count: "exact" })
      .eq("org_id", org_id);

    if (delErr) throw delErr;

    return new Response(
      JSON.stringify({ success: true, deleted: count ?? 0 }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── RECOMMANDATION SUIVANTE ──
// 1. Migrer simpleHash() -> bcrypt (ex: via https://deno.land/x/bcrypt) pour
//    les nouveaux mots de passe, avec migration progressive à la connexion.
// 2. À terme, remplacer complètement ce flux "email+password en clair à chaque
//    reset" par une vraie session Supabase Auth (le JWT porterait déjà le rôle
//    et l'org_id, plus besoin de renvoyer le mot de passe).

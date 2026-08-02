// supabase/functions/bootstrap-org/index.ts
// Amorçage 1er admin d'une organisation (remplace l'ancien initDemoUsers() client).
// Idempotent : refuse si l'org possède déjà au moins un utilisateur.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const PBKDF2_SALT = "SanixAviNest_PBKDF2_2025";
const PBKDF2_ITER = 100000;

async function hashPwd(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(PBKDF2_SALT), iterations: PBKDF2_ITER },
    key, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { org_id, nom, email, password } = await req.json();
    if (!org_id || !nom || !email || !password) {
      return new Response(JSON.stringify({ error: "org_id, nom, email, password requis" }), { status: 400, headers: CORS });
    }
    if (org_id === "default") {
      return new Response(JSON.stringify({ error: "org_id 'default' interdit en production" }), { status: 400, headers: CORS });
    }

    const admin = createClient(Deno.env.get("SB_URL")!, Deno.env.get("SB_SERVICE_ROLE")!);
    const { data: existing, error: e1 } = await admin
      .from("avico_records").select("id").eq("store", "users").eq("org_id", org_id).is("deleted_at", null).limit(1);
    if (e1) throw e1;
    if (existing && existing.length) {
      return new Response(JSON.stringify({ error: "Organisation déjà initialisée" }), { status: 409, headers: CORS });
    }

    const pwd = await hashPwd(password);
    const { data, error } = await admin.from("avico_records").insert({
      store: "users", org_id,
      data: { nom, email, pwd, role: "admin", actif: true, dernierAcces: null },
    }).select("id").single();
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, user_id: data.id }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: CORS });
  }
});

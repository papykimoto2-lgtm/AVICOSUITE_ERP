// supabase/functions/staff-login/index.ts
// Vérifie email+mdp côté serveur (service_role, RLS bypass) et émet un JWT
// HS256 signé avec le JWT Secret du projet (Project Settings → API → JWT Settings
// → "Legacy JWT Secret"). PostgREST valide ce token nativement, sans passer
// par Supabase Auth : current_setting('request.jwt.claims') expose org_id/user_role/sub.
//
// Secrets requis (supabase secrets set) :
//   JWT_SECRET   = JWT Secret du projet
//   SB_URL       = https://xxxx.supabase.co
//   SB_SERVICE_ROLE = service_role key (jamais exposée au client)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const PBKDF2_SALT = "SanixAviNest_PBKDF2_2025";
const PBKDF2_ITER = 100000;

async function verifyPwd(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (/^[0-9a-f]{64}$/.test(storedHash)) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(PBKDF2_SALT), iterations: PBKDF2_ITER },
      key, 256
    );
    const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computed === storedHash;
  }
  return false; // djb2 legacy non accepté côté serveur — forcer migration au login classique client avant bascule
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { email, password, org_id, remember } = await req.json();
    if (!email || !password || !org_id) {
      return new Response(JSON.stringify({ error: "email, password, org_id requis" }), { status: 400, headers: CORS });
    }

    const admin = createClient(Deno.env.get("SB_URL")!, Deno.env.get("SB_SERVICE_ROLE")!);
    const { data: rows, error } = await admin
      .from("avico_records")
      .select("id,data")
      .eq("store", "users")
      .eq("org_id", org_id)
      .is("deleted_at", null);
    if (error) throw error;

    const user = (rows || []).map(r => ({ ...r.data, id: r.id }))
      .find((u: any) => (u.email || "").toLowerCase() === String(email).toLowerCase() && u.actif !== false);

    if (!user || !(await verifyPwd(password, user.pwd))) {
      return new Response(JSON.stringify({ error: "Email ou mot de passe incorrect" }), { status: 401, headers: CORS });
    }

    const secret = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(Deno.env.get("JWT_SECRET")!),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const expSeconds = remember ? 30 * 24 * 3600 : 10 * 3600;
    const token = await create(
      { alg: "HS256", typ: "JWT" },
      { role: "authenticated", org_id, user_role: user.role, sub: String(user.id), exp: getNumericDate(expSeconds) },
      secret
    );

    await admin.from("avico_records").update({ data: { ...user, dernierAcces: new Date().toISOString(), pwd: user.pwd } })
      .eq("id", user.id).eq("store", "users");

    return new Response(JSON.stringify({
      token,
      expires_at: Date.now() + expSeconds * 1000,
      user: { id: user.id, nom: user.nom, email: user.email, role: user.role },
    }), { headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: CORS });
  }
});

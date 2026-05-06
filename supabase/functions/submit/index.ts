// ============================================================================
// DriftMetrics  //  Edge Function: /functions/v1/submit
// ----------------------------------------------------------------------------
// The single write-path entry point for the frontend. Validates Turnstile,
// optionally redeems a code, then inserts into query_queue.
//
// Always returns HTTP 201 with {ok: true} (or with extra fields on success).
// Failures are silent by design — bots get the same response shape as
// successful submits, so they can't probe for valid configurations.
//
// Deploy:
//   npx supabase functions deploy submit --no-verify-jwt
//
// Required secret:
//   npx supabase secrets set TURNSTILE_SECRET=<your-secret>
//
// Auto-populated by Supabase (don't set manually):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TS_SECRET    = Deno.env.get("TURNSTILE_SECRET") ?? "";

// Lock this down once you have a deployed origin. Set the env var
// ALLOWED_ORIGINS to a comma-separated list, e.g.:
//   "https://driftmetrics.example.com,http://localhost:8000"
// If unset, defaults to "*". CORS is one layer; Turnstile + shadowban + RLS
// are the others, so * is acceptable during development.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",").map(s => s.trim()).filter(Boolean);

const TS_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SILENT_OK = { ok: true };

interface SubmitBody {
  request_id?: string;
  keyword?: string;
  code?: string;
  honeypot?: string;
  turnstile_token?: string;
  user_agent?: string;
}

function corsHeaders(origin: string): Record<string, string> {
  const allow = ALLOWED_ORIGINS.includes("*")
    ? "*"
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "");
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Max-Age":       "86400",
    "Vary": "Origin",
  };
}

function silent(origin: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ...SILENT_OK, ...extra }), {
    status: 201,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/json",
    },
  });
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "0.0.0.0";
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!token || !TS_SECRET) return false;
  const form = new FormData();
  form.append("secret",   TS_SECRET);
  form.append("response", token);
  if (ip && ip !== "0.0.0.0") form.append("remoteip", ip);
  try {
    const r = await fetch(TS_VERIFY_URL, { method: "POST", body: form });
    if (!r.ok) return false;
    const data = await r.json() as { success?: boolean };
    return data.success === true;
  } catch (_e) {
    return false;
  }
}

function isUuid(s: unknown): s is string {
  return typeof s === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405, headers: corsHeaders(origin),
    });
  }

  // Parse body. Malformed → silent OK (don't tell a bot it sent garbage).
  let body: SubmitBody;
  try {
    body = await req.json() as SubmitBody;
  } catch (_e) {
    return silent(origin);
  }

  const requestId = body.request_id;
  const keyword   = (body.keyword ?? "").toString();
  const code      = (body.code    ?? "").toString().trim();
  const honeypot  = (body.honeypot ?? "").toString();
  const tsToken   = (body.turnstile_token ?? "").toString();
  const userAgent = (body.user_agent ?? req.headers.get("user-agent") ?? "").toString();
  const ip        = clientIp(req);

  // Shape gates. Silent fails — return shape identical to a real submit.
  if (!isUuid(requestId)) return silent(origin);
  if (keyword.length < 2 || keyword.length > 128) return silent(origin);

  // 1. Turnstile verification. Failure is silent.
  const tsOk = await verifyTurnstile(tsToken, ip);
  if (!tsOk) return silent(origin);

  // 2. Build a Supabase client with service role. Forward x-forwarded-for
  //    so the trigger's dm_client_ip() sees the real client IP, not the
  //    edge function's egress IP.
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        "x-forwarded-for": ip,
        "x-real-ip":       ip,
      },
    },
  });

  // 3a. Coded path: redeem_code RPC. Decrements balance + inserts atomically.
  if (code.length > 0) {
    const { data, error } = await supabase.rpc("redeem_code", {
      p_request_id:  requestId,
      p_keyword:     keyword,
      p_code:        code,
      p_user_agent:  userAgent || null,
    });

    if (error) {
      // DB error → silent. (Logged server-side via Supabase function logs.)
      console.error("redeem_code error:", error);
      return silent(origin);
    }

    // data is the JSONB shape: {ok, remaining?, bonus?, tier?, error?}
    if (data && data.ok === true) {
      // Surface remaining + tier so the UI can show "9 LEFT" badge.
      // Do NOT surface `bonus` — it's a hidden mechanic per ASC spec §6.
      return silent(origin, {
        coded:     true,
        remaining: data.remaining,
        tier:      data.tier,
      });
    }

    // Invalid / depleted / expired code → silent. The shadowban model says
    // the attacker (or the user with a bad code) gets the same response
    // as success. They'll see node timeout 45s later. By then they've
    // hopefully checked their card and tried again.
    return silent(origin);
  }

  // 3b. Cached-open path: direct insert into query_queue. The shadowban
  //     trigger fires normally and may silently mutate status to
  //     'shadowbanned' if the IP is over rate or the queue is full.
  const { error } = await supabase
    .from("query_queue")
    .insert({
      request_id:  requestId,
      keyword:     keyword,
      honeypot:    honeypot,
      user_agent:  userAgent || null,
    });

  if (error) {
    console.error("queue insert error:", error);
    // Still return silent OK — we don't differentiate failure modes to client.
  }

  return silent(origin);
});

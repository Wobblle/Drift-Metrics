// ============================================================================
// DriftMetrics // Edge Function: /functions/v1/sad_advance
// ----------------------------------------------------------------------------
// The single write-path entry for the Bureau game layer (SAD INTAKE). Validates
// the code, optionally burns scrapes, then advances the player's hash-chained
// ledger stub. Two modes:
//
//   * Standard advance — CAS on prev_head + count. Fails with `desync` if the
//     server's stored head doesn't match the client's prev_head. Used for
//     normal stamping and any chain extension.
//
//   * Force advance — bypasses CAS, costs a flat 3 scrapes ("provenance tax"),
//     resets the server head to whatever the client claims. Used to recover
//     from orphan state (someone else used the code, or local archive lost).
//
// Always returns a JSON body. Failure cases are explicit (unlike /submit's
// silent-OK pattern) because the Bureau UI needs to surface what happened so
// the player can react in lore terms (LEDGER DESYNC, BALANCE INSUFFICIENT,
// etc).
//
// Deploy:
//   npx supabase functions deploy sad_advance --no-verify-jwt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",").map(s => s.trim()).filter(Boolean);

const HEX64       = /^[0-9a-f]{64}$/i;
const ZERO64      = "0".repeat(64);
const FORCE_COST  = 3;
const MAX_COST    = 10;

interface AdvanceBody {
  code?: string;
  prev_head?: string;
  new_head?: string;
  new_count?: number;
  cost?: number;
  force?: boolean;
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

function json(origin: string, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/json",
    },
  });
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

  let body: AdvanceBody;
  try {
    body = await req.json() as AdvanceBody;
  } catch (_e) {
    return json(origin, { ok: false, error: "invalid_body" }, 400);
  }

  const code     = (body.code      ?? "").toString().trim();
  const newHead  = (body.new_head  ?? "").toString().trim().toLowerCase();
  const newCount = Number(body.new_count ?? -1);
  const force    = !!body.force;
  const prevHead = force
    ? ZERO64
    : (body.prev_head ?? "").toString().trim().toLowerCase();

  // Force-overwrite always costs FORCE_COST. For other actions take from
  // body.cost, clamped to [0, MAX_COST]. Stamps in v0.1 are cost=0.
  const cost = force
    ? FORCE_COST
    : Math.max(0, Math.min(MAX_COST, Math.floor(Number(body.cost ?? 0))));

  // Input validation. Cheap bail-outs.
  if (!code) {
    return json(origin, { ok: false, error: "code_required" }, 400);
  }
  if (!HEX64.test(newHead)) {
    return json(origin, { ok: false, error: "bad_new_head" }, 400);
  }
  if (!Number.isInteger(newCount) || newCount < 1) {
    return json(origin, { ok: false, error: "bad_new_count" }, 400);
  }
  if (!force && !HEX64.test(prevHead)) {
    return json(origin, { ok: false, error: "bad_prev_head" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Burn scrapes first when cost > 0. If burn fails, no advance happens.
  //    Note: in v0.1 the only path with cost > 0 is force-overwrite, where
  //    the subsequent advance is an upsert and cannot return desync. So
  //    charge-then-advance is safe here. When DEEP-FILE / DISPATCH ship in
  //    v0.2 we'll need refund-on-desync logic if those ever cost scrapes
  //    AND go through standard advance.
  if (cost > 0) {
    const { data: burnData, error: burnErr } =
      await supabase.rpc("burn_code", { p_code: code, p_amount: cost });
    if (burnErr) {
      console.error("burn_code error:", burnErr);
      return json(origin, { ok: false, error: "burn_failed" }, 500);
    }
    if (!burnData || burnData.ok !== true) {
      return json(origin, {
        ok:        false,
        error:     burnData?.error ?? "burn_rejected",
        remaining: burnData?.remaining,
        required:  burnData?.required,
      });
    }
  }

  // 2. Advance (or force-advance) the chain.
  const rpcName = force ? "sad_force_advance" : "sad_advance";
  const rpcArgs = force
    ? { p_code: code, p_new_head: newHead, p_new_count: newCount }
    : { p_code: code, p_prev_head: prevHead, p_new_head: newHead, p_new_count: newCount };

  const { data: advData, error: advErr } = await supabase.rpc(rpcName, rpcArgs);
  if (advErr) {
    console.error(`${rpcName} error:`, advErr);
    return json(origin, { ok: false, error: "advance_failed" }, 500);
  }
  if (!advData || advData.ok !== true) {
    return json(origin, {
      ok:           false,
      error:        advData?.error ?? "advance_rejected",
      server_head:  advData?.head,
      server_count: advData?.count,
      cost_charged: cost,
    });
  }

  return json(origin, {
    ok:           true,
    head:         advData.head,
    count:        advData.count,
    cost_charged: cost,
  });
});

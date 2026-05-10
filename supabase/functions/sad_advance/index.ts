// ============================================================================
// DriftMetrics // Edge Function: /functions/v1/sad_advance  v0.3a
// ----------------------------------------------------------------------------
// The single write-path entry for the Bureau game layer (SAD INTAKE). Validates
// inputs, optionally burns scrapes against the ACTIVE code, then advances the
// player's hash-chained ledger stub identified by (anchor_code, chain_nonce).
//
// Two modes:
//
//   * Standard advance — CAS on prev_head + count under the chain identified
//     by (anchor_code, chain_nonce). Fails with `desync` if the server's
//     stored head doesn't match. Used for stamping, deep-file, dispatch, and
//     stacking new codes (which is just a STACK chain event).
//
//   * Force advance — bypasses CAS, costs a flat 3-scrape provenance tax,
//     resets the server head/cdx to whatever the client claims. Used to
//     recover from local-data loss or to override a parallel chain you
//     already control.
//
// Notes on v0.3a fields:
//   * anchor_code   — first code in the player's codex, never changes for a
//                     given chain. Used for routing.
//   * active_code   — code currently at the top of the codex. Used for
//                     burning scrapes. May equal anchor_code in single-code
//                     codexes.
//   * chain_nonce   — random hex32 generated client-side at chain genesis.
//                     Allows multiple chains to coexist on the same anchor.
//   * cdx_hash      — sha256 roll of the codex; stored passively in v0.3a
//                     (no server enforcement, but binds the client chain).
//
// Always returns a JSON body. Failure cases are explicit so the Bureau UI can
// react in lore terms (LEDGER DESYNC, BALANCE INSUFFICIENT, etc).
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
const HEX32_NONCE = /^[0-9a-f]{32}$/i;
const ZERO64      = "0".repeat(64);
const FORCE_COST  = 3;
const MAX_COST    = 10;

interface AdvanceBody {
  // Routing — chain identity
  anchor_code?: string;
  chain_nonce?: string;
  // Authentication / billing — burns happen against this
  active_code?: string;
  // Chain advance payload
  prev_head?: string;
  new_head?: string;
  new_count?: number;
  cdx_hash?: string;
  // Action options
  cost?: number;
  force?: boolean;
  // Backwards-compat — pre-v0.3 clients sent `code` only
  code?: string;
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
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders(origin) });
  }

  let body: AdvanceBody;
  try { body = await req.json() as AdvanceBody; }
  catch (_e) { return json(origin, { ok: false, error: "invalid_body" }, 400); }

  // Routing identity. Pre-v0.3 clients send `code`; treat that as both
  // anchor and active for backwards compat. Pre-v0.3 clients also won't
  // send chain_nonce; default to the legacy sentinel (zero string).
  const legacyCode = (body.code ?? "").toString().trim();
  const anchorCode = (body.anchor_code ?? legacyCode).toString().trim();
  const activeCode = (body.active_code ?? (legacyCode || anchorCode)).toString().trim();
  const chainNonce = (body.chain_nonce ?? "0".repeat(32)).toString().trim().toLowerCase();

  const newHead   = (body.new_head  ?? "").toString().trim().toLowerCase();
  const newCount  = Number(body.new_count ?? -1);
  const force     = !!body.force;
  const prevHead  = force
    ? ZERO64
    : (body.prev_head ?? "").toString().trim().toLowerCase();
  const cdxHash   = body.cdx_hash ? String(body.cdx_hash).trim().toLowerCase() : null;

  const cost = force
    ? FORCE_COST
    : Math.max(0, Math.min(MAX_COST, Math.floor(Number(body.cost ?? 0))));

  // Input validation.
  if (!anchorCode) return json(origin, { ok: false, error: "code_required" }, 400);
  if (!activeCode) return json(origin, { ok: false, error: "active_code_required" }, 400);
  if (!HEX32_NONCE.test(chainNonce) && chainNonce !== "0".repeat(32)) {
    return json(origin, { ok: false, error: "bad_chain_nonce" }, 400);
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
  if (cdxHash !== null && !HEX64.test(cdxHash)) {
    return json(origin, { ok: false, error: "bad_cdx_hash" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Refund helper for the cost>0 + advance-failed path.
  async function refund(amount: number): Promise<boolean> {
    if (amount <= 0) return true;
    const { data, error } =
      await supabase.rpc("credit_code", { p_code: activeCode, p_amount: amount });
    if (error) {
      console.error("credit_code (refund) error:", error);
      return false;
    }
    return !!(data && data.ok === true);
  }

  // 1. Burn scrapes from the ACTIVE code (which may differ from anchor when
  //    a player has stacked codes on top of their original).
  if (cost > 0) {
    const { data: burnData, error: burnErr } =
      await supabase.rpc("burn_code", { p_code: activeCode, p_amount: cost });
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

  // 2. Advance the chain identified by (anchor_code, chain_nonce).
  const rpcName = force ? "sad_force_advance" : "sad_advance";
  const rpcArgs = force
    ? {
        p_anchor_code: anchorCode,
        p_chain_nonce: chainNonce,
        p_new_head:    newHead,
        p_new_count:   newCount,
        p_cdx_hash:    cdxHash,
      }
    : {
        p_anchor_code: anchorCode,
        p_chain_nonce: chainNonce,
        p_prev_head:   prevHead,
        p_new_head:    newHead,
        p_new_count:   newCount,
        p_cdx_hash:    cdxHash,
      };

  const { data: advData, error: advErr } = await supabase.rpc(rpcName, rpcArgs);

  if (advErr) {
    console.error(`${rpcName} error:`, advErr);
    if (cost > 0) await refund(cost);
    return json(origin, { ok: false, error: "advance_failed", cost_charged: 0 }, 500);
  }

  if (!advData || advData.ok !== true) {
    let refunded = false;
    if (cost > 0) refunded = await refund(cost);
    return json(origin, {
      ok:           false,
      error:        advData?.error ?? "advance_rejected",
      server_head:  advData?.head,
      server_count: advData?.count,
      server_cdx:   advData?.cdx_hash,
      cost_charged: refunded ? 0 : cost,
      refunded,
    });
  }

  return json(origin, {
    ok:           true,
    head:         advData.head,
    count:        advData.count,
    cdx_hash:     advData.cdx_hash,
    cost_charged: cost,
  });
});

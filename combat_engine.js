// ============================================================================
// combat_engine.js
// ----------------------------------------------------------------------------
// Pure deterministic combat engine for Telemetry Trench.
//
// CONTRACT:
//   - No DOM, no fs, no network. Pure compute.
//   - Same input always yields same output (seeded PRNG, no Date.now(), no Math.random()).
//   - Importable in browser AND in Node.js worker subprocess.
//   - Items catalog passed in as parameter (engine does not load files).
//
// USAGE:
//   import { simulate, ENGINE_VERSION } from './combat_engine.js';
//   const result = simulate({
//     player_board, ghost_board, drift_score, seed, round_number, items_catalog
//   });
//
// Asleepius Games LLC — Telemetry Trench — v0.1.0
// ============================================================================

export const ENGINE_VERSION = "0.1.0";

// ============================================================================
// 1. DETERMINISTIC PRNG (mulberry32)
// ----------------------------------------------------------------------------
// Seed is a hex string (typically sha256 output). We take the first 32 bits
// as the PRNG state. mulberry32 is a simple, fast, well-tested deterministic
// PRNG with good statistical properties for game randomness.
// ============================================================================

function makePRNG(seedHex) {
  if (typeof seedHex !== "string" || seedHex.length < 8) {
    throw new Error("seed must be a hex string of at least 8 chars");
  }
  let a = parseInt(seedHex.slice(0, 8), 16) | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Roll an integer in [min, max] inclusive using the PRNG.
function rollInt(prng, min, max) {
  if (max < min) return min;
  return Math.floor(min + prng() * (max - min + 1));
}

// ============================================================================
// 2. BOARD HELPERS
// ----------------------------------------------------------------------------
// Boards are arrays of placements: [{item_id, lane, tick}, ...]
// Lanes: 1..4. Ticks: 1..8. At most one item per (lane, tick) cell.
// ============================================================================

function indexBoard(board) {
  // Returns { byCell: Map("lane:tick" -> placement), byLane: {1:[], 2:[], 3:[], 4:[]} }
  const byCell = new Map();
  const byLane = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of board) {
    byCell.set(`${p.lane}:${p.tick}`, p);
    if (byLane[p.lane]) byLane[p.lane].push(p);
  }
  for (const lane of [1, 2, 3, 4]) {
    byLane[lane].sort((a, b) => a.tick - b.tick);
  }
  return { byCell, byLane };
}

function getItemAt(idx, lane, tick) {
  return idx.byCell.get(`${lane}:${tick}`) || null;
}

function emptyTicksBehind(idx, lane, tick) {
  // Count contiguous empty ticks before this one on the same lane.
  let count = 0;
  for (let t = tick - 1; t >= 1; t--) {
    if (idx.byCell.has(`${lane}:${t}`)) break;
    count++;
  }
  return count;
}

function emptyTicksAhead(idx, lane, tick) {
  let count = 0;
  for (let t = tick + 1; t <= 8; t++) {
    if (idx.byCell.has(`${lane}:${t}`)) break;
    count++;
  }
  return count;
}

function laneHasItemOfType(idx, lane, itemId) {
  return idx.byLane[lane].some((p) => p.item_id === itemId);
}

function laneItemOfType(idx, lane, itemId) {
  return idx.byLane[lane].find((p) => p.item_id === itemId) || null;
}

// ============================================================================
// 3. CHARGE CALCULATION
// ----------------------------------------------------------------------------
// Given a placement and the full board context, compute its effective charge
// count for this combat. Returns a number (>= 0). Returns 0 if the item is
// "consumed" by a Drain Pole behind it.
//
// Order of operations:
//   1. base = emptyTicksBehind
//   2. Echo Capacitor on this lane → base counts double (with overflow bonus)
//   3. Inversion Plate on this lane → add emptyTicksAhead
//   4. Drain Pole at tick-1 on this lane → double charges, mark forward as consumed
//      (handled at consumption-resolution layer, not here)
//   5. Sink on enemy side at SAME tick column → subtract 1 (floored at 0)
//   6. Drift modifier applies to max_charge ceiling at fire-time, not here
// ============================================================================

function computeCharges({
  placement,
  ownIdx,
  enemyIdx,
  itemsCatalog,
  consumedSet,
}) {
  const { lane, tick } = placement;

  // If this item was consumed by a Drain Pole behind it, it can't charge.
  if (consumedSet.has(`${lane}:${tick}`)) return { charges: 0, consumed: true };

  // 1. Base charge: empty ticks behind on same lane
  let charges = emptyTicksBehind(ownIdx, lane, tick);

  // 2. Echo Capacitor on this lane — find one (if multiple, take strongest)
  const echo = laneItemOfType(ownIdx, lane, "echo_capacitor");
  if (echo && echo.tick < tick) {
    // Echo's own charge level determines multiplier strength.
    const echoCharges = emptyTicksBehind(ownIdx, lane, echo.tick);
    const echoItem = itemsCatalog["echo_capacitor"];
    if (echoCharges >= echoItem.min_charge) {
      const overflow = Math.max(0, echoCharges - (echoItem.soft_max || 3));
      const mult =
        echoItem.effect.multiplier_base +
        overflow * echoItem.effect.multiplier_per_overflow;
      charges = Math.floor(charges * mult);
    }
  }

  // 3. Inversion Plate on this lane — empty ticks ahead also count
  const inv = laneItemOfType(ownIdx, lane, "inversion_plate");
  if (inv && inv.tick !== tick) {
    const invCharges = emptyTicksBehind(ownIdx, lane, inv.tick);
    const invItem = itemsCatalog["inversion_plate"];
    if (invCharges >= invItem.min_charge) {
      charges += emptyTicksAhead(ownIdx, lane, tick);
    }
  }

  // 4. Drain Pole at lane:tick-1 → doubles this item's effective charges,
  //    consumes this item. Handled separately at the resolution layer:
  //    if THIS placement is "consumed", we don't fire (handled in §5).
  //    The Drain Pole itself, when resolved, gets its own charges doubled.
  const drainAtPrev = getItemAt(ownIdx, lane, tick - 1);
  if (placement.item_id === "drain_pole") {
    // We ARE the drain pole. Get our own charges from emptyTicksBehind,
    // then double them as our effect.
    const drainCharges = emptyTicksBehind(ownIdx, lane, tick);
    const drainItem = itemsCatalog["drain_pole"];
    if (drainCharges >= drainItem.min_charge) {
      charges = drainCharges * 2;
    }
  } else if (drainAtPrev && drainAtPrev.item_id === "drain_pole") {
    // We're being consumed by the drain pole behind us — mark and bail.
    return { charges: 0, consumed: true };
  }

  // 5. Sink on enemy side at same tick column → -1 charge
  for (let l = 1; l <= 4; l++) {
    const enemyItem = getItemAt(enemyIdx, l, tick);
    if (enemyItem && enemyItem.item_id === "sink") {
      // Sink applies to the player item in the SAME tick column, ANY lane.
      // (Reading: a sink on the enemy's lane 2 at tick 5 reduces ALL player
      //  items at tick 5 by 1 charge. This is intentional — sinks are
      //  broad-spectrum anti-overclock tech, not lane-locked.)
      charges = Math.max(0, charges - 1);
      break; // multiple sinks at same tick don't stack — keep it simple
    }
  }

  return { charges: Math.max(0, charges), consumed: false };
}

// ============================================================================
// 4. DAMAGE ROLL
// ----------------------------------------------------------------------------
// Given an item and its effective charges, return a damage roll.
// Capped: max_roll scales linearly from min to max as charges/max_charge.
// Uncapped: at soft_max charges = full max; each additional charge adds
//           +25% of (max-min) to the upper bound. Linear scaling continues.
// ============================================================================

function rollDamage(item, charges, prng, driftMaxChargeBonus) {
  const dMin = item.effect.damage_min;
  const dMax = item.effect.damage_max;

  // Drift modifies the effective max_charge ceiling, NOT the charges themselves.
  // So a max_charge=3 item with drift +1 effectively scales toward max at 4 charges.
  let effectiveMax;
  let chargeRatio;

  if (item.max_charge === "uncapped") {
    const softMax = (item.soft_max || 3) + driftMaxChargeBonus;
    const baseScale = Math.min(1.0, charges / Math.max(1, softMax));
    const overflow = Math.max(0, charges - softMax);
    const upper = dMin + (dMax - dMin) * (baseScale + overflow * 0.25);
    return rollInt(prng, dMin, Math.floor(upper));
  } else {
    effectiveMax = item.max_charge + driftMaxChargeBonus;
    if (effectiveMax <= 0) {
      // drift squeeze took the ceiling to zero — item rolls minimum
      return dMin;
    }
    chargeRatio = Math.min(1.0, charges / effectiveMax);
    const upper = dMin + (dMax - dMin) * chargeRatio;
    return rollInt(prng, dMin, Math.floor(upper));
  }
}

// Generic range roll for non-damage effects (reflect %, integrity bonus, etc.)
function rollRange(prng, min, max, charges, maxCharge, driftMaxChargeBonus) {
  if (maxCharge === "uncapped" || maxCharge === 0) {
    // For binary or uncapped non-damage, just use min/max directly with ratio.
    if (maxCharge === 0) return Math.floor((min + max) / 2);
  }
  const effectiveMax = (maxCharge || 1) + driftMaxChargeBonus;
  if (effectiveMax <= 0) return min;
  const ratio = Math.min(1.0, charges / effectiveMax);
  const upper = min + (max - min) * ratio;
  return rollInt(prng, min, Math.floor(upper));
}

// ============================================================================
// 5. PRE-COMBAT: PASSIVES + CONSUMPTION SETUP
// ----------------------------------------------------------------------------
// Before tick 1, resolve all passives (Shroud Plate adds lane integrity) and
// build the set of "consumed" cells (items eaten by Drain Poles behind them).
// ============================================================================

function applyPassivesAndConsumption({
  board,
  state,
  itemsCatalog,
  prng,
  driftMaxChargeBonus,
  ownIdx,
  log,
  side,
}) {
  const consumed = new Set();

  // Drain Pole consumption: each drain pole at (lane, tick) consumes the item
  // at (lane, tick+1), if any.
  for (const p of board) {
    if (p.item_id === "drain_pole") {
      const drainItem = itemsCatalog["drain_pole"];
      const drainCharges = emptyTicksBehind(ownIdx, p.lane, p.tick);
      if (drainCharges >= drainItem.min_charge) {
        const forward = getItemAt(ownIdx, p.lane, p.tick + 1);
        if (forward) {
          consumed.add(`${p.lane}:${p.tick + 1}`);
          log.push({
            phase: "pre_combat",
            actor: side,
            event: "drain_pole_consumed",
            lane: p.lane,
            tick: p.tick,
            consumed: { item: forward.item_id, at_tick: p.tick + 1 },
          });
        }
      }
    }
  }

  // Shroud Plates: passive lane integrity bonus.
  for (const p of board) {
    if (consumed.has(`${p.lane}:${p.tick}`)) continue;
    if (p.item_id !== "shroud_plate") continue;
    const item = itemsCatalog["shroud_plate"];
    const charges = emptyTicksBehind(ownIdx, p.lane, p.tick);
    if (charges < item.min_charge) continue;
    const bonus = rollRange(
      prng,
      item.effect.bonus_min,
      item.effect.bonus_max,
      charges,
      item.max_charge,
      driftMaxChargeBonus
    );
    state.lane_integrity[p.lane - 1] += bonus;
    log.push({
      phase: "pre_combat",
      actor: side,
      event: "shroud_plate",
      lane: p.lane,
      tick: p.tick,
      charges,
      bonus,
      lane_integrity_after: state.lane_integrity[p.lane - 1],
    });
  }

  return consumed;
}

// ============================================================================
// 6. DAMAGE APPLICATION
// ----------------------------------------------------------------------------
// Apply damage to a target's lane. Handles:
//   - Static Cage blocking the FIRST damage source on that lane (consumed once)
//   - Reflector Coil reflecting a % back
//   - Aegis Loop preventing collapse once per round
//   - Lane integrity → spillover to phantom_pool when lane collapses
// ============================================================================

function applyDamageToLane({
  attackerSide,
  defenderState,
  defenderIdx,
  defenderBoard,
  targetLane,
  rawDamage,
  itemsCatalog,
  log,
  tick,
  sourceItem,
  sourceLane,
}) {
  if (rawDamage <= 0) return { damage_dealt: 0, reflected: 0 };

  // Static Cage check: blocks the first damage source on this lane per round.
  const cagePlace = laneItemOfType(defenderIdx, targetLane, "static_cage");
  if (cagePlace && !defenderState.cage_used[targetLane]) {
    const cageItem = itemsCatalog["static_cage"];
    const cageCharges = emptyTicksBehind(defenderIdx, targetLane, cagePlace.tick);
    if (cageCharges >= cageItem.min_charge) {
      defenderState.cage_used[targetLane] = true;
      log.push({
        phase: "combat",
        tick,
        actor: attackerSide,
        event: "static_cage_block",
        defender_lane: targetLane,
        blocked_item: sourceItem,
        blocked_damage: rawDamage,
      });
      return { damage_dealt: 0, reflected: 0, blocked: true };
    }
  }

  // Reflector Coil: reflects a % of the damage back at the attacker's same lane.
  let reflected = 0;
  const reflPlace = laneItemOfType(defenderIdx, targetLane, "reflector_coil");
  if (reflPlace) {
    const reflItem = itemsCatalog["reflector_coil"];
    const reflCharges = emptyTicksBehind(defenderIdx, targetLane, reflPlace.tick);
    if (reflCharges >= reflItem.min_charge) {
      const pct = rollRange(
        defenderState._prng,
        reflItem.effect.reflect_pct_min,
        reflItem.effect.reflect_pct_max,
        reflCharges,
        reflItem.max_charge,
        defenderState._driftBonus
      );
      reflected = Math.floor((rawDamage * pct) / 100);
    }
  }

  // Apply to lane integrity first; spill to phantom_pool if lane collapses.
  let remaining = rawDamage;
  const laneIdx = targetLane - 1;
  if (defenderState.lane_integrity[laneIdx] > 0) {
    const absorb = Math.min(defenderState.lane_integrity[laneIdx], remaining);
    defenderState.lane_integrity[laneIdx] -= absorb;
    remaining -= absorb;
    if (defenderState.lane_integrity[laneIdx] === 0 && !defenderState.lanes_collapsed.includes(targetLane)) {
      // Check Aegis Loop save
      const aegis = laneItemOfType(defenderIdx, targetLane, "aegis_loop");
      if (aegis && !defenderState.aegis_used[targetLane]) {
        const aegisItem = itemsCatalog["aegis_loop"];
        const aegisCharges = emptyTicksBehind(defenderIdx, targetLane, aegis.tick);
        if (aegisCharges >= aegisItem.min_charge) {
          defenderState.aegis_used[targetLane] = true;
          defenderState.lane_integrity[laneIdx] = 5; // emergency restore
          log.push({
            phase: "combat",
            tick,
            event: "aegis_loop_save",
            actor: attackerSide === "player" ? "ghost" : "player",
            lane: targetLane,
            restored_to: 5,
          });
        } else {
          defenderState.lanes_collapsed.push(targetLane);
        }
      } else {
        defenderState.lanes_collapsed.push(targetLane);
      }
    }
  }
  // Spillover into phantom_pool
  if (remaining > 0) {
    defenderState.phantom_pool = Math.max(0, defenderState.phantom_pool - remaining);
  }

  return { damage_dealt: rawDamage, reflected, blocked: false };
}

// ============================================================================
// 7. TICK RESOLUTION
// ----------------------------------------------------------------------------
// For a given tick, resolve all items that fire this tick on both boards.
// Order within a tick:
//   1. Compute all damage rolls (player + ghost) — no state mutation yet
//   2. Apply Cascade (damage copies to adjacent lanes) on both sides
//   3. Apply Drift Tap multipliers per lane (additive across taps on that lane)
//   4. Apply Keyword Forge burst on tick 4 (drift_score * 10 to that lane)
//   5. Apply damage to defenders (Static Cage → Reflector → Integrity → Pool)
//   6. Apply reflected damage to attackers
// ============================================================================

function getFiringEvents(board, idx, tick, itemsCatalog) {
  // Returns [{ placement, item, charges, fires_this_tick }, ...]
  const events = [];
  for (const p of board) {
    const item = itemsCatalog[p.item_id];
    if (!item) continue;
    const t = item.effect.type;
    let firesThisTick = false;

    if (t === "damage_on_placed_tick" && p.tick === tick) firesThisTick = true;
    else if (t === "damage_on_tick_8" && tick === 8) firesThisTick = true;
    else if (t === "damage_twice_placement_and_eight" && (p.tick === tick || tick === 8)) {
      // Avoid double-firing if placed on tick 8
      if (p.tick === 8 && tick === 8) firesThisTick = true; // only once
      else if (p.tick === tick) firesThisTick = true;
      else if (tick === 8) firesThisTick = true;
    } else if (t === "damage_every_other_tick" && p.tick <= tick && (tick - p.tick) % 2 === 0) {
      firesThisTick = true;
    } else if (t === "drift_burst_on_tick_4" && tick === 4) {
      firesThisTick = true;
    }

    if (firesThisTick) events.push({ placement: p, item });
  }
  return events;
}

function resolveTick({
  tick,
  playerBoard,
  ghostBoard,
  playerIdx,
  ghostIdx,
  playerState,
  ghostState,
  playerConsumed,
  ghostConsumed,
  itemsCatalog,
  prng,
  driftScore,
  driftMaxChargeBonus,
  log,
}) {
  // Phase A: compute raw damage rolls and queue them
  const queueDamage = (side, ownIdx, enemyIdx, ownConsumed, ownBoard) => {
    const events = getFiringEvents(ownBoard, ownIdx, tick, itemsCatalog);
    const out = [];
    for (const ev of events) {
      const { placement, item } = ev;
      if (ownConsumed.has(`${placement.lane}:${placement.tick}`)) continue;

      // Charges
      const { charges } = computeCharges({
        placement,
        ownIdx,
        enemyIdx,
        itemsCatalog,
        consumedSet: ownConsumed,
      });
      if (charges < item.min_charge) {
        log.push({
          phase: "combat",
          tick,
          actor: side,
          event: "misfire",
          lane: placement.lane,
          item: placement.item_id,
          charges,
          min_required: item.min_charge,
        });
        continue;
      }

      // Damage
      let damage = 0;
      if (item.effect.type === "drift_burst_on_tick_4") {
        damage = Math.floor(driftScore * item.effect.drift_multiplier);
      } else {
        damage = rollDamage(item, charges, prng, driftMaxChargeBonus);
      }

      out.push({
        side,
        placement,
        item,
        charges,
        damage_base: damage,
        target_lane: placement.lane,
      });
    }
    return out;
  };

  const playerEvents = queueDamage("player", playerIdx, ghostIdx, playerConsumed, playerBoard);
  const ghostEvents = queueDamage("ghost", ghostIdx, playerIdx, ghostConsumed, ghostBoard);

  // Phase B: apply Drift Tap multipliers per lane (additive across taps)
  const applyDriftTap = (events, ownIdx) => {
    for (const ev of events) {
      const tap = laneItemOfType(ownIdx, ev.placement.lane, "drift_tap");
      if (!tap) continue;
      const tapItem = itemsCatalog["drift_tap"];
      const tapCharges = emptyTicksBehind(ownIdx, ev.placement.lane, tap.tick);
      if (tapCharges < tapItem.min_charge) continue;
      const effectiveTapCharges = Math.min(tapCharges, tapItem.max_charge + driftMaxChargeBonus);
      const mult = 1 + effectiveTapCharges * tapItem.effect.per_charge_bonus;
      ev.damage_after_drift_tap = Math.floor(ev.damage_base * mult);
    }
    for (const ev of events) {
      if (ev.damage_after_drift_tap === undefined) ev.damage_after_drift_tap = ev.damage_base;
    }
  };
  applyDriftTap(playerEvents, playerIdx);
  applyDriftTap(ghostEvents, ghostIdx);

  // Phase C: Cascade — copy lane damage to adjacent lanes
  const applyCascade = (events, ownIdx) => {
    const extras = [];
    for (const ev of events) {
      if (ev.item.effect.type !== "drift_burst_on_tick_4" &&
          !["damage_on_placed_tick", "damage_on_tick_8", "damage_twice_placement_and_eight", "damage_every_other_tick"].includes(ev.item.effect.type)) {
        continue;
      }
      const cas = laneItemOfType(ownIdx, ev.placement.lane, "cascade");
      if (!cas) continue;
      const casItem = itemsCatalog["cascade"];
      const casCharges = emptyTicksBehind(ownIdx, ev.placement.lane, cas.tick);
      if (casCharges < casItem.min_charge) continue;
      const effective = Math.min(casCharges, casItem.max_charge + driftMaxChargeBonus);
      const ratio = (effective - casItem.min_charge) / Math.max(1, casItem.max_charge - casItem.min_charge);
      const copyPct =
        casItem.effect.copy_pct_at_min +
        (casItem.effect.copy_pct_at_max - casItem.effect.copy_pct_at_min) * ratio;
      const copied = Math.floor((ev.damage_after_drift_tap * copyPct) / 100);
      const adjacents = [ev.placement.lane - 1, ev.placement.lane + 1].filter((l) => l >= 1 && l <= 4);
      for (const adj of adjacents) {
        extras.push({
          side: ev.side,
          placement: ev.placement,
          item: ev.item,
          charges: ev.charges,
          damage_base: copied,
          damage_after_drift_tap: copied,
          target_lane: adj,
          via_cascade: true,
        });
      }
    }
    return extras;
  };
  const playerCascades = applyCascade(playerEvents, playerIdx);
  const ghostCascades = applyCascade(ghostEvents, ghostIdx);
  playerEvents.push(...playerCascades);
  ghostEvents.push(...ghostCascades);

  // Phase D: apply damage. Player attacks ghost. Ghost attacks player.
  playerState._prng = prng;
  playerState._driftBonus = driftMaxChargeBonus;
  ghostState._prng = prng;
  ghostState._driftBonus = driftMaxChargeBonus;

  const reflectsBackToPlayer = [];
  const reflectsBackToGhost = [];

  for (const ev of playerEvents) {
    const res = applyDamageToLane({
      attackerSide: "player",
      defenderState: ghostState,
      defenderIdx: ghostIdx,
      defenderBoard: ghostBoard,
      targetLane: ev.target_lane,
      rawDamage: ev.damage_after_drift_tap,
      itemsCatalog,
      log,
      tick,
      sourceItem: ev.placement.item_id,
      sourceLane: ev.placement.lane,
    });
    log.push({
      phase: "combat",
      tick,
      actor: "player",
      event: "fire",
      lane: ev.placement.lane,
      target_lane: ev.target_lane,
      item: ev.placement.item_id,
      charges: ev.charges,
      damage_rolled: ev.damage_base,
      damage_after_drift_tap: ev.damage_after_drift_tap,
      damage_dealt: res.damage_dealt,
      blocked: !!res.blocked,
      via_cascade: !!ev.via_cascade,
      ghost_lane_integrity: ghostState.lane_integrity[ev.target_lane - 1],
      ghost_phantom_pool: ghostState.phantom_pool,
    });
    if (res.reflected > 0) reflectsBackToPlayer.push({ lane: ev.placement.lane, dmg: res.reflected });
  }

  for (const ev of ghostEvents) {
    const res = applyDamageToLane({
      attackerSide: "ghost",
      defenderState: playerState,
      defenderIdx: playerIdx,
      defenderBoard: playerBoard,
      targetLane: ev.target_lane,
      rawDamage: ev.damage_after_drift_tap,
      itemsCatalog,
      log,
      tick,
      sourceItem: ev.placement.item_id,
      sourceLane: ev.placement.lane,
    });
    log.push({
      phase: "combat",
      tick,
      actor: "ghost",
      event: "fire",
      lane: ev.placement.lane,
      target_lane: ev.target_lane,
      item: ev.placement.item_id,
      charges: ev.charges,
      damage_rolled: ev.damage_base,
      damage_after_drift_tap: ev.damage_after_drift_tap,
      damage_dealt: res.damage_dealt,
      blocked: !!res.blocked,
      via_cascade: !!ev.via_cascade,
      player_lane_integrity: playerState.lane_integrity[ev.target_lane - 1],
      player_phantom_pool: playerState.phantom_pool,
    });
    if (res.reflected > 0) reflectsBackToGhost.push({ lane: ev.placement.lane, dmg: res.reflected });
  }

  // Phase E: reflected damage applied back. Reflects can't trigger reflects.
  for (const r of reflectsBackToPlayer) {
    const laneIdx = r.lane - 1;
    if (playerState.lane_integrity[laneIdx] > 0) {
      const absorb = Math.min(playerState.lane_integrity[laneIdx], r.dmg);
      playerState.lane_integrity[laneIdx] -= absorb;
      const spill = r.dmg - absorb;
      if (spill > 0) playerState.phantom_pool = Math.max(0, playerState.phantom_pool - spill);
    } else {
      playerState.phantom_pool = Math.max(0, playerState.phantom_pool - r.dmg);
    }
    log.push({
      phase: "combat",
      tick,
      event: "reflect_back",
      actor: "ghost",
      target_lane: r.lane,
      damage: r.dmg,
      player_phantom_pool: playerState.phantom_pool,
    });
  }
  for (const r of reflectsBackToGhost) {
    const laneIdx = r.lane - 1;
    if (ghostState.lane_integrity[laneIdx] > 0) {
      const absorb = Math.min(ghostState.lane_integrity[laneIdx], r.dmg);
      ghostState.lane_integrity[laneIdx] -= absorb;
      const spill = r.dmg - absorb;
      if (spill > 0) ghostState.phantom_pool = Math.max(0, ghostState.phantom_pool - spill);
    } else {
      ghostState.phantom_pool = Math.max(0, ghostState.phantom_pool - r.dmg);
    }
    log.push({
      phase: "combat",
      tick,
      event: "reflect_back",
      actor: "player",
      target_lane: r.lane,
      damage: r.dmg,
      ghost_phantom_pool: ghostState.phantom_pool,
    });
  }
}

// ============================================================================
// 8. WINNER DETERMINATION
// ----------------------------------------------------------------------------
// player wins if: ghost phantom_pool <= 0 OR all 4 ghost lanes collapsed OR
//                  total damage dealt by player > total damage dealt by ghost
// ghost wins  if: player phantom_pool <= 0 OR all 4 player lanes collapsed OR
//                  total damage dealt by ghost > total damage dealt by player
// draw       if: both phantom_pools equal and damage tallies equal
// ============================================================================

function determineWinner(playerState, ghostState, log) {
  if (ghostState.phantom_pool <= 0) return "player";
  if (playerState.phantom_pool <= 0) return "ghost";
  if (ghostState.lanes_collapsed.length === 4) return "player";
  if (playerState.lanes_collapsed.length === 4) return "ghost";

  // Damage tally tiebreaker (sum of damage_dealt events)
  let playerDmg = 0, ghostDmg = 0;
  for (const ev of log) {
    if (ev.event !== "fire") continue;
    if (ev.actor === "player") playerDmg += ev.damage_dealt || 0;
    else if (ev.actor === "ghost") ghostDmg += ev.damage_dealt || 0;
  }
  if (playerDmg > ghostDmg) return "player";
  if (ghostDmg > playerDmg) return "ghost";
  return "draw";
}

// ============================================================================
// 9. PUBLIC API: simulate(input)
// ============================================================================

export function simulate(input) {
  const {
    player_board,
    ghost_board,
    drift_score,
    seed,
    round_number,
    items_catalog,
    player_starting_state,
    ghost_starting_state,
  } = input;

  if (!Array.isArray(player_board)) throw new Error("player_board must be array");
  if (!Array.isArray(ghost_board)) throw new Error("ghost_board must be array");
  if (typeof drift_score !== "number") throw new Error("drift_score must be number");
  if (typeof seed !== "string") throw new Error("seed must be string");
  if (!items_catalog || typeof items_catalog !== "object")
    throw new Error("items_catalog required");

  const clampedDrift = Math.max(0, Math.min(1, drift_score));
  const driftMaxChargeBonus =
    clampedDrift >= 0.75 ? 1 : clampedDrift <= 0.25 ? -1 : 0;

  const prng = makePRNG(seed);

  // Starting state: optional inputs override defaults. Both sides may carry
  // phantom_pool across rounds, and lane_integrity may be upgraded.
  const defaultIntegrity = () => [30, 30, 30, 30];
  const playerState = {
    phantom_pool: (player_starting_state && typeof player_starting_state.phantom_pool === "number")
      ? player_starting_state.phantom_pool : 100,
    lane_integrity: (player_starting_state && Array.isArray(player_starting_state.lane_integrity) && player_starting_state.lane_integrity.length === 4)
      ? player_starting_state.lane_integrity.slice() : defaultIntegrity(),
    lanes_collapsed: [],
    cage_used: {},
    aegis_used: {},
  };
  const ghostState = {
    phantom_pool: (ghost_starting_state && typeof ghost_starting_state.phantom_pool === "number")
      ? ghost_starting_state.phantom_pool : 100,
    lane_integrity: (ghost_starting_state && Array.isArray(ghost_starting_state.lane_integrity) && ghost_starting_state.lane_integrity.length === 4)
      ? ghost_starting_state.lane_integrity.slice() : defaultIntegrity(),
    lanes_collapsed: [],
    cage_used: {},
    aegis_used: {},
  };

  const playerIdx = indexBoard(player_board);
  const ghostIdx = indexBoard(ghost_board);

  const log = [];

  // Pre-combat: passives + consumption mapping
  const playerConsumed = applyPassivesAndConsumption({
    board: player_board,
    state: playerState,
    itemsCatalog: items_catalog,
    prng,
    driftMaxChargeBonus,
    ownIdx: playerIdx,
    log,
    side: "player",
  });
  const ghostConsumed = applyPassivesAndConsumption({
    board: ghost_board,
    state: ghostState,
    itemsCatalog: items_catalog,
    prng,
    driftMaxChargeBonus,
    ownIdx: ghostIdx,
    log,
    side: "ghost",
  });

  // Combat loop: 8 ticks
  for (let tick = 1; tick <= 8; tick++) {
    // Early termination if either side is dead
    if (playerState.phantom_pool <= 0 || ghostState.phantom_pool <= 0) break;

    resolveTick({
      tick,
      playerBoard: player_board,
      ghostBoard: ghost_board,
      playerIdx,
      ghostIdx,
      playerState,
      ghostState,
      playerConsumed,
      ghostConsumed,
      itemsCatalog: items_catalog,
      prng,
      driftScore: clampedDrift,
      driftMaxChargeBonus,
      log,
    });
  }

  // Strip internal fields before returning
  const cleanState = (s) => ({
    phantom_pool: s.phantom_pool,
    lane_integrity: s.lane_integrity.slice(),
    lanes_collapsed: s.lanes_collapsed.slice(),
  });

  const winner = determineWinner(playerState, ghostState, log);

  return {
    tick_log: log,
    final_state: {
      player: cleanState(playerState),
      ghost: cleanState(ghostState),
    },
    winner,
    drift_score_used: clampedDrift,
    max_charge_modifier: driftMaxChargeBonus,
    seed,
    round_number,
    engine_version: ENGINE_VERSION,
  };
}

// ============================================================================
// Default export for environments that prefer it
// ============================================================================
export default { simulate, ENGINE_VERSION };

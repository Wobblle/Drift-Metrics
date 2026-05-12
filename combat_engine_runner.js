#!/usr/bin/env node
// ============================================================================
// combat_engine_runner.js
// ----------------------------------------------------------------------------
// CLI shim for combat_engine.js. Reads JSON input from stdin, invokes
// simulate(), writes JSON output to stdout. Exit code 0 on success, 1 on
// any error (with diagnostic JSON on stderr).
//
// USAGE (from Python worker):
//   proc = subprocess.run(
//       ["node", "combat_engine_runner.js"],
//       input=json.dumps({
//           "player_board":  [...],
//           "ghost_board":   [...],
//           "drift_score":   0.83,
//           "seed":          "abc123...",
//           "round_number":  5,
//           "items_catalog_path": "/path/to/trench_items.json"  // OR
//           "items_catalog":      { ... }                         // inline
//       }),
//       capture_output=True, text=True, timeout=30,
//   )
//   result = json.loads(proc.stdout)
//
// Asleepius Games LLC — Telemetry Trench — v0.1.0
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, ENGINE_VERSION } from "./combat_engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fail(msg, details) {
  const err = { ok: false, error: msg, engine_version: ENGINE_VERSION };
  if (details) err.details = details;
  process.stderr.write(JSON.stringify(err) + "\n");
  process.exit(1);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
    // 5 second hard timeout on stdin read
    setTimeout(() => reject(new Error("stdin read timeout")), 5000);
  });
}

(async () => {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    fail("stdin_read_failed", String(e));
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    fail("invalid_json_input", String(e));
  }

  // Resolve items_catalog: either inline or from path
  let catalogObj;
  if (input.items_catalog && typeof input.items_catalog === "object") {
    catalogObj = input.items_catalog;
  } else if (input.items_catalog_path) {
    try {
      const txt = fs.readFileSync(input.items_catalog_path, "utf8");
      catalogObj = JSON.parse(txt);
    } catch (e) {
      fail("items_catalog_load_failed", String(e));
    }
  } else {
    // Default: trench_items.json adjacent to this script
    try {
      const def = path.join(__dirname, "trench_items.json");
      const txt = fs.readFileSync(def, "utf8");
      catalogObj = JSON.parse(txt);
    } catch (e) {
      fail("items_catalog_missing", "no items_catalog or items_catalog_path provided and ./trench_items.json not readable");
    }
  }

  // Normalize: catalog can be {items: [...]} or {id: item, ...}
  let itemsById;
  if (Array.isArray(catalogObj)) {
    itemsById = {};
    for (const it of catalogObj) itemsById[it.id] = it;
  } else if (catalogObj.items && Array.isArray(catalogObj.items)) {
    itemsById = {};
    for (const it of catalogObj.items) itemsById[it.id] = it;
  } else if (typeof catalogObj === "object") {
    itemsById = catalogObj;
  } else {
    fail("items_catalog_shape_invalid");
  }

  let result;
  try {
    result = simulate({
      player_board: input.player_board,
      ghost_board: input.ghost_board,
      drift_score: input.drift_score,
      seed: input.seed,
      round_number: input.round_number,
      items_catalog: itemsById,
    });
  } catch (e) {
    fail("simulate_threw", String(e.message || e));
  }

  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  process.exit(0);
})();

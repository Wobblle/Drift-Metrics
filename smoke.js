import { simulate, ENGINE_VERSION } from './combat_engine.js';
import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync('./trench_items.json', 'utf8'));
const itemsById = {};
for (const it of catalog.items) itemsById[it.id] = it;

const input = {
  player_board: [
    { item_id: 'matrix_bolt', lane: 1, tick: 5 },
    { item_id: 'void_battery', lane: 3, tick: 1 },
    { item_id: 'shroud_plate', lane: 2, tick: 1 },
    { item_id: 'capacitor_mine', lane: 4, tick: 8 },
  ],
  ghost_board: [
    { item_id: 'matrix_bolt', lane: 1, tick: 4 },
    { item_id: 'drift_lance', lane: 2, tick: 3 },
    { item_id: 'shroud_plate', lane: 3, tick: 1 },
  ],
  drift_score: 0.83,
  seed: 'abc123def456789012345678901234567890abcdef1234567890abcdef123456',
  round_number: 5,
  items_catalog: itemsById,
};

const result = simulate(input);

console.log('engine:', ENGINE_VERSION);
console.log('winner:', result.winner);
console.log('drift modifier:', result.max_charge_modifier);
console.log('player final:', JSON.stringify(result.final_state.player));
console.log('ghost final:', JSON.stringify(result.final_state.ghost));
console.log('tick log entries:', result.tick_log.length);
console.log('---');
console.log('first 5 events:');
result.tick_log.slice(0, 5).forEach(e => console.log('  ' + JSON.stringify(e)));
console.log('last 5 events:');
result.tick_log.slice(-5).forEach(e => console.log('  ' + JSON.stringify(e)));
console.log('---');

const result2 = simulate(input);
const ok = result.winner === result2.winner &&
           JSON.stringify(result.final_state) === JSON.stringify(result2.final_state) &&
           result.tick_log.length === result2.tick_log.length;
console.log('determinism check:', ok ? 'PASS' : 'FAIL');

import {test} from "node:test";
import assert from "node:assert/strict";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const blast = (extra={}) => ({schemaVersion: 1, id: "action:blast", label: "Blast", costs: {allOf: []},
  damage: [{id: "fire", expression: {type: "dice", number: {type: "context", path: "area.ticks"}, faces: 6}, damageType: "fire",
    provenance: "spell-base"}], ...extra});
/** The validation errors' paths of a 20-ft lasting area (with a clock) whose one trigger is `trigger`. */
const reasons = trigger => validateActionDefinition({schemaVersion: 1, id: "action:bead", label: "Bead", costs: {allOf: []},
  targeting: {type: "area"}, area: {shape: "radial", size: {value: 20, unit: "ft"}, persistence: {clock: {}, triggers: [trigger]}}})
  .errors.map(error => error.path);

test("an area.ended trigger is valid with its age and a ticks gate; once, per, turnOf, push out, a depth fall, opens and leavesArea are refused", () => {
  assert.deepEqual(reasons({on: ["area.ended"], ticks: {from: 1}, action: blast()}), []);
  assert.deepEqual(reasons({on: ["area.ended"], action: blast({fall: {feet: 10}})}), [], "a fall of its own feet");
  const at = path => [`area.persistence.triggers.0.${path}`];
  for ( const [extra, path] of [[{once: "turn"}, "once"], [{once: "area"}, "once"], [{per: 5}, "per"], [{turnOf: "source"}, "turnOf"]] ) {
    assert.deepEqual(reasons({on: ["area.ended"], ...extra, action: blast()}), at(path), JSON.stringify(extra));
  }
  assert.deepEqual(reasons({on: ["turn.started", "area.ended"], once: "turn", action: blast()}), at("once"), "beside another event too");
  assert.deepEqual(reasons({on: ["area.ended"], action: blast({save: {ability: "agility", dc: {type: "constant", value: 15}},
    push: {out: true}})}), at("action.push.out"));
  assert.deepEqual(reasons({on: ["area.ended"], action: blast({fall: {}})}), at("action.fall"));
  assert.deepEqual(reasons({on: ["area.ended"], action: blast({effects: [{id: "stuck", type: "condition", conditionId: "restrained",
    metadata: {endsWhen: "leavesArea"}}]})}), at("action.effects"));
  assert.ok(reasons({on: ["area.ended"], action: blast({targeting: {type: "self"}, opens: {count: 1, depth: 10, persistence: {}}})})
    .includes(at("action.opens")[0]), "openings ride a caster-turn trigger");
  assert.deepEqual(reasons({on: ["area.exited"], once: "turn", action: blast({push: {out: true}})}), [], "other events unchanged");
});

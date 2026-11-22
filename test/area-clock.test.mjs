import {test} from "node:test";
import assert from "node:assert/strict";
import {areaTicks, persistentAreaRegionData} from "../module/adapters/foundry-v14-persistent-areas.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {fillContextPaths} from "../module/helpers/value-expressions.mjs";

const TICKS = {type: "context", path: "area.ticks"};
const action = (id, expression) => ({schemaVersion: 1, id, label: "Bead", costs: {allOf: []},
  damage: [{id: "fire", expression, damageType: "fire", provenance: "spell-base"}]});
/** A lasting area's Action with `persistence` (a 20-ft sphere), and its validation errors' paths. */
const definition = (persistence, extra={}) => ({schemaVersion: 1, id: "action:bead", label: "Bead", costs: {allOf: []},
  targeting: {type: "area"}, area: {shape: "radial", size: {value: 20, unit: "ft"}, persistence}, ...extra});
const reasons = (persistence, extra) => validateActionDefinition(definition(persistence, extra)).errors.map(error => error.path);

test("fillContextPaths writes named numbers into an Action, works out a dice count and floors it at 0; nothing named, the same object", () => {
  // Delayed Blast Fireball's growth: 12d6 + (ticks)d6; Tsunami's shrinking 6 - ticks d10.
  const growing = action("action:grow", {type: "add", terms: [{type: "dice", number: 12, faces: 6}, {type: "dice", number: TICKS, faces: 6}]});
  assert.deepEqual(fillContextPaths(growing, {"area.ticks": 3}).damage[0].expression,
    {type: "add", terms: [{type: "dice", number: 12, faces: 6}, {type: "dice", number: 3, faces: 6}]});
  const shrinking = {type: "dice", number: {type: "subtract", terms: [6, TICKS]}, faces: 10};
  assert.deepEqual([1, 5, 8].map(ticks => fillContextPaths(shrinking, {"area.ticks": ticks}).number), [5, 1, 0]);
  assert.deepEqual(fillContextPaths({type: "add", terms: [1, TICKS]}, {"area.ticks": 2}),
    {type: "add", terms: [1, {type: "constant", value: 2}]}, "outside a dice count, a constant");
  const plain = action("action:plain", {type: "dice", number: 2, faces: 6});
  assert.equal(fillContextPaths(plain, {"area.ticks": 2}), plain, "nothing to write in");
  const other = {type: "context", path: "summon.level"};
  assert.equal(fillContextPaths(other, {"area.ticks": 2}), other, "a path it is not given stays");
  // A count also reading a number known only at resolution keeps it, with the age written in, for then.
  const mixed = {type: "dice", number: {type: "add", terms: [{type: "context", path: "castLevel"}, TICKS]}, faces: 6};
  assert.deepEqual(fillContextPaths(mixed, {"area.ticks": 2}).number,
    {type: "add", terms: [{type: "context", path: "castLevel"}, {type: "constant", value: 2}]});
});

test("fillContextPaths leaves area.* in a nested lasting area's triggers for its own age, and still fills other paths there", () => {
  const LEVEL = {type: "context", path: "summon.level"};
  const nested = {type: "dice", number: {type: "add", terms: [TICKS, LEVEL]}, faces: 6};
  const persistence = {clock: {}, triggers: [{on: ["turn.started"], turnOf: "source", action: action("action:inner", nested)}]};
  const outer = {...action("action:outer", {type: "dice", number: TICKS, faces: 6}), opens: {persistence},
    area: {persistence}, sections: {leaves: persistence}};
  const filled = fillContextPaths(outer, {"area.ticks": 3, "summon.level": 4});
  assert.deepEqual(filled.damage[0].expression.number, 3, "the outer area's own age");
  for ( const holder of [filled.opens, filled.area, filled.sections.leaves] ) {
    assert.deepEqual(holder.persistence?.triggers[0].action.damage[0].expression.number
      ?? holder.triggers[0].action.damage[0].expression.number, {type: "add", terms: [TICKS, {type: "constant", value: 4}]});
  }
});

test("a lasting area's clock and its triggers' ticks are validated; area.ticks is refused outside a lasting area's trigger", () => {
  const trigger = (extra={}, expression={type: "constant", value: 1}) => ({on: ["turn.started"], turnOf: "source",
    action: action("action:t", expression), ...extra});
  assert.deepEqual(reasons({clock: {}, triggers: [trigger({ticks: {from: 1, to: 1}}, {type: "dice", number: TICKS, faces: 6})]}), []);
  assert.deepEqual(reasons({clock: {at: "turn.ended", every: {value: 1, units: "minutes"}}}), []);
  for ( const clock of [{at: "round.started"}, {every: {value: 0, units: "rounds"}}, {every: {value: 1, units: "moons"}},
    {every: {value: 3, units: "seconds"}}, {every: {value: 0.5, units: "rounds"}}, {ends: 3}, []] ) {
    assert.deepEqual(reasons({clock}), ["area.persistence.clock"], JSON.stringify(clock));
  }
  for ( const ticks of [{from: -1}, {from: 1.5}, {from: 3, to: 2}, {after: 1}, 2] ) {
    assert.deepEqual(reasons({clock: {}, triggers: [trigger({ticks})]}), ["area.persistence.triggers.0.ticks"], JSON.stringify(ticks));
  }
  assert.deepEqual(reasons({triggers: [trigger({ticks: {from: 1}})]}), ["area.persistence.triggers.0.ticks"], "no clock to gate on");
  // Only the areas adapter writes area.ticks in: on the cast itself it would roll 1 die or fail.
  assert.deepEqual(reasons({}, {damage: [{id: "fire", expression: {type: "dice", number: TICKS, faces: 6}, damageType: "fire",
    provenance: "spell-base"}]}), ["damage.0.expression.number"]);
  assert.deepEqual(reasons({clock: {}, triggers: [trigger({}, TICKS)]}), [], "in a trigger, at any depth of its Action");
  assert.deepEqual(reasons({}, {summon: {choiceId: "x", area: {shape: "emanation", size: {value: 10, unit: "ft"},
    persistence: {triggers: [trigger({}, TICKS)]}}}}).filter(path => path.includes("expression")), [], "a summon's carried area's trigger");
});

test("a lasting area's Region keeps its clock and its triggers' ticks; its age is its seconds over its every", () => {
  const sourceToken = {id: "caster", actor: {uuid: "Actor.caster"}, parent: {grid: {size: 100, distance: 5}}};
  const region = persistence => persistentAreaRegionData({placement: {footprint: {topology: "square", fields: []},
    definition: definition(persistence)}, sourceToken, combat: null}).flags.wildpath.area;
  const clock = {at: "turn.ended", every: {value: 1, units: "minutes"}};
  const triggers = [{on: ["turn.ended"], turnOf: "source", ticks: {from: 1}, action: action("action:t", 1)}];
  const flag = region({clock, triggers});
  assert.deepEqual([flag.persistence.clock, flag.persistence.triggers[0].ticks], [clock, {from: 1}]);
  assert.notEqual(flag.persistence.clock, clock, "a copy, not the definition's own object");
  assert.equal("clock" in region({}).persistence, false, "an older or clock-free area has none");
  assert.deepEqual([0, 54, 60, 125].map(seconds => areaTicks({...flag, clock: {seconds, last: null}})), [0, 0, 1, 2], "a minute clock");
  assert.equal(areaTicks({...flag, persistence: {...flag.persistence, clock: {}}, clock: {seconds: 18, last: null}}), 3, "a round clock");
  assert.equal(areaTicks({...region({}), clock: {seconds: 18, last: null}}), 0, "no clock, no age");
});

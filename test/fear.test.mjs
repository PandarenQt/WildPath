import {test} from "node:test";
import assert from "node:assert/strict";
import {directedMovementPolicy, directedSources, fearContext} from "../module/adapters/foundry-v14-fear.mjs";

/** A 100-px, 5-ft square Scene with a Frightened creature at x 0 and the dragon that frightened it at x 1000. */
function world({statuses=["frightened"], sourceRef="Actor.dragon", extra=[]}={}) {
  const scene = {tokenVision: false, grid: {type: 1, size: 100, distance: 5}, dimensions: {size: 100, distance: 5}, tokens: []};
  const token = (id, x, effects=[]) => ({id, x, y: 0, width: 1, height: 1, elevation: 0, parent: scene,
    actor: {id: `actor-${id}`, uuid: `Actor.${id}`, effects, statuses: new Set()}});
  const fear = {id: "fear", statuses: new Set(statuses), flags: {wildpath: {conditionEffect: {sourceRef}}}};
  scene.tokens.push(token("hero", 0, [fear]), token("dragon", 1000), ...extra.map(([id, x]) => token(id, x)));
  return {scene, hero: scene.tokens[0], fear};
}

test("the source of a creature's fear is the Token its Frightened effect names, on its Scene", () => {
  const {hero} = world();
  const {sources, known} = directedSources(hero);
  assert.deepEqual([sources.map(source => [source.token.id, source.rule]), known], [[["dragon", "away"]], true]);
  assert.equal(directedSources(world({sourceRef: "Actor.elsewhere"}).hero).known, false, "a source not on the Scene");
  assert.deepEqual(directedSources(world({statuses: ["prone"]}).hero).sources, [], "nothing directs it");
  assert.deepEqual(fearContext(hero), {}, "without walls to test (no canvas), its fear stays on");
});

test("a Frightened creature can't willingly move closer to the source of its fear; a Command to approach the reverse", () => {
  const footprint = x => ({anchor: {x, y: 0}, fields: [{x, y: 0}], size: "medium", effectiveSize: "medium"});
  const step = (policy, from, to, movementKind="voluntary") => policy({fromFootprint: footprint(from), toFootprint: footprint(to), movementKind}).ok;
  const fleeing = directedMovementPolicy(world().hero);
  assert.deepEqual([step(fleeing, 2, 3), step(fleeing, 2, 1), step(fleeing, 2, 3, "forced")], [false, true, true],
    "toward the dragon (at field 10) is refused, away is fine, and being pushed is not willing");
  const approaching = directedMovementPolicy(world({statuses: ["commanded-approach"]}).hero);
  assert.deepEqual([step(approaching, 2, 3), step(approaching, 2, 1)], [true, false]);
  assert.equal(directedMovementPolicy(world({statuses: ["prone"]}).hero), null);
});

test("Frightened gives Disadvantage only while the source of its fear is within line of sight", async () => {
  const {rollModesFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const {WILDPATH} = await import("../module/config.mjs");
  const modes = context => rollModesFromRuleElements([{ruleElements: WILDPATH.CONDITIONS.frightened.ruleElements}],
    {domains: ["attack"], context}).length;
  assert.deepEqual([modes({}), modes({fearSourceOutOfSight: true})], [1, 0]);
});

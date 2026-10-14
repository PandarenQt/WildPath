import {test} from "node:test";
import assert from "node:assert/strict";
import {inSunlight, sunlightContext} from "../module/adapters/foundry-v14-sunlight.mjs";

/** A 100-px, 5-ft grid Scene with these lights and Tokens; the hero stands at 1000,1000 (center 1050,1050). */
function scene({flags={}, lights=[], tokens=[]}={}) {
  const world = {flags, grid: {size: 100, distance: 5}, lights, tokens: []};
  const hero = {id: "hero", x: 1000, y: 1000, width: 1, height: 1, elevation: 0, parent: world};
  world.tokens = [hero, ...tokens.map(token => ({...token, parent: world}))];
  return hero;
}
const sun = {flags: {wildpath: {sunlight: true}}};

test("sunlight: a sunlit Scene, or a light tagged as sunlight that reaches the creature", () => {
  assert.equal(inSunlight(scene()), false, "night, no lights");
  assert.equal(inSunlight(scene({flags: sun.flags})), true, "a Scene tagged as sunlit");
  const daylight = {...sun, x: 1250, y: 1050, config: {bright: 60, dim: 120}};
  assert.equal(inSunlight(scene({lights: [daylight]})), true, "a Daylight light 40 ft away, 60 ft bright");
  assert.equal(inSunlight(scene({lights: [{...daylight, x: 3500}]})), false, "out of its reach");
  assert.equal(inSunlight(scene({lights: [{...daylight, flags: {}}]})), false, "a torch is not sunlight");
  assert.equal(inSunlight(scene({lights: [{...daylight, hidden: true}]})), false, "a light switched off");
  const carrier = {...sun, id: "cleric", x: 1100, y: 1000, width: 1, height: 1, light: {bright: 10, dim: 0}};
  assert.equal(inSunlight(scene({tokens: [carrier]})), true, "a Token whose light is sunlight");
  assert.deepEqual(sunlightContext(scene({flags: sun.flags})), {inSunlight: true});
  assert.deepEqual(sunlightContext(null), {});
});

test("sunlight on the viewed Scene is Foundry's own light test, walls included", () => {
  const blocked = {...sun, x: 1250, y: 1050, config: {bright: 60}, object: {lightSource: {active: true, testPoint: () => false}}};
  const hero = scene({lights: [blocked]});
  assert.equal(inSunlight(hero, {canvas: {scene: hero.parent}}), false, "a wall blocks it");
  assert.equal(inSunlight(hero, {canvas: {scene: {}}}), true, "off the viewed Scene, its radius decides");
});

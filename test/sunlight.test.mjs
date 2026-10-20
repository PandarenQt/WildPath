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

test("the light a creature stands in: light, darkness or magical Darkness, on and off the viewed Scene", async () => {
  const {lightAt} = await import("../module/adapters/foundry-v14-sunlight.mjs");
  const lit = hero => Object.assign(hero.parent, {tokenVision: true}) && hero;
  const unseeing = scene();
  unseeing.parent.tokenVision = false;
  assert.equal(lightAt(unseeing), "light", "a Scene without Token vision is all light");
  assert.equal(lightAt(lit(scene())), "dark", "night, no lights");
  assert.equal(lightAt(lit(scene({lights: [{x: 1250, y: 1050, config: {bright: 20, dim: 40}}]}))), "light", "a torch's radius");
  const darkness = {x: 1050, y: 1050, config: {bright: 15, negative: true}};
  assert.equal(lightAt(lit(scene({lights: [darkness, {x: 1250, y: 1050, config: {bright: 60}}]}))), "magicalDarkness",
    "a Darkness spell (a negative light) beats a light");
  const day = lit(scene());
  day.parent.environment = {globalLight: {enabled: true}};
  assert.equal(lightAt(day), "light", "global illumination");
  const hero = lit(scene());
  const effects = (darkness, light) => ({scene: hero.parent, effects: {testInsideDarkness: () => darkness, testInsideLight: () => light}});
  assert.deepEqual([lightAt(hero, {canvas: effects(true, true)}), lightAt(hero, {canvas: effects(false, true)}),
    lightAt(hero, {canvas: effects(false, false)})], ["magicalDarkness", "light", "dark"], "the viewed Scene: Foundry's sources decide");
});

test("unseen in the dark: Darkvision sees darkness, Devil's Sight and Truesight magical Darkness, and Invisible stays one source", async () => {
  const {attackSight} = await import("../module/adapters/foundry-v14-senses.mjs");
  const {obscured} = await import("../module/helpers/senses.mjs");
  const creature = (senses={}, statuses=[]) => ({statuses: new Set(statuses), system: {senses}});
  assert.equal(obscured(creature(), {observedLight: "dark"}), true);
  assert.equal(obscured(creature({darkvision: 60}), {observedLight: "dark", distance: 30}), false);
  assert.equal(obscured(creature({darkvision: 60}), {observedLight: "magicalDarkness", distance: 30}), true, "Darkvision can't see magical Darkness");
  assert.equal(obscured(creature({devilsSight: 120}), {observedLight: "magicalDarkness", distance: 30}), false);
  assert.equal(obscured(creature({darkvision: 60}), {observerLight: "magicalDarkness", distance: 30}), true, "inside it, it sees nothing out");
  assert.equal(obscured(creature({blindsight: 10}), {observedLight: "magicalDarkness", distance: 10}), false, "Blindsight ignores light");
  // A target in a Darkness spell; the attacker in torchlight beside it.
  const at = (x, lights) => {
    const hero = scene({lights});
    Object.assign(hero.parent, {tokenVision: true});
    return Object.assign(hero, {x});
  };
  const darkness = {x: 1550, y: 1050, config: {bright: 15, negative: true}};
  const torch = {x: 1050, y: 1050, config: {bright: 20}};
  const attackerToken = at(1000, [darkness, torch]);
  const targetToken = {...attackerToken, id: "foe", x: 1500};
  const sight = (attacker, target) => attackSight({attacker, target, attackerToken, targetToken, distance: 25});
  assert.deepEqual(sight(creature({darkvision: 60}), creature()), {seesTarget: false, seenByTarget: false, targetHidden: true, attackerHidden: true},
    "neither sees the other: Disadvantage and Advantage, which cancel");
  assert.deepEqual(sight(creature({devilsSight: 120}), creature()), {seesTarget: true, seenByTarget: false, targetHidden: false, attackerHidden: true});
  assert.deepEqual(sight(creature({darkvision: 60}), creature({}, ["invisible"])).targetHidden, false,
    "an Invisible target is unseen by Invisible's own rule, not again by the dark");
});

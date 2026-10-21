import {test} from "node:test";
import assert from "node:assert/strict";
import {bestSenses, onGround, perceives} from "../module/helpers/senses.mjs";
import {applySensesToToken, registerDarknessSight} from "../module/adapters/foundry-v14-senses.mjs";
import {rollModesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {combineRollModes} from "../module/helpers/rolls.mjs";
import {WILDPATH} from "../module/config.mjs";

test("a creature's senses are the best range each grant gives", () => {
  assert.deepEqual(bestSenses([{sense: "darkvision", range: 60}, {sense: "darkvision", range: 120}, {sense: "truesight", range: 30},
    {sense: "smell", range: 10}]), {darkvision: 120, blindsight: 0, tremorsense: 0, truesight: 30, devilsSight: 0, seeInvisibility: 0});
});

test("Devil's Sight and Truesight see in the dark and through magical Darkness: sight range, and the highest priority", () => {
  const token = senses => ({sight: {}, detectionModes: {}, actor: {system: {senses}}});
  const sees = token({darkvision: 60, devilsSight: 120});
  applySensesToToken(sees);
  assert.deepEqual(sees.sight, {range: 120, visionMode: "darkvision"});
  const config = {Token: {objectClass: class { _getVisionSourceData() { return {radius: 1}; } }}};
  registerDarknessSight(config);
  const source = senses => Object.assign(new config.Token.objectClass(), {document: {actor: {system: {senses}}}})._getVisionSourceData();
  assert.deepEqual([source({devilsSight: 120}).priority, source({truesight: 30}).priority, source({darkvision: 60}).priority],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, undefined], "Darkvision alone is blinded by magical Darkness");
});

test("perceiving despite Blinded and Invisible: Blindsight, Truesight and Tremorsense within range", () => {
  const creature = (statuses=[], senses={}) => ({statuses: new Set(statuses), system: {senses}});
  assert.equal(perceives(creature(), creature()), true);
  assert.equal(perceives(creature(), creature(["invisible"])), false);
  assert.equal(perceives(creature([], {truesight: 30}), creature(["invisible"]), {distance: 30}), true);
  assert.equal(perceives(creature([], {truesight: 30}), creature(["invisible"]), {distance: 35}), false, "out of range");
  assert.equal(perceives(creature(["blinded"], {truesight: 120}), creature()), false, "Truesight is sight");
  assert.equal(perceives(creature(["blinded"], {blindsight: 10}), creature(["invisible"]), {distance: 10}), true);
  assert.equal(perceives(creature(["blinded"], {tremorsense: 60}), creature(), {distance: 20, grounded: false}), false, "a flier");
  assert.equal(perceives(creature([], {seeInvisibility: 5280}), creature(["invisible"]), {distance: 60}), true, "See Invisibility");
  assert.equal(perceives(creature(["blinded"], {seeInvisibility: 5280}), creature(["invisible"]), {distance: 60}), false, "and it is sight");
  const token = {sight: {}, detectionModes: {}, actor: {system: {senses: {seeInvisibility: 5280}}}};
  applySensesToToken(token);
  assert.deepEqual([token.sight.visionMode, token.detectionModes.seeInvisibility], ["basic", {enabled: true, range: 5280}]);
  assert.equal(onGround({elevation: 20, level: "l", parent: {levels: {get: () => ({elevation: {bottom: 0}})}}}), false);
});

test("Invisible and Blinded give their roll modes only while the other creature can't perceive them", () => {
  const modes = (condition, domains, attack) => combineRollModes(rollModesFromRuleElements([{ruleElements: WILDPATH.CONDITIONS[condition].ruleElements}],
    {domains, context: {attack}}));
  assert.equal(modes("invisible", ["attacked"], {}), "disadvantage", "attacking an Invisible creature");
  assert.equal(modes("invisible", ["attacked"], {seesTarget: true}), "normal", "with Truesight in range");
  assert.equal(modes("invisible", ["attack"], {seenByTarget: true}), "normal", "its target sees it");
  assert.equal(modes("blinded", ["attack"], {seesTarget: true}), "normal", "Blindsight");
  assert.equal(modes("blinded", ["attacked"], {}), "advantage");
});

test("light its creature's grants shed: the brightest, on its Token unless the Token's own is brighter", async () => {
  const {brightestLight} = await import("../module/helpers/senses.mjs");
  const {applyLightToToken} = await import("../module/adapters/foundry-v14-senses.mjs");
  const {grantedLightsFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const torch = {schemaVersion: 1, id: "light", type: "GrantLight", data: {bright: 20, dim: 40}};
  const bullseye = {schemaVersion: 1, id: "cone", type: "GrantLight", data: {bright: 60, dim: 120, angle: 60}};
  const lights = grantedLightsFromRuleElements([{ruleElements: [torch]}, {ruleElements: [bullseye]}]);
  assert.deepEqual(lights.map(({source: _source, ...light}) => light), [{bright: 20, dim: 40}, {bright: 60, dim: 120, angle: 60}]);
  assert.deepEqual(brightestLight(lights), {bright: 60, dim: 120, angle: 60});
  assert.equal(brightestLight([]), null);
  const token = light => ({light: {bright: 0, dim: 0, angle: 360}, actor: {system: {light}}});
  const lit = token({bright: 20, dim: 40});
  applyLightToToken(lit);
  assert.deepEqual(lit.light, {bright: 20, dim: 40, angle: 360});
  const lantern = {light: {bright: 30, dim: 60}, actor: {system: {light: {bright: 20, dim: 40}}}};
  applyLightToToken(lantern);
  assert.deepEqual(lantern.light, {bright: 30, dim: 60}, "its own is brighter");
});

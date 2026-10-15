import {test} from "node:test";
import assert from "node:assert/strict";
import {weaponMasteryOf, withWeaponMastery} from "../module/helpers/weapon-mastery.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const longsword = (mastery, extra={}) => ({schemaVersion: 1, id: "action:longsword", label: "Longsword", costs: {allOf: [{capability: "action", amount: 1}]},
  attack: {type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true, weapon: {category: "martial", base: "longsword", mastery}},
  range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
  damage: [{id: "base", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}], ...extra});
const fighter = masteries => ({id: "hero", system: {training: {masteries}}});

test("a weapon's mastery is used only by a creature whose training lists that weapon", () => {
  assert.equal(weaponMasteryOf(longsword("sap").attack, fighter(["longsword"])), "sap");
  assert.equal(weaponMasteryOf(longsword("sap").attack, fighter(["greatsword"])), null);
  assert.equal(weaponMasteryOf(longsword("sap").attack, {system: {}}), null, "a stat block");
  const raw = longsword("sap");
  assert.equal(withWeaponMastery(raw, fighter([])), raw, "untouched without the mastery");
});

test("Push, Slow, Sap and Vex join the attack; Topple and Graze only name it; each stays a valid Action", () => {
  const used = mastery => withWeaponMastery(longsword(mastery), fighter(["longsword"]));
  assert.deepEqual(used("push").push, {distance: 10, maxSize: "large"});
  assert.deepEqual(used("slow").effects[0].ruleElements[0].data.domains, ["resources.movement.max", "speed"]);
  assert.equal(used("sap").effects[0].endsWhen, "attacks");
  const vex = used("vex").effects[0];
  assert.deepEqual([vex.slug, vex.endsWhen, vex.ruleElements[0].predicate],
    ["mastery-vexed-hero", "attackedBySource", {equals: {path: "attack.fromAttacker.mastery-vexed-hero", value: true}}]);
  for ( const mastery of ["topple", "graze", "cleave", "nick"] ) {
    assert.deepEqual([used(mastery).attack.mastery, used(mastery).effects, used(mastery).push], [mastery, undefined, undefined]);
  }
  for ( const mastery of ["push", "slow", "sap", "vex", "topple"] ) assert.equal(validateActionDefinition(used(mastery)).ok, true, mastery);
  const own = withWeaponMastery(longsword("push", {push: {distance: 5}}), fighter(["longsword"]));
  assert.deepEqual(own.push, {distance: 5}, "an Action's own push is kept");
});

test("after an attack: Vex ends when its source attacks again, Sap when its creature attacks, not by the hit that applied them", async () => {
  const {endEffectsWhenAttacked} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const deleted = [];
  const effect = (id, endsWhen, statuses=[], sourceRef=null) => ({id, statuses: new Set(statuses),
    flags: {wildpath: {conditionEffect: {sourceRef, definition: {endsWhen}}}}});
  const holder = effects => ({uuid: `Actor.${effects[0]?.id}`, effects, deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids)});
  const hero = holder([effect("sapped", "attacks", ["mastery-sapped"])]);
  hero.uuid = "Actor.hero";
  hero.id = "hero";
  const enemy = holder([effect("vex-hero", "attackedBySource", ["mastery-vexed-hero"], "Actor.hero"),
    effect("vex-other", "attackedBySource", ["mastery-vexed-other"], "Actor.other")]);
  const scene = {tokens: {get: id => (id === "enemy" ? {actor: enemy} : null)}};
  const fromUuid = async () => ({parent: scene, actor: hero});
  const vexing = withWeaponMastery(longsword("vex"), fighter(["longsword"]));
  const state = hit => ({source: {tokenRef: "Scene.s.Token.hero"}, actionDefinition: vexing,
    results: {attackResolution: {results: [{ok: true, hit, target: {tokenId: "enemy"}}]}}});
  await endEffectsWhenAttacked({state: state(true)}, {fromUuid});
  assert.deepEqual(deleted, ["sapped"], "a hit that (re)applies Vex keeps it; the attacker's Sap is spent");
  deleted.length = 0;
  await endEffectsWhenAttacked({state: state(false)}, {fromUuid});
  assert.deepEqual(deleted, ["vex-hero", "sapped"], "a miss spends the hero's Vex, not another creature's");
});

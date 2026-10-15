import {test} from "node:test";
import assert from "node:assert/strict";
import {actorAbilityModifier, resolveActorCheckStatistic, resolveActorSaveStatistic} from "../module/helpers/combat-statistics.mjs";

const creature = (abilities, modifierTotal=null) => ({system: {abilities},
  ...(modifierTotal == null ? {} : {getStatistic: () => ({totalModifier: modifierTotal})})});

test("saves and checks add the ability modifier to their Modifiers; a save with no such ability adds nothing", () => {
  assert.equal(actorAbilityModifier(creature({fortitude: {value: 15}}), "fortitude"), 2);
  assert.equal(actorAbilityModifier(creature({fortitude: {value: 7}}), "fortitude"), -2);
  assert.equal(actorAbilityModifier(creature({}), "death"), null);
  assert.equal(resolveActorSaveStatistic(creature({fortitude: {value: 14}}, 1), "fortitude").totalModifier, 3);
  assert.equal(resolveActorSaveStatistic(creature({fortitude: {value: 14}}, -2), "death").totalModifier, -2, "a death save: Exhaustion only");
  assert.equal(resolveActorCheckStatistic(creature({wits: {value: 16}}, 2), {ability: "wits", skill: "medicine"}).totalModifier, 5);
  assert.equal(resolveActorCheckStatistic(creature({wits: {value: 16}}), {ability: "wits"}).totalModifier, 3, "no Modifiers to read");
  assert.equal(resolveActorCheckStatistic(creature({}), {skill: "medicine"}), null, "a skill alone names no ability");
});

test("an attack adds Might in melee, Agility at range, the better of the two with finesse, or the spellcasting ability", async () => {
  const {attackAbility, resolveActorAttackStatistic} = await import("../module/helpers/combat-statistics.mjs");
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const rogue = {system: {abilities: {might: {value: 12}, agility: {value: 18}, wits: {value: 14}}, spellcasting: {ability: "wits"}},
    getStatistic: () => ({totalModifier: 2})};
  assert.equal(attackAbility(rogue, {type: "melee", statistic: "weapon"}), "might");
  assert.equal(attackAbility(rogue, {type: "ranged", statistic: "weapon"}), "agility");
  assert.equal(attackAbility(rogue, {type: "melee", statistic: "weapon", properties: ["finesse"]}), "agility");
  assert.equal(attackAbility({system: {abilities: {might: {value: 16}, agility: {value: 12}}}},
    {type: "melee", properties: ["finesse"]}), "might", "finesse takes the better one");
  assert.equal(attackAbility(rogue, {type: "ranged", statistic: "spell"}), "wits");
  assert.equal(attackAbility(rogue, {type: "melee", statistic: "weapon"}, {tags: ["spell"]}), "wits");
  assert.equal(attackAbility(rogue, {type: "ranged", ability: "might"}), "might", "a thrown weapon can name Might");
  const dagger = resolveActorAttackStatistic(rogue, {type: "melee", statistic: "weapon", properties: ["finesse"]});
  assert.deepEqual([dagger.totalModifier, dagger.abilityModifier, dagger.spell], [6, 4, false], "proficiency 2 + Agility 4");

  const definition = attack => ({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []}, attack});
  assert.equal(validateActionDefinition(definition({type: "melee", statistic: "weapon", properties: ["finesse"]})).ok, true);
  assert.equal(validateActionDefinition(definition({type: "melee", statistic: "weapon", properties: "finesse"})).ok, false);
});

test("weapon proficiency follows weapon training (G8); without training, the attack's own flag", async () => {
  const {attackProficient} = await import("../module/helpers/combat-statistics.mjs");
  const longsword = {proficient: true, weapon: {category: "martial", base: "longsword", mastery: "sap"}};
  const trained = weapons => ({system: {training: {weapons}}});
  assert.equal(attackProficient(trained(["simple", "martial"]), longsword), true);
  assert.equal(attackProficient(trained(["simple", "longsword"]), longsword), true, "the weapon itself");
  assert.equal(attackProficient(trained(["simple"]), longsword), false, "a Wizard with a longsword");
  assert.equal(attackProficient(trained([]), longsword), true, "a stat block keeps what the attack says");
  assert.equal(attackProficient(trained(["martial"]), {...longsword, proficient: false}), false, "unticked stays unticked");
  assert.equal(attackProficient(trained(["simple"]), {proficient: true}), true, "not a weapon: a spell attack");
});

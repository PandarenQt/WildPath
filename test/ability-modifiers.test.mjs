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

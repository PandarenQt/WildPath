import {test} from "node:test";
import assert from "node:assert/strict";
import {
  resolveActorAttackStatistic,
  resolveActorDefense
} from "../module/helpers/combat-statistics.mjs";

function statistic(domain, totalModifier) {
  return {
    totalModifier,
    trace: {
      domain,
      total: totalModifier,
      applied: [{id: `${domain}:bonus`, value: totalModifier}]
    }
  };
}

test("resolveActorDefense combines persisted defense base with WildPathStatistic modifiers", () => {
  const actor = {
    id: "actor-defender",
    uuid: "Actor.actor-defender",
    system: {defenses: {ac: {value: 14}}},
    getStatistic(domains) {
      return [domains].flat().includes("defense.ac") ? statistic("defense.ac", 2) : null;
    }
  };

  const defense = resolveActorDefense(actor, "ac");

  assert.equal(defense.value, 16);
  assert.equal(defense.slug, "ac");
  assert.equal(defense.source.base, 14);
  assert.equal(defense.source.modifier, 2);
  assert.equal(defense.source.statistic.domain, "defense.ac");
  assert.deepEqual(JSON.parse(JSON.stringify(defense)), defense);
});

test("resolveActorAttackStatistic snapshots source attack modifiers into plain roll data", () => {
  const actor = {
    id: "actor-attacker",
    uuid: "Actor.actor-attacker",
    getStatistic(domains) {
      return [domains].flat().includes("attack.weapon") ? statistic("attack.weapon", 4) : null;
    }
  };

  const attack = resolveActorAttackStatistic(actor, {type: "melee", statistic: "weapon"});

  assert.equal(attack.key, "weapon");
  assert.equal(attack.domain, "attack.weapon");
  assert.equal(attack.totalModifier, 4);
  assert.equal(attack.source.statistic.domain, "attack.weapon");
  assert.deepEqual(JSON.parse(JSON.stringify(attack)), attack);
});

test("proficiency joins only an attack or save the creature is proficient in, by level or threat, and Modifiers change it", async () => {
  const {actorProficiencyBonus, proficiencyForLevel, resolveActorSaveStatistic} = await import("../module/helpers/combat-statistics.mjs");
  assert.deepEqual([0, 1, 4, 5, 9, 13, 17, 20].map(proficiencyForLevel), [2, 2, 2, 3, 4, 5, 6, 6]);
  const creature = (details, proficiencyModifier=0) => ({id: "c", system: {details, abilities: {might: {value: 16},
    agility: {value: 12, saveProficient: true}}}, getStatistic(domains) {
    return [domains].flat().includes("proficiency") ? statistic("proficiency", proficiencyModifier) : statistic("none", 0);
  }});
  const fighter = creature({level: 5});
  assert.equal(resolveActorAttackStatistic(fighter, {type: "melee", statistic: "weapon"}).totalModifier, 3, "not proficient: Might only");
  assert.equal(resolveActorAttackStatistic(fighter, {type: "melee", statistic: "weapon", proficient: true}).totalModifier, 6, "Might 3 + proficiency 3");
  assert.equal(actorProficiencyBonus(creature({threat: 10})), 4, "a creature's Challenge Rating sets it");
  assert.equal(actorProficiencyBonus(creature({level: 5}, -1)), 2, "a Modifier on proficiency changes it");
  assert.equal(resolveActorSaveStatistic(fighter, "agility").totalModifier, 4, "a proficient save adds it: Agility 1 + 3");
  assert.equal(resolveActorSaveStatistic(fighter, "might").totalModifier, 3, "a save it is not proficient in does not");
});

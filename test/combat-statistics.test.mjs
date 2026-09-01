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
    getStatistic(domain) {
      return domain === "defense.ac" ? statistic(domain, 2) : null;
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
    getStatistic(domain) {
      return domain === "attack.weapon" ? statistic(domain, 4) : null;
    }
  };

  const attack = resolveActorAttackStatistic(actor, {type: "melee", statistic: "weapon"});

  assert.equal(attack.key, "weapon");
  assert.equal(attack.domain, "attack.weapon");
  assert.equal(attack.totalModifier, 4);
  assert.equal(attack.source.statistic.domain, "attack.weapon");
  assert.deepEqual(JSON.parse(JSON.stringify(attack)), attack);
});

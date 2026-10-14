import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryDying, deathSaveResult, dyingAfterChange} from "../module/adapters/foundry-v14-dying.mjs";

const damage = (from, amount, max=20) => ({type: "damage", from, to: Math.max(from - amount, 0), max, amount,
  overflow: Math.max(amount - from, 0)});

test("2024 dropping to 0: a character falls Unconscious, an NPC dies, massive damage kills either", () => {
  assert.deepEqual(dyingAfterChange({change: damage(5, 8)}), {unconscious: true, deathSaves: {successes: 0, failures: 0}});
  assert.deepEqual(dyingAfterChange({change: damage(5, 8), character: false}), {die: true});
  assert.deepEqual(dyingAfterChange({change: damage(5, 25)}), {die: true}, "20 left over after reaching 0 is the maximum");
  assert.equal(dyingAfterChange({change: damage(15, 8)}), null, "still standing");
});

test("2024 hurt at 0: a failed death save, two on a critical hit, death on the third or on massive damage", () => {
  const saves = {successes: 1, failures: 0};
  assert.deepEqual(dyingAfterChange({change: damage(0, 3), deathSaves: saves}), {deathSaves: {successes: 1, failures: 1}});
  assert.deepEqual(dyingAfterChange({change: damage(0, 3), critical: true, deathSaves: saves}), {deathSaves: {successes: 1, failures: 2}});
  assert.deepEqual(dyingAfterChange({change: damage(0, 3), deathSaves: {successes: 0, failures: 2}}), {die: true});
  assert.deepEqual(dyingAfterChange({change: damage(0, 20)}), {die: true});
});

test("2024 healing at 0 wakes the creature and clears its death saves", () => {
  assert.deepEqual(dyingAfterChange({change: {type: "healing", from: 0, to: 4, max: 20, amount: 4}}),
    {wake: true, deathSaves: {successes: 0, failures: 0}});
  assert.equal(dyingAfterChange({change: {type: "healing", from: 3, to: 7, max: 20, amount: 4}}), null);
});

test("2024 death saves: 10 or higher succeeds, a natural 1 is two failures, a natural 20 is back with 1", () => {
  const saves = {successes: 2, failures: 1};
  assert.deepEqual(deathSaveResult({natural: 10, total: 10, deathSaves: saves}), {deathSaves: {successes: 3, failures: 1}}, "stable");
  assert.deepEqual(deathSaveResult({natural: 9, total: 9, deathSaves: saves}), {deathSaves: {successes: 2, failures: 2}});
  assert.deepEqual(deathSaveResult({natural: 12, total: 8, deathSaves: saves}), {deathSaves: {successes: 2, failures: 2}},
    "Exhaustion's penalty can turn a 12 into a failure");
  assert.deepEqual(deathSaveResult({natural: 1, total: 1, deathSaves: saves}), {die: true});
  assert.deepEqual(deathSaveResult({natural: 20, total: 20, deathSaves: saves}), {heal: 1, wake: true, deathSaves: {successes: 0, failures: 0}});
});

/** A fake creature that records what the dying rules do to it. */
function creature({type="character", health=0, saves={successes: 0, failures: 0}, conditions=[]}={}) {
  const actor = {uuid: "Actor.hero", id: "hero", type, effects: conditions.map(id => ({system: {type: id}})), calls: [],
    system: {resources: {health: {value: health}}, deathSaves: {...saves}},
    async update(data) {
      this.calls.push(["update", data]);
      for ( const [path, value] of Object.entries(data) ) {
        if ( path === "system.deathSaves" ) this.system.deathSaves = {...value};
        if ( path === "system.resources.health.value" ) this.system.resources.health.value = value;
      }
    },
    async toggleCondition(id, {levels=1}={}) {
      this.calls.push(["condition", id, levels]);
      if ( levels > 0 ) this.effects.push({system: {type: id}});
      else this.effects = this.effects.filter(effect => effect.system.type !== id);
    },
    async toggleStatusEffect(id, options) { this.calls.push(["status", id, options]); this.effects.push({system: {type: id}}); }};
  return actor;
}

test("the active GM applies the dying rules to the creatures an Action changed: Unconscious, then dead on a critical", async () => {
  const hero = creature({health: 5, saves: {successes: 0, failures: 1}});
  const combatant = {actor: hero, defeated: false, async update(data) { Object.assign(this, data); }};
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: [{combatants: [combatant]}]},
    coordinator: {}, resolveAction: async () => ({ok: false})});
  const target = {actorRef: "Actor.hero", tokenId: "hero-token"};
  const event = (plan, outcome="hit") => ({options: {targetActors: {"token:hero-token": hero}}, state: {mutationPlans: [{type: "durabilityDamage",
    target, plan}], results: {attackResolution: {hits: [{outcome, target}]}}}});
  await dying.afterResolution(event(damage(5, 8)));
  assert.deepEqual(hero.effects.map(effect => effect.system.type), ["unconscious"]);
  assert.deepEqual(hero.system.deathSaves, {successes: 0, failures: 0}, "falling resets the death saves");
  await dying.afterResolution(event(damage(0, 2), "criticalHit"));
  assert.deepEqual(hero.system.deathSaves, {successes: 0, failures: 2});
  await dying.afterResolution(event(damage(0, 2)));
  assert.deepEqual(hero.system.deathSaves, {successes: 0, failures: 3}, "the third failure is death");
  assert.ok(hero.effects.some(effect => effect.system.type === "dead"), "Defeated");
  assert.equal(combatant.defeated, true);
  const calls = hero.calls.length;
  await dying.afterResolution(event(damage(0, 2)));
  assert.equal(hero.calls.length, calls, "the dead are past the dying rules");
});

test("Exhaustion's sixth level is death; a lower level is not", async () => {
  const hero = creature({health: 12});
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: []},
    coordinator: {}, resolveAction: async () => ({ok: false})});
  await dying.onEffectChanged({system: {type: "exhaustion", level: 5}, parent: hero});
  assert.equal(hero.system.resources.health.value, 12);
  await dying.onEffectChanged({system: {type: "exhaustion", level: 6}, parent: hero});
  assert.deepEqual([hero.system.resources.health.value, hero.system.deathSaves.failures], [0, 3]);
});

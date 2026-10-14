import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryDying, deathSaveResult, dyingAfterChange, makesDeathSaves, stableRecovered} from "../module/adapters/foundry-v14-dying.mjs";

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
  assert.deepEqual(deathSaveResult({natural: 10, total: 10, deathSaves: saves}), {deathSaves: {successes: 3, failures: 0}},
    "stable, and the failures reset (2024)");
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
    async toggleStatusEffect(id, options) { this.calls.push(["status", id, options]); this.effects.push({system: {type: id}}); },
    flags: {},
    async setFlag(scope, key, value) { this.flags[scope] = {...(this.flags[scope] ?? {}), [key]: value}; },
    async unsetFlag(scope, key) { delete this.flags[scope]?.[key]; }};
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

test("who makes death saves: characters, and companions or sidekicks a Player controls, unless the creature says otherwise", () => {
  const companion = {controllers: ["Actor.ranger"]};
  assert.equal(makesDeathSaves({type: "character"}), true);
  assert.equal(makesDeathSaves({type: "npc"}), false);
  assert.equal(makesDeathSaves({type: "npc", companion, playerControlled: true}), true, "follows its character");
  assert.equal(makesDeathSaves({type: "npc", companion, playerControlled: false}), false, "a GM's companion dies");
  assert.equal(makesDeathSaves({type: "npc", dyingMode: "deathSaves"}), true, "an important NPC");
  assert.equal(makesDeathSaves({type: "character", dyingMode: "dies"}), false);
});

test("a Player's companion dropped to 0 falls Unconscious instead of dying", async () => {
  const wolf = creature({type: "npc", health: 5});
  Object.assign(wolf, {hasPlayerOwner: true});
  wolf.system.companion = {kind: "companion", controllers: ["Actor.ranger"]};
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: []},
    coordinator: {}, resolveAction: async () => ({ok: false})});
  await dying.afterPlans(wolf, [damage(5, 8)]);
  assert.deepEqual(wolf.effects.map(effect => effect.system.type), ["unconscious"]);
});

test("Regeneration: a Troll at 0 lies Unconscious until its turn, Fire stops it, and it dies only if it does not regenerate", async () => {
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: []},
    coordinator: {}, resolveAction: async () => ({ok: false})});
  const troll = creature({type: "npc", health: 6});
  troll.items = [{system: {active: true, ruleElements: [{type: "Trigger", data: {event: "turn.started", stoppedBy: ["acid", "fire"],
    deferDeath: true}}]}}];
  troll.update = async function (data) {
    this.calls.push(["update", data]);
    for ( const [path, value] of Object.entries(data) ) {
      if ( path.startsWith("flags.wildpath.damageTaken.") ) this.flags.wildpath = {...this.flags.wildpath,
        damageTaken: {...this.flags.wildpath?.damageTaken, [path.split(".").pop()]: value}};
      if ( path === "system.resources.health.value" ) this.system.resources.health.value = value;
    }
  };
  const burn = (from, amount, byDamageType) => ({type: "durabilityDamage", plan: {...damage(from, amount, 84),
    metadata: {damageResult: {byDamageType}}}});
  await dying.afterPlans(troll, [burn(6, 8, {fire: 5, slashing: 3})]);
  assert.deepEqual(troll.effects.map(effect => effect.system.type), ["unconscious"], "not dead at 0");
  assert.deepEqual(troll.flags.wildpath.damageTaken, {fire: true}, "the Fire is recorded; the Slashing stops nothing");
  troll.system.resources.health.value = 0;
  await dying.onTurnStart({combatant: {actor: troll}});
  assert.ok(troll.effects.some(effect => effect.system.type === "dead"), "it started its turn at 0 without regenerating");
  assert.equal(troll.flags.wildpath.damageTaken, undefined, "the record ends with the turn");

  const healed = creature({type: "npc", health: 10});
  healed.items = troll.items;
  await dying.onTurnStart({combatant: {actor: healed}});
  assert.equal(healed.effects.length, 0, "it regenerated");
});

test("2024 stability: the third success resets the failures, and damage while stable starts the death saves over", () => {
  assert.deepEqual(deathSaveResult({natural: 12, total: 12, deathSaves: {successes: 2, failures: 2}}),
    {deathSaves: {successes: 3, failures: 0}});
  assert.deepEqual(dyingAfterChange({change: damage(0, 2), deathSaves: {successes: 3, failures: 0}}),
    {deathSaves: {successes: 0, failures: 1}});
  assert.deepEqual(dyingAfterChange({change: damage(0, 2), critical: true, deathSaves: {successes: 3, failures: 0}}),
    {deathSaves: {successes: 0, failures: 2}});
});

test("a stabilize Action makes a dying target stable, unless its check failed; the living and the dead are left alone", async () => {
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: []},
    coordinator: {}, resolveAction: async () => ({ok: false})});
  const hero = creature({health: 0, saves: {successes: 1, failures: 2}});
  const standing = creature({health: 6});
  const target = token => ({actorRef: `Actor.${token}`, tokenId: token});
  const event = (checkResolution, tokens=["hero"]) => ({options: {targetActors: {"token:hero": hero, "token:standing": standing}},
    state: {actionDefinition: {stabilize: true}, mutationPlans: [], results: {...(checkResolution ? {checkResolution} : {}),
      actionResult: {context: {targets: tokens.map(target)}}}}});
  await dying.afterResolution(event({success: false}));
  assert.deepEqual(hero.system.deathSaves, {successes: 1, failures: 2}, "a failed check stabilizes no one");
  await dying.afterResolution(event({success: true}, ["hero", "standing"]));
  assert.deepEqual(hero.system.deathSaves, {successes: 3, failures: 0});
  assert.equal(standing.calls.length, 0, "a creature above 0 health is not touched");
});

test("2024: a stable creature regains 1 health after 1d4 hours; world time and rests both count", async () => {
  assert.equal(stableRecovered({worldTime: 100, hours: 2}, 100 + 7199), false);
  assert.equal(stableRecovered({worldTime: 100, hours: 2}, 100 + 7200), true);
  assert.equal(stableRecovered({worldTime: 100, hours: 2, restHours: 1}, 100 + 3600), true, "a short rest's hour counts");
  assert.equal(stableRecovered(null, 1e9), false);

  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: [], time: {worldTime: 1000}, actors: [], scenes: []};
  const dying = createFoundryDying({game, coordinator: {}, resolveAction: async () => ({ok: false}), rollHours: async () => 2});
  const hero = creature({health: 0, saves: {successes: 1, failures: 1}, conditions: ["unconscious"]});
  game.actors.push(hero);
  const stabilize = {options: {targetActors: {"token:hero": hero}}, state: {actionDefinition: {stabilize: true}, mutationPlans: [],
    results: {actionResult: {context: {targets: [{actorRef: "Actor.hero", tokenId: "hero"}]}}}}};
  await dying.afterResolution(stabilize);
  assert.deepEqual(hero.flags.wildpath.stableSince, {worldTime: 1000, hours: 2}, "becoming stable starts the 1d4-hour wait");

  await dying.onWorldTime(1000 + 3600);
  assert.equal(hero.system.resources.health.value, 0, "one hour is not enough");
  await dying.onWorldTime(1000 + 7200);
  assert.equal(hero.system.resources.health.value, 1, "after the rolled hours it regains 1 health");
  assert.deepEqual(hero.effects.map(effect => effect.system.type), [], "and wakes");
  assert.deepEqual(hero.system.deathSaves, {successes: 0, failures: 0});
  assert.equal(hero.flags.wildpath.stableSince, undefined, "and stops waiting");

  // A table that does not advance world time: a long rest's 8 hours count.
  const resting = creature({health: 0, saves: {successes: 3, failures: 0}, conditions: ["unconscious"]});
  resting.flags.wildpath = {stableSince: {worldTime: 1000, hours: 4}};
  assert.equal(await dying.restHours(resting, 1), false);
  assert.equal(await dying.restHours(resting, 8), true);
  assert.equal(resting.system.resources.health.value, 1);

  // Damage while stable starts the death saves over, and the wait with them.
  const hurt = creature({health: 0, saves: {successes: 3, failures: 0}});
  hurt.flags.wildpath = {stableSince: {worldTime: 1000, hours: 1}};
  const target = {actorRef: "Actor.hero", tokenId: "hero-token"};
  await dying.afterResolution({options: {targetActors: {"token:hero-token": hurt}}, state: {mutationPlans: [{type: "durabilityDamage",
    target, plan: damage(0, 2)}], results: {}}});
  assert.deepEqual(hurt.system.deathSaves, {successes: 0, failures: 1});
  assert.equal(hurt.flags.wildpath.stableSince, undefined);
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_MUTATION_COMMIT_CODES,
  commitTargetMutationPlans,
  prepareTargetMutationCommitOperations
} from "../module/resolvers/target-mutation-commit-resolver.mjs";
import {executeResolutionTransaction} from "../module/resolvers/resolution-transaction-resolver.mjs";
import {createActorDamageMutationPlan, createActorHealingMutationPlan} from "../module/resolvers/durability-resolver.mjs";

function mutationPlan() {
  return {
    type: "durabilityDamage",
    targetRef: "actor:actor-orc",
    target: {id: "orc", actorId: "actor-orc"},
    plan: {
      ok: true,
      updates: {"system.resources.health.value": 4}
    }
  };
}

test("target mutation commit adapter commits with explicit active GM authority", async () => {
  const calls = [];
  const targetActor = {
    id: "actor-orc",
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: {"actor:actor-orc": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, TARGET_MUTATION_COMMIT_CODES.OK);
  assert.deepEqual(calls, [{"system.resources.health.value": 4}]);
  assert.equal(result.committed[0].targetRef, "actor:actor-orc");
});

test("target mutation commit adapter rejects missing authority and missing actors", async () => {
  const unauthorized = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: {"actor:actor-orc": {id: "actor-orc", async update() {}}},
    authority: {isGM: false, userId: "player-a"}
  });
  const missingActor = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: {},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, TARGET_MUTATION_COMMIT_CODES.COMMIT_NOT_AUTHORIZED);
  assert.equal(missingActor.ok, false);
  assert.equal(missingActor.code, TARGET_MUTATION_COMMIT_CODES.TARGET_ACTOR_NOT_FOUND);
});

test("target mutation commit adapter supports authority functions", async () => {
  const calls = [];
  const result = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: [{id: "actor-orc", async update(updates) { calls.push(updates); }}],
    authority: ({target}) => target.actorId === "actor-orc"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{"system.resources.health.value": 4}]);
});

/* -------------------------------------------- */
/*  Durability commits rebased on the live creature, one at a time  */
/* -------------------------------------------- */

/** An orc at `value` whose writes land a tick after they are sent, as Foundry's round trip does. */
function racingOrc(value=14) {
  const orc = {uuid: "Actor.orc", id: "actor-orc", system: {resources: {health: {value, max: 20}}, pools: []}, writes: []};
  const persistencePort = {async updateActor({actor, updates}) {
    await new Promise(resolve => setImmediate(resolve));
    actor.writes.push(updates);
    for ( const [path, next] of Object.entries(updates) ) {
      const keys = path.replace(/^system\./, "").split(".");
      keys.slice(0, -1).reduce((node, key) => node[key], actor.system)[keys.at(-1)] = next;
    }
    return {ok: true};
  }};
  return {orc, persistencePort};
}

/** The orc's damage, planned now from what it has now. */
function orcDamage(orc, amount) {
  return {type: "durabilityDamage", targetRef: "actor:actor-orc", target: {id: "orc", actorId: "actor-orc"},
    plan: createActorDamageMutationPlan(structuredClone(orc.system), {amount})};
}

function damageTransaction(orc, persistencePort, plans, {snapshotActor, extra=[]}={}) {
  const prepared = prepareTargetMutationCommitOperations({mutationPlans: plans, targetActors: {"actor:actor-orc": orc}, authority: true,
    persistencePort, snapshotActor});
  assert.equal(prepared.ok, true);
  return executeResolutionTransaction({operations: [...prepared.operations, ...extra], persistencePort});
}

const snapshotActor = actor => structuredClone(actor.system);

test("two Actions' damage planned from one snapshot both land, each on what the other left", async () => {
  const {orc, persistencePort} = racingOrc(14);
  const first = orcDamage(orc, 6);
  const second = orcDamage(orc, 6);
  const [one, two] = await Promise.all([damageTransaction(orc, persistencePort, [first], {snapshotActor}),
    damageTransaction(orc, persistencePort, [second], {snapshotActor})]);
  assert.equal(one.ok && two.ok, true);
  assert.equal(orc.system.resources.health.value, 2);
  assert.deepEqual(two.committed[0].updates, {"system.resources.health.value": 2}, "the committed operation shows what was written");
  assert.deepEqual([two.committed[0].metadata.mutationPlan.plan.from, two.committed[0].metadata.mutationPlan.plan.rebased], [8, true]);
});

test("a rolled-back Action takes back only its own damage, not an Action's that landed after it", async () => {
  const {orc, persistencePort} = racingOrc(14);
  const first = orcDamage(orc, 6);
  const second = orcDamage(orc, 6);
  let secondDone;
  const landed = new Promise(resolve => { secondDone = resolve; });
  const failing = {id: "source:0:resourcePayment", type: "resourcePayment", commit: async () => { await landed; return false; }};
  const one = damageTransaction(orc, persistencePort, [first], {snapshotActor, extra: [failing]});
  await new Promise(resolve => setImmediate(resolve));
  const two = await damageTransaction(orc, persistencePort, [second], {snapshotActor});
  secondDone();
  const failed = await one;
  assert.equal(two.ok, true);
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(orc.system.resources.health.value, 8, "the second Action's 6 stays");
  assert.deepEqual(orc.writes.at(-1), {"system.resources.health.value": 8});
});

test("without a snapshotActor, durability commits write their planned updates as before", async () => {
  const {orc, persistencePort} = racingOrc(14);
  const plans = [orcDamage(orc, 6), orcDamage(orc, 6)];
  await Promise.all(plans.map(plan => damageTransaction(orc, persistencePort, [plan])));
  assert.deepEqual(orc.writes, [{"system.resources.health.value": 8}, {"system.resources.health.value": 8}]);
});

test("a rolled-back heal the creature refused (it can't regain Hit Points) takes back nothing", async () => {
  const {orc, persistencePort} = racingOrc(10);
  // As the Actor's _preUpdate does under Chill Touch: a raise of its Hit Points keeps them where they are.
  const refusing = {async updateActor(request) {
    const value = request.updates["system.resources.health.value"];
    const kept = (value > request.actor.system.resources.health.value)
      ? {...request.updates, "system.resources.health.value": request.actor.system.resources.health.value} : request.updates;
    return persistencePort.updateActor({...request, updates: kept});
  }};
  const heal = {type: "durabilityHealing", targetRef: "actor:actor-orc", target: {id: "orc", actorId: "actor-orc"},
    plan: createActorHealingMutationPlan(structuredClone(orc.system), {amount: 5})};
  const failing = {id: "source:0:resourcePayment", type: "resourcePayment", commit: async () => false};
  const failed = await damageTransaction(orc, refusing, [heal], {snapshotActor, extra: [failing]});
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(orc.system.resources.health.value, 10, "not 5: the 5 it never regained is not taken");
});

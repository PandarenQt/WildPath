import {test} from "node:test";
import assert from "node:assert/strict";
import {
  RESOLUTION_TRANSACTION_CODES,
  createActorUpdateTransactionOperation,
  executeResolutionTransaction
} from "../module/resolvers/resolution-transaction-resolver.mjs";

function actorWithCalls(id, calls, {failOn=null}={}) {
  return {
    id,
    async update(updates) {
      calls.push({actorId: id, updates});
      if ( failOn?.(updates) ) throw new Error(`update failed for ${id}`);
      return true;
    }
  };
}

function durabilityPlan(path, from, to) {
  return {
    ok: true,
    path,
    from,
    to,
    updates: from === to ? {} : {[path]: to}
  };
}

test("ResolutionTransaction commits actor update operations in order", async () => {
  const calls = [];
  const result = await executeResolutionTransaction({
    operations: [
      createActorUpdateTransactionOperation({
        id: "damage",
        type: "durabilityDamage",
        actorRef: "actor:target",
        actor: actorWithCalls("target", calls),
        mutationPlan: durabilityPlan("system.resources.health.value", 12, 7)
      }),
      createActorUpdateTransactionOperation({
        id: "payment",
        type: "resourcePayment",
        actorRef: "actor:source",
        actor: actorWithCalls("source", calls),
        mutationPlan: durabilityPlan("system.resources.action.value", 1, 0)
      })
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, RESOLUTION_TRANSACTION_CODES.OK);
  assert.deepEqual(calls, [
    {actorId: "target", updates: {"system.resources.health.value": 7}},
    {actorId: "source", updates: {"system.resources.action.value": 0}}
  ]);
});

test("ResolutionTransaction rolls back committed operations when a later commit fails", async () => {
  const calls = [];
  const result = await executeResolutionTransaction({
    operations: [
      createActorUpdateTransactionOperation({
        id: "damage",
        type: "durabilityDamage",
        actorRef: "actor:target",
        actor: actorWithCalls("target", calls),
        mutationPlan: durabilityPlan("system.resources.health.value", 12, 7)
      }),
      createActorUpdateTransactionOperation({
        id: "payment",
        type: "resourcePayment",
        actorRef: "actor:source",
        actor: actorWithCalls("source", calls, {
          failOn: updates => updates["system.resources.action.value"] === 0
        }),
        mutationPlan: durabilityPlan("system.resources.action.value", 1, 0)
      })
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLUTION_TRANSACTION_CODES.COMMIT_FAILED);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls, [
    {actorId: "target", updates: {"system.resources.health.value": 7}},
    {actorId: "source", updates: {"system.resources.action.value": 0}},
    {actorId: "target", updates: {"system.resources.health.value": 12}}
  ]);
});

test("ResolutionTransaction reports rollback failures explicitly", async () => {
  const calls = [];
  const result = await executeResolutionTransaction({
    operations: [
      createActorUpdateTransactionOperation({
        id: "damage",
        type: "durabilityDamage",
        actorRef: "actor:target",
        actor: actorWithCalls("target", calls, {
          failOn: updates => updates["system.resources.health.value"] === 12
        }),
        mutationPlan: durabilityPlan("system.resources.health.value", 12, 7)
      }),
      createActorUpdateTransactionOperation({
        id: "payment",
        type: "resourcePayment",
        actorRef: "actor:source",
        actor: actorWithCalls("source", calls, {
          failOn: updates => updates["system.resources.action.value"] === 0
        }),
        mutationPlan: durabilityPlan("system.resources.action.value", 1, 0)
      })
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLUTION_TRANSACTION_CODES.ROLLBACK_FAILED);
  assert.equal(result.rolledBack, false);
  assert.equal(result.failures.at(-1).code, RESOLUTION_TRANSACTION_CODES.ROLLBACK_FAILED);
});

test("ResolutionTransaction refuses non-noop updates without rollback data", async () => {
  const calls = [];
  const result = await executeResolutionTransaction({
    operations: [{
      id: "unsafe",
      type: "actorUpdate",
      actorRef: "actor:target",
      actor: actorWithCalls("target", calls),
      updates: {"system.resources.health.value": 7}
    }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, RESOLUTION_TRANSACTION_CODES.ROLLBACK_UNAVAILABLE);
  assert.deepEqual(calls, []);
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {summarizeNestedChildOutcome} from "../module/helpers/nested-child-outcome.mjs";
import {validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";

test("terminal child summary bounds diagnostics and excludes payloads and runtime objects", () => {
  const operation = {id: "source:0:resourcePayment", type: "resourcePayment", actorRef: "Scene.s.Token.t.Actor.a",
    metadata: {role: "sourcePayment", document: new Error("Do not retain"), callback() {}}};
  const tx = {code: "COMMIT_FAILED", commitFailure: {code: "COMMIT_FAILED", reason: "Payment rejected", operation},
    failures: [{code: "ROLLBACK_FAILED", reason: "Deletion rejected", operation}], rolledBack: false};
  const child = {id: "child", status: "failed", currentStageId: "action.commit",
    errors: Array.from({length: 100}, () => ({code: "FAILED", reason: "x".repeat(10000), data: {document: new Error()}})),
    trace: Array.from({length: 100}, () => ({stageId: "action.commit", status: "failed", code: "FAILED", data: {tx}})),
    results: {actionResult: {status: "failed", code: "RESOURCE_COMMIT_FAILED", errors: [], steps: [{data: {transaction: tx}}]}},
    input: {huge: "x".repeat(100000)}};
  const summary = summarizeNestedChildOutcome(child);
  assert.equal(summary.reason, "Payment rejected");
  assert.equal(summary.failedStageId, "action.commit");
  assert.equal(summary.errors.length, 8);
  assert.equal(summary.errors[0].reason.length, 1024);
  assert.equal(summary.traceTail.length, 8);
  assert.deepEqual(summary.transaction.commitFailure.operation.metadata, {role: "sourcePayment"});
  assert.equal(summary.transaction.failures[0].reason, "Deletion rejected");
  assert.equal(validateResolutionStateSerializable(summary).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  assert.ok(JSON.stringify(summary).length < 15000);
});

test("cancelled child summary retains warning reason without requiring an action transaction", () => {
  const summary = summarizeNestedChildOutcome({id: "cancelled", status: "cancelled", currentStageId: "action.effects",
    warnings: [{code: "CANCELLED", reason: "Cancelled by GM"}]});
  assert.equal(summary.code, "CANCELLED");
  assert.equal(summary.reason, "Cancelled by GM");
  assert.equal(summary.transaction, null);
  assert.equal(summarizeNestedChildOutcome({id: "completed", status: "completed"}), null);
});

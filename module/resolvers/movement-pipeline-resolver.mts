import type {AutomationEvent, DocumentPersistencePort, ResolutionPipelineStage, ResolutionState, TokenGridFootprint} from "../types/contracts.js";
import {createMovementPath, evaluateMovementPath} from "../helpers/movement-paths.mjs";
import {createAutomationEvent} from "../helpers/automation-events.mjs";
import {clonePlainData} from "../helpers/multiplayer-authority.mjs";
import {movementTransitionRelations, type MovementObserver} from "../helpers/movement-transition.mjs";
import {createResolutionState, updateResolutionState, runResolutionPipeline, resumeResolutionPipeline,
  continueResolutionStage, completeResolutionStage, failResolutionStage, failResolutionState} from "../helpers/resolution-state.mjs";
import {createReactionWindowStage, completeReactionChildResolution} from "./reaction-resolver.mjs";
import {createActionReactionChildState} from "./action-pipeline-resolver.mjs";
import {resolveActorResourcePayment} from "./resource-resolver.mjs";
import {createActorUpdateTransactionOperation, executeResolutionTransaction, commitActorUpdateOperation} from "./resolution-transaction-resolver.mjs";
import {createDocumentUpdateTransactionOperation} from "./document-update-transaction.mjs";

type Data = Record<string, unknown>;
export interface MovementTraversal {
  readonly completedTransitionCount: number;
  readonly cumulativeCost: number;
  readonly stopped: boolean;
  readonly reason: string | null;
}
export interface MovementContinuation {
  readonly decision: "continue" | "stop" | "invalid";
  readonly reason?: string;
}
export interface MovementPipelineOptions {
  readonly id: string;
  readonly path: Parameters<typeof createMovementPath>[0];
  readonly evaluationOptions?: Parameters<typeof evaluateMovementPath>[1];
  readonly source: Data;
  readonly payment: {readonly capability: string; readonly unit: string; readonly scale: number};
}
export interface MovementPipelinePorts {
  readonly actor: unknown;
  readonly document: unknown;
  readonly documentRef: string;
  readonly persistencePort: DocumentPersistencePort;
  readonly readActorSystem: () => Data;
  readonly positionUpdates: (footprint: TokenGridFootprint) => Data;
  readonly originalPosition: Data;
  readonly validate: (state: ResolutionState, traversal: MovementTraversal) => MovementContinuation;
  readonly observers?: (state: ResolutionState) => readonly MovementObserver[];
  readonly discovery?: (context: {state: ResolutionState; event: AutomationEvent}) => Data;
}

/** A logical traversal host over MovementPath. Only its final transaction persists locomotion. */
export function createMovementResolutionHost(options: MovementPipelineOptions, ports: MovementPipelinePorts) {
  const path = createMovementPath(options.path);
  const evaluation = evaluateMovementPath(path, options.evaluationOptions);
  if (!options.id || !options.payment.capability || !options.payment.unit
    || !Number.isFinite(options.payment.scale) || options.payment.scale <= 0) {
    throw new Error("Movement resolution requires identity and an explicit positive payment conversion.");
  }
  const input = clonePlainData({path, evaluation, source: options.source, payment: options.payment});
  const paymentPolicy = clonePlainData(options.payment);
  const source = clonePlainData(options.source);
  const count = evaluation.transitions.length;
  const initial: MovementTraversal = {completedTransitionCount: 0, cumulativeCost: 0, stopped: false, reason: null};
  const state = createResolutionState({id: options.id, source,
    input: {movement: input}, results: {movement: initial}, metadata: {host: "movement"}});
  const stages: ResolutionPipelineStage[] = [];
  const stage = (id: string, run: ResolutionPipelineStage["run"], active=false) => {
    stages.push({id, run, metadata: {}, ...(active ? {canRun: (s: ResolutionState) => !movementTraversal(s).stopped} : {})});
  };
  stage("movement.intention", s => continueResolutionStage({state: s}));
  stage("movement.route", s => continueResolutionStage({state: s, data: {anchorCount: path.anchors.length}}));
  stage("movement.validation", s => {
    if (!evaluation.valid) return failResolutionStage({state: s, code: "MOVEMENT_ROUTE_INVALID",
      reason: "Movement route is invalid.", data: {failures: evaluation.failures}});
    const validity = ports.validate(s, movementTraversal(s));
    if (validity.decision !== "continue") return failResolutionStage({state: s, code: "MOVEMENT_STATE_INVALID",
      reason: validity.reason ?? "Movement cannot start."});
    const payment = planPayment(evaluation.cost.consumesBudget ? evaluation.cost.amount : 0);
    return payment.ok ? continueResolutionStage({state: s})
      : failResolutionStage({state: s, code: "MOVEMENT_PAYMENT_UNAVAILABLE", reason: "The intended route is not affordable."});
  });
  for (let index = 0; index < count; index++) {
    const prefix = `movement.transition:${index}`;
    stage(`${prefix}.propose`, s => {
      const traversal = movementTraversal(s);
      if (traversal.completedTransitionCount !== index) throw new Error("Movement traversal cursor is out of order.");
      const previous = footprint(index), proposed = footprint(index + 1);
      const transition = evaluation.transitions[index];
      const event = createAutomationEvent({id: `${s.id}:transition:${index}`, type: "movement.transition-proposed", phase: "interrupt",
        source, data: {movementId: s.id, transitionIndex: index, previous, proposed,
          transition, cumulativeCost: traversal.cumulativeCost, movementKind: path.movementKind,
          movementMode: path.movementMode, relations: movementTransitionRelations(previous, proposed, ports.observers?.(s) ?? [])}});
      return continueResolutionStage({state: updateResolutionState(s, {results: {...s.results, proposedMovement: event}})});
    }, true);
    const reaction = createReactionWindowStage({id: `${prefix}.reactions`, timing: "before-transition",
      eventSelector: s => proposedEvent(s), discovery: context => {
        if (ports.discovery) return ports.discovery(context);
        const reactions = context.services.reactions as Data | undefined;
        const resolve = (value: unknown) => typeof value === "function" ? value(context) : value;
        return {...reactions, triggers: resolve(reactions?.triggers) ?? [],
          resourcesByActor: resolve(reactions?.resourcesByActor) ?? {}};
      },
      createChildState: createActionReactionChildState});
    stages.push({...reaction, canRun: s => !movementTraversal(s).stopped});
    stage(`${prefix}.revalidation`, s => {
      const traversal = movementTraversal(s);
      const validity = ports.validate(s, traversal);
      if (validity.decision === "invalid") return failResolutionStage({state: s, code: "MOVEMENT_STATE_STALE",
        reason: validity.reason ?? "Movement source changed during resolution."});
      const cost = evaluation.transitions[index]?.cost.amount ?? 0;
      const payable = planPayment(evaluation.cost.consumesBudget ? traversal.cumulativeCost + cost : 0).ok;
      if (validity.decision === "stop" || !payable) return continueResolutionStage({state: withTraversal(s, {...traversal,
        stopped: true, reason: validity.reason ?? "Remaining movement is unaffordable."})});
      return continueResolutionStage({state: s});
    }, true);
    stage(`${prefix}.traverse`, s => {
      const traversal = movementTraversal(s);
      return continueResolutionStage({state: withTraversal(s, {...traversal, completedTransitionCount: index + 1,
        cumulativeCost: traversal.cumulativeCost + (evaluation.transitions[index]?.cost.amount ?? 0)})});
    }, true);
  }
  stage("movement.payment", s => {
    const traversal = movementTraversal(s);
    const payment = planPayment(evaluation.cost.consumesBudget ? traversal.cumulativeCost : 0);
    if (!payment.ok) return failResolutionStage({state: s, code: "MOVEMENT_PAYMENT_UNAVAILABLE",
      reason: "Completed logical movement can no longer be paid."});
    const position = {documentRef: ports.documentRef, updates: ports.positionUpdates(footprint(traversal.completedTransitionCount)),
      rollbackUpdates: clonePlainData(ports.originalPosition)};
    return continueResolutionStage({state: updateResolutionState(s, {results: {...s.results, paymentResolution: payment,
      movementPosition: position}, mutationPlans: [
      {type: "resourcePayment", plan: payment.mutationPlan}, {type: "documentUpdate", ...position}
    ]})});
  });
  stage("movement.ready-to-commit", s => completeResolutionStage({state: s, status: "ready-to-commit"}));

  let execution: Promise<{ok: boolean; state: ResolutionState}> | undefined;
  return {state,
    plan: ({state: current, services={}}: {state: ResolutionState; services?: Data}) =>
      runResolutionPipeline({state: current, stages, services}),
    resume: ({state: current, response, services={}}: {state: ResolutionState; response: unknown; services?: Data}) => {
      const validity = ports.validate(current, movementTraversal(current));
      if (validity.decision === "invalid") return {ok: false, state: failResolutionState(current,
        {code: "MOVEMENT_STATE_STALE", reason: validity.reason ?? "Movement source changed while awaiting a response."})};
      return resumeResolutionPipeline({state: current, response, stages, services});
    },
    completeChild: (args: Parameters<typeof completeReactionChildResolution>[0]) => {
      const completed = completeReactionChildResolution(args);
      if (completed.duplicate) return completed;
      let current = completed.state;
      if (current.status === "cancelled") {
        // A child cancels the suffix. Completed logical traversal still needs its own commit/payment.
        current = withTraversal(updateResolutionState(current, {status: "running", pendingRequests: [],
          metadata: {...current.metadata, activeChildResolution: null}}), {...movementTraversal(current),
          stopped: true, reason: "Reaction cancelled remaining movement."});
      } else if (current.status === "running") {
        const validity = ports.validate(current, movementTraversal(current));
        if (validity.decision === "invalid") return {...completed, ok: false, state: failResolutionState(current,
          {code: "MOVEMENT_STATE_STALE", reason: validity.reason ?? "Movement source changed during reaction."})};
        if (validity.decision === "stop") current = withTraversal(current, {...movementTraversal(current),
          stopped: true, reason: validity.reason ?? "Movement stopped by continuation policy."});
        // Re-enter the existing grouped window; its accepted/declined candidate IDs prevent loops.
        const id = current.currentStageId;
        current = updateResolutionState(current, {completedStageIds: current.completedStageIds.filter(stageId => stageId !== id)});
      }
      return {...completed, ok: current.status === "running", state: current};
    },
    execute: async ({state: current, authority}: {state: ResolutionState; authority: {canCommit?: boolean}}) => {
      if (current.status === "completed") return {ok: true, duplicate: true, state: current};
      if (current.status !== "ready-to-commit" || authority?.canCommit !== true) {
        return {ok: false, state: failResolutionState(current, {code: "MOVEMENT_COMMIT_UNAUTHORIZED",
          reason: "Movement commit requires ready state and current authority."})};
      }
      // The coordinator owns this host for one intent. Concurrent/replayed commits share one result.
      execution ??= commit(current);
      return execution;
    }
  };

  async function commit(current: ResolutionState) {
      const validity = ports.validate(current, movementTraversal(current));
      if (validity.decision === "invalid" || (validity.decision === "stop" && !movementTraversal(current).stopped)) return {ok: false, state: failResolutionState(current, {
        code: "MOVEMENT_STATE_STALE", reason: validity.reason ?? "Movement source changed before commit."})};
      // Re-read payment at commit; a child may have changed current resources.
      const traversal = movementTraversal(current);
      const payment = planPayment(evaluation.cost.consumesBudget ? traversal.cumulativeCost : 0);
      if (!payment.ok) return {ok: false, state: failResolutionState(current, {code: "MOVEMENT_PAYMENT_UNAVAILABLE",
        reason: "Completed movement is no longer affordable."})};
      current = updateResolutionState(current, {status: "committing", currentStageId: "movement.commit"});
      const updates = ports.positionUpdates(footprint(traversal.completedTransitionCount));
      const transaction = await executeResolutionTransaction({operations: [
        createDocumentUpdateTransactionOperation({id: `${current.id}:position`, document: ports.document,
          documentRef: ports.documentRef, updates, rollbackUpdates: ports.originalPosition, persistencePort: ports.persistencePort}),
        createActorUpdateTransactionOperation({id: `${current.id}:payment`, actor: ports.actor,
          actorRef: source.actorRef, mutationPlan: payment.mutationPlan, persistencePort: ports.persistencePort,
          commit: async operation => {
            const fresh = planPayment(evaluation.cost.consumesBudget ? traversal.cumulativeCost : 0);
            if (!fresh.ok || JSON.stringify(fresh.mutationPlan) !== JSON.stringify(payment.mutationPlan)) {
              throw new Error("Movement resource changed while the position transaction was committing.");
            }
            return commitActorUpdateOperation(operation);
          }})
      ], metadata: {resolutionId: current.id}});
      current = updateResolutionState(current, {results: {...current.results, transaction, paymentResolution: payment,
        movementOutcome: {completedTransitionCount: traversal.completedTransitionCount, intendedTransitionCount: count,
          cumulativeCost: traversal.cumulativeCost, stopped: traversal.stopped, reason: traversal.reason,
          footprint: footprint(traversal.completedTransitionCount), committed: transaction.ok}}});
      if (!transaction.ok) return {ok: false, state: failResolutionState(current, {stageId: "movement.commit",
        code: transaction.code, reason: "Movement transaction failed.", data: {transaction}})};
      return {ok: true, state: updateResolutionState(current, {status: "completed", currentStageId: "movement.finalization",
        completedStageIds: [...current.completedStageIds, "movement.commit", "movement.finalization"],
        stageStatuses: {...current.stageStatuses, "movement.commit": "completed", "movement.finalization": "completed"},
        trace: [...current.trace, {id: `${current.id}:commit`, stageId: "movement.commit", status: "completed", result: "complete", code: "OK", reason: null, data: {}, requestIds: []},
          {id: `${current.id}:finalization`, stageId: "movement.finalization", status: "completed", result: "complete", code: "OK", reason: null, data: {}, requestIds: []}]})};
  }

  function planPayment(amount: number) {
    return resolveActorResourcePayment({actorSystem: ports.readActorSystem(), cost: {allOf: amount > 0
      ? [{capability: paymentPolicy.capability, amount: amount * paymentPolicy.scale, unit: paymentPolicy.unit}] : []}});
  }
  function footprint(index: number): TokenGridFootprint {
    const value = evaluation.footprints[index];
    if (!value) throw new Error("Movement cursor has no tactical footprint.");
    return value;
  }
}

export function movementTraversal(state: ResolutionState): MovementTraversal {
  const value = state.results.movement;
  if (!value || typeof value !== "object" || !("completedTransitionCount" in value) || !("cumulativeCost" in value)
    || !("stopped" in value) || !("reason" in value) || !Number.isInteger(value.completedTransitionCount)
    || typeof value.completedTransitionCount !== "number" || value.completedTransitionCount < 0
    || typeof value.cumulativeCost !== "number" || !Number.isFinite(value.cumulativeCost) || value.cumulativeCost < 0
    || typeof value.stopped !== "boolean" || (value.reason !== null && typeof value.reason !== "string")) {
    throw new Error("Invalid serialized movement traversal.");
  }
  return {completedTransitionCount: value.completedTransitionCount, cumulativeCost: value.cumulativeCost,
    stopped: value.stopped, reason: value.reason};
}
function withTraversal(state: ResolutionState, traversal: MovementTraversal): ResolutionState {
  return updateResolutionState(state, {results: {...state.results, movement: traversal}});
}
function proposedEvent(state: ResolutionState): AutomationEvent {
  const event = state.results.proposedMovement;
  if (!event || typeof event !== "object" || !("type" in event) || event.type !== "movement.transition-proposed") {
    throw new Error("Movement reaction window has no proposed transition.");
  }
  // Written only by the propose stage, after canonical event construction and state validation.
  return event as AutomationEvent;
}

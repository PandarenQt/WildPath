import type {AutomationEvent, EntityRef, GridField, GridTopology, TokenGridFootprint} from "../types/contracts.js";
/** Pure movement facts. Edit this TypeScript source; npm run build emits the Foundry .mjs. */
import {AUTOMATION_EVENT_PHASES, AUTOMATION_EVENT_TYPES, createAutomationEvent} from "./automation-events.mjs";
import {fieldKey, normalizeGridField} from "./grid-footprints.mjs";
import {isPlainSerializableData} from "./multiplayer-authority.mjs";
import {requireEntityRefString} from "./entity-refs.mjs";

export type MovementKind = "voluntary" | "forced" | "teleport";
export type MovementProgressStatus = "pending" | "moving" | "paused" | "interrupted" | "completed";

export interface MovementPathSnapshot {
  readonly topology: GridTopology;
  readonly anchors: readonly GridField[];
  readonly movementKind: MovementKind;
  readonly movementMode: string;
}

export interface MovementStepSnapshot {
  readonly index: number;
  readonly from: GridField;
  readonly to: GridField;
  readonly allowed: boolean;
  readonly cost: {
    readonly amount: number;
    readonly unit: string;
    readonly measurementMode: string;
  };
}

export interface MovementEvaluationSnapshot {
  readonly valid: boolean;
  readonly path: MovementPathSnapshot | null;
  readonly footprints: readonly TokenGridFootprint[];
  readonly transitions: readonly MovementStepSnapshot[];
  readonly cost: {readonly ok: boolean; readonly consumesBudget: boolean};
  readonly trace: {readonly measurementMode: string};
}

export interface MovementSource {
  readonly actorRef: EntityRef | null;
  readonly actorId: string | null;
  readonly tokenRef: EntityRef;
  readonly tokenId: string;
  readonly sceneRef: EntityRef;
}

export interface MovementProgress {
  readonly type: "MovementProgress";
  readonly schemaVersion: 1;
  readonly movementId: string;
  readonly source: MovementSource;
  readonly authority: {readonly userId: string; readonly mode: string};
  readonly approvedPath: MovementPathSnapshot;
  readonly approvedFootprints: readonly TokenGridFootprint[];
  readonly approvedTransitions: readonly MovementStepSnapshot[];
  readonly measurementMode: string;
  readonly consumesBudget: boolean;
  readonly completedTransitionCount: number;
  readonly actualFootprint: TokenGridFootprint;
  readonly cumulativeCost: number;
  readonly status: MovementProgressStatus;
  readonly started: boolean;
}

interface MovementObservationPrefix {
  readonly completedTransitionCount: number;
  readonly actualFootprint: TokenGridFootprint;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export type MovementObservation = MovementObservationPrefix & (
  | {readonly status: "moving" | "paused" | "completed"}
  | {readonly status: "interrupted"; readonly interruption: {
    readonly reason: string;
    readonly source: string | null;
    readonly resumable: boolean;
  }}
);

export interface MovementProgressResult {
  readonly progress: MovementProgress;
  readonly events: readonly AutomationEvent[];
  readonly duplicate: boolean;
}

/** Match an observed segment by ordered index, including routes that revisit an anchor. */
export function completedMovementPrefix(progress: MovementProgress, anchors: readonly GridField[], startTransitionIndex=0): number {
  if ( !Number.isInteger(startTransitionIndex) || startTransitionIndex < 0 || !anchors.length
    || startTransitionIndex + anchors.length > progress.approvedPath.anchors.length ) {
    throw new Error("Observed movement segment is outside the approved route.");
  }
  for ( const [index, anchor] of anchors.entries() ) {
    const approved = progress.approvedPath.anchors[startTransitionIndex + index];
    if ( !approved || fieldKey(anchor, progress.approvedPath.topology) !== fieldKey(approved, progress.approvedPath.topology) ) {
      throw new Error("Observed ordered movement is not a prefix of the approved route.");
    }
  }
  return startTransitionIndex + anchors.length - 1;
}

/** Costs are in the approved measurement mode; the adapter owns conversion to Actor resources. */
export function movementPaymentDelta(progress: MovementProgress, committedMovementCost: number): {
  readonly cumulativeCost: number; readonly committedCost: number; readonly amount: number;
} {
  const cumulativeCost = progress.consumesBudget ? progress.cumulativeCost : 0;
  if ( !Number.isFinite(cumulativeCost) || !Number.isFinite(committedMovementCost)
    || committedMovementCost < 0 || committedMovementCost > cumulativeCost ) {
    throw new Error("Committed movement cost must be between zero and verified cumulative cost.");
  }
  return {cumulativeCost, committedCost: committedMovementCost, amount: cumulativeCost - committedMovementCost};
}

/** Approval creates pending state, never semantic movement facts. */
export function createMovementProgress({movementId, source, authority, evaluation}: {
  readonly movementId: string;
  readonly source: MovementSource;
  readonly authority: MovementProgress["authority"];
  readonly evaluation: MovementEvaluationSnapshot;
}): MovementProgress {
  plainCopy({movementId, source, authority, evaluation});
  if ( !movementId || !authority.userId ) throw new Error("Movement progress requires movement and authority identities.");
  requireEntityRefString(source.tokenRef, "movement Token");
  requireEntityRefString(source.sceneRef, "movement Scene");
  if ( source.actorRef !== null ) requireEntityRefString(source.actorRef, "movement Actor");
  const path = evaluation.path;
  if ( !evaluation.valid || !evaluation.cost.ok || !path?.anchors.length ) {
    throw new Error("Movement progress requires a valid evaluated route.");
  }
  if ( !["voluntary", "forced", "teleport"].includes(path.movementKind) ) throw new Error("Invalid movement kind.");
  if ( evaluation.footprints.length !== path.anchors.length || evaluation.transitions.length !== path.anchors.length - 1 ) {
    throw new Error("Movement progress route, footprint, and transition counts must agree.");
  }
  for ( const [index, footprint] of evaluation.footprints.entries() ) {
    const anchor = path.anchors[index];
    if ( !anchor || footprint.topology !== path.topology || fieldKey(anchor, path.topology) !== fieldKey(footprint.anchor, path.topology) ) {
      throw new Error("Movement footprint does not match its approved anchor.");
    }
    canonicalFields(footprint);
  }
  for ( const [index, step] of evaluation.transitions.entries() ) {
    const from = path.anchors[index];
    const to = path.anchors[index + 1];
    if ( !from || !to || step.index !== index || !step.allowed
      || fieldKey(from, path.topology) !== fieldKey(step.from, path.topology)
      || fieldKey(to, path.topology) !== fieldKey(step.to, path.topology)
      || !Number.isFinite(step.cost.amount) || step.cost.amount < 0 ) {
      throw new Error("Movement progress requires ordered, allowed transitions with finite nonnegative costs.");
    }
  }
  const origin = evaluation.footprints[0];
  if ( !origin ) throw new Error("Movement progress requires an origin footprint.");
  return plainCopy({
    type: "MovementProgress",
    schemaVersion: 1,
    movementId,
    source,
    authority,
    approvedPath: path,
    approvedFootprints: evaluation.footprints,
    approvedTransitions: evaluation.transitions,
    measurementMode: evaluation.trace.measurementMode,
    consumesBudget: evaluation.cost.consumesBudget,
    completedTransitionCount: 0,
    actualFootprint: origin,
    cumulativeCost: 0,
    status: "pending",
    started: false
  });
}

/** Reconcile an explicit observed prefix. The caller owns proof that this progress happened. */
export function advanceMovementProgress(progress: MovementProgress, observation: MovementObservation): MovementProgressResult {
  plainCopy({progress, observation});
  const count = observation.completedTransitionCount;
  const total = progress.approvedTransitions.length;
  if ( !Number.isInteger(count) || count < 0 || count > total ) throw new Error("Observed movement prefix is out of range.");
  if ( !["moving", "paused", "interrupted", "completed"].includes(observation.status) ) throw new Error("Invalid movement progress status.");
  const expected = progress.approvedFootprints[count];
  if ( !expected || !sameMovementFootprint(expected, observation.actualFootprint) ) {
    throw new Error("Observed footprint does not match the reported completed route prefix.");
  }
  if ( observation.status === "completed" && count !== total ) throw new Error("An incomplete prefix cannot complete movement.");
  if ( observation.status === "interrupted" && !observation.interruption?.reason ) {
    throw new Error("Interrupted movement requires an interruption reason.");
  }
  if ( count < progress.completedTransitionCount ) return {progress: plainCopy(progress), events: [], duplicate: true};
  if ( progress.status === "completed" || progress.status === "interrupted" ) {
    if ( observation.status !== progress.status || count !== progress.completedTransitionCount ) {
      throw new Error("Terminal movement progress cannot be resumed or rewritten.");
    }
    return {progress: plainCopy(progress), events: [], duplicate: true};
  }
  if ( count === progress.completedTransitionCount && observation.status === progress.status ) {
    return {progress: plainCopy(progress), events: [], duplicate: true};
  }
  const events: AutomationEvent[] = [];
  const started = progress.started || count > 0 || (total > 0 && observation.status === "moving");
  if ( started && !progress.started ) events.push(movementEvent(progress, AUTOMATION_EVENT_TYPES.MOVEMENT_STARTED, "started", {
    origin: endpoint(progress.approvedFootprints[0]),
    approvedDestination: endpoint(progress.approvedFootprints.at(-1)),
    approvedTransitionCount: total
  }, observation));

  let cumulativeCost = progress.cumulativeCost;
  for ( let index = progress.completedTransitionCount; index < count; index++ ) {
    const from = progress.approvedFootprints[index];
    const to = progress.approvedFootprints[index + 1];
    const step = progress.approvedTransitions[index];
    if ( !from || !to || !step ) throw new Error("Movement progress has a missing transition.");
    cumulativeCost += step.cost.amount;
    events.push(movementEvent(progress, AUTOMATION_EVENT_TYPES.MOVEMENT_TRANSITION, `transition:${index}`, {
      transitionIndex: index,
      from: endpoint(from),
      to: endpoint(to),
      ...diffMovementFootprints(from, to),
      stepCost: step.cost,
      cumulativeCost,
      budgetCost: progress.consumesBudget ? cumulativeCost : 0,
      discontinuous: progress.approvedPath.movementKind === "teleport"
    }, observation));
  }
  const next: MovementProgress = plainCopy({
    ...progress,
    completedTransitionCount: count,
    actualFootprint: observation.actualFootprint,
    cumulativeCost,
    status: observation.status,
    started
  });
  if ( observation.status === "completed" && total > 0 ) {
    events.push(movementEvent(next, AUTOMATION_EVENT_TYPES.MOVEMENT_COMPLETED, "completed", {
      origin: endpoint(progress.approvedFootprints[0]),
      actualDestination: endpoint(next.actualFootprint),
      completedTransitionCount: count,
      actualTotalCost: cumulativeCost,
      budgetCost: progress.consumesBudget ? cumulativeCost : 0
    }, observation));
  }
  if ( observation.status === "interrupted" ) {
    events.push(movementEvent(next, AUTOMATION_EVENT_TYPES.MOVEMENT_INTERRUPTED, "interrupted", {
      approvedDestination: endpoint(progress.approvedFootprints.at(-1)),
      actualDestination: endpoint(next.actualFootprint),
      completedTransitionCount: count,
      remainingTransitionCount: total - count,
      completedAnchors: progress.approvedPath.anchors.slice(0, count + 1),
      remainingAnchors: progress.approvedPath.anchors.slice(count),
      completedCost: cumulativeCost,
      interruption: observation.interruption
    }, observation));
  }
  return {progress: next, events, duplicate: false};
}

export function diffMovementFootprints(before: TokenGridFootprint, after: TokenGridFootprint): {
  readonly leftFields: readonly GridField[];
  readonly enteredFields: readonly GridField[];
  readonly retainedFields: readonly GridField[];
} {
  if ( before.topology !== after.topology ) throw new Error("Movement footprint delta requires matching topologies.");
  const left = canonicalFields(before);
  const right = canonicalFields(after);
  return plainCopy({
    leftFields: [...left].filter(([key]) => !right.has(key)).map(([, field]) => field),
    enteredFields: [...right].filter(([key]) => !left.has(key)).map(([, field]) => field),
    retainedFields: [...left].filter(([key]) => right.has(key)).map(([, field]) => field)
  });
}

export function sameMovementFootprint(left: TokenGridFootprint, right: TokenGridFootprint): boolean {
  if ( left.topology !== right.topology || left.size !== right.size || left.effectiveSize !== right.effectiveSize
    || fieldKey(left.anchor, left.topology) !== fieldKey(right.anchor, right.topology) ) return false;
  return JSON.stringify([...canonicalFields(left).keys()]) === JSON.stringify([...canonicalFields(right).keys()]);
}

function canonicalFields(footprint: TokenGridFootprint): Map<string, GridField> {
  if ( !["square", "hex"].includes(footprint.topology) || !footprint.fields.length ) throw new Error("Invalid movement footprint.");
  const entries = footprint.fields.map(field => {
    const coordinates = footprint.topology === "hex"
      ? ("q" in field && "r" in field ? [field.q, field.r] : [])
      : ("x" in field && "y" in field ? [field.x, field.y] : []);
    if ( coordinates.length !== 2 || !coordinates.every(Number.isInteger) ) throw new Error("Movement fields require integer topology coordinates.");
    return [fieldKey(field, footprint.topology), normalizeGridField(field, footprint.topology)] as const;
  });
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return new Map(entries);
}

function endpoint(footprint: TokenGridFootprint | undefined) {
  if ( !footprint ) throw new Error("Movement endpoint footprint is missing.");
  return {anchor: footprint.anchor, footprint};
}

/** Shared identity for canonical facts and their pre-approved application boundaries. */
export function movementEventId(progress: Pick<MovementProgress, "source" | "movementId">, suffix: string): string {
  const identity = [progress.source.sceneRef, progress.source.tokenRef, progress.movementId].map(encodeURIComponent).join(":");
  return `movement:${identity}:${suffix}`;
}

function movementEvent(progress: MovementProgress, type: string, suffix: string, data: Record<string, unknown>, observation: MovementObservation): AutomationEvent {
  return createAutomationEvent({
    id: movementEventId(progress, suffix),
    type,
    phase: AUTOMATION_EVENT_PHASES.INFORMATION,
    source: {ref: progress.source.tokenRef, actorId: progress.source.actorId, tokenId: progress.source.tokenId},
    tags: ["movement", progress.approvedPath.movementKind, progress.approvedPath.movementMode],
    data: {
      movementId: progress.movementId,
      movementKind: progress.approvedPath.movementKind,
      movementMode: progress.approvedPath.movementMode,
      sceneRef: progress.source.sceneRef,
      actorRef: progress.source.actorRef,
      tokenRef: progress.source.tokenRef,
      measurementMode: progress.measurementMode,
      consumesBudget: progress.consumesBudget,
      ...data
    },
    metadata: {authority: progress.authority, observation: observation.provenance}
  });
}

function plainCopy<T>(value: T): T {
  if ( !isPlainSerializableData(value) ) throw new Error("Movement facts must contain only plain serializable data.");
  return structuredClone(value);
}

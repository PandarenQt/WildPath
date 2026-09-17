// Development-only assertions shared by the live helper and its regression tests.
import {fieldKey} from "../../module/helpers/grid-footprints.mjs";

const check = (value, reason) => {if (!value) throw new Error(reason);};
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
export function footprintSnapshot(footprint) {
  if (!footprint) return null;
  return clone({topology:footprint.topology,size:footprint.size,anchor:footprint.anchor,fields:footprint.fields});
}
function footprintKey(footprint) {
  check(["square","hex"].includes(footprint?.topology) && footprint.anchor && footprint.fields?.length,
    "Missing full tactical footprint evidence.");
  const keys = footprint.fields.map(f => fieldKey(f,footprint.topology)).sort();
  check(new Set(keys).size === keys.length,"Duplicate footprint fields.");
  return JSON.stringify([footprint.topology,fieldKey(footprint.anchor,footprint.topology),keys]);
}
const sameFootprint = (a,b) => footprintKey(a) === footprintKey(b);

export function captureMovementQA(state, renderedPosition, renderedFootprint) {
  const cursor = state.results.movement, child = state.metadata.activeChildResolution;
  const event = state.results.proposedMovement;
  const window = state.metadata.reactionWindows?.find(w => w.event?.id === event?.id);
  return clone({resolutionId:state.id,status:state.status,stage:state.currentStageId,cursor,
    renderedPosition,renderedFootprint:footprintSnapshot(renderedFootprint),
    origin:footprintSnapshot(state.input.movement.evaluation.footprints[0]),
    logical:footprintSnapshot(state.input.movement.evaluation.footprints[cursor.completedTransitionCount]),
    event:event ? {id:event.id,type:event.type,phase:event.phase,data:{transitionIndex:event.data.transitionIndex,
      previous:footprintSnapshot(event.data.previous),proposed:footprintSnapshot(event.data.proposed),
      cumulativeCost:event.data.cumulativeCost,relations:event.data.relations}} : null,
    window:window ? {id:window.id,timing:window.timing,offeredCandidateIds:window.offeredCandidateIds} : null,
    pendingChoice:state.pendingRequests.some(r => r.type === "reaction-choice"),
    child:child ? {id:child.id,status:child.status,source:child.source,rollResults:child.rollResults,
      targetFootprints:child.input?.context?.spatial?.targetFootprints?.map(t => ({target:t.target,
        footprint:footprintSnapshot(t.footprint)}))} : null});
}

function verifyInterruption(entry, prepared) {
  check(entry?.resolutionId === prepared.resolutionId,"Missing matching interruption evidence.");
  check(entry.cursor?.completedTransitionCount === 1 && entry.event?.data?.transitionIndex === 1,
    "Reaction must precede transition 1, after exactly one completed logical transition.");
  check(entry.event.type === "movement.transition-proposed" && entry.event.phase === "interrupt"
    && entry.window?.timing === "before-transition" && entry.window.offeredCandidateIds?.length === 1,
    "Missing pre-transition reaction discovery.");
  const relation = entry.event.data.relations?.qaReactor;
  check(relation?.leavesReach === true && relation.withinBefore === true && relation.withinAfter === false
    && relation.before === 1 && relation.after === 2 && relation.reachFields === 1,
    "Missing full-footprint leavesReach evidence.");
  check(sameFootprint(entry.logical,entry.event.data.previous),"Event previous footprint disagrees with completed cursor.");
  check(!sameFootprint(entry.logical,entry.origin),"Fixture does not distinguish logical position from origin.");
  check(sameFootprint(entry.renderedFootprint,entry.origin)
    && entry.renderedPosition.x === prepared.origin.x && entry.renderedPosition.y === prepared.origin.y,
    "Token moved from rendered origin before final commit.");
  check(!sameFootprint(entry.logical,entry.event.data.proposed),"Proposed footprint has already traversed.");
  if (prepared.variant === "large-hex-decline") {
    for (const f of [entry.origin,entry.logical,entry.event.data.previous,entry.event.data.proposed,entry.renderedFootprint]) {
      check(f.topology === "hex" && f.size === "large" && f.fields.length === 3,
        "Large hex QA requires full three-field footprints.");
    }
  }
}

export function verifyPendingMovementQA(entry, prepared) {
  verifyInterruption(entry,prepared);
  check(entry.pendingChoice && !entry.child,"Run the pending proof before answering the reaction choice.");
  return true;
}

export function verifyMovementQA({state,prepared,after,pending,children=[]}) {
  check(state?.status === "completed","Movement has not completed; inspect dump() and pending prompts.");
  const used = ["miss","hit","stop"].includes(prepared.mode), stopped = prepared.mode === "stop";
  const count = stopped ? 1 : 3, expected = prepared.route[count-1];
  const outcome = state.results.movementOutcome, evaluation = state.input.movement.evaluation;
  check(after.x === expected.x && after.y === expected.y,"Unexpected completed position.");
  check(after.movement === 30-count*5,"Unexpected movement payment.");
  check(after.reaction === (used ? 0 : 1),"Unexpected reaction payment.");
  check(after.hp === (["hit","stop"].includes(prepared.mode) ? 24 : 30),"Unexpected child damage.");
  check(outcome?.stopped === stopped && outcome.committed === true && outcome.completedTransitionCount === count
    && outcome.intendedTransitionCount === 3,"Unexpected continuation outcome.");
  check(sameFootprint(outcome.footprint,evaluation.footprints[count]),"Final logical footprint mismatch.");
  check(sameFootprint(after.footprint,outcome.footprint),"Persisted Token footprint disagrees with final logical position.");
  const windows = (state.metadata.reactionWindows ?? []).filter(w => w.offeredCandidateIds.length);
  if (prepared.mode === "ordinary") {
    check(!windows.length && !children.length,"Ordinary movement unexpectedly discovered a reaction.");
    return true;
  }
  verifyPendingMovementQA(pending,prepared);
  check(windows.length === 1 && windows[0].id === pending.window.id && windows[0].status === "closed",
    "Expected the discovered reaction window to close exactly once.");
  const window = windows[0];
  if (used) {
    check(window.childResolutionIds.length === 1 && children.length > 0,"Missing reaction child footprint evidence.");
    for (const entry of children) {
      verifyInterruption(entry,prepared);
      check(entry.child?.id === window.childResolutionIds[0],"Captured child is not the discovered reaction child.");
      const targets = entry.child.targetFootprints;
      check(targets?.length === 1 && targets[0].target?.id === prepared.moverTokenId,
        "Reaction child must target the mover.");
      check(sameFootprint(targets[0].footprint,entry.logical),
        "Reaction child targetFootprints must use the last-completed logical footprint.");
      check(!sameFootprint(targets[0].footprint,entry.renderedFootprint),
        "Reaction child incorrectly targets the rendered origin.");
    }
  } else {
    check(prepared.mode === "decline" && window.declinedCandidateIds.length === 1
      && window.declinedCandidateIds[0] === window.offeredCandidateIds[0]
      && !window.childResolutionIds.length && !children.length,"Decline unexpectedly created a child or was not recorded.");
  }
  if (prepared.variant === "large-hex-decline") {
    check(prepared.mode === "decline","Large hex variant is decline-only.");
    check(evaluation.footprints.length === 4 && evaluation.footprints.every(f =>
      f.topology === "hex" && f.size === "large" && f.fields.length === 3),"Route lost its Large hex footprint.");
  }
  return true;
}

/* -------------------------------------------- */
/*  Level-5 evidence wrapper (development only)  */
/* -------------------------------------------- */

export const STAGED_MOVEMENT_EVIDENCE_SCHEMA = 1;
export const STAGED_MOVEMENT_EVIDENCE_TYPE = "staged-movement-level5";
/** The only cases the canonical two-browser sentinel may label. Everything else is Quench-owned. */
export const STAGED_MOVEMENT_SENTINELS = Object.freeze({
  "ordinary":{mode:"ordinary",variant:"square"},
  "decline":{mode:"decline",variant:"square"},
  "large-hex-decline":{mode:"decline",variant:"large-hex-decline"}
});
export const STAGED_MOVEMENT_EVIDENCE_FILES = Object.freeze({
  "ordinary":{gm:"evidence/gm-movement-ordinary.json",player:"evidence/player-movement-ordinary.json"},
  "decline":{gm:"evidence/gm-movement-decline.json",player:"evidence/player-movement-decline.json"},
  "large-hex-decline":{gm:"evidence/gm-large-hex-decline.json",player:"evidence/player-large-hex-decline.json"}
});

export function sentinelForCase(mode, variant) {
  const entry = Object.entries(STAGED_MOVEMENT_SENTINELS).find(([,s]) => s.mode === mode && s.variant === variant);
  return entry ? entry[0] : null;
}

// JSON.stringify would silently drop functions/undefined, empty Maps and Sets, and stringify Dates and
// Documents' enumerable state. Canonical evidence must fail closed instead.
function assertPlainJSON(value, path, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {check(Number.isFinite(value),`${path} must be a finite number.`); return;}
  check(type === "object",`${path} must be JSON data, not ${type}.`);
  check(!seen.has(value),`${path} is circular.`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertPlainJSON(entry,`${path}[${index}]`,seen));
  else {
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null,
      `${path} must be a plain object (found ${proto?.constructor?.name ?? "unknown prototype"}).`);
    for (const [key, entry] of Object.entries(value)) assertPlainJSON(entry,`${path}.${key}`,seen);
  }
  seen.delete(value);
}

/**
 * Wrap the helper's bounded GM `prove()`/`dump()` or player `dumpPlayer()` object as canonical Level-5
 * evidence. Pure and deterministic: runtime metadata and the Git SHA are supplied by the caller, and
 * `capturedAt` may be injected for tests. Throws rather than producing misleading evidence.
 */
export function buildStagedMovementLevel5Evidence({role, evidence, gitSha, runtime, sentinel=null, capturedAt=null}={}) {
  check(role === "gm" || role === "player","Evidence role must be \"gm\" or \"player\".");
  check(evidence && typeof evidence === "object" && !Array.isArray(evidence),"Evidence must be the helper's dump object.");
  check(evidence.role === role,`Evidence was captured as ${evidence.role ?? "<unknown>"}, not ${role}.`);
  const label = sentinelForCase(evidence.mode,evidence.variant);
  check(label,`mode ${JSON.stringify(evidence.mode)} with variant ${JSON.stringify(evidence.variant)} is not a Level-5 sentinel case; `
    + "only ordinary (square), decline (square) and large-hex-decline are canonical.");
  if (sentinel !== null) check(sentinel === label,`Requested sentinel ${JSON.stringify(sentinel)} does not match the prepared case ${label}.`);
  check(typeof evidence.runId === "string" && evidence.runId,"Evidence must carry the fixture runId.");
  check(typeof evidence.resolutionId === "string" && evidence.resolutionId,"Evidence must carry the resolutionId.");
  if (role === "gm") {
    check(evidence.proofPassed === true,"GM evidence requires a passed final proof (movementQA.prove()) before export.");
    check(evidence.state?.status === "completed",`GM evidence requires a completed resolution, found ${JSON.stringify(evidence.state?.status)}.`);
    check(evidence.footprintProof && typeof evidence.footprintProof === "object","GM evidence must include footprintProof.");
    if (label !== "ordinary") check(evidence.footprintProof.pending,"Reaction sentinels require the captured pending proof.");
    check(!evidence.footprintProof.captureErrors?.length,"GM evidence has capture errors; inspect dump().footprintProof.captureErrors.");
  } else {
    const result = evidence.result;
    check(result && typeof result === "object",
      "Player evidence requires the terminal result received by the player client; the prepared flag alone is not evidence.");
    check(result.resolutionId === evidence.resolutionId,"Player terminal result belongs to a different resolution.");
    check(result.status === "completed" && result.ok !== false,
      `Player evidence requires a completed terminal result, found ${JSON.stringify(result.status)}.`);
  }
  check(typeof gitSha === "string" && /^[0-9a-f]{7,40}$/i.test(gitSha.trim()),
    "gitSha must be the exact Git commit SHA (7-40 hex characters) of the served build; canonical evidence is never exported without it.");
  check(runtime && typeof runtime === "object","Foundry runtime metadata is required.");
  check(typeof runtime.foundryVersion === "string" && runtime.foundryVersion.trim(),"runtime.foundryVersion must be Foundry's version string.");
  for (const key of ["generation","build"]) {
    if (runtime[key] != null) check(Number.isInteger(runtime[key]),`runtime.${key} must be an integer when supplied.`);
  }
  check(runtime.systemId === "wildpath","Evidence must be captured with the wildpath system active.");
  const stamp = capturedAt ?? new Date().toISOString();
  check(typeof stamp === "string" && Number.isFinite(Date.parse(stamp)) && new Date(stamp).toISOString() === stamp,
    "capturedAt must be an ISO-8601 UTC timestamp such as new Date().toISOString().");
  assertPlainJSON(evidence,"evidence",new Set());
  return {
    schemaVersion:STAGED_MOVEMENT_EVIDENCE_SCHEMA, evidenceType:STAGED_MOVEMENT_EVIDENCE_TYPE,
    role, case:label, mode:evidence.mode, variant:evidence.variant,
    foundryVersion:runtime.foundryVersion.trim(),
    foundry:{generation:runtime.generation ?? null, build:runtime.build ?? null},
    systemId:runtime.systemId, systemVersion:typeof runtime.systemVersion === "string" ? runtime.systemVersion : null,
    gitSha:gitSha.trim().toLowerCase(), capturedAt:stamp,
    runId:evidence.runId, resolutionId:evidence.resolutionId,
    evidenceFile:STAGED_MOVEMENT_EVIDENCE_FILES[label][role],
    evidence:JSON.parse(JSON.stringify(evidence))
  };
}

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

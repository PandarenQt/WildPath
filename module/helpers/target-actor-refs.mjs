import {
  ENTITY_REF_KINDS,
  actorRef,
  normalizeEntityRef,
  parseEntityRef,
  tokenRef,
  uuidRef
} from "./entity-refs.mjs";

/* -------------------------------------------- */

export function targetLookupRefs(target={}) {
  return uniqueStrings([
    normalizeEntityRef(target),
    target.ref,
    target.uuid ? uuidRef(target.uuid) : null,
    target.uuid,
    target.actorId ? actorRef(target.actorId) : null,
    target.actorId,
    target.tokenId ? tokenRef(target.tokenId, {sceneId: target.sceneId}) : null,
    target.tokenId,
    target.id,
    // A target candidate wraps its creature's own refs (its Token) in `target`.
    ...((target.target && (typeof target.target === "object")) ? targetLookupRefs(target.target) : [])
  ]);
}

/**
 * Whether two ref lists (targetLookupRefs of one creature, or the union of several creatures') share a creature. By Token
 * when both name Tokens, since unlinked Tokens of one Actor share its actor refs and its id; else by any shared ref (a
 * linked or Token-less creature, or a list written with actor refs only).
 */
export function sameTargetRefs(left=[], right=[]) {
  const tokenIds = refs => refs.map(parseEntityRef).filter(parsed => parsed.kind === ENTITY_REF_KINDS.TOKEN).map(parsed => parsed.id);
  const leftTokens = tokenIds(left);
  const rightTokens = tokenIds(right);
  if ( leftTokens.length && rightTokens.length ) return leftTokens.some(id => rightTokens.includes(id));
  return left.some(ref => right.includes(ref));
}

/** A completed Action's targets: those its intent chose, or the resolved ones (chosen at a target prompt, or by area). */
export function completedTargetRefs(state) {
  return state?.targets?.length ? state.targets
    : (state?.results?.targetResolution?.targetContexts ?? []).map(context => context?.target?.target ?? context?.target);
}

export function preferredTargetRef(target={}) {
  return normalizeEntityRef(target) ?? target.ref ?? target.actorId ?? target.tokenId ?? target.uuid ?? target.id ?? null;
}

export function targetLabel(target={}) {
  return preferredTargetRef(target) ?? target.name ?? "target";
}

export function resolveTargetLookupValue(lookup, target, payload=null, {selectValue=defaultSelectValue}={}) {
  if ( typeof lookup === "function" ) {
    return lookup({
      target: clonePlain(target),
      payload: clonePlain(payload),
      refs: targetLookupRefs(target)
    }) ?? null;
  }

  const refs = targetLookupRefs(target);
  if ( lookup instanceof Map ) {
    return refs.map(ref => selectValue(lookup.get(ref))).find(Boolean) ?? null;
  }

  if ( Array.isArray(lookup) ) {
    return resolveTargetLookupValueFromArray(lookup, refs, selectValue);
  }

  if ( lookup && typeof lookup === "object" ) {
    return refs.map(ref => selectValue(lookup[ref])).find(Boolean) ?? null;
  }

  return null;
}

/* -------------------------------------------- */

function resolveTargetLookupValueFromArray(entries, refs, selectValue) {
  for ( const entry of entries ) {
    const entryRefs = targetLookupRefs(entry.target ?? entry);
    if ( sameTargetRefs(refs, entryRefs) ) return selectValue(entry);
  }
  return null;
}

function defaultSelectValue(entry) {
  return entry ?? null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null && value !== "").map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}

import {
  actorRef,
  normalizeEntityRef,
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
    target.id
  ]);
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
    if ( refs.some(ref => entryRefs.includes(ref)) ) return selectValue(entry);
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

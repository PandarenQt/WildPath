export const ENTITY_REF_KINDS = Object.freeze({
  ACTOR: "actor",
  TOKEN: "token",
  ITEM: "item",
  EFFECT: "effect",
  SCENE: "scene",
  COMBAT: "combat",
  COMBATANT: "combatant",
  USER: "user",
  UUID: "uuid",
  UNKNOWN: "unknown"
});

const KIND_PATTERN = /^[a-z][a-z0-9-]*$/;
const SCOPED_REF_KINDS = new Set([
  ENTITY_REF_KINDS.TOKEN,
  ENTITY_REF_KINDS.COMBATANT
]);

/* -------------------------------------------- */

export function createEntityRef(kind, id, {scope=null}={}) {
  const normalizedKind = normalizeKind(kind);
  const normalizedId = normalizeSegment(id);
  if ( !normalizedKind || !normalizedId ) return null;

  const normalizedScope = normalizeSegment(scope);
  const key = normalizedScope ? `${normalizedScope}.${normalizedId}` : normalizedId;
  return `${normalizedKind}:${key}`;
}

export function actorRef(actorId) {
  return createEntityRef(ENTITY_REF_KINDS.ACTOR, actorId);
}

export function tokenRef(tokenId, {sceneId=null}={}) {
  return createEntityRef(ENTITY_REF_KINDS.TOKEN, tokenId, {scope: sceneId});
}

export function itemRef(itemId) {
  return createEntityRef(ENTITY_REF_KINDS.ITEM, itemId);
}

export function effectRef(effectId) {
  return createEntityRef(ENTITY_REF_KINDS.EFFECT, effectId);
}

export function uuidRef(uuid) {
  return createEntityRef(ENTITY_REF_KINDS.UUID, uuid);
}

/* -------------------------------------------- */

export function parseEntityRef(value) {
  if ( typeof value !== "string" ) return invalidRef("reference must be a string");

  const ref = value.trim();
  const separator = ref.indexOf(":");
  if ( !ref || separator <= 0 || separator === ref.length - 1 ) {
    return invalidRef("reference must use the kind:id format");
  }

  const kind = normalizeKind(ref.slice(0, separator));
  const key = normalizeSegment(ref.slice(separator + 1));
  if ( !kind || !key ) return invalidRef("reference kind or id is invalid");

  const {scope, id} = splitScopedKey(kind, key);
  return {
    ok: true,
    ref: `${kind}:${key}`,
    kind,
    scope,
    id,
    key,
    reason: null
  };
}

export function isEntityRefString(value) {
  return parseEntityRef(value).ok;
}

export function requireEntityRefString(value, label="entity reference") {
  const parsed = parseEntityRef(value);
  if ( !parsed.ok ) throw new Error(`${label} must be an opaque string reference.`);
  return parsed.ref;
}

/* -------------------------------------------- */

export function normalizeEntityRef(value, {kind=null, scope=null, sceneId=null}={}) {
  if ( typeof value === "string" ) {
    const parsed = parseEntityRef(value);
    return parsed.ok ? parsed.ref : null;
  }

  if ( !value || typeof value !== "object" ) return null;

  const explicit = parseEntityRef(value.ref);
  if ( explicit.ok ) return explicit.ref;

  const tokenId = value.tokenId ?? value.token?.id ?? documentId(value, "Token");
  const tokenSceneId = sceneId ?? scope ?? value.sceneId ?? value.scene?.id
    ?? value.token?.scene?.id ?? value.token?.parent?.id ?? null;
  if ( tokenId ) return tokenRef(tokenId, {sceneId: tokenSceneId});

  const actorId = value.actorId ?? value.actor?.id ?? documentId(value, "Actor");
  if ( actorId ) return actorRef(actorId);

  const itemId = value.itemId ?? value.item?.id ?? documentId(value, "Item");
  if ( itemId ) return itemRef(itemId);

  const effectId = value.effectId ?? value.effect?.id ?? documentId(value, "ActiveEffect");
  if ( effectId ) return effectRef(effectId);

  if ( value.uuid ) return uuidRef(value.uuid);

  const fallbackKind = normalizeKind(kind ?? value.refKind);
  if ( fallbackKind && value.id ) {
    return createEntityRef(fallbackKind, value.id, {scope: sceneId ?? scope});
  }

  return null;
}

export function entityRefId(value) {
  const ref = normalizeEntityRef(value);
  return ref ? parseEntityRef(ref).id : null;
}

export function sameEntityRef(a, b) {
  const left = normalizeEntityRef(a);
  const right = normalizeEntityRef(b);
  return Boolean(left && right && left === right);
}

/* -------------------------------------------- */

function splitScopedKey(kind, key) {
  if ( !SCOPED_REF_KINDS.has(kind) ) return {scope: null, id: key};

  const separator = key.indexOf(".");
  if ( separator <= 0 || separator === key.length - 1 ) {
    return {scope: null, id: key};
  }

  return {
    scope: key.slice(0, separator),
    id: key.slice(separator + 1)
  };
}

function normalizeKind(value) {
  if ( value == null ) return null;
  const kind = String(value).trim().toLowerCase();
  return KIND_PATTERN.test(kind) ? kind : null;
}

function normalizeSegment(value) {
  if ( value == null ) return null;
  const segment = String(value).trim();
  return segment || null;
}

function documentId(value, documentName) {
  return value.documentName === documentName ? value.id : null;
}

function invalidRef(reason) {
  return {
    ok: false,
    ref: null,
    kind: ENTITY_REF_KINDS.UNKNOWN,
    scope: null,
    id: null,
    key: null,
    reason
  };
}

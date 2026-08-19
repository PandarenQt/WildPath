import {evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpressionNumber} from "./value-expressions.mjs";

export const INVENTORY_OPERATIONS = Object.freeze({
  VIEW: "view",
  DEPOSIT: "deposit",
  WITHDRAW: "withdraw",
  MANAGE: "manage"
});

export const INVENTORY_WEIGHT_POLICY = Object.freeze({
  TRACK_AND_PROPAGATE: "track-and-propagate",
  TRACK_INDEPENDENTLY: "track-independently",
  TRACK_BUT_IGNORE_FOR_CARRIER: "track-but-ignore-for-carrier",
  IGNORE: "ignore"
});

export const INVENTORY_CODES = Object.freeze({
  OK: "OK",
  NO_ACCESS: "NO_ACCESS",
  WITHDRAW_NOT_ALLOWED: "WITHDRAW_NOT_ALLOWED",
  DEPOSIT_NOT_ALLOWED: "DEPOSIT_NOT_ALLOWED",
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  CONTAINMENT_CYCLE: "CONTAINMENT_CYCLE",
  SPACE_UNAVAILABLE: "SPACE_UNAVAILABLE",
  ITEM_NOT_FOUND: "ITEM_NOT_FOUND"
});

const ALL_OPERATIONS = Object.freeze([
  INVENTORY_OPERATIONS.VIEW,
  INVENTORY_OPERATIONS.DEPOSIT,
  INVENTORY_OPERATIONS.WITHDRAW,
  INVENTORY_OPERATIONS.MANAGE
]);

/* -------------------------------------------- */

export function createInventorySpace(data) {
  if ( !data.id ) throw new Error("InventorySpace requires a stable id.");
  return {
    id: String(data.id),
    label: data.label ?? data.id,
    host: clonePlain(data.host ?? {type: "world", id: "world"}),
    accessPolicy: clonePlain(data.accessPolicy ?? {}),
    weightPolicy: normalizeWeightPolicy(data.weightPolicy),
    capacity: clonePlain(data.capacity ?? {}),
    parentItemId: data.parentItemId ?? null,
    metadata: clonePlain(data.metadata ?? {})
  };
}

export function createInventoryItem(data) {
  if ( !data.id ) throw new Error("Inventory item requires a stable id.");
  return {
    id: String(data.id),
    label: data.label ?? data.name ?? data.id,
    quantity: Math.max(Number(data.quantity ?? 1) || 0, 0),
    weight: Math.max(Number(data.weight ?? 0) || 0, 0),
    stackKey: data.stackKey ?? data.id,
    spaceId: data.spaceId ?? null,
    containsSpaceIds: [...(data.containsSpaceIds ?? [])],
    accessGrants: (data.accessGrants ?? []).map(grant => createInventoryAccessGrant({...grant, sourceItemId: data.id})),
    metadata: clonePlain(data.metadata ?? {})
  };
}

export function createInventoryAccessGrant(data) {
  return {
    id: String(data.id ?? `${data.sourceItemId ?? "grant"}:${data.spaceId}`),
    spaceId: data.spaceId,
    grantee: data.grantee ? clonePlain(data.grantee) : null,
    granteePolicy: data.granteePolicy ?? null,
    operations: [...(data.operations ?? [INVENTORY_OPERATIONS.VIEW])],
    active: data.active !== false,
    predicate: data.predicate ?? null,
    source: clonePlain(data.source ?? (data.sourceItemId ? {type: "item", id: data.sourceItemId} : {})),
    sourceItemId: data.sourceItemId ?? null,
    metadata: clonePlain(data.metadata ?? {})
  };
}

export function createInventoryState({spaces=[], items=[], accessGrants=[]}={}) {
  return {
    spaces: spaces.map(createInventorySpace),
    items: items.map(createInventoryItem),
    accessGrants: accessGrants.map(createInventoryAccessGrant)
  };
}

/* -------------------------------------------- */

export function getAccessibleInventorySpaces(actorRef, state, context={}) {
  const actor = normalizeActorRef(actorRef);
  const grantsBySpace = new Map();

  for ( const space of state.spaces ) {
    if ( space.host?.type === "actor" && space.host.id === actor.id ) {
      addAccess(grantsBySpace, space, {
        operations: ALL_OPERATIONS,
        source: {type: "space-host", id: actor.id},
        active: true
      });
    }
  }

  for ( const grant of allAccessGrants(state) ) {
    const result = evaluateAccessGrant(grant, actor, state, context);
    if ( !result.ok ) continue;
    const space = state.spaces.find(s => s.id === grant.spaceId);
    if ( space ) addAccess(grantsBySpace, space, {
      operations: grant.operations,
      source: grant.source,
      active: true,
      grantId: grant.id
    });
  }

  return [...grantsBySpace.values()].map(entry => ({
    space: cloneSpace(entry.space),
    operations: [...entry.operations].sort(),
    sources: entry.sources.map(clonePlain),
    active: true,
    weightPolicy: clonePlain(entry.space.weightPolicy)
  }));
}

/* -------------------------------------------- */

export function planInventoryTransfer({
  state,
  itemId,
  sourceSpaceId,
  destinationSpaceId,
  actorRef=null,
  quantity=1,
  newItemId=null,
  ignoreAccess=false
}) {
  const item = state.items.find(i => i.id === itemId);
  if ( !item ) return failPlan(INVENTORY_CODES.ITEM_NOT_FOUND);
  const sourceSpace = state.spaces.find(s => s.id === sourceSpaceId);
  const destinationSpace = state.spaces.find(s => s.id === destinationSpaceId);
  if ( !sourceSpace || !destinationSpace ) return failPlan(INVENTORY_CODES.SPACE_UNAVAILABLE);
  if ( item.spaceId !== sourceSpaceId ) return failPlan(INVENTORY_CODES.ITEM_NOT_FOUND, "item is not in the requested source space");

  const amount = Math.floor(Number(quantity) || 0);
  if ( amount <= 0 || amount > item.quantity ) return failPlan(INVENTORY_CODES.INVALID_QUANTITY);
  if ( item.containsSpaceIds.length && amount < item.quantity ) {
    return failPlan(INVENTORY_CODES.INVALID_QUANTITY, "cannot split a storage-granting item stack");
  }

  if ( !ignoreAccess && actorRef ) {
    const access = getAccessibleInventorySpaces(actorRef, state);
    if ( !hasOperation(access, sourceSpaceId, INVENTORY_OPERATIONS.WITHDRAW) ) {
      return failPlan(INVENTORY_CODES.WITHDRAW_NOT_ALLOWED);
    }
    if ( !hasOperation(access, destinationSpaceId, INVENTORY_OPERATIONS.DEPOSIT) ) {
      return failPlan(INVENTORY_CODES.DEPOSIT_NOT_ALLOWED);
    }
  }

  if ( wouldCreateContainmentCycle(state, itemId, destinationSpaceId) ) {
    return failPlan(INVENTORY_CODES.CONTAINMENT_CYCLE);
  }
  const capacity = validateCapacity(state, destinationSpace, item, amount);
  if ( !capacity.ok ) return failPlan(capacity.code, capacity.reason);

  const mergeTarget = findMergeTarget(state, destinationSpaceId, item);
  return {
    ok: true,
    code: INVENTORY_CODES.OK,
    itemId,
    sourceSpaceId,
    destinationSpaceId,
    quantity: amount,
    mergeTargetId: mergeTarget?.id ?? null,
    newItemId: newItemId ?? `${item.id}:split:${amount}`,
    operations: [
      {type: "remove", spaceId: sourceSpaceId, itemId, quantity: amount},
      {type: mergeTarget ? "merge" : "add", spaceId: destinationSpaceId, itemId, quantity: amount}
    ]
  };
}

/* -------------------------------------------- */

export function commitInventoryTransfer(state, plan) {
  if ( !plan?.ok ) return {ok: false, code: plan?.code ?? INVENTORY_CODES.SPACE_UNAVAILABLE, state: cloneState(state)};
  const next = cloneState(state);
  const item = next.items.find(i => i.id === plan.itemId);
  if ( !item || item.quantity < plan.quantity ) {
    return {ok: false, code: INVENTORY_CODES.ITEM_NOT_FOUND, state: next};
  }

  const mergeTarget = plan.mergeTargetId ? next.items.find(i => i.id === plan.mergeTargetId) : null;
  if ( plan.quantity === item.quantity ) {
    if ( mergeTarget ) {
      mergeTarget.quantity += plan.quantity;
      next.items = next.items.filter(i => i.id !== item.id);
    }
    else item.spaceId = plan.destinationSpaceId;
  }
  else {
    item.quantity -= plan.quantity;
    if ( mergeTarget ) mergeTarget.quantity += plan.quantity;
    else next.items.push({
      ...clonePlain(item),
      id: plan.newItemId,
      quantity: plan.quantity,
      spaceId: plan.destinationSpaceId,
      containsSpaceIds: []
    });
  }

  return {ok: true, code: INVENTORY_CODES.OK, state: next, committed: plan.operations.map(clonePlain)};
}

/* -------------------------------------------- */

export function calculateSpaceInternalWeight(state, spaceId) {
  const space = state.spaces.find(s => s.id === spaceId);
  if ( !space || space.weightPolicy.mode === INVENTORY_WEIGHT_POLICY.IGNORE ) return 0;
  return state.items.filter(item => item.spaceId === spaceId)
    .reduce((sum, item) => sum + item.weight * item.quantity, 0);
}

export function calculateInventoryWeights(state, actorRef) {
  const actor = normalizeActorRef(actorRef);
  const trace = [];
  let total = 0;

  for ( const space of state.spaces ) {
    const internalWeight = calculateSpaceInternalWeight(state, space.id);
    const contribution = propagatedContribution(space, internalWeight, actor);
    if ( contribution.amount ) total += contribution.amount;
    trace.push({
      spaceId: space.id,
      label: space.label,
      internalWeight,
      propagatedWeight: contribution.amount,
      recipient: contribution.recipient,
      policy: space.weightPolicy.mode
    });
  }

  return {actorId: actor.id, total, trace};
}

/* -------------------------------------------- */

export function inventorySpaceContents(state, spaceId) {
  return state.items.filter(item => item.spaceId === spaceId).map(cloneItem);
}

export function wouldCreateContainmentCycle(state, itemId, destinationSpaceId) {
  return containedSpacesForItem(state, itemId).has(destinationSpaceId);
}

/* -------------------------------------------- */

export function createInventoryDebugSnapshot(state, {actorRef=null}={}) {
  const access = actorRef ? getAccessibleInventorySpaces(actorRef, state) : [];
  const accessBySpace = new Map(access.map(entry => [entry.space.id, entry]));
  const weights = actorRef ? calculateInventoryWeights(state, actorRef) : null;

  return {
    actor: actorRef ? normalizeActorRef(actorRef) : null,
    counts: {
      spaces: state.spaces.length,
      items: state.items.length,
      grants: allAccessGrants(state).length
    },
    spaces: state.spaces.map(space => {
      const spaceAccess = accessBySpace.get(space.id);
      return {
        id: space.id,
        label: space.label,
        host: clonePlain(space.host),
        parentItemId: space.parentItemId,
        weightPolicy: clonePlain(space.weightPolicy),
        capacity: clonePlain(space.capacity ?? {}),
        contents: inventorySpaceContents(state, space.id).map(item => ({
          id: item.id,
          label: item.label,
          quantity: item.quantity,
          weight: item.weight,
          containsSpaceIds: [...item.containsSpaceIds]
        })),
        internalWeight: calculateSpaceInternalWeight(state, space.id),
        accessible: !!spaceAccess,
        accessOperations: spaceAccess?.operations ?? [],
        accessSources: spaceAccess?.sources ?? []
      };
    }),
    access: access.map(entry => ({
      spaceId: entry.space.id,
      operations: [...entry.operations],
      sources: entry.sources.map(clonePlain),
      weightPolicy: clonePlain(entry.weightPolicy)
    })),
    grants: allAccessGrants(state).map(grant => ({
      id: grant.id,
      spaceId: grant.spaceId,
      operations: [...grant.operations],
      active: grant.active,
      source: clonePlain(grant.source),
      sourceItemId: grant.sourceItemId ?? null,
      grantee: grant.grantee ? clonePlain(grant.grantee) : null,
      granteePolicy: grant.granteePolicy ?? null
    })),
    containment: state.items.flatMap(item => item.containsSpaceIds.map(spaceId => ({
      itemId: item.id,
      spaceId
    }))),
    weights
  };
}

/* -------------------------------------------- */

function allAccessGrants(state) {
  return [
    ...(state.accessGrants ?? []),
    ...state.items.flatMap(item => item.accessGrants ?? [])
  ];
}

function evaluateAccessGrant(grant, actor, state, context) {
  if ( !grant.active ) return {ok: false};
  if ( grant.granteePolicy === "holder" || grant.granteePolicy === "carrier" ) {
    const item = state.items.find(i => i.id === grant.sourceItemId);
    if ( !item ) return {ok: false};
    const holder = resolveSpaceHostActor(state, item.spaceId);
    if ( holder !== actor.id ) return {ok: false};
  }
  else if ( grant.grantee?.id && grant.grantee.id !== actor.id ) return {ok: false};

  const predicate = evaluatePredicate(grant.predicate, {actor, grant, ...context});
  return predicate.ok ? {ok: true} : {ok: false, reason: predicate.reason};
}

function addAccess(map, space, grant) {
  if ( !map.has(space.id) ) map.set(space.id, {space, operations: new Set(), sources: []});
  const entry = map.get(space.id);
  for ( const operation of grant.operations ) entry.operations.add(operation);
  entry.sources.push(grant.source ?? {type: "unknown"});
}

function hasOperation(accessList, spaceId, operation) {
  return accessList.some(access => access.space.id === spaceId && access.operations.includes(operation));
}

function validateCapacity(state, destinationSpace, item, quantity) {
  const movedWeight = item.weight * quantity;
  const maxWeight = destinationSpace.capacity?.maxWeight;
  if ( maxWeight != null ) {
    const limit = evaluateValueExpressionNumber(maxWeight, {space: destinationSpace}, Infinity);
    if ( calculateSpaceInternalWeight(state, destinationSpace.id) + movedWeight > limit ) {
      return {ok: false, code: INVENTORY_CODES.CAPACITY_EXCEEDED, reason: "maximum weight exceeded"};
    }
  }
  const maxItems = destinationSpace.capacity?.maxItems;
  if ( maxItems != null ) {
    const limit = evaluateValueExpressionNumber(maxItems, {space: destinationSpace}, Infinity);
    const count = inventorySpaceContents(state, destinationSpace.id).length;
    const mergeTarget = findMergeTarget(state, destinationSpace.id, item);
    if ( !mergeTarget && count + 1 > limit ) return {
      ok: false,
      code: INVENTORY_CODES.CAPACITY_EXCEEDED,
      reason: "maximum item count exceeded"
    };
  }
  return {ok: true};
}

function findMergeTarget(state, destinationSpaceId, item) {
  return state.items.find(candidate => candidate.spaceId === destinationSpaceId
    && candidate.id !== item.id
    && candidate.stackKey
    && candidate.stackKey === item.stackKey
    && !(candidate.containsSpaceIds?.length));
}

function containedSpacesForItem(state, itemId, visited=new Set()) {
  const item = state.items.find(i => i.id === itemId);
  if ( !item ) return visited;
  for ( const spaceId of item.containsSpaceIds ?? [] ) {
    if ( visited.has(spaceId) ) continue;
    visited.add(spaceId);
    for ( const childItem of state.items.filter(i => i.spaceId === spaceId) ) {
      containedSpacesForItem(state, childItem.id, visited);
    }
  }
  return visited;
}

function resolveSpaceHostActor(state, spaceId) {
  const space = state.spaces.find(s => s.id === spaceId);
  if ( !space ) return null;
  if ( space.host?.type === "actor" ) return space.host.id;
  if ( space.parentItemId ) {
    const parentItem = state.items.find(item => item.id === space.parentItemId);
    return parentItem ? resolveSpaceHostActor(state, parentItem.spaceId) : null;
  }
  return null;
}

function propagatedContribution(space, internalWeight, actor) {
  if ( space.weightPolicy.mode !== INVENTORY_WEIGHT_POLICY.TRACK_AND_PROPAGATE ) {
    return {amount: 0, recipient: null};
  }
  const attribution = space.weightPolicy.attribution ?? "hostActor";
  if ( attribution === "hostActor" && space.host?.type === "actor" && space.host.id === actor.id ) {
    return {amount: internalWeight, recipient: {type: "actor", id: actor.id}};
  }
  if ( attribution === "explicitActor" && space.weightPolicy.actorId === actor.id ) {
    return {amount: internalWeight, recipient: {type: "actor", id: actor.id}};
  }
  return {amount: 0, recipient: null};
}

function normalizeWeightPolicy(policy={}) {
  if ( typeof policy === "string" ) return {mode: policy};
  return {mode: policy.mode ?? INVENTORY_WEIGHT_POLICY.TRACK_AND_PROPAGATE, ...clonePlain(policy)};
}

function normalizeActorRef(actorRef) {
  return typeof actorRef === "string" ? {type: "actor", id: actorRef} : clonePlain(actorRef ?? {});
}

function failPlan(code, reason=null) {
  return {ok: false, code, reason, operations: []};
}

function cloneState(state) {
  return createInventoryState(state);
}

function cloneSpace(space) {
  return createInventorySpace(space);
}

function cloneItem(item) {
  return createInventoryItem(item);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

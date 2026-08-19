import {
  calculateInventoryWeights,
  commitInventoryTransfer,
  createInventoryDebugSnapshot,
  createInventoryState,
  getAccessibleInventorySpaces,
  inventorySpaceContents,
  planInventoryTransfer
} from "./inventory.mjs";

/**
 * Pure in-memory repository that defines the persistence boundary future Foundry adapters should
 * implement. Domain helpers work with plain inventory state; repositories own loading, saving,
 * reference resolution, and transactional commit.
 * @param {object} initialState
 * @returns {object}
 */
export function createInMemoryInventoryRepository(initialState={}) {
  let state = createInventoryState(initialState);

  return {
    async loadState() {
      return cloneState(state);
    },

    async saveState(nextState) {
      state = createInventoryState(nextState);
      return cloneState(state);
    },

    async listSpaces() {
      return cloneState(state).spaces;
    },

    async loadSpace(spaceId) {
      return cloneState(state).spaces.find(space => space.id === spaceId) ?? null;
    },

    async listContents(spaceId) {
      return inventorySpaceContents(state, spaceId);
    },

    async getAccessibleSpaces(actorRef, context={}) {
      return getAccessibleInventorySpaces(actorRef, state, context);
    },

    async resolveReference(reference) {
      return resolveInventoryReference(state, reference);
    },

    async planTransfer(request) {
      return planInventoryTransfer({...request, state});
    },

    async commitTransfer(plan) {
      const result = commitInventoryTransfer(state, plan);
      if ( result.ok ) state = createInventoryState(result.state);
      return {...result, state: cloneState(result.state)};
    },

    async transferItem(request) {
      const plan = await this.planTransfer(request);
      if ( !plan.ok ) return {ok: false, code: plan.code, reason: plan.reason ?? null, plan, state: cloneState(state)};
      return this.commitTransfer(plan);
    },

    async calculateWeights(actorRef) {
      return calculateInventoryWeights(state, actorRef);
    },

    async debugSnapshot(options={}) {
      return createInventoryDebugSnapshot(state, options);
    }
  };
}

/* -------------------------------------------- */

export function resolveInventoryReference(state, reference) {
  const ref = typeof reference === "string" ? {id: reference} : reference;
  if ( !ref?.id ) return {ok: false, type: null, value: null};

  if ( ref.type === "space" || ref.type === "inventory-space" ) {
    const space = state.spaces.find(candidate => candidate.id === ref.id);
    return space ? {ok: true, type: "space", value: cloneState({spaces: [space]}).spaces[0]} : notFound("space");
  }

  if ( ref.type === "item" ) {
    const item = state.items.find(candidate => candidate.id === ref.id);
    return item ? {ok: true, type: "item", value: cloneState({items: [item]}).items[0]} : notFound("item");
  }

  const space = state.spaces.find(candidate => candidate.id === ref.id);
  if ( space ) return {ok: true, type: "space", value: cloneState({spaces: [space]}).spaces[0]};
  const item = state.items.find(candidate => candidate.id === ref.id);
  if ( item ) return {ok: true, type: "item", value: cloneState({items: [item]}).items[0]};
  return notFound(ref.type ?? "unknown");
}

function notFound(type) {
  return {ok: false, type, value: null};
}

function cloneState(state) {
  return createInventoryState(state);
}

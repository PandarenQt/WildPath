import {WILDPATH} from "../config.mjs";

export const ACTION_COST_CAPABILITIES = Object.freeze({
  action: "action",
  bonus: "bonus-action",
  reaction: "reaction",
  movement: "movement"
});

/**
 * Compute the full set of resource deltas an Action's `cost` schema would spend, expressed as a
 * plain `{resourceId: amount}` map. Pure function (no Foundry globals) so it is directly
 * testable and reusable outside the `WildPathAction` DataModel wrapper.
 *
 * Zero, negative, and blank-resource entries are silently ignored - rather than throwing - for
 * both built-in and custom costs alike, since a "cost" of nothing is not a valid resource spend.
 * Schema-level `min: 0` constraints prevent negative costs from being persisted in the first
 * place, but this function defensively re-checks in case it is ever called with looser data
 * (e.g. a partial update delta that has not yet round-tripped through the schema).
 * @param {object} cost                     An Action's `system.cost` data.
 * @param {string[]} [builtinResources]     Built-in resource ids to check on `cost` directly.
 * @returns {Record<string, number>}
 */
export function computeActionCostMap(cost, builtinResources=WILDPATH.ACTION_COST_RESOURCES) {
  const deltas = {};

  for ( const id of builtinResources ) {
    const amount = cost?.[id];
    if ( amount > 0 ) deltas[id] = (deltas[id] ?? 0) + amount;
  }

  for ( const {resource, amount} of cost?.custom ?? [] ) {
    if ( !resource || !(amount > 0) ) continue;
    deltas[resource] = (deltas[resource] ?? 0) + amount;
  }

  return deltas;
}

/* -------------------------------------------- */

/**
 * Convert the current Action cost schema into activation requirements for the generic payment
 * resolver. This keeps existing Item data compatible while moving future resolution toward
 * "what the action requires" instead of "which exact Actor field gets decremented".
 * @param {object} cost
 * @param {Record<string, string>} [capabilities]
 * @returns {{allOf: object[]}}
 */
export function computeActivationCost(cost, capabilities=ACTION_COST_CAPABILITIES) {
  const allOf = [];
  for ( const [resource, capability] of Object.entries(capabilities) ) {
    const amount = cost?.[resource];
    if ( amount > 0 ) allOf.push({capability, amount});
  }
  for ( const custom of cost?.custom ?? [] ) {
    if ( !custom.resource || !(custom.amount > 0) ) continue;
    allOf.push({capability: custom.resource, amount: custom.amount});
  }
  return {allOf};
}

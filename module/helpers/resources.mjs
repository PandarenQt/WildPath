/**
 * Pure resource-pool math shared by the Actor data model and unit tests.
 * Contains no Foundry globals (not even the `Math.clamp` runtime polyfill) so it can be
 * exercised directly under Node, independent of a running Foundry client.
 */

/**
 * Clamp a number between a minimum and maximum (inclusive).
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* -------------------------------------------- */

/**
 * Compute a resource pool's derived maximum from its persisted `base`/`bonus` (both
 * user-authored/manual values) plus a freshly-computed `modifierBonus` (the total contributed
 * by Items/ActiveEffects for the current prepare cycle).
 *
 * This is intentionally a pure function rather than an in-place `+=` mutation: Foundry may run
 * `prepareDerivedData()` more than once without an intervening reset of transient properties, so
 * always *recomputing* `max` from scratch - and never accumulating onto a persisted field -
 * keeps the result idempotent no matter how many times preparation runs.
 * @param {{base: number, bonus: number}} pool
 * @param {number} [modifierBonus=0]   The Item/ActiveEffect-derived bonus for this prepare cycle.
 * @returns {number}
 */
export function computeResourceMax(pool, modifierBonus=0) {
  return Math.max((pool.base ?? 0) + (pool.bonus ?? 0) + (modifierBonus ?? 0), 0);
}

/* -------------------------------------------- */

/**
 * Clamp a resource pool's current `value` within [0, max].
 * @param {number} value
 * @param {number} max
 * @returns {number}
 */
export function clampResourceValue(value, max) {
  return clamp(value ?? 0, 0, max);
}

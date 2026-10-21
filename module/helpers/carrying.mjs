/**
 * Carrying (the `encumbrance` world setting, 2026-10-21).
 * - `capacity` (the default, 2024 PHB): a creature carries up to its Might score × 15 lb, times its size's factor.
 *   Carrying more, its Speed is at most 5 feet, as for dragging, lifting or pushing more than that.
 * - `variant` (the 2014 PHB's variant encumbrance): over 5 × Might it is Encumbered (Speed −10 ft); over 10 × Might it
 *   is Heavily Encumbered (Speed −20 ft, and Disadvantage on Might, Agility and Fortitude d20 tests). Over its capacity,
 *   Speed is at most 5 feet too.
 * - `off`: weight is shown, nothing follows.
 * Only characters: a stat block's Speed is its own.
 */

export const CARRYING_MODES = Object.freeze(["capacity", "variant", "off"]);

/** A creature's size factor by its Token's width in grid squares (2024: Tiny half, Large ×2, Huge ×4, Gargantuan ×8). */
export function carryingSizeFactor(width=1) {
  const size = Number(width) || 1;
  return size < 1 ? 0.5 : (size >= 4 ? 8 : ({1: 1, 2: 2, 3: 4}[Math.floor(size)] ?? 1));
}

/** The load a weight is for a creature of `might` and `sizeFactor`: its capacity, and what follows by `mode`. */
export function carryingLoad({weight=0, might=10, sizeFactor=1, mode="capacity"}={}) {
  const capacity = Math.max(Number(might) || 0, 0) * 15 * sizeFactor;
  const carried = Math.max(Number(weight) || 0, 0);
  if ( !CARRYING_MODES.includes(mode) || (mode === "off") ) return {weight: carried, capacity, mode: "off"};
  const over = carried > capacity;
  const step = capacity / 3;
  const level = (mode === "variant") ? ((carried > step * 2) ? 2 : ((carried > step) ? 1 : 0)) : 0;
  return {weight: carried, capacity, mode, over, ...(level ? {encumbered: level} : {})};
}

/** Disadvantage on Might, Agility and Fortitude d20 tests (Heavily Encumbered). */
const HEAVY_DOMAINS = ["attack.might", "attack.agility", "save.might", "save.agility", "save.fortitude", "check.might", "check.agility",
  "check.fortitude"];

/** The rules a load gives its creature: a 5-foot Speed cap over its capacity; the variant's Speed and Disadvantage. */
export function carryingRules(load) {
  if ( !load || (load.mode === "off") ) return [];
  return [
    ...(load.over ? [{schemaVersion: 1, id: "carrying.over-capacity", type: "ResourceCap", data: {resources: ["movement"], maximum: 5}}] : []),
    ...(load.encumbered ? [{schemaVersion: 1, id: "carrying.encumbered", type: "Modifier",
      data: {domains: ["resources.movement.max", "speed"], modifierType: "untyped", value: load.encumbered === 2 ? -20 : -10}}] : []),
    ...((load.encumbered === 2) ? [{schemaVersion: 1, id: "carrying.heavily-encumbered", type: "RollMode",
      data: {domains: HEAVY_DOMAINS, mode: "disadvantage"}}] : [])
  ];
}

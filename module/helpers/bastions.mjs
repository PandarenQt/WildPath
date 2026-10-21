/**
 * Bastion rules (2024 DMG, 2026-10-22): what a character's Bastion may hold, what building costs, what an order yields,
 * and how its map is checked. Pure: applications/bastions.mjs and bastion-map.mjs apply them.
 */

/** A facility's space and the most 5-foot squares it may cover. */
export const FACILITY_SQUARES = Object.freeze({cramped: 4, roomy: 16, vast: 36});

/** Adding a basic facility of a space: [gold, days]. */
export const BUILD_COST = Object.freeze({cramped: [500, 20], roomy: [1000, 45], vast: [3000, 125]});

/** Enlarging a basic facility one space: [gold, days, the space it becomes]. */
export const ENLARGE_COST = Object.freeze({cramped: [500, 25, "roomy"], roomy: [2000, 80, "vast"]});

/** Special facilities a character's Bastion holds by its level (from 5th). */
export function specialSlots(level) {
  const value = Number(level) || 0;
  return value >= 17 ? 6 : value >= 13 ? 5 : value >= 9 ? 4 : value >= 5 ? 2 : 0;
}

/**
 * The Bastion map's size in squares by its character's level (the maintainer let this be WildPath's call): 12 by 12 at
 * 5th, 16 at 9th, 20 at 13th, 24 at 17th.
 */
export function mapSize(level) {
  const value = Number(level) || 0;
  return value >= 17 ? 24 : value >= 13 ? 20 : value >= 9 ? 16 : 12;
}

/**
 * Whether a special facility can join a character's Bastion: its level is reached, and a slot is free. Returns null when
 * it can, else the reason's key and data.
 */
export function canAddSpecial({level=0, facilityLevel=0, specialCount=0}={}) {
  if ( (Number(level) || 0) < 5 ) return {key: "WILDPATH.BASTION.TooYoung", data: {}};
  if ( (Number(facilityLevel) || 0) > (Number(level) || 0) ) return {key: "WILDPATH.BASTION.TooLow", data: {level: facilityLevel}};
  if ( specialCount >= specialSlots(level) ) return {key: "WILDPATH.BASTION.NoSlot", data: {slots: specialSlots(level)}};
  return null;
}

/**
 * A Bastion map's problems: squares outside its grid, or a facility covering more than its space allows. `cells` are
 * `{x, y, facilityId}`; `facilities` map an id to its space.
 */
export function mapProblems(cells=[], {size=12, facilities={}}={}) {
  const problems = [];
  const counts = {};
  const seen = new Set();
  for ( const {x, y, facilityId} of cells ) {
    if ( (x < 0) || (y < 0) || (x >= size) || (y >= size) ) problems.push({key: "WILDPATH.BASTION.MapOutside", data: {x, y}});
    if ( seen.has(`${x},${y}`) ) problems.push({key: "WILDPATH.BASTION.MapOverlap", data: {x, y}});
    seen.add(`${x},${y}`);
    counts[facilityId] = (counts[facilityId] ?? 0) + 1;
  }
  for ( const [id, count] of Object.entries(counts) ) {
    const most = FACILITY_SQUARES[facilities[id]] ?? 0;
    if ( count > most ) problems.push({key: "WILDPATH.BASTION.MapTooBig", data: {id, count, most}});
  }
  return problems;
}

/** A Recruit order: up to 4 more defenders, no more than its facilities house. */
export const recruited = (defenders=0, capacity=0) => Math.max(Math.min(4, (Number(capacity) || 0) - (Number(defenders) || 0)), 0);

/** A Trade order selling its stock: the gold it brings, its stock's value plus its profit. */
export const tradeSale = (stock=0, profit=0) => Math.floor((Number(stock) || 0) * (1 + ((Number(profit) || 0) / 100)));

/** An attack on the Bastion (a Bastion event): of 6d6 (2 fewer for each Armory), each 1 is a defender lost. */
export const defendersLost = results => results.filter(result => Number(result) === 1).length;

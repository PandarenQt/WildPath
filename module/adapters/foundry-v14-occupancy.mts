/**
 * Creatures' spaces in movement (2024 "Moving Around Other Creatures"): a creature may move through an ally's space, and
 * through a hostile creature's only if that creature is Tiny, they are two or more sizes apart, or it can't act
 * (Incapacitated); no creature may willingly end its move in another's space. A creature above or below another (their
 * grid-sized cubes, `footprint.levels`, don't overlap), or on another Scene Level, is not in its way. Forced movement and teleports find a free
 * space of their own (foundry-v14-forced-movement, foundry-v14-teleport). Spaces and sizes are the tactical grid's
 * TokenGridFootprints. Exceptions are Modifiers on a creature:
 * - `occupancy.share`: it shares spaces both ways, ending in one too (a swarm "can occupy another creature's space and vice
 *   versa");
 * - `occupancy.pass`: it moves through any creature (Incorporeal Movement);
 * - `occupancy.pass.larger`: it moves through any larger creature (Halfling Nimbleness);
 * - `occupancy.difficult`: every other creature's space is Difficult Terrain for it, an ally's or a Tiny one's too,
 *   whatever the world setting says (Incorporeal Movement's "as if they were Difficult Terrain").
 */

import {collectionContents} from "../helpers/collections.mjs";
import {CREATURE_SIZE_ORDER, footprintLevels} from "../helpers/grid-footprints.mjs";
import {createFoundryV14TacticalGridAdapter, foundryTokenCreatureSize} from "./foundry-v14-tactical-grid-adapter.mjs";

interface OccupantActor {statuses?: Set<string>; getStatistic?(domains: string[]): {totalModifier?: number} | null}
interface OccupantToken {
  id: string; disposition?: number; elevation?: number; depth?: number; level?: string | null; actor?: OccupantActor | null;
  parent?: OccupantScene | null;
}
interface OccupantScene {tokens?: Iterable<OccupantToken>; grid?: {distance?: number} | null}
interface Levels {bottom: number; top: number}
interface Footprint {fieldKeys?: string[]; levels?: Levels}
interface Occupant {token: OccupantToken; keys: Set<string>; levels: Levels | undefined; size: number; ally: boolean; passable: boolean; shares: boolean}
type StepCost = (step: {toFootprint?: Footprint; defaultAmount?: number; movementKind?: string; transitionIndex?: number;
  path?: {anchors?: unknown[]}} & Record<string, unknown>) => {amount: number; source?: string} | null | undefined;

// The conditions that leave a creature Incapacitated (2024), so it can be moved through.
const INCAPACITATING = ["incapacitated", "stunned", "paralyzed", "petrified", "unconscious"];

const has = (actor: OccupantActor | null | undefined, domain: string) => (Number(actor?.getStatistic?.([domain])?.totalModifier) || 0) > 0;
const sizeOf = (token: OccupantToken) => CREATURE_SIZE_ORDER.indexOf((foundryTokenCreatureSize as (token: unknown) => string)(token) as never);
const overlaps = (a: Levels | undefined, b: Levels | undefined) => !a || !b || ((a.bottom <= b.top) && (b.bottom <= a.top));
const inside = (occupants: Occupant[], footprint: Footprint | undefined, levels: Levels | undefined) => occupants.some(occupant =>
  overlaps(occupant.levels, levels) && (footprint?.fieldKeys ?? []).some(key => occupant.keys.has(key)));

/**
 * The cubes `token` fills at each step of its move, as the tactical grid's footprint.levels: at its own elevation, and at
 * `elevation` (its destination's) on the last step. shortcut: the path's anchors carry no elevation, so a step between
 * keeps the starting one; read each waypoint's when MovementPath anchors carry it.
 */
function moverLevels(token: OccupantToken, elevation: number | null | undefined) {
  const distance = Number(token.parent?.grid?.distance) || 5;
  const at = (feet: number | null | undefined) => ((feet != null) && Number.isFinite(Number(feet)))
    ? footprintLevels(Number(feet), (Number(token.depth) || 1) * distance, distance) as Levels : undefined;
  const start = at(token.elevation);
  const end = at(elevation) ?? start;
  return (step: number, last: number) => (step === last) ? end : start;
}

/** The other living creatures on `token`'s Scene Level: the spaces each fills, and whether `token` may move through it. */
function occupantsAround(token: OccupantToken): Occupant[] {
  const scene = token.parent;
  if ( !scene ) return [];
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const size = sizeOf(token);
  const passAll = has(token.actor, "occupancy.pass");
  const passLarger = has(token.actor, "occupancy.pass.larger");
  // A dead creature is no longer in the way.
  return (collectionContents(scene.tokens) as OccupantToken[]).filter(other => other.actor && (other.id !== token.id) && !other.actor.statuses?.has("dead")
    && ((other.level ?? null) === (token.level ?? null)))
    .flatMap(other => {
      const footprint = (adapter.tokenToFootprint(other) as {footprint?: Footprint}).footprint;
      if ( !footprint?.fieldKeys?.length ) return [];
      const otherSize = sizeOf(other);
      const shares = has(other.actor, "occupancy.share");
      const sides = (token.disposition ?? 0) * (other.disposition ?? 0);
      const passable = (sides >= 0) || passAll || shares || (otherSize === 0) || (Math.abs(size - otherSize) >= 2)
        || (passLarger && (otherSize > size)) || INCAPACITATING.some(status => other.actor!.statuses?.has(status));
      return [{token: other, keys: new Set(footprint.fieldKeys), levels: footprint.levels, size: otherSize, ally: sides > 0,
        passable, shares}];
    });
}

/**
 * The occupancy policy (movement-paths.mjs) of `token`'s voluntary move: a step into a creature's space it may not move
 * through is blocked, and so is the last one into any creature's space. Null when nothing can stop it (no other creature
 * on its Scene, or it shares spaces). `elevation` is where the move ends (its destination's).
 */
export function creatureOccupancyPolicy(token: OccupantToken | null | undefined, {elevation}: {elevation?: number | null} = {}) {
  if ( !token?.actor || has(token.actor, "occupancy.share") ) return null;
  const occupants = occupantsAround(token);
  if ( !occupants.length ) return null;
  const blocking = occupants.filter(occupant => !occupant.passable);
  const taken = occupants.filter(occupant => !occupant.shares);
  const levelsAt = moverLevels(token, elevation);
  return ({footprint, stepIndex, path}: {footprint?: Footprint; stepIndex?: number; path?: {anchors?: unknown[]}}) => {
    // Where it starts is where it already stands.
    if ( !stepIndex ) return null;
    const last = (path?.anchors?.length ?? 0) - 1;
    const levels = levelsAt(stepIndex, last);
    if ( inside(blocking, footprint, levels) ) return {ok: false, reason: "Movement is blocked by a hostile creature's space."};
    if ( (stepIndex === last) && inside(taken, footprint, levels) ) {
      return {ok: false, reason: "Movement can't end in an occupied space."};
    }
    return null;
  };
}

/**
 * `terrain` (the step cost policy of Difficult Terrain) with another creature's space as Difficult Terrain too: with
 * `always` (the world setting), the space of a creature that isn't Tiny or the mover's ally (2024); with the mover's own
 * `occupancy.difficult`, every creature's. Difficult Terrain doesn't stack: a step costs the most either makes it.
 * Freedom of Movement's `terrain.ignore` ignores this terrain as well. `elevation` is where the move ends.
 */
export function creatureSpaceTerrainPolicy(token: OccupantToken | null | undefined, terrain: StepCost | null,
  {always=false, elevation}: {always?: boolean; elevation?: number | null} = {}) {
  const own = has(token?.actor, "occupancy.difficult");
  if ( !token?.actor || !(always || own) || has(token.actor, "terrain.ignore") ) return terrain;
  const occupants = occupantsAround(token).filter(occupant => own || (!occupant.ally && (occupant.size !== 0)));
  if ( !occupants.length ) return terrain;
  const levelsAt = moverLevels(token, elevation);
  return ((step: Parameters<StepCost>[0]) => {
    const other = terrain?.(step) ?? null;
    const levels = levelsAt((step.transitionIndex ?? 0) + 1, (step.path?.anchors?.length ?? 0) - 1);
    if ( ((step.movementKind ?? "voluntary") !== "voluntary") || !inside(occupants, step.toFootprint, levels) ) return other;
    const amount = (Number(step.defaultAmount) || 0) * 2;
    return ((other?.amount ?? 0) >= amount) ? other : {amount, source: "creature-space"};
  }) as StepCost;
}

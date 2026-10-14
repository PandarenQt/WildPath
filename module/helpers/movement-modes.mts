/**
 * Movement modes under the 2024 rules (maintainer decision, 2026-10-14). A creature has a walking Speed and may
 * be granted others (`GrantMovement`). One move is spent across them: whenever it switches mode, what it has
 * already moved this turn is subtracted from the new Speed, so what remains in a mode is that Speed minus the
 * movement spent. Swimming and climbing without their Speed use the walking Speed at double cost, crawling always
 * costs double, and flying or burrowing needs its Speed. Foundry's own actions name the modes.
 */

export const MOVEMENT_MODE_CODES = Object.freeze({NOT_SUPPORTED: "MOVEMENT_MODE_NOT_SUPPORTED"});

interface ModeRule {readonly speed: string; readonly fallback?: string; readonly costMultiplier?: number}
const MODE_RULES: Readonly<Record<string, ModeRule>> = Object.freeze({
  walk: {speed: "walk"},
  jump: {speed: "walk"},
  crawl: {speed: "walk", costMultiplier: 2},
  swim: {speed: "swim", fallback: "walk"},
  climb: {speed: "climb", fallback: "walk"},
  fly: {speed: "fly"},
  burrow: {speed: "burrow"}
});

/** A creature's Speeds: its walking Speed, and the fastest grant for each mode (a walk grant can raise walking). */
export function movementSpeeds(walk: number, grants: readonly {mode?: string; distance?: number}[] = []): Record<string, number> {
  const speeds: Record<string, number> = {walk: Math.max(Number(walk) || 0, 0)};
  for ( const {mode="walk", distance=0} of grants ) speeds[mode] = Math.max(speeds[mode] ?? 0, Number(distance) || 0);
  return speeds;
}

/**
 * What moving in `mode` allows: the Speed that applies and what each foot costs. A mode WildPath does not know
 * (a teleport, a custom action) moves at walking Speed.
 */
export function movementAllowance(mode: string, speeds: Readonly<Record<string, number>>):
  {ok: true; speed: number; costMultiplier: number} | {ok: false; code: string; reason: string} {
  const rule = MODE_RULES[mode] ?? MODE_RULES.walk!;
  const own = speeds[rule.speed] ?? 0;
  if ( own > 0 ) return {ok: true, speed: own, costMultiplier: rule.costMultiplier ?? 1};
  if ( rule.fallback ) return {ok: true, speed: speeds[rule.fallback] ?? 0, costMultiplier: 2};
  if ( rule.speed === "walk" ) return {ok: true, speed: 0, costMultiplier: rule.costMultiplier ?? 1};
  return {ok: false, code: MOVEMENT_MODE_CODES.NOT_SUPPORTED, reason: `This creature has no ${rule.speed} Speed.`};
}

/** Movement left in `mode` after `spent` this turn (in the units Speeds use), or 0 when the mode is not allowed. */
export function remainingMovement(mode: string, speeds: Readonly<Record<string, number>>, spent: number) {
  const allowance = movementAllowance(mode, speeds);
  return allowance.ok ? Math.max(allowance.speed - (Number(spent) || 0), 0) : 0;
}

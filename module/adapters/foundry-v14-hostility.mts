import {combatOf} from "./foundry-v14-creature-tokens.mjs";

/**
 * Who is hostile to whom: the one hostility check the reactions (`toSource.{self}.hostile`, Opportunity Attacks), ally
 * selection (`notHostile`) and the runtime share. A friendly and a hostile (or secret) Token are hostile to each other;
 * a neutral one is hostile to no one until it attacks a creature on a side or a creature on that side attacks it (Q47,
 * 2026-11-16). That is kept for the combat on the Combat holding them (`flags.wildpath.turnedHostile: {<tokenId>:
 * [side, ...]}`, a side being 1 friendly or -1 hostile), written by the GM once the attack completes (recordTurnedHostile),
 * an Action's own reads seeing it from its start (hostileTurns); Token dispositions are
 * not changed, and the record goes with its Combat.
 */

export interface SidedToken {readonly id?: string; readonly disposition?: number; readonly parent?: {id?: string} | null;
  readonly document?: SidedToken}
export interface HostilityCombat {readonly started?: boolean; readonly combatants?: Iterable<{tokenId?: string | null; sceneId?: string | null}> | null;
  readonly flags?: {wildpath?: {turnedHostile?: Record<string, readonly number[]>}};
  setFlag?(scope: string, key: string, value: unknown): Promise<unknown>}
interface HostilityGame {readonly combats?: Iterable<HostilityCombat> | null; readonly user?: {isGM?: boolean} | null}

const placed = (token: SidedToken | null | undefined) => token?.document ?? token ?? null;
/** 1 friendly, -1 hostile or secret, 0 neutral (or no Token). */
const sideOf = (token: SidedToken | null | undefined) => Math.sign(Number(placed(token)?.disposition) || 0);
const gameOf = (game: HostilityGame | null | undefined) => game ?? (globalThis as {game?: HostilityGame}).game ?? null;
/** The Combat holding either Token (the neutral one's first): where its turn to hostility is kept. */
const combatFor = (neutral: SidedToken, other: SidedToken, game: HostilityGame | null) =>
  combatOf(placed(neutral) as never, game as never) as HostilityCombat | null ?? combatOf(placed(other) as never, game as never) as HostilityCombat | null;

/**
 * Whether a lasting area acting on one side (`persistence.affects`) leaves `token` alone, by disposition with its caster's
 * Token as the side. `"enemies"` (Spirit Guardians) spares the caster and creatures of its disposition, so a neutral
 * creature is still affected; `"allies"` ("you and your allies") affects only the caster and creatures of its own
 * non-neutral side (Q110 (a); sideOf, secret with hostile), so a neutral caster's allies are itself. With no caster both spare everyone; with
 * no `affects` no one is spared. Deliberately not the auras' meaning (they leave neutral creatures out of "enemies") nor
 * tokensHostile's turned-hostile record: an area's side is fixed by dispositions.
 */
export function areaSpares(affects: string | null | undefined, caster: SidedToken | null | undefined, token: SidedToken) {
  if ( (affects !== "enemies") && (affects !== "allies") ) return false;
  if ( !caster ) return true;
  if ( placed(caster)?.id === placed(token)?.id ) return affects === "enemies";
  if ( affects === "enemies" ) return placed(caster)?.disposition === placed(token)?.disposition;
  // A secret Token is on the hostile side (sideOf), so a hostile caster's secret ally shares its blessing.
  return !sideOf(caster) || (sideOf(token) !== sideOf(caster));
}

/** A neutral Token (by id) turning hostile to a side, kept on `combat`. */
export interface HostileTurn {readonly id: string; readonly side: number; readonly combat: HostilityCombat}

/**
 * Whether `a` and `b` stand on opposite sides, a neutral one counting once it has turned hostile to the other's side: by
 * its Combat's record, or by `turns` (hostileTurns: the Action being resolved, before its record is written).
 */
export function tokensHostile(a: SidedToken | null | undefined, b: SidedToken | null | undefined, game?: HostilityGame | null,
  turns: readonly HostileTurn[] = []) {
  const [sa, sb] = [sideOf(a), sideOf(b)];
  if ( (sa * sb) !== 0 ) return (sa * sb) < 0;
  if ( (sa === sb) || !a || !b ) return false;
  const [neutral, other, side] = (sa === 0) ? [a, b, sb] : [b, a, sa];
  const id = placed(neutral)?.id;
  return !!id && (turns.some(turn => (turn.id === id) && (turn.side === side))
    || (combatFor(neutral, other, gameOf(game))?.flags?.wildpath?.turnedHostile?.[id] ?? []).includes(side));
}

/**
 * The turns to hostility `source` attacking `targets` makes: a neutral attacker turns hostile to each target's side, and
 * a neutral target to the attacker's, each on the Combat holding them; none outside combat.
 */
export function hostileTurns(source: SidedToken | null | undefined, targets: Iterable<SidedToken | null | undefined>,
  game?: HostilityGame | null): HostileTurn[] {
  const world = gameOf(game);
  const turns: HostileTurn[] = [];
  if ( !source ) return turns;
  for ( const target of targets ) {
    if ( !target || (placed(target)?.id === placed(source)?.id) ) continue;
    const [ss, st] = [sideOf(source), sideOf(target)];
    if ( (ss === 0) === (st === 0) ) continue;
    const [neutral, other, side] = (ss === 0) ? [source, target, st] : [target, source, ss];
    const id = placed(neutral)?.id;
    const combat = combatFor(neutral, other, world);
    if ( id && combat ) turns.push({id, side, combat});
  }
  return turns;
}

/**
 * `source` attacked `targets` (hostileTurns): its turns written on their Combats, by the GM only (a player can't update the
 * Combat). Returns whether anything was written.
 */
export async function recordTurnedHostile(source: SidedToken | null | undefined, targets: Iterable<SidedToken | null | undefined>,
  game?: HostilityGame | null) {
  if ( gameOf(game)?.user?.isGM !== true ) return false;
  const changes = new Map<HostilityCombat, Record<string, number[]>>();
  for ( const {id, side, combat} of hostileTurns(source, targets, game) ) {
    if ( typeof combat.setFlag !== "function" ) continue;
    const record = changes.get(combat) ?? structuredClone(combat.flags?.wildpath?.turnedHostile ?? {}) as Record<string, number[]>;
    if ( (record[id] ?? []).includes(side) ) continue;
    record[id] = [...(record[id] ?? []), side];
    changes.set(combat, record);
  }
  for ( const [combat, record] of changes ) await combat.setFlag!("wildpath", "turnedHostile", record);
  return changes.size > 0;
}

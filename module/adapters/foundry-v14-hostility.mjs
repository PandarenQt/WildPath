import { combatOf } from "./foundry-v14-creature-tokens.mjs";
const placed = (token) => token?.document ?? token ?? null;
/** 1 friendly, -1 hostile or secret, 0 neutral (or no Token). */
const sideOf = (token) => Math.sign(Number(placed(token)?.disposition) || 0);
const gameOf = (game) => game ?? globalThis.game ?? null;
/** The Combat holding either Token (the neutral one's first): where its turn to hostility is kept. */
const combatFor = (neutral, other, game) => combatOf(placed(neutral), game) ?? combatOf(placed(other), game);
/**
 * Whether a lasting area acting on one side (`persistence.affects`) leaves `token` alone, by disposition with its caster's
 * Token as the side. `"enemies"` (Spirit Guardians) spares the caster and creatures of its disposition, so a neutral
 * creature is still affected; `"allies"` ("you and your allies") affects only the caster and creatures of its own
 * non-neutral side (Q110 (a); sideOf, secret with hostile), so a neutral caster's allies are itself. With no caster both spare everyone; with
 * no `affects` no one is spared. Deliberately not the auras' meaning (they leave neutral creatures out of "enemies") nor
 * tokensHostile's turned-hostile record: an area's side is fixed by dispositions.
 */
export function areaSpares(affects, caster, token) {
    if ((affects !== "enemies") && (affects !== "allies"))
        return false;
    if (!caster)
        return true;
    if (placed(caster)?.id === placed(token)?.id)
        return affects === "enemies";
    if (affects === "enemies")
        return placed(caster)?.disposition === placed(token)?.disposition;
    // A secret Token is on the hostile side (sideOf), so a hostile caster's secret ally shares its blessing.
    return !sideOf(caster) || (sideOf(token) !== sideOf(caster));
}
/**
 * Whether `a` and `b` stand on opposite sides, a neutral one counting once it has turned hostile to the other's side: by
 * its Combat's record, or by `turns` (hostileTurns: the Action being resolved, before its record is written).
 */
export function tokensHostile(a, b, game, turns = []) {
    const [sa, sb] = [sideOf(a), sideOf(b)];
    if ((sa * sb) !== 0)
        return (sa * sb) < 0;
    if ((sa === sb) || !a || !b)
        return false;
    const [neutral, other, side] = (sa === 0) ? [a, b, sb] : [b, a, sa];
    const id = placed(neutral)?.id;
    return !!id && (turns.some(turn => (turn.id === id) && (turn.side === side))
        || (combatFor(neutral, other, gameOf(game))?.flags?.wildpath?.turnedHostile?.[id] ?? []).includes(side));
}
/**
 * The turns to hostility `source` attacking `targets` makes: a neutral attacker turns hostile to each target's side, and
 * a neutral target to the attacker's, each on the Combat holding them; none outside combat.
 */
export function hostileTurns(source, targets, game) {
    const world = gameOf(game);
    const turns = [];
    if (!source)
        return turns;
    for (const target of targets) {
        if (!target || (placed(target)?.id === placed(source)?.id))
            continue;
        const [ss, st] = [sideOf(source), sideOf(target)];
        if ((ss === 0) === (st === 0))
            continue;
        const [neutral, other, side] = (ss === 0) ? [source, target, st] : [target, source, ss];
        const id = placed(neutral)?.id;
        const combat = combatFor(neutral, other, world);
        if (id && combat)
            turns.push({ id, side, combat });
    }
    return turns;
}
/**
 * `source` attacked `targets` (hostileTurns): its turns written on their Combats, by the GM only (a player can't update the
 * Combat). Returns whether anything was written.
 */
export async function recordTurnedHostile(source, targets, game) {
    if (gameOf(game)?.user?.isGM !== true)
        return false;
    const changes = new Map();
    for (const { id, side, combat } of hostileTurns(source, targets, game)) {
        if (typeof combat.setFlag !== "function")
            continue;
        const record = changes.get(combat) ?? structuredClone(combat.flags?.wildpath?.turnedHostile ?? {});
        if ((record[id] ?? []).includes(side))
            continue;
        record[id] = [...(record[id] ?? []), side];
        changes.set(combat, record);
    }
    for (const [combat, record] of changes)
        await combat.setFlag("wildpath", "turnedHostile", record);
    return changes.size > 0;
}

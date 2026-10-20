/**
 * The source of a creature's fear (2024 Frightened): its Disadvantage on ability checks and attack rolls counts only
 * "while the source of fear is within line of sight", and it "can't willingly move closer to the source of its fear".
 * Each Frightened effect names its source (effect-sources.mjs); the source's Tokens on the creature's Scene are where
 * that fear comes from. A Command (Flee, Approach) uses the same direction rule.
 */
import { effectsFrom } from "../helpers/effect-sources.mjs";
import { footprintDistance } from "../helpers/grid-footprints.mjs";
import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { coverBetween, foundrySightCollision } from "./foundry-v14-cover.mjs";
/** The statuses that keep a creature from moving one way relative to their source: away from it, or toward it. */
export const DIRECTED_STATUSES = Object.freeze({
    frightened: "away", "commanded-flee": "away", "commanded-approach": "toward"
});
const sourcesOf = effectsFrom;
/**
 * Each status of `token`'s creature that directs it (Frightened), with the Tokens on its Scene that gave it. `known`
 * is false when one such effect's source is not on the Scene (it then can't be measured or seen).
 */
export function directedSources(token) {
    const actor = token?.actor;
    const effects = [...(actor?.effects ?? [])].filter(effect => !effect.disabled && !effect.isSuppressed
        && [...(effect.statuses ?? [])].some(status => status in DIRECTED_STATUSES));
    if (!actor || !effects.length)
        return { sources: [], known: true, statuses: [] };
    const others = [...(token?.parent?.tokens ?? [])].filter(other => other.actor && (other.id !== token.id));
    const sources = [];
    let known = true;
    for (const effect of effects) {
        const givers = others.filter(other => sourcesOf(actor, other.actor).some(entry => entry.id === effect.id));
        if (!givers.length)
            known = false;
        for (const status of [...(effect.statuses ?? [])].filter(id => id in DIRECTED_STATUSES)) {
            for (const giver of givers)
                sources.push({ token: giver, status, rule: DIRECTED_STATUSES[status] });
        }
    }
    return { sources, known, statuses: [...new Set(effects.flatMap(effect => [...(effect.statuses ?? [])]))] };
}
/**
 * What a creature's own rolls' predicates see of its fear: `fearSourceOutOfSight` when it is Frightened and every
 * source of its fear is on its Scene and out of its line of sight (a wall gives it Total Cover). An unknown source, or
 * no walls to test (no canvas), keeps the fear on.
 */
export function fearContext(token) {
    const { sources, known, statuses } = directedSources(token);
    if (!statuses.includes("frightened") || !known)
        return {};
    const fear = sources.filter(source => source.status === "frightened");
    const collides = foundrySightCollision();
    if (!fear.length || !collides)
        return {};
    const outOfSight = fear.every(source => coverBetween({ source: token, target: source.token, collides }) === "total");
    return outOfSight ? { fearSourceOutOfSight: true } : {};
}
/**
 * A movement transition policy for `token` (movement-paths.mjs): a voluntary step that brings it closer to a source of
 * its fear (or of a Command to flee) is refused, as is one taking it farther from what it was Commanded to approach.
 * Null when nothing directs it.
 */
export function directedMovementPolicy(token) {
    const { sources } = directedSources(token);
    const scene = token?.parent;
    if (!sources.length || !scene)
        return null;
    const grid = createFoundryV14TacticalGridAdapter({ scene: scene });
    const placed = sources.flatMap(source => {
        const result = grid.tokenToFootprint(source.token);
        return (result.ok && result.footprint) ? [{ ...source, footprint: result.footprint }] : [];
    });
    const distance = footprintDistance;
    return ({ fromFootprint, toFootprint, movementKind }) => {
        if ((movementKind && (movementKind !== "voluntary")) || !fromFootprint || !toFootprint)
            return { ok: true };
        for (const source of placed) {
            const before = distance(fromFootprint, source.footprint);
            const after = distance(toFootprint, source.footprint);
            if ((source.rule === "away") && (after < before))
                return { ok: false, code: "DIRECTED_MOVEMENT",
                    reason: `It can't willingly move closer to the source of its ${source.status === "frightened" ? "fear" : "Command"}.` };
            if ((source.rule === "toward") && (after > before))
                return { ok: false, code: "DIRECTED_MOVEMENT",
                    reason: "It was Commanded to approach: it can't move away." };
        }
        return { ok: true };
    };
}

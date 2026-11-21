/**
 * Removed from the scene while a status lasts (a status config's `removes: true`: Trapped in a Mirror of Life Trapping).
 * The active GM hides its creature's Tokens and their Combatants, keeping each one's own `hidden` in
 * `flags.wildpath.removed`, and gives it back once none of its statuses removes it. Level-triggered from its statuses, as
 * the token-size adapter is, so two such effects keep it hidden until the last one ends. It reappears beside the creature
 * that gave the effect that ended when that effect's row says `metadata.returns: "source"`, else where it was, or beside
 * that spot when another creature stands there now. Its separation from everyone else is its status's `plane` (planeOf).
 */
import { WILDPATH } from "../config.mjs";
import { effectGiverActor } from "../helpers/effect-sources.mjs";
import { combatantOf, creatureTokens } from "./foundry-v14-creature-tokens.mjs";
import { blink, freeLanding, spaceBeside } from "./foundry-v14-teleport.mjs";
import { sceneCollision } from "./foundry-v14-walls.mjs";
/** Whether one of `actor`'s statuses removes it from the scene (`removes: true` in WILDPATH.CONDITIONS). */
export function removedFromScene(actor) {
    const conditions = WILDPATH.CONDITIONS ?? {};
    return [...(actor?.statuses ?? [])].some(status => conditions[status]?.removes === true);
}
export function createFoundryRemoved({ game, fromUuidSync = globalThis.fromUuidSync }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    /** The Token and each of its Combatants, in any combat. */
    const withCombatants = (token) => [token, ...[...(game.combats ?? [])]
            .map(combat => combatantOf(token, combat)).filter((entry) => Boolean(entry))];
    /** Where `token` reappears as `effect` ends, its top-left there; null to stay where it is. */
    function landing(token, effect) {
        const scene = token.parent;
        if (effect.flags?.wildpath?.conditionEffect?.metadata?.returns === "source") {
            const giver = effectGiverActor(effect, fromUuidSync, game);
            const source = creatureTokens(giver).find(other => other.parent?.id === scene?.id);
            if (source) {
                // On its source's side of any wall (a mirror hung on one), not behind it.
                const collides = sceneCollision(scene);
                const from = source.getCenterPoint();
                const beside = spaceBeside(token, source, position => !collides(from, token.getCenterPoint(position), { type: "move" }));
                if (beside)
                    return beside;
            }
        }
        // shortcut: spaceBeside searches one ring, so with that ring full it stays on the creature standing there; upgrade to a
        // second ring if play shows it.
        return freeLanding(token, { x: token.x, y: token.y }).ok ? null : spaceBeside(token, token);
    }
    /**
     * An effect on a creature arrived, changed or ended: its Tokens are hidden while a status removes it, back after. One
     * after another, as Foundry's hooks don't wait: a shattered mirror's prisoners each land once the one before has (its
     * Token's new place is known only after its update), so two never pick the same space, nor one creature release twice.
     * Whether it is removed is read as the hook fires: an unrelated effect's change queued behind another release must not
     * release it by that effect's row once its Trapped ends meanwhile (losing `returns`); the Trapped hook releases it.
     */
    let queue = Promise.resolve();
    function onEffectChanged(effect) {
        const removed = removedFromScene(effect.parent);
        const run = queue.then(() => settle(effect, removed));
        queue = run.catch(() => undefined);
        return run;
    }
    async function settle(effect, removed) {
        const actor = effect.parent;
        if (!isActiveGM() || !actor?.statuses)
            return;
        for (const token of creatureTokens(actor)) {
            const marked = Boolean(token.flags?.wildpath?.removed);
            if (removed && !marked) {
                for (const document of withCombatants(token)) {
                    if (!document.flags?.wildpath?.removed)
                        await document.update({ hidden: true, "flags.wildpath.removed": { hidden: Boolean(document.hidden) } });
                }
            }
            else if (!removed && marked) {
                // Moved before it is unmarked, so an area it reappears in can tell this from a walk in.
                const point = landing(token, effect);
                if (point)
                    await blink(token, point);
                // A Combatant added while it was hidden copied the Token's hidden with no marker: it gets the Token's own back.
                const tokenBefore = token.flags?.wildpath?.removed;
                for (const document of withCombatants(token)) {
                    const before = document.flags?.wildpath?.removed ?? tokenBefore;
                    if (before)
                        await document.update({ hidden: Boolean(before.hidden), "flags.wildpath.removed": null });
                }
            }
        }
    }
    return { onEffectChanged };
}

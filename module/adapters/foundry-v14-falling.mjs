import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
import { creatureTokens } from "./foundry-v14-creature-tokens.mjs";
import { rolledTargets } from "../helpers/forced-movement.mjs";
import { gmNotice } from "../helpers/gm-notice.mjs";
/** Conditions that make a flying creature fall: Prone, and those that take its Speed to 0. */
export const FALLING_CONDITIONS = Object.freeze(["prone", "grappled", "restrained", "paralyzed", "petrified", "stunned", "unconscious"]);
/** The elevation of the floor of `token`'s Level (0 without Levels): the ground it falls to. */
function floorOf(token) {
    return Number(token.parent?.levels?.get(String(token.level))?.elevation?.bottom) || 0;
}
/** How a fall from `height` feet hurts: `{dice}` d6s (one per full 10 feet, 20 at most). */
export function fallDamageDice(height) {
    return Math.min(20, Math.floor(Math.max(Number(height) || 0, 0) / 10));
}
export function createFoundryFalling({ game, coordinator, resolveAction, logger = console, fromUuid = () => null }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    let sequence = 0;
    /** A condition (an ActiveEffect with statuses) arrived on a creature: each of its Tokens in the air may fall. */
    async function onEffectCreated(effect) {
        if (!isActiveGM() || ![...(effect.statuses ?? [])].some(status => FALLING_CONDITIONS.includes(status)))
            return [];
        const actor = effect.parent;
        if (!actor?.uuid)
            return [];
        const tokens = creatureTokens(actor);
        const fallen = [];
        for (const token of tokens)
            if (await fall(actor, token))
                fallen.push(token);
        return fallen;
    }
    /** Drop `token` to its Level's floor and resolve the fall; false when it is on the floor or can hover. */
    async function fall(actor, token) {
        const floor = floorOf(token);
        const height = (Number(token.elevation) || 0) - floor;
        if ((height <= 0) || (actor.getGrantedMovement?.() ?? []).some(movement => movement.hover))
            return false;
        await token.update({ elevation: floor }, { wildpath: { movementKind: "forced" } });
        await resolveFall(actor, token, height);
        return true;
    }
    /**
     * What a fall of `height` feet does to `actor`, whose Token has already come down: its damage and Prone, as an
     * authority Action (none under 10 feet). The Action's state, or null when nothing was rolled.
     */
    async function resolveFall(actor, token, height) {
        const dice = fallDamageDice(height);
        if (!dice || !token.parent)
            return null;
        const label = game.i18n?.localize?.("WILDPATH.FALLING.Fall") ?? "Falling";
        const self = { actorRef: actor.uuid, tokenId: token.id, sceneId: token.parent.id };
        // 2024: Prone, "unless it avoids taking damage from the fall" (immunity, a reaction that cancels it).
        return runAuthorityAction({ coordinator: coordinator, resolveAction: resolveAction, logger,
            senderUserId: String(game.user?.id), resolutionId: `fall:${actor.uuid}:${++sequence}`, label, actorRef: actor.uuid,
            source: { tokenId: token.id, sceneId: token.parent.id }, target: self,
            definition: { schemaVersion: 1, id: "action:fall", label, costs: { allOf: [] }, tags: ["fall"],
                damage: [{ id: "fall", expression: { type: "dice", number: dice, faces: 6 }, damageType: "bludgeoning" }],
                effects: [{ id: "fall-prone", type: "condition", conditionId: "prone", whenDamaged: true }] } });
    }
    /**
     * An Action with `fall: {feet}` completed: each creature it acts on (`rolledTargets`: with a save, each that failed it;
     * with an attack, each it hit) drops into an opening `feet` deep in its Level's floor (or below where it stands, when
     * that is lower: one already in a pit), as forced movement, and takes that fall (resolveFall). One above the floor
     * falls through the air into it too, so it lands below the floor once, and the Prone it lands with does not drop it
     * again (onEffectCreated). The Tokens that fell.
     */
    async function afterResolution({ state }) {
        const definition = state?.actionDefinition;
        const feet = Number(definition?.fall?.feet) || 0;
        if (!state || !definition?.fall || (feet <= 0) || !isActiveGM())
            return [];
        const source = await fromUuid(String(state.source?.tokenRef ?? ""));
        // The creatures it acts on are on its source's Scene, as a push's are.
        const scene = source?.parent;
        if (!scene) {
            gmNotice("WILDPATH.NOTICE.FallNoToken", {}, undefined, { logger });
            return [];
        }
        const fallen = [];
        for (const target of rolledTargets(state, definition)) {
            const token = scene.tokens.get(String(target?.tokenId ?? ""));
            if (!token?.actor?.uuid)
                continue;
            const elevation = Number(token.elevation) || 0;
            const bottom = Math.min(elevation, floorOf(token)) - feet;
            await token.update({ elevation: bottom }, { wildpath: { movementKind: "forced" } });
            await resolveFall(token.actor, token, elevation - bottom);
            fallen.push(token);
        }
        return fallen;
    }
    return { onEffectCreated, fall, resolveFall, afterResolution };
}

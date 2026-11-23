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
    // The Tokens on their way down, by id: how many drops of each are under way, and the fall Action each one last
    // started. The Prone their own fall gives them (or a second condition arriving at once) is created before the forced
    // move's elevation lands on the Token, so its stale elevation would drop it again; so is the Unconscious its fall's
    // damage gives it (the dying step of that Action's follow-ups, which a fall that paused for a prompt has already
    // returned before). Drops of one Token are counted, so one ending does not lift another's guard.
    const dropping = new Map();
    const fallOf = new Map();
    const records = coordinator;
    /** Whether `token` is still on its way down: dropping, or its fall Action's follow-ups are still being written. */
    function isFalling(token) {
        if (dropping.get(token.id))
            return true;
        const resolutionId = fallOf.get(token.id);
        if (resolutionId && records.getRecord?.(resolutionId)?.followingUp)
            return true;
        fallOf.delete(token.id);
        return false;
    }
    /** Move `token` down to `elevation` as forced movement and resolve its fall of `height` feet (resolveFall). */
    async function drop(actor, token, elevation, height) {
        dropping.set(token.id, (dropping.get(token.id) ?? 0) + 1);
        try {
            await token.update({ elevation }, { wildpath: { movementKind: "forced" } });
            await resolveFall(actor, token, height);
        }
        finally {
            const left = (dropping.get(token.id) ?? 1) - 1;
            if (left)
                dropping.set(token.id, left);
            else
                dropping.delete(token.id);
        }
    }
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
    /** Drop `token` to its Level's floor and resolve the fall; false when it is on the floor, can hover or is falling. */
    async function fall(actor, token) {
        const floor = floorOf(token);
        const height = (Number(token.elevation) || 0) - floor;
        if (isFalling(token) || (height <= 0) || (actor.getGrantedMovement?.() ?? []).some(movement => movement.hover))
            return false;
        await drop(actor, token, floor, height);
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
        const resolutionId = `fall:${actor.uuid}:${++sequence}`;
        fallOf.set(token.id, resolutionId);
        // 2024: Prone, "unless it avoids taking damage from the fall" (immunity, a reaction that cancels it).
        return runAuthorityAction({ coordinator: coordinator, resolveAction: resolveAction, logger,
            senderUserId: String(game.user?.id), resolutionId, label, actorRef: actor.uuid,
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
     * again (onEffectCreated). With no `feet`, the opening is as deep as the area that ran the Action (`parentArea`'s
     * `depth`: a fissure's own trigger), and nothing falls when that area has none. The Tokens that fell.
     */
    async function afterResolution({ state, options }) {
        const definition = state?.actionDefinition;
        const feet = Number(definition?.fall?.feet ?? options?.parentArea?.depth) || 0;
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
            await drop(token.actor, token, bottom, elevation - bottom);
            fallen.push(token);
        }
        return fallen;
    }
    return { onEffectCreated, fall, resolveFall, afterResolution };
}

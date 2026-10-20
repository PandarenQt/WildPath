import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
const run = runAuthorityAction;
export function createFoundryTurnDamage({ game, coordinator, resolveAction, logger = console }) {
    let sequence = 0;
    /**
     * `amount` damage of `damageType` to `actor` (its condition's, `label`), resolved by the authority. False when the
     * creature has no Token on a Scene to resolve it on (its caller then commits the damage itself).
     */
    async function apply(actor, { amount, damageType = null, label = null }) {
        const token = actor.isToken ? (actor.token ?? null) : (actor.getActiveTokens?.(false, true)?.[0] ?? null);
        if (!token?.parent || !(Number(amount) > 0))
            return false;
        const name = label ?? game.i18n?.localize?.("WILDPATH.CONDITIONS.TurnDamage") ?? "Condition damage";
        const self = { actorRef: actor.uuid, tokenId: token.id, sceneId: token.parent.id };
        await run({ coordinator, resolveAction, logger, senderUserId: String(game.user?.id), label: name,
            resolutionId: `turn-damage:${actor.uuid}:${++sequence}`, actorRef: actor.uuid,
            source: { tokenId: token.id, sceneId: token.parent.id }, target: self,
            definition: { schemaVersion: 1, id: "action:condition-damage", label: name, costs: { allOf: [] }, tags: ["condition-damage"],
                range: { type: "self" }, targeting: { type: "self" },
                damage: [{ id: "condition", expression: { type: "constant", value: Number(amount) }, ...(damageType ? { damageType } : {}) }] } });
        return true;
    }
    return { apply };
}

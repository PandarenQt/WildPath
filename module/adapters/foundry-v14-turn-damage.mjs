import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
const run = runAuthorityAction;
export function createFoundryTurnDamage({ game, coordinator, resolveAction, logger = console }) {
    let sequence = 0;
    /**
     * `amount` damage of `damageType` to `actor` (its condition's, `label`), resolved by the authority: on its Token in
     * the combat (`token`), else its own or one on the viewed Scene. Without any, it still resolves on the creature
     * (resistances, rescue and dying; no reactions, which need a position). False only when there is no damage.
     */
    async function apply(actor, { amount, damageType = null, label = null, token: given = null }) {
        if (!(Number(amount) > 0))
            return false;
        const token = [given, actor.isToken ? actor.token : null, actor.getActiveTokens?.(false, true)?.[0]]
            .find(candidate => candidate?.parent) ?? null;
        const name = label ? (game.i18n?.localize?.(label) ?? label) : (game.i18n?.localize?.("WILDPATH.CONDITIONS.TurnDamage") ?? "Condition damage");
        const at = token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {};
        await run({ coordinator, resolveAction, logger, senderUserId: String(game.user?.id), label: name,
            resolutionId: `turn-damage:${actor.uuid}:${++sequence}`, actorRef: actor.uuid,
            source: at, target: { actorRef: actor.uuid, ...at },
            // No range: it is always its own creature's (and a creature with no Token has no position to measure from).
            definition: { schemaVersion: 1, id: "action:condition-damage", label: name, costs: { allOf: [] }, tags: ["condition-damage"],
                targeting: { type: "self" },
                damage: [{ id: "condition", expression: { type: "constant", value: Number(amount) }, ...(damageType ? { damageType } : {}) }] } });
        return true;
    }
    return { apply };
}

import { createActionBarViewModel } from "./ui-view-models.mjs";
import { reactionPolicyOf } from "./automation-events.mjs";
const viewModel = createActionBarViewModel;
const policyOf = reactionPolicyOf;
/** How each reaction setting shows on its toggle. */
const POLICY_VIEWS = {
    ask: { icon: "fa-circle-question", label: "WILDPATH.ACTIONBAR.Policy.Ask" },
    always: { icon: "fa-bolt", label: "WILDPATH.ACTIONBAR.Policy.Always" },
    never: { icon: "fa-ban", label: "WILDPATH.ACTIONBAR.Policy.Never" }
};
// The counters the bar always shows first, in this order; pools follow.
const ECONOMY_ORDER = ["economy.action", "economy.bonus-action", "economy.reaction", "economy.movement"];
const GROUP_LABELS = {
    "action": "WILDPATH.ACTIONBAR.Group.action",
    "bonus-action": "WILDPATH.ACTIONBAR.Group.bonus",
    "reaction": "WILDPATH.ACTIONBAR.Group.reaction"
};
export function actionBarContext({ actor, conditions = [] }) {
    const bar = viewModel({ actor });
    const order = (resource) => {
        const index = ECONOMY_ORDER.indexOf(resource.id);
        return index < 0 ? ECONOMY_ORDER.length : index;
    };
    // Groups list their Actions by ref; the views carry the rest.
    const byRef = new Map(bar.actions.map(action => [action.ref, action]));
    const items = new Map([...(actor.items ?? [])].map(item => [item.id, item]));
    const levels = new Map([...(actor.effects ?? [])].filter(effect => !effect.disabled && effect.system?.type)
        .map(effect => [String(effect.system.type), Number(effect.system.level) || null]));
    return {
        name: actor.name ?? bar.actorName ?? "",
        img: actor.img ?? null,
        resources: [...bar.resources].sort((a, b) => order(a) - order(b)).map(resource => ({ id: resource.id, label: resource.label,
            current: resource.current, maximum: resource.maximum, depleted: resource.depleted })),
        groups: bar.groups.map(group => ({ id: group.id, label: GROUP_LABELS[group.id] ?? group.label,
            actions: group.actions.flatMap(ref => byRef.get(ref) ?? []).map(action => ({ id: action.id, label: action.label,
                img: action.img ?? "icons/svg/sword.svg", enabled: action.enabled, disabledCode: action.disabledCode,
                // A reaction's Always / Ask / Never setting.
                ...(group.id === "reaction" ? { policy: { id: policyOf(items.get(action.id)), ...POLICY_VIEWS[policyOf(items.get(action.id))] } } : {}) })) })),
        conditions: conditions.filter(condition => levels.has(condition.id)).map(condition => ({ id: condition.id,
            name: condition.name, img: condition.img, level: condition.stacking ? levels.get(condition.id) ?? null : null }))
    };
}

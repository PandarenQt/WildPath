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
const signed = (value) => (value < 0 ? `${value}` : `+${value}`);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/**
 * How an Action's odds show: a badge with the chance (a range over several targets), and one tooltip line per target
 * as a lang key with its data. `mode` and `ability` are lang keys too.
 */
export function oddsView(entries = []) {
    if (!entries.length)
        return null;
    const percents = entries.map(entry => Math.round(entry.chance * 100));
    const [low, high] = [Math.min(...percents), Math.max(...percents)];
    return {
        badge: low === high ? `${low}%` : `${low}–${high}%`,
        lines: entries.map((entry, index) => {
            const mode = entry.rollMode === "normal" ? null : `WILDPATH.ODDS.Mode.${entry.rollMode}`;
            if (entry.kind === "attack")
                return { key: "WILDPATH.ODDS.Hit", mode, ability: null,
                    data: { name: entry.name, chance: percents[index], modifier: signed(entry.modifier), defense: entry.defense } };
            const ability = `WILDPATH.ABILITIES.${capitalize(String(entry.ability ?? ""))}`;
            return entry.automatic ? { key: "WILDPATH.ODDS.AlwaysFails", mode: null, ability, data: { name: entry.name } }
                : { key: "WILDPATH.ODDS.Fails", mode, ability,
                    data: { name: entry.name, chance: percents[index], dc: entry.dc, modifier: signed(entry.modifier) } };
        })
    };
}
export function actionBarContext({ actor, conditions = [], odds = {}, common = [] }) {
    const bar = viewModel({ actor });
    const order = (resource) => {
        const index = ECONOMY_ORDER.indexOf(resource.id);
        return index < 0 ? ECONOMY_ORDER.length : index;
    };
    // Groups list their Actions by ref; the views carry the rest.
    const byRef = new Map(bar.actions.map(action => [action.ref, action]));
    const items = new Map([...(actor.items ?? [])].map(item => [item.id, item]));
    const commonById = new Map(common.map(action => [action.id, action]));
    const view = (groupId) => (action) => ({ id: action.id, label: action.label,
        img: action.img ?? "icons/svg/sword.svg", enabled: action.enabled, disabledCode: action.disabledCode,
        odds: oddsView(odds[action.id ?? ""] ?? []),
        // A reaction's Always / Ask / Never setting (a common reaction's is on its own Action).
        ...(action.group === "reaction" ? { policy: { id: policyOf(items.get(action.id) ?? commonById.get(action.id ?? "")),
                ...POLICY_VIEWS[policyOf(items.get(action.id) ?? commonById.get(action.id ?? ""))] } } : {}) });
    // The actions every creature has come last, in their own group (Baldur's Gate 3's common actions).
    const commonActions = common.length ? viewModel({ actor, actions: common }).actions : [];
    const levels = new Map([...(actor.effects ?? [])].filter(effect => !effect.disabled && effect.system?.type)
        .map(effect => [String(effect.system.type), Number(effect.system.level) || null]));
    return {
        name: actor.name ?? bar.actorName ?? "",
        img: actor.img ?? null,
        resources: [...bar.resources].sort((a, b) => order(a) - order(b)).map(resource => ({ id: resource.id, label: resource.label,
            current: resource.current, maximum: resource.maximum, depleted: resource.depleted })),
        groups: [...bar.groups.map(group => ({ id: group.id, label: GROUP_LABELS[group.id] ?? group.label,
                actions: group.actions.flatMap(ref => byRef.get(ref) ?? []).map(view(group.id)) })),
            ...(commonActions.length ? [{ id: "common", label: "WILDPATH.ACTIONBAR.Group.common", actions: commonActions.map(view("common")) }] : [])],
        conditions: conditions.filter(condition => levels.has(condition.id)).map(condition => ({ id: condition.id,
            name: condition.name, img: condition.img, level: condition.stacking ? levels.get(condition.id) ?? null : null }))
    };
}

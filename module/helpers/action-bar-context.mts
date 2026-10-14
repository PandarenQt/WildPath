import {createActionBarViewModel} from "./ui-view-models.mjs";
import {reactionPolicyOf} from "./automation-events.mjs";

/**
 * What the in-play action bar shows for one creature (M6): its action-economy counters and pools, its Actions
 * grouped by what they cost (each ready or not, with why), and its active conditions. Availability is the
 * same payment discovery the authority uses, so the bar never decides a rule itself.
 */

type Data = Record<string, unknown>;
interface ResourceView {id: string; category: string; label: string; current: number; maximum: number; depleted: boolean}
interface ActionView {id: string | null; ref: string; label: string; img: string | null; enabled: boolean; group: string;
  disabledCode: string | null}
interface GroupView {id: string; label: string; actions: string[]}
interface BarView {actorName: string | null; resources: ResourceView[]; actions: ActionView[]; groups: GroupView[]}
interface ConditionDefinition {id: string; name: string; img: string; stacking?: boolean}
interface BarActor {
  name?: string; img?: string; items?: Iterable<{id?: string | null; flags?: Data}>;
  effects?: Iterable<{system?: {type?: string; level?: number}; disabled?: boolean}>;
  system?: Data;
}

const viewModel = createActionBarViewModel as unknown as (options: {actor: BarActor}) => BarView;
const policyOf = reactionPolicyOf as (item: unknown) => "ask" | "always" | "never";
/** How each reaction setting shows on its toggle. */
const POLICY_VIEWS = {
  ask: {icon: "fa-circle-question", label: "WILDPATH.ACTIONBAR.Policy.Ask"},
  always: {icon: "fa-bolt", label: "WILDPATH.ACTIONBAR.Policy.Always"},
  never: {icon: "fa-ban", label: "WILDPATH.ACTIONBAR.Policy.Never"}
};
// The counters the bar always shows first, in this order; pools follow.
const ECONOMY_ORDER = ["economy.action", "economy.bonus-action", "economy.reaction", "economy.movement"];
const GROUP_LABELS: Record<string, string> = {
  "action": "WILDPATH.ACTIONBAR.Group.action",
  "bonus-action": "WILDPATH.ACTIONBAR.Group.bonus",
  "reaction": "WILDPATH.ACTIONBAR.Group.reaction"
};

export function actionBarContext({actor, conditions=[]}: {actor: BarActor; conditions?: readonly ConditionDefinition[]}) {
  const bar = viewModel({actor});
  const order = (resource: ResourceView) => {
    const index = ECONOMY_ORDER.indexOf(resource.id);
    return index < 0 ? ECONOMY_ORDER.length : index;
  };
  // Groups list their Actions by ref; the views carry the rest.
  const byRef = new Map(bar.actions.map(action => [action.ref, action]));
  const items = new Map([...(actor.items ?? [])].map(item => [item.id, item]));
  const levels = new Map([...(actor.effects ?? [])].filter(effect => !effect.disabled && effect.system?.type)
    .map(effect => [String(effect.system!.type), Number(effect.system!.level) || null]));
  return {
    name: actor.name ?? bar.actorName ?? "",
    img: actor.img ?? null,
    resources: [...bar.resources].sort((a, b) => order(a) - order(b)).map(resource => ({id: resource.id, label: resource.label,
      current: resource.current, maximum: resource.maximum, depleted: resource.depleted})),
    groups: bar.groups.map(group => ({id: group.id, label: GROUP_LABELS[group.id] ?? group.label,
      actions: group.actions.flatMap(ref => byRef.get(ref) ?? []).map(action => ({id: action.id, label: action.label,
        img: action.img ?? "icons/svg/sword.svg", enabled: action.enabled, disabledCode: action.disabledCode,
        // A reaction's Always / Ask / Never setting.
        ...(group.id === "reaction" ? {policy: {id: policyOf(items.get(action.id)), ...POLICY_VIEWS[policyOf(items.get(action.id))]}} : {})}))})),
    conditions: conditions.filter(condition => levels.has(condition.id)).map(condition => ({id: condition.id,
      name: condition.name, img: condition.img, level: condition.stacking ? levels.get(condition.id) ?? null : null}))
  };
}

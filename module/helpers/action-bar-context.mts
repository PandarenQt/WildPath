import {createActionBarViewModel} from "./ui-view-models.mjs";
import {reactionPolicyOf} from "./automation-events.mjs";
import {activeEffectViews} from "./effect-views.mjs";

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
/** The odds of an Action against one target (`foundryActionOdds`). */
export interface OddsEntry {name: string; kind: "attack" | "save"; chance: number; modifier: number; rollMode: string;
  defense?: number; dc?: number; ability?: string | null; automatic?: boolean}
interface BarActor {
  name?: string; img?: string; items?: Iterable<{id?: string | null; flags?: Data}>;
  effects?: Iterable<{system?: {type?: string; level?: number}; disabled?: boolean}>;
  system?: Data;
  flags?: Data;
}

const viewModel = createActionBarViewModel as unknown as (options: {actor: BarActor; actions?: readonly unknown[]}) => BarView;
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

const signed = (value: number) => (value < 0 ? `${value}` : `+${value}`);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * How an Action's odds show: a badge with the chance (a range over several targets), and one tooltip line per target
 * as a lang key with its data. `mode` and `ability` are lang keys too.
 */
export function oddsView(entries: readonly OddsEntry[] = []) {
  if ( !entries.length ) return null;
  const percents = entries.map(entry => Math.round(entry.chance * 100));
  const [low, high] = [Math.min(...percents), Math.max(...percents)];
  return {
    badge: low === high ? `${low}%` : `${low}–${high}%`,
    lines: entries.map((entry, index) => {
      const mode = entry.rollMode === "normal" ? null : `WILDPATH.ODDS.Mode.${entry.rollMode}`;
      if ( entry.kind === "attack" ) return {key: "WILDPATH.ODDS.Hit", mode, ability: null,
        data: {name: entry.name, chance: percents[index], modifier: signed(entry.modifier), defense: entry.defense}};
      const ability = `WILDPATH.ABILITIES.${capitalize(String(entry.ability ?? ""))}`;
      return entry.automatic ? {key: "WILDPATH.ODDS.AlwaysFails", mode: null, ability, data: {name: entry.name}}
        : {key: "WILDPATH.ODDS.Fails", mode, ability,
          data: {name: entry.name, chance: percents[index], dc: entry.dc, modifier: signed(entry.modifier)}};
    })
  };
}

/** A creature's Legendary Resistance setting (Ask by default), as its toggle shows it. */
function legendaryPolicy(actor: BarActor) {
  const policies = (actor.flags?.wildpath as {commonPolicies?: Data} | undefined)?.commonPolicies;
  const id = policyOf({flags: {wildpath: {reactionPolicy: policies?.["legendary-resistance"]}}});
  return {id, ...POLICY_VIEWS[id]};
}

export function actionBarContext({actor, conditions=[], odds={}, common=[]}: {actor: BarActor; conditions?: readonly ConditionDefinition[];
  odds?: Record<string, readonly OddsEntry[]>; common?: readonly {id: string}[]}) {
  const bar = viewModel({actor});
  const order = (resource: ResourceView) => {
    const index = ECONOMY_ORDER.indexOf(resource.id);
    return index < 0 ? ECONOMY_ORDER.length : index;
  };
  // Groups list their Actions by ref; the views carry the rest.
  const byRef = new Map(bar.actions.map(action => [action.ref, action]));
  const items = new Map([...(actor.items ?? [])].map(item => [item.id, item]));
  const commonById = new Map(common.map(action => [action.id, action]));
  const view = (groupId: string) => (action: ActionView) => ({id: action.id, label: action.label,
    img: action.img ?? "icons/svg/sword.svg", enabled: action.enabled, disabledCode: action.disabledCode,
    odds: oddsView(odds[action.id ?? ""] ?? []),
    // A reaction's Always / Ask / Never setting (a common reaction's is on its own Action).
    ...(action.group === "reaction" ? {policy: {id: policyOf(items.get(action.id) ?? commonById.get(action.id ?? "")),
      ...POLICY_VIEWS[policyOf(items.get(action.id) ?? commonById.get(action.id ?? ""))]}} : {})});
  // The actions every creature has come last, in their own group (Baldur's Gate 3's common actions).
  const commonActions = common.length ? viewModel({actor, actions: common}).actions : [];
  return {
    name: actor.name ?? bar.actorName ?? "",
    img: actor.img ?? null,
    resources: [...bar.resources].sort((a, b) => order(a) - order(b)).map(resource => ({id: resource.id, label: resource.label,
      current: resource.current, maximum: resource.maximum, depleted: resource.depleted,
      // Legendary Resistance has a setting like a reaction's: the creature's own, as a common reaction's is.
      ...(resource.id === "legendary-resistance" ? {policy: legendaryPolicy(actor)} : {})})),
    groups: [...bar.groups.map(group => ({id: group.id, label: GROUP_LABELS[group.id] ?? group.label,
      actions: group.actions.flatMap(ref => byRef.get(ref) ?? []).map(view(group.id))})),
    ...(commonActions.length ? [{id: "common", label: "WILDPATH.ACTIONBAR.Group.common", actions: commonActions.map(view("common"))}] : [])],
    conditions: activeEffectViews(actor.effects ?? [], conditions)
  };
}

import {createActionBarViewModel} from "./ui-view-models.mjs";
import {reactionPolicyOf} from "./automation-events.mjs";
import {activeEffectViews} from "./effect-views.mjs";
import {discoverActionConfigurationChoices} from "./action-configuration.mjs";
import {actionDefinitionFromAction} from "./action-definitions.mjs";
import {isUnprepared} from "./spellcasting.mjs";
import {evaluatePredicate} from "./predicates.mjs";

/**
 * What the in-play action bar shows for one creature (M6): its action-economy counters and pools, its Actions
 * grouped by what they cost (each ready or not, with why), and its active conditions. Availability is the
 * same payment discovery the authority uses, so the bar never decides a rule itself.
 */

type Data = Record<string, unknown>;
interface ResourceView {id: string; category: string; label: string; current: number; maximum: number; depleted: boolean}
interface ActionView {id: string | null; ref: string; label: string; img: string | null; enabled: boolean; group: string;
  disabledCode: string | null; payment?: {failures?: Array<{resourceId?: string | null; code?: string | null}>}}
interface GroupView {id: string; label: string; actions: string[]}
interface BarView {actorName: string | null; resources: ResourceView[]; actions: ActionView[]; groups: GroupView[]}
interface ConditionDefinition {id: string; name: string; img: string; stacking?: boolean}
/** The odds of an Action against one target (`foundryActionOdds`). */
export interface OddsEntry {name: string; kind: "attack" | "save"; chance: number; modifier: number; rollMode: string;
  defense?: number; dc?: number; ability?: string | null; automatic?: boolean}
interface BarActor {
  name?: string; img?: string; items?: Iterable<{id?: string | null; name?: string; flags?: Data; system?: {active?: boolean; attunement?: string}}>;
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
  "reaction": "WILDPATH.ACTIONBAR.Group.reaction",
  "items": "WILDPATH.ACTIONBAR.Group.items",
  "spell-0": "WILDPATH.ACTIONBAR.Group.SpellsCantrips", "spell-1": "WILDPATH.ACTIONBAR.Group.SpellsFirst",
  "spell-2": "WILDPATH.ACTIONBAR.Group.SpellsSecond", "spell-3": "WILDPATH.ACTIONBAR.Group.SpellsThird",
  "spell-4": "WILDPATH.ACTIONBAR.Group.SpellsFourth", "spell-5": "WILDPATH.ACTIONBAR.Group.SpellsFifth",
  "spell-6": "WILDPATH.ACTIONBAR.Group.SpellsSixth", "spell-7": "WILDPATH.ACTIONBAR.Group.SpellsSeventh",
  "spell-8": "WILDPATH.ACTIONBAR.Group.SpellsEighth", "spell-9": "WILDPATH.ACTIONBAR.Group.SpellsNinth"
};
/** After the Actions by cost: spells by level, then magic items' Actions (Baldur's Gate 3's bar). */
const EXTRA_GROUPS = [...Array.from({length: 10}, (_, level) => `spell-${level}`), "items"];
const definitionOf = actionDefinitionFromAction as (item: unknown, options: Data) => {ok: boolean; definition?: Data | null};
const discover = discoverActionConfigurationChoices as (options: Data) => {ok: boolean; requests?: Array<{id: string; type: string;
  options?: Array<{id: string; label?: string; paymentOptionId?: string; metadata?: {castingLevel?: number}}>}>};

/** A spell's level on the bar: 0 for a cantrip, else the lowest slot it can use; null for anything else. */
function spellLevel(definition: Data | null | undefined): number | null {
  if ( !(definition?.tags as string[] | undefined)?.includes("spell") ) return null;
  // Foundry stores `{"spell-slot.3": 3}` as `{"spell-slot": {"3": 3}}`; both shapes count.
  const levels = ((definition?.configuration as Array<{levelByResourceId?: Data}> | undefined) ?? []).flatMap(choice =>
    Object.values(choice.levelByResourceId ?? {}).flatMap(value => (value && (typeof value === "object") ? Object.values(value) : [value])))
    .map(Number).filter(Number.isFinite);
  return levels.length ? Math.min(...levels) : 0;
}

/** The slots a spell can be cast with now, when the slot is its only choice: a button for each, by level. */
function slotButtons(item: unknown, actorSystem: unknown) {
  const definition = definitionOf(item, {actorSystem}).definition;
  if ( !definition ) return null;
  const discovery = discover({definition, actorSystem});
  const [request, ...others] = discovery.ok ? discovery.requests ?? [] : [];
  if ( !request || others.length || (request.type !== "resource") || !request.options?.length ) return null;
  return request.options.map(option => ({choiceId: request.id, optionId: option.paymentOptionId ?? option.id,
    level: option.metadata?.castingLevel ?? null, label: option.label ?? option.id}));
}

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
  // A magic item's Action needs its item equipped and, when it needs attunement, attuned (as the authority checks).
  const sourceItem = (action: ActionView) => items.get(String((items.get(action.id ?? "")?.flags?.wildpath as Data | undefined)?.grantedBy ?? ""));
  const itemReady = (action: ActionView) => {
    const source = sourceItem(action);
    return !source || ((source.system?.active !== false) && (source.system?.attunement !== "required"));
  };
  // What its definition requires of the creature (`requires`: Steady Aim, not moved this turn), as the authority checks.
  const requiresMet = (action: ActionView) => {
    const requires = rawDefinition(action)?.requires;
    return !requires || (evaluatePredicate as (predicate: unknown, context: Data) => {ok: boolean})(requires,
      {actorSystem: actor.system, tags: rawDefinition(action)?.tags ?? []}).ok;
  };
  const ready = (action: ActionView) => itemReady(action) && requiresMet(action);
  const resourceLabels = new Map(bar.resources.map(resource => [resource.id, resource.label]));
  // Why it is not available, in words: its item is not ready, or what has run out ("no 3rd-level slot left").
  const reason = (action: ActionView) => {
    if ( !itemReady(action) ) return {key: "WILDPATH.ACTIONBAR.Reason.ItemNotReady", name: sourceItem(action)?.name ?? ""};
    if ( !requiresMet(action) ) return {key: "WILDPATH.ACTIONBAR.Reason.Requires", name: ""};
    const spent = [...new Set((action.payment?.failures ?? []).filter(failure => failure.code === "INSUFFICIENT_RESOURCE")
      .map(failure => resourceLabels.get(String(failure.resourceId)) ?? String(failure.resourceId)))];
    return spent.length ? {key: "WILDPATH.ACTIONBAR.Reason.Spent", name: spent.join(", ")} : {key: "WILDPATH.ACTIONBAR.Unavailable", name: ""};
  };
  const rawDefinition = (action: ActionView) => (items.get(action.id ?? "") as {system?: {definition?: Data}} | undefined)?.system?.definition;
  // Spells go by level and magic items' Actions together (Baldur's Gate 3); reactions stay with reactions.
  const placeOf = (groupId: string, action: ActionView) => {
    if ( groupId === "reaction" ) return groupId;
    if ( sourceItem(action) ) return "items";
    const level = spellLevel(rawDefinition(action));
    return level === null ? groupId : `spell-${level}`;
  };
  const view = (groupId: string) => (action: ActionView) => ({id: action.id, label: action.label,
    img: action.img ?? "icons/svg/sword.svg", enabled: action.enabled && ready(action),
    disabledCode: itemReady(action) ? (requiresMet(action) ? action.disabledCode : "REQUIRES_NOT_MET") : "ITEM_NOT_READY",
    ...((action.enabled && ready(action)) ? {} : {reason: reason(action)}),
    odds: oddsView(odds[action.id ?? ""] ?? []),
    // A spell whose only choice is its slot: one button per slot level it can use now.
    ...(((spellLevel(rawDefinition(action)) ?? 0) > 0) && action.enabled ? {slots: slotButtons(items.get(action.id ?? ""), actor.system)} : {}),
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
    groups: [...[...bar.groups.map(group => group.id), ...EXTRA_GROUPS].flatMap(groupId => {
      // An unprepared spell is not on the bar (Baldur's Gate 3); the sheet prepares it.
      const actions = bar.groups.flatMap(group => group.actions.flatMap(ref => byRef.get(ref) ?? [])
        .filter(action => (placeOf(group.id, action) === groupId) && !isUnprepared(items.get(action.id ?? "") as never)));
      const label = GROUP_LABELS[groupId] ?? bar.groups.find(group => group.id === groupId)?.label ?? groupId;
      return actions.length ? [{id: groupId, label, actions: actions.map(view(groupId))}] : [];
    }),
    ...(commonActions.length ? [{id: "common", label: "WILDPATH.ACTIONBAR.Group.common", actions: commonActions.map(view("common"))}] : [])],
    conditions: activeEffectViews(actor.effects ?? [], conditions)
  };
}

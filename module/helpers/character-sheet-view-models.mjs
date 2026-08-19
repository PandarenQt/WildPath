import {createActionBarViewModel} from "./ui-view-models.mjs";
import {actorRef, itemRef, normalizeEntityRef, uuidRef} from "./entity-refs.mjs";

export const CHARACTER_SHEET_SECTIONS = Object.freeze([
  {id: "overview", label: "Overview"},
  {id: "actions", label: "Actions"},
  {id: "inventory", label: "Inventory"},
  {id: "effects", label: "Effects"},
  {id: "biography", label: "Biography"}
]);

/* -------------------------------------------- */

export function createActorSheetViewModel({
  actor={},
  system=null,
  items=null,
  effects=null,
  statuses=null,
  abilityLabels={},
  resourceLabels={},
  conditionDefinitions=[]
}={}) {
  const actorSystem = system ?? actor.system ?? {};
  const actorModel = normalizeActor(actor);
  const itemEntries = collectionContents(items ?? actor.items).map(normalizeItemEntry);
  const effectEntries = collectionContents(effects ?? actor.effects).map(normalizeEffectEntry);
  const conditionEntries = normalizeConditions(conditionDefinitions, statuses ?? actor.statuses);
  const groupedItems = groupItems(itemEntries);
  const actionBar = createActionBarViewModel({
    actor: {...actorModel, system: actorSystem},
    actorSystem,
    actions: groupedItems.action
  });
  const actionById = new Map(actionBar.actions.map(entry => [entry.id, entry]));
  const actionItems = groupedItems.action.map(item => ({
    ...item,
    availability: summarizeActionAvailability(actionById.get(item.id))
  }));

  const summary = {
    actionCount: actionItems.length,
    featureCount: groupedItems.feature.length,
    gearCount: groupedItems.gear.length,
    otherItemCount: groupedItems.other.length,
    effectCount: effectEntries.length,
    activeConditionCount: conditionEntries.filter(condition => condition.active).length
  };

  return {
    actor: actorModel,
    system: actorSystem,
    header: createHeaderView(actorModel, actorSystem, summary),
    sections: CHARACTER_SHEET_SECTIONS.map(section => ({...section, anchor: `wildpath-${actorModel.id}-${section.id}`})),
    abilities: normalizeAbilities(actorSystem.abilities, abilityLabels),
    resources: normalizeResources(actorSystem.resources, resourceLabels),
    pools: normalizePools(actorSystem.pools),
    items: itemEntries,
    actionItems,
    featureItems: groupedItems.feature,
    gearItems: groupedItems.gear,
    otherItems: groupedItems.other,
    effects: effectEntries,
    conditions: conditionEntries,
    actionBar,
    summary
  };
}

/* -------------------------------------------- */

function normalizeActor(actor) {
  const id = actor?.id ?? actor?.uuid ?? "actor";
  return {
    id: String(id),
    ref: normalizeEntityRef(actor) ?? actorRef(id),
    uuid: actor?.uuid ?? null,
    type: actor?.type ?? "actor",
    name: actor?.name ?? "",
    img: actor?.img ?? "icons/svg/mystery-man.svg"
  };
}

function createHeaderView(actor, system, summary) {
  const health = system?.resources?.health ?? null;
  const movement = system?.resources?.movement ?? null;
  return {
    actorRef: actor.ref,
    name: actor.name,
    img: actor.img,
    type: actor.type,
    health: health ? normalizeResourceSummary("health", health) : null,
    movement: movement ? normalizeResourceSummary("movement", movement) : null,
    activeConditionCount: summary.activeConditionCount,
    effectCount: summary.effectCount
  };
}

function normalizeAbilities(abilities={}, labels={}) {
  return Object.entries(abilities ?? {}).map(([key, ability]) => ({
    key,
    value: Number(ability?.value ?? 0) || 0,
    modifier: Math.floor(((Number(ability?.value ?? 0) || 0) - 10) / 2),
    label: labels[key]?.label ?? labels[key] ?? key
  }));
}

function normalizeResources(resources={}, labels={}) {
  return Object.entries(resources ?? {}).map(([key, resource]) => ({
    key,
    ...resource,
    label: labels[key]?.label ?? labels[key] ?? key,
    ratio: resource?.max > 0 ? (Number(resource.value ?? 0) || 0) / resource.max : 0
  }));
}

function normalizePools(pools=[]) {
  return (pools ?? []).map((pool, index) => ({
    ...pool,
    index,
    ratio: pool?.max > 0 ? (Number(pool.value ?? 0) || 0) / pool.max : 0
  }));
}

function normalizeResourceSummary(key, resource) {
  return {
    key,
    value: Number(resource.value ?? 0) || 0,
    max: Number(resource.max ?? 0) || 0,
    label: key
  };
}

function normalizeItemEntry(item) {
  const id = item?.id ?? item?.uuid ?? item?.name ?? "item";
  const uuid = item?.uuid ?? null;
  return {
    id: String(id),
    ref: uuid ? uuidRef(uuid) : itemRef(id),
    uuid,
    type: item?.type ?? "item",
    name: item?.name ?? "Unnamed Item",
    img: item?.img ?? "icons/svg/item-bag.svg",
    sort: Number(item?.sort ?? 0) || 0,
    tags: [...(item?.tags ?? item?.system?.tags ?? [])],
    activationCost: clonePlain(item?.system?.getActivationCost?.() ?? item?.activationCost ?? item?.system?.activationCost ?? null),
    cost: clonePlain(item?.cost ?? item?.system?.cost ?? null)
  };
}

function normalizeEffectEntry(effect) {
  const id = effect?.id ?? effect?.uuid ?? effect?.name ?? "effect";
  return {
    id: String(id),
    ref: effect?.uuid ? uuidRef(effect.uuid) : null,
    uuid: effect?.uuid ?? null,
    name: effect?.name ?? "Effect",
    img: effect?.img ?? "icons/svg/aura.svg",
    disabled: !!effect?.disabled,
    suppressed: !!effect?.isSuppressed,
    sourceName: effect?.sourceName ?? effect?.origin ?? null
  };
}

function normalizeConditions(conditionDefinitions, statuses) {
  return (conditionDefinitions ?? []).map(condition => ({
    ...condition,
    active: hasStatus(statuses, condition.id)
  }));
}

function groupItems(items) {
  const grouped = {action: [], feature: [], gear: [], other: []};
  for ( const item of [...items].sort(compareItems) ) {
    if ( item.type === "action" ) grouped.action.push(item);
    else if ( item.type === "feature" ) grouped.feature.push(item);
    else if ( item.type === "gear" ) grouped.gear.push(item);
    else grouped.other.push(item);
  }
  return grouped;
}

function summarizeActionAvailability(action) {
  if ( !action ) return null;
  return {
    enabled: action.enabled,
    state: action.state,
    code: action.disabledCode ?? action.payment?.code ?? null,
    defaultPaymentOptionId: action.payment?.defaultOptionId ?? null,
    reason: action.enabled ? "Available" : labelFromCode(action.disabledCode ?? action.payment?.code)
  };
}

function compareItems(a, b) {
  const sort = a.sort - b.sort;
  if ( sort ) return sort;
  return a.name.localeCompare(b.name);
}

function hasStatus(statuses, id) {
  if ( !id || !statuses ) return false;
  if ( typeof statuses.has === "function" ) return statuses.has(id);
  if ( Array.isArray(statuses) ) return statuses.includes(id);
  return !!statuses[id];
}

function collectionContents(collection) {
  if ( !collection ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( Array.isArray(collection.contents) ) return collection.contents;
  if ( typeof collection.values === "function" ) return [...collection.values()];
  return [];
}

function labelFromCode(code) {
  if ( !code ) return null;
  return String(code).toLowerCase().split("_").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}

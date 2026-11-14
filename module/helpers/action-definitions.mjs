import {normalizeActivationCost} from "./action-economy.mjs";
import {computeActivationCost} from "./actions.mjs";
import {evaluatePredicate, PREDICATE_CODES} from "./predicates.mjs";
import {evaluateValueExpression, selectTableRows} from "./value-expressions.mjs";
import {
  DEFAULT_RULE_ELEMENT_REGISTRY,
  RULE_ELEMENT_CODES,
  serializeRuleElementDefinition,
  validateRuleElementDefinition
} from "./rule-elements.mjs";
import {WILDPATH} from "../config.mjs";
import {simpleFormulaBounds} from "./rolls.mjs";
import {withWeaponMastery} from "./weapon-mastery.mjs";
import {withMetamagic} from "./metamagic.mjs";
import {fitsSpellChoice, spellBaseLevel, spellChoiceMark, spellChoicePool, spellChoices} from "./spellcasting.mjs";

/**
 * When a custom effect ends early: its creature is attacked, attacked by the creature that applied it, or attacks; or it
 * saves (`saves`), or saves against that creature's Action (`savedBySource`: Eldritch Strike).
 */
export const CUSTOM_EFFECT_ENDS_WHEN = Object.freeze(["attacked", "attackedBySource", "attackedByOther", "attackedByAllyOfSource", "attacks",
  "hits", "saves", "savedBySource", "checks"]);

/**
 * When a creature an effect reached repeats the save that let it in (2024: "At the end of each of its turns, the target
 * repeats the save, ending the spell on itself on a success"): `turnEnd` or `turnStart` of its own turns.
 */
export const REPEAT_SAVE_TIMINGS = Object.freeze(["turnEnd", "turnStart"]);

/** V14's ActiveEffect duration units and expiry events (CONST), for a custom effect's native duration. */
export const CUSTOM_EFFECT_DURATION_UNITS = Object.freeze(["years", "months", "days", "hours", "minutes", "seconds", "rounds", "turns"]);
// `sourceTurnStart`/`sourceTurnEnd`: the start or end of its source's next turn (Assist: "before the start of your next turn").
export const CUSTOM_EFFECT_EXPIRY_EVENTS = Object.freeze(["combatStart", "roundStart", "turnStart", "combatEnd", "roundEnd", "turnEnd",
  "sourceTurnStart", "sourceTurnEnd"]);

/** The status id a custom effect is known by: its `slug` ("raging"), else one unique to this Action and effect. */
export function customEffectId(definitionId, effect) {
  return effect.slug ?? `${definitionId}:${effect.id}`;
}

export const ACTION_DEFINITION_SCHEMA_VERSION = 1;

export const ACTION_DEFINITION_CODES = Object.freeze({
  OK: "OK",
  INVALID_DEFINITION: "INVALID_DEFINITION",
  INVALID_SCHEMA_VERSION: "INVALID_SCHEMA_VERSION",
  MISSING_IDENTITY: "MISSING_IDENTITY",
  INVALID_COST: "INVALID_COST",
  INVALID_PREDICATE: "INVALID_PREDICATE",
  INVALID_VALUE_EXPRESSION: "INVALID_VALUE_EXPRESSION",
  INVALID_TARGETING: "INVALID_TARGETING",
  MISSING_AREA_DEFINITION: "MISSING_AREA_DEFINITION",
  INVALID_AREA: "INVALID_AREA",
  INVALID_ATTACK: "INVALID_ATTACK",
  INVALID_SAVE: "INVALID_SAVE",
  INVALID_CHECK: "INVALID_CHECK",
  INVALID_DAMAGE: "INVALID_DAMAGE",
  INVALID_DAMAGE_TYPE: "INVALID_DAMAGE_TYPE",
  INVALID_HEALING: "INVALID_HEALING",
  MISSING_EFFECT_REFERENCE: "MISSING_EFFECT_REFERENCE",
  INVALID_EFFECT: "INVALID_EFFECT",
  INVALID_RULE_ELEMENT: "INVALID_RULE_ELEMENT",
  NON_SERIALIZABLE: "NON_SERIALIZABLE"
});

export const ACTION_ORIGIN_TYPES = Object.freeze({
  SELF: "self",
  ELIGIBLE_CONTROLLED: "eligible-controlled",
  SELF_AND_ELIGIBLE_CONTROLLED: "self-and-eligible-controlled",
  LINKED_SOURCE: "linked-source",
  CUSTOM: "custom"
});

export const ACTION_RANGE_TYPES = Object.freeze({
  SELF: "self",
  TOUCH: "touch",
  REACH: "reach",
  RANGED: "ranged",
  SIGHT: "sight",
  SPECIAL: "special"
});

export const ACTION_TARGETING_TYPES = Object.freeze({
  NONE: "none",
  SELF: "self",
  SINGLE: "single",
  MULTIPLE: "multiple",
  AREA: "area"
});

const DAMAGE_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/i;

/* -------------------------------------------- */

export function normalizeActionDefinition(rawDefinition={}, {
  item=null,
  source=null,
  legacyCost=null,
  legacyActivationCost=null
}={}) {
  const raw = isPlainObject(rawDefinition) ? rawDefinition : {};
  const itemSystem = item?.system ?? {};
  const itemSourceData = source ?? sourceFromItem(item);
  const legacyCostShape = legacyActivationCost
    ?? safeLegacyActivationCost(itemSystem)
    ?? computeActivationCost(legacyCost ?? itemSystem.cost);
  const definitionCost = raw.costs ?? raw.activationCost ?? raw.cost ?? legacyCostShape;

  return {
    schemaVersion: normalizeSchemaVersion(raw.schemaVersion) ?? ACTION_DEFINITION_SCHEMA_VERSION,
    id: stringOrNull(raw.id ?? raw.actionId ?? item?.id ?? item?.uuid),
    slug: stringOrNull(raw.slug ?? raw.key ?? itemSystem.slug ?? item?.slug),
    label: stringOrNull(raw.label ?? raw.name ?? item?.name),
    category: stringOrDefault(raw.category ?? raw.type, "action"),
    tags: normalizeStrings(raw.tags ?? itemSystem.tags),
    source: clonePlain(raw.source ?? itemSourceData),
    origin: normalizeOriginDefinition(raw.origin),
    activation: normalizeActivationDefinition(raw.activation),
    costs: normalizeCostDefinition(definitionCost),
    // What a companion's Action also costs the controller commanding it (an Action, Bonus Action, movement...).
    controllerCosts: normalizeCostDefinition(raw.controllerCosts),
    range: normalizeRangeDefinition(raw.range),
    targeting: normalizeTargetingDefinition(raw.targeting ?? raw.target),
    area: normalizeAreaDefinition(raw.area),
    attack: normalizePlainComponent(raw.attack),
    save: normalizePlainComponent(raw.save),
    check: normalizePlainComponent(raw.check),
    damage: normalizeArray(raw.damage ?? raw.damageDefinitions ?? raw.damageComponents).map(normalizeDamageDefinition),
    // Damage it deals its own source once its damage is rolled (Overchannel's backlash: action-resolution.md).
    ...(normalizeArray(raw.sourceDamage).length ? {sourceDamage: normalizeArray(raw.sourceDamage).map(normalizeDamageDefinition)} : {}),
    healing: normalizeArray(raw.healing ?? raw.healingDefinitions ?? raw.healingComponents).map(normalizeHealingDefinition),
    effects: normalizeArray(raw.effects ?? raw.effectApplications ?? raw.effectApplicationDefinitions).map(normalizeEffectApplicationDefinition),
    duration: normalizeDurationDefinition(raw.duration),
    // The creature takes a form when the Action completes: a fixed `formRef`, the form a `choiceId` configuration
    // choice picked, or `revert` to end its transformation (transformations: classes-and-spellcasting.md).
    transform: normalizePlainComponent(raw.transform),
    // Creatures the Action summons when it completes (companions.md): a fixed `actorRef` or a `choiceId`
    // configuration choice of creatures, `count`, and optionally `rounds`, `concentration`, `match` ({attacks, saves}: its
    // summoner's spell attack and save DC) and `area` (the lasting area each creature carries).
    summon: normalizePlainComponent(raw.summon),
    // Forced movement (areas.md): each creature it hits, or that fails its save, is pushed `distance` feet away from
    // its source, or pulled toward it (`toward`); only one no bigger than `maxSize` when it has one. `on: "success"`
    // pushes the creatures that succeed on its save instead. `choose`: its user picks where its one target lands
    // ("space", "line"), within the Action's range too with `inRange`. With no save or attack it moves its targets.
    push: normalizePlainComponent(raw.push),
    // Moves its creature's lasting area left by the Action `of` (its definition id) up to `distance` feet (areas.md).
    ...(raw.moveArea ? {moveArea: normalizePlainComponent(raw.moveArea)} : {}),
    // Teleports its own creature up to `distance` feet to a space it chooses (Misty Step, Dimension Door).
    ...(raw.teleport ? {teleport: normalizePlainComponent(raw.teleport)} : {}),
    // The ammunition a weapon's attack spends ("arrow": adapters/foundry-v14-ammunition.mjs).
    ...(raw.ammunition ? {ammunition: String(raw.ammunition)} : {}),
    // Cast from a Spell Scroll, which reading uses up (helpers/spell-scrolls.mjs).
    ...(raw.scroll === true ? {scroll: true} : {}),
    // A choice filled by chance instead of by its user: a RollTable its use draws, whose result names the option (a Bag of
    // Tricks' creature: {table, choiceId}), or dice whose total falls in an option's `range` (Prismatic Spray's ray:
    // {formula, choiceId, perTarget}, rolled by the pipeline's draw stage, for each creature with `perTarget`).
    ...(raw.draw ? {draw: normalizePlainComponent(raw.draw)} : {}),
    // Enchants one of its creature's Items (an Artificer's infusion: inventory.md): the Item its `choiceId` choice picked
    // gets the effect whose `level` range holds its creature's class level; at most `limit` with its `key` at once.
    ...(raw.enchant ? {enchant: normalizePlainComponent(raw.enchant)} : {}),
    // Items its creature has while it lasts (a rest's choice: Circle of the Land Spells): the option its `choiceId` choice
    // picked, `options.<value>` rows keyed by `class` level, each row's Item uuids from that level (runtime grantChosenItems).
    ...(raw.grantItems ? {grantItems: normalizePlainComponent(raw.grantItems)} : {}),
    ...(raw.stabilize === true ? {stabilize: true} : {}),
    // A reaction whose target failing its save cancels the Action that triggered it (2024 Counterspell).
    ...(raw.counters === true ? {counters: true} : {}),
    // Effects it ends on its targets: those tagged (`tags`, Remove Curse's "curse") and spells up to a level (`spells`:
    // a number, or "slot" for the level it is cast at; Dispel Magic).
    ...(raw.ends ? {ends: normalizePlainComponent(raw.ends)} : {}),
    // What its creature must be for it to be used: a predicate on `{actorSystem, tags}` (Steady Aim: it has not moved
    // this turn). The authority refuses it otherwise, and the action bar greys it.
    ...(raw.requires ? {requires: clonePlain(raw.requires)} : {}),
    // A reaction's changes to the Action it answers (reactions.md): {forgoDice, damage, rollMode, tags, push}.
    ...(raw.rider ? {rider: normalizePlainComponent(raw.rider)} : {}),
    // Its own damage, moved to a creature within `range` of its target (Superior Hunter's Prey): {range}.
    ...(raw.retarget ? {retarget: normalizePlainComponent(raw.retarget)} : {}),
    // A reaction's target picked as it is used (reactions.md): the creature whose event it answers ("trigger-source"),
    // the first that event names ("trigger-target"), itself ("self"), any creature within `range` feet of it
    // ("creatures", itself too with `includeSelf`), or one its automatic Trigger's `around` reaches ("around"), its
    // controller's pick.
    ...(raw.targetChoice ? {targetChoice: normalizePlainComponent(raw.targetChoice)} : {}),
    // Its caster concentrates on it for `duration` (a native duration), though nothing it sustains is automated (Fog
    // Cloud, Detect Thoughts): a marker on the caster, which a new concentration, damage or Incapacitated ends.
    ...(raw.concentration ? {concentration: normalizePlainComponent(raw.concentration)} : {}),
    // Pools of the acting creature the Action refills when it is used (Multiattack's attacks, a use given back).
    // `amountExpression`: an amount worked out for its creature (Sorcerous Restoration's half its sorcerer level);
    // `refuseWhenFull`: the Action is refused while that pool is full (Dragon Wings' Restore Use).
    ...(Array.isArray(raw.restores) && raw.restores.length ? {restores: raw.restores.map(entry => ({
      resourceId: stringOrNull(entry?.resourceId ?? entry?.resource), amount: finiteNumber(entry?.amount) ?? 1,
      ...(entry?.amountExpression ? {amountExpression: clonePlain(entry.amountExpression)} : {}),
      ...(entry?.refuseWhenFull === true ? {refuseWhenFull: true} : {})}))} : {}),
    configuration: normalizeArray(raw.configuration ?? raw.configurations).map(clonePlain),
    ruleElements: normalizeArray(raw.ruleElements).map(clonePlain),
    policies: clonePlain(raw.policies ?? raw.resolutionPolicies ?? {}) ?? {},
    metadata: clonePlain(raw.metadata ?? {}) ?? {}
  };
}

/* -------------------------------------------- */

export function validateActionDefinition(rawDefinition={}, options={}) {
  if ( !isPlainObject(rawDefinition) ) {
    return validationFailure(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "ActionDefinition must be a plain object.", "definition");
  }

  const serializableIssue = findNonSerializable(rawDefinition, "definition");
  if ( serializableIssue ) {
    return validationFailure(ACTION_DEFINITION_CODES.NON_SERIALIZABLE, serializableIssue.reason, serializableIssue.path);
  }

  const definition = normalizeActionDefinition(rawDefinition, options);
  const errors = [];

  if ( definition.schemaVersion !== ACTION_DEFINITION_SCHEMA_VERSION ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_SCHEMA_VERSION, "schemaVersion", "ActionDefinition schemaVersion must be 1."));
  }
  if ( !definition.id ) {
    errors.push(error(ACTION_DEFINITION_CODES.MISSING_IDENTITY, "id", "ActionDefinition requires stable identity."));
  }

  validateCosts(definition.costs, errors);
  validateCosts(definition.controllerCosts, errors, "controllerCosts");
  (definition.restores ?? []).forEach((entry, index) => {
    if ( !entry.resourceId || !Number.isInteger(entry.amount) || (entry.amount < 1) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_COST, `restores.${index}`, "A restore names a pool and a whole amount of at least 1."));
    }
  });
  validateTransform(definition.transform, errors);
  const concentrationUnits = definition.concentration?.duration?.units;
  if ( concentrationUnits && !CUSTOM_EFFECT_DURATION_UNITS.includes(concentrationUnits) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "concentration.duration.units", `Unknown duration unit: ${concentrationUnits}`));
  }
  validateSummon(definition.summon, errors);
  validateEnchant(definition.enchant, errors);
  if ( definition.grantItems && ((typeof definition.grantItems.choiceId !== "string") || !isPlainObject(definition.grantItems.options)) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "grantItems", "A grant names its choice and the Items of each option."));
  }
  validatePush(definition.push, errors, definition.targeting);
  validateDraw(definition, errors);
  validateUseAction(definition, errors);
  validateTargetChoice(definition.targetChoice, errors);
  if ( definition.teleport && !(Number(definition.teleport.distance) > 0) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "teleport.distance", "A teleport goes a positive number of feet."));
  }
  if ( definition.moveArea && (!definition.moveArea.of || !(Number(definition.moveArea.distance) > 0)) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "moveArea",
      "Moving an area names the Action that left it (of) and a positive number of feet."));
  }
  validatePredicateCandidates(definition, errors);
  validateTargeting(definition, errors);
  validateArea(definition.area, errors);
  validateAttack(definition.attack, errors);
  validateSave(definition.save, errors);
  validateCheck(definition.check, errors);
  validateDamage(definition.damage, errors);
  validateHealing(definition.healing, errors);
  validateEffects(definition.effects, errors, options);
  validateRuleElements(definition.ruleElements, errors);

  return {
    ok: errors.length === 0,
    code: errors[0]?.code ?? ACTION_DEFINITION_CODES.OK,
    definition,
    errors
  };
}

/* -------------------------------------------- */

export function serializeActionDefinition(rawDefinition={}, options={}) {
  const validation = validateActionDefinition(rawDefinition, options);
  const definition = validation.definition ?? normalizeActionDefinition(rawDefinition, options);
  const serializedRuleElements = definition.ruleElements.map((ruleElement, index) => {
    const serialized = serializeRuleElementDefinition(ruleElement, {
      source: actionDefinitionRuleElementSource(definition),
      index
    });
    return serialized.definition;
  });

  return {
    ok: validation.ok,
    code: validation.code,
    definition: clonePlain({
      ...definition,
      ruleElements: serializedRuleElements
    }),
    errors: validation.errors ?? []
  };
}

/* -------------------------------------------- */

export function actionDefinitionFromItem(item, options={}) {
  const system = item?.system ?? {};
  // Its range bonus before Metamagic, so Distant Spell doubles the longer range.
  const actor = item?.actor ?? null;
  const stored = system.definition ?? system.actionDefinition ?? item?.definition ?? item?.actionDefinition ?? null;
  const ranged = withHalfOnSuccess(withRangeBonus(withOwnWeapons(withWeaponMastery(withExtraAttacks(stored, item), actor), actor), item), actor);
  const raw = withContributedChoices(withSummonLevels(withFreeCasts(withSpellChoices(withMetamagic(
    withGrantedCastingAbility(ranged, item), actor), item), item), actor), item);
  const migrated = !hasAuthoredDefinition(raw);
  const source = sourceFromItem(item);
  const legacyActivationCost = options.legacyActivationCost
    ?? item?.activationCost
    ?? (typeof system.getActivationCost === "function" && typeof system.getActionDefinition !== "function"
      ? system.getActivationCost()
      : null);
  const legacyCost = system.cost ?? item?.cost;
  const baseDefinition = migrated ? {
    id: item?.id ?? item?.uuid ?? null,
    label: item?.name ?? null,
    source,
    metadata: {
      migration: {
        from: "legacy-action-cost",
        schemaVersion: ACTION_DEFINITION_SCHEMA_VERSION
      }
    }
  } : raw;

  const validation = validateActionDefinition(baseDefinition, {
    ...options,
    item,
    source,
    legacyCost,
    legacyActivationCost
  });

  return {
    ...validation,
    migrated
  };
}

/* -------------------------------------------- */

/**
 * 2024 Extra Attack: while the Item's creature has an `ExtraAttack` pool, each of its weapon attacks that costs the
 * Action may instead be paid from that pool, and paying with the Action fills the pool. The stored definition is
 * untouched; this is what the creature can pay now.
 */
/**
 * A choice of one of its creature's own weapons (`optionsFrom: {type: "weapons", melee?, bases?}`: Magic Weapon,
 * Shillelagh): its options are the weapons whose attacks the creature has, by the weapon's own Item id (the gear that
 * grants the attack, else the attack itself), worked out whenever the Action is read, so a forged id is never one.
 */
function withOwnWeapons(raw, actor) {
  const choices = raw?.configuration;
  if ( !Array.isArray(choices) || !choices.some(choice => ["weapons", "gear"].includes(choice?.optionsFrom?.type)) ) return raw;
  const items = [...(actor?.items ?? [])];
  const attacks = items.filter(item => (item.type === "action") && item.system?.definition?.attack?.weapon);
  return {...raw, configuration: choices.map(choice => {
    if ( choice?.optionsFrom?.type === "gear" ) return {...choice, options: ownGear(items, attacks, choice.optionsFrom.kinds)};
    if ( choice?.optionsFrom?.type !== "weapons" ) return choice;
    const {melee=false, bases=[]} = choice.optionsFrom;
    const options = new Map();
    for ( const action of attacks ) {
      const attack = action.system.definition.attack;
      if ( (melee && (attack.type !== "melee")) || (bases.length && !bases.includes(attack.weapon.base)) ) continue;
      const id = action.flags?.wildpath?.grantedBy ?? action.id;
      if ( !options.has(id) ) options.set(id, {id, value: id, label: items.find(item => item.id === id)?.name ?? action.name});
    }
    return {...choice, options: [...options.values()]};
  })};
}

/**
 * A ranged Action's range (10 feet or more) made longer by its creature's `range` Modifiers, and a spell's by `range.spell`
 * ones, as its tags select (2024 Eldritch Spear: a damaging cantrip's range + 30 feet per warlock level), worked out
 * whenever the Action is read.
 */
function withRangeBonus(raw, item) {
  const range = raw?.range;
  if ( (range?.type !== "ranged") || !(Number(range.normal?.value) >= 10) || (typeof item?.actor?.getStatistic !== "function") ) return raw;
  // An attack's too (Spell Sniper: spell attacks).
  const tags = [...(raw.tags ?? []), ...(raw.attack ? ["attack"] : [])];
  const bonus = Number(item.actor.getStatistic([...(tags.includes("spell") ? ["range.spell"] : []), "range"], {item, tags})?.totalModifier) || 0;
  if ( !(bonus > 0) ) return raw;
  const longer = distance => (distance ? {...distance, value: Number(distance.value) + bonus} : distance);
  return {...raw, range: {...range, normal: longer(range.normal), ...(range.long ? {long: longer(range.long)} : {})}};
}

/**
 * A creature that succeeds on its save against the Action takes half its damage rather than none, while its creature
 * has a `half-on-success` RollOutcome on `imposed.save` whose predicate holds for the Action's tags (2024 Potent
 * Cantrip: cantrips).
 */
function withHalfOnSuccess(raw, actor) {
  if ( !raw?.save || !(raw.damage ?? []).some(entry => entry?.saveOutcomePolicy?.success === "none") ) return raw;
  if ( !(actor?.getRollOutcomes?.(["imposed.save"], {context: {tags: raw.tags ?? []}}) ?? [])
    .some(outcome => outcome.outcome === "half-on-success") ) return raw;
  return {...raw, damage: raw.damage.map(entry => ((entry?.saveOutcomePolicy?.success === "none")
    ? {...entry, saveOutcomePolicy: {...entry.saveOutcomePolicy, success: "half"}} : entry))};
}

/**
 * A choice another of its creature's features adds to the Action (`flags.wildpath.choiceFor: {identifier, choice}` on an
 * active feature: Restoring Touch's conditions on Lay on Hands), for the Actions whose source identifier it names, or the
 * spells it describes (`choiceFits`: Overchannel).
 */
function withContributedChoices(raw, item) {
  const identifier = item?.flags?.wildpath?.source?.identifier;
  if ( !raw ) return raw;
  // Once each: a feature held twice adds its choice once.
  const seen = new Set((raw.configuration ?? []).map(entry => entry?.id));
  const added = [...(item?.actor?.items ?? [])].filter(feature => (feature?.system?.active !== false)
    && choiceFits(feature?.flags?.wildpath?.choiceFor, raw, identifier)).map(feature => feature.flags.wildpath.choiceFor.choice)
    .filter(choice => choice?.id && !seen.has(choice.id) && seen.add(choice.id));
  return added.length ? {...raw, configuration: [...(raw.configuration ?? []), ...clonePlain(added)]} : raw;
}

/**
 * Whether a feature's `choiceFor` names this Action: by its `identifier`, or by `spell: {lists?, minLevel?, damage?}`, a
 * spell on one of those class spell lists (`metadata.spellLists`), of at least that level (a cantrip's is 0), that deals
 * damage when `damage` (Overchannel's wizard spells of level 1+). shortcut: a spell on the list counts whichever class
 * prepared it; upgrade when spells record the class they are cast through.
 */
function choiceFits(choiceFor, raw, identifier) {
  if ( choiceFor?.identifier ) return choiceFor.identifier === identifier;
  const spell = choiceFor?.spell;
  if ( !spell || !(raw.tags ?? []).includes("spell") ) return false;
  const lists = spell.lists ?? [];
  return (!lists.length || (raw.metadata?.spellLists ?? []).some(list => lists.includes(list)))
    && ((spellBaseLevel(raw) ?? 0) >= (Number(spell.minLevel) || 0)) && (!spell.damage || !!raw.damage?.length);
}

/**
 * Options offered at its creature's level only (`option.level {min?, max?, class?}`: a Steel Defender from artificer
 * level 3, its improved form from 15), worked out whenever the Action is read. Without a creature, all of them.
 */
function withSummonLevels(raw, actor) {
  const choices = raw?.configuration;
  if ( !actor || !Array.isArray(choices) || !choices.some(choice => (choice?.options ?? []).some(option => option?.level)) ) return raw;
  const levelFor = range => Number(evaluateValueExpression(range.class ? {type: "class-level", class: range.class} : {type: "character-level"},
    {actor, actorSystem: actor.system}).value) || 0;
  const fits = option => !option?.level || (((option.level.min ?? 0) <= levelFor(option.level)) && (levelFor(option.level) <= (option.level.max ?? Infinity)));
  return {...raw, configuration: choices.map(choice => (Array.isArray(choice?.options) ? {...choice, options: choice.options.filter(fits)} : choice))};
}

/**
 * Its creature's Items of the given kinds, by Item id: what an Item enchantment (an infusion) may pick. `weapon`: each
 * weapon, as its attack names it (`weapon:<id>`: the gear granting the attack, else the attack's own Action, as an SRD
 * Dagger is); `armor`; `shield`; none: any of its gear and weapons.
 */
function ownGear(items, attacks, kinds=[]) {
  const weapons = new Map();
  for ( const action of attacks ) {
    const id = action.flags?.wildpath?.grantedBy ?? action.id;
    if ( !weapons.has(id) ) weapons.set(id, items.find(item => item.id === id) ?? action);
  }
  const kindOf = item => (weapons.has(item.id) ? "weapon" : (item.system?.armor === "shield") ? "shield" : item.system?.armor ? "armor" : "other");
  return [...new Set([...weapons.values(), ...items.filter(item => item.type === "gear")])]
    .filter(item => !kinds?.length || kinds.includes(kindOf(item))).map(item => ({id: item.id, value: item.id, label: item.name}));
}

/**
 * The spells its creature's features let it mark (`flags.wildpath.spellChoice` on an active feature, spellcasting.mts):
 * a spell marked for a choice that fits it (its level, its costs) is also cast at its own level, free (Spell Mastery:
 * `metadata.freeCastLevel`) or from the choice's pool while its creature has it (Mystic Arcanum's `mystic-arcanum.<level>`,
 * Signature Spells' `signature-spell.<n>`).
 */
function withSpellChoices(raw, item) {
  const choice = raw?.configuration?.find(entry => entry?.id === "spell-slot");
  const level = choice ? spellBaseLevel(raw) : null;
  if ( !level ) return raw;
  const pools = new Set((item.actor?.system?.pools ?? []).map(pool => pool.id));
  let slot = choice;
  for ( const spellChoice of spellChoices(item.actor) ) {
    const mark = spellChoiceMark(spellChoice, item);
    if ( (mark === null) || !fitsSpellChoice(spellChoice, raw) ) continue;
    const capability = spellChoicePool(spellChoice, mark, level);
    if ( !capability ) slot = {...slot, cost: {anyOf: [...(slot.cost?.anyOf ?? []), []]}, metadata: {...(slot.metadata ?? {}), freeCastLevel: level}};
    else if ( pools.has(capability) ) slot = {...slot, cost: {anyOf: [...(slot.cost?.anyOf ?? []), [{capability, amount: 1}]]},
      levelByResourceId: {...(slot.levelByResourceId ?? {}), [capability]: level}};
  }
  return (slot === choice) ? raw : {...raw, configuration: raw.configuration.map(entry => ((entry === choice) ? slot : entry))};
}

/**
 * A spell a feature lets its creature cast once without a slot (`flags.wildpath.freeCast: {spells, resourceId}` on an active
 * feature: Faithful Steed's Find Steed, once per Long Rest; `granted: true` for the spells the feature gave, Magic
 * Initiate's level 1 spell; `fromFeatures` for those the features with these identifiers gave, Natural Recovery's Circle
 * Spells): its slot choice may spend that pool instead, at the spell's own level, while the pool is there.
 */
function withFreeCasts(raw, item) {
  const identifier = item?.flags?.wildpath?.source?.identifier;
  const choice = identifier ? raw?.configuration?.find(entry => entry?.id === "spell-slot") : null;
  const level = choice ? spellBaseLevel(raw) : null;
  if ( !level ) return raw;
  const pools = new Set((item.actor?.system?.pools ?? []).map(pool => pool.id));
  // The feature that gave it, by identifier (`fromFeatures`: Natural Recovery's Circle Spells).
  const grantor = [...(item.actor?.items ?? [])].find(entry => entry?.id && (entry.id === item.flags?.wildpath?.grantedBy))
    ?.flags?.wildpath?.source?.identifier ?? null;
  const capabilities = [...new Set([...(item.actor?.items ?? [])].filter(entry => entry?.system?.active !== false)
    .filter(entry => entry?.flags?.wildpath?.freeCast?.spells?.includes(identifier)
      || (entry?.flags?.wildpath?.freeCast?.granted && entry.id && (entry.id === item.flags?.wildpath?.grantedBy))
      || (grantor && entry?.flags?.wildpath?.freeCast?.fromFeatures?.includes(grantor)))
    // Each copy's own pool (`{item}`: Magic Initiate taken twice).
    .map(entry => String(entry.flags.wildpath.freeCast.resourceId).replaceAll("{item}", String(entry.id ?? "")))
    .filter(resourceId => pools.has(resourceId)))];
  if ( !capabilities.length ) return raw;
  return {...raw, configuration: raw.configuration.map(entry => ((entry !== choice) ? entry : {...entry,
    cost: {anyOf: [...(entry.cost?.anyOf ?? []), ...capabilities.map(capability => [{capability, amount: 1}])]},
    levelByResourceId: {...(entry.levelByResourceId ?? {}), ...Object.fromEntries(capabilities.map(capability => [capability, level]))}}))};
}

/**
 * A spell a feature gave its creature, cast with the feature's own ability (`flags.wildpath.castingAbilities` on the
 * granting feature: Magic Initiate's Intelligence, Wisdom or Charisma): the best of them, for its spell attack, its save DC
 * and every spellcasting modifier in it that names no ability or class of its own.
 */
export function withGrantedCastingAbility(raw, item) {
  const grantedBy = item?.flags?.wildpath?.grantedBy;
  const abilities = grantedBy ? [...(item.actor?.items ?? [])].find(entry => entry?.id === grantedBy)?.flags?.wildpath?.castingAbilities : null;
  if ( !raw || !Array.isArray(abilities) || !abilities.length || !(raw.tags ?? []).includes("spell") ) return raw;
  const score = ability => Number(item.actor?.system?.abilities?.[ability]?.value) || 0;
  const ability = abilities.reduce((best, entry) => ((score(entry) > score(best)) ? entry : best));
  const pin = value => {
    if ( Array.isArray(value) ) return value.map(pin);
    if ( !value || (typeof value !== "object") ) return value;
    const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pin(entry)]));
    return ((value.type === "spellcasting-modifier") && !value.ability && !value.class) ? {...copy, ability} : copy;
  };
  const pinned = pin(raw);
  return raw.attack?.statistic === "spell" ? {...pinned, attack: {...pinned.attack, ability}} : pinned;
}

function withExtraAttacks(raw, item) {
  const actor = item?.actor ?? null;
  const allOf = raw?.costs?.allOf;
  if ( (raw?.attack?.statistic !== "weapon") || !Array.isArray(allOf) || raw.costs.anyOf
    || !allOf.some(cost => cost?.capability === "action") || (typeof actor?.getExtraAttacks !== "function") ) return raw;
  const resourceId = actor.getExtraAttacks()[0];
  const pool = (actor.system?.pools ?? []).find(entry => entry.id === resourceId);
  if ( !pool ) return raw;
  const rest = allOf.filter(cost => cost?.capability !== "action");
  return {...raw, costs: {anyOf: [[{capability: resourceId, amount: 1}, ...rest], allOf]},
    restores: [...(raw.restores ?? []), {resourceId, amount: Math.max(Number(pool.max) || 0, 1)}]};
}

export function actionDefinitionFromAction(action, options={}) {
  if ( !action ) {
    return validationFailure(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "Action is required.", "action");
  }
  if ( action.definition || action.actionDefinition || action.system?.definition || action.system?.actionDefinition ) {
    return actionDefinitionFromItem(action, options);
  }
  return actionDefinitionFromItem(action, options);
}

/* -------------------------------------------- */

/**
 * Whether completing an Action starts a new concentration (2024: casting another concentration spell ends the
 * one you have): an effect, lasting area or summon it sustains. A converted follow-up of the same spell (Move Mark,
 * `metadata.followUp`) continues its concentration instead.
 */
export function startsConcentration(definition) {
  if ( !definition || definition.metadata?.followUp ) return false;
  return (definition.effects ?? []).some(effect => effect?.concentration) || Boolean(definition.area?.persistence?.concentration)
    || Boolean(definition.summon?.concentration) || Boolean(definition.transform?.concentration) || Boolean(definition.concentration);
}

/* -------------------------------------------- */

export function actionDefinitionActivationCost(definition) {
  const cost = normalizeActivationCost(definition?.costs ?? {allOf: []});
  if ( cost.anyOf ) return {
    anyOf: cost.anyOf.map(branch => branch.map(costRequirementForPayment).filter(requirement => requirement.amount > 0))
  };
  return {
    allOf: (cost.allOf ?? []).map(costRequirementForPayment).filter(requirement => requirement.amount > 0)
  };
}

/* -------------------------------------------- */

export function actionDefinitionToResolverInput(definition, {
  actorSystem=null,
  source=null,
  targets=[],
  targeting=null,
  attack=null,
  save=null,
  check=null,
  damage=null,
  sourceDamage=null,
  healing=null,
  effects=null,
  context={},
  policies={}
}={}) {
  const normalized = normalizeActionDefinition(definition);
  const evaluationContext = {
    actorSystem,
    source,
    targets,
    action: normalized,
    actionDefinition: normalized,
    ...(context ?? {})
  };
  const base = {
    context: {
      ...context,
      actionDefinition: normalized,
      areaDefinition: normalized.area,
      rangeDefinition: normalized.range,
      originDefinition: normalized.origin,
      durationDefinition: normalized.duration,
      configurationDefinitions: normalized.configuration
    },
    policies: {
      ...normalized.policies,
      ...policies
    },
    targeting: targetingFromDefinition(normalized, {source, targeting, evaluationContext}),
    attack: resolverRequestFromAttackDefinition(normalized.attack, attack),
    save: resolverRequestFromSaveDefinition(normalized.save, save, evaluationContext),
    check: normalized.check ? mergeResolverRequest({ability: normalized.check.ability ?? null, skill: normalized.check.skill ?? null,
      dc: resolveSaveDCDefinition(normalized.check.dc, evaluationContext), policy: normalized.check.policy ?? {}}, check) : check ?? null,
    damage: resolverRequestFromDamageDefinition(normalized, damage, evaluationContext),
    healing: resolverRequestFromHealingDefinition(normalized, healing, evaluationContext),
    effects: resolverRequestFromEffectsDefinition(normalized, effects),
    // Its damage to its own source, its rolled amounts kept (the pipeline's damage roll stage).
    ...(normalized.sourceDamage ? {sourceDamage: {components: normalized.sourceDamage.map((component, index) => damageComponentForResolver({
      component, index, runtimeComponents: normalizeArray(sourceDamage?.components), evaluationContext}))}} : {})
  };

  return {
    ...base,
    targets: targets.length ? targets.map(clonePlain) : []
  };
}

/* -------------------------------------------- */

function targetingFromDefinition(definition, {source, targeting, evaluationContext}) {
  const targetDefinition = definition.targeting;
  if ( !targetDefinition ) return targeting ?? null;

  // A count that grows with its creature (Eldritch Blast's beams by character level) is its row for this creature, as a
  // cantrip's dice are.
  const rowed = (targetDefinition.count?.type === "table") ? selectTableRows(targetDefinition.count, evaluationContext) : null;
  const count = (rowed?.type === "constant") ? Number(rowed.value) : targetDefinition.count;
  const refinementPolicy = {
    ...(targetDefinition.refinementPolicy ?? {}),
    ...(count != null ? {
      // "Up to three creatures" sets its own minimum; otherwise a required count is exact.
      minSelections: targetDefinition.refinementPolicy?.minSelections ?? (targetDefinition.required ? count : 0),
      maxSelections: count,
      // Its count is that many separate hits its user shares among its targets (Magic Missile's darts), each its own attack
      // when it has one (Scorching Ray's rays).
      ...(targetDefinition.repeatable ? {instances: count} : {})
    } : {})
  };
  const eligibilityPolicy = {
    ...(targetDefinition.eligibilityPolicy ?? {}),
    ...(targetDefinition.predicate ? {predicate: targetDefinition.predicate} : {})
  };
  const definitionTargets = targetDefinition.type === ACTION_TARGETING_TYPES.SELF && source
    ? [source]
    : [];

  return mergeResolverRequest({
    required: targetDefinition.required,
    eligibilityPolicy,
    refinementPolicy,
    targets: definitionTargets,
    metadata: {
      actionDefinitionId: definition.id,
      targetingType: targetDefinition.type,
      range: definition.range,
      area: definition.area
    }
  }, targeting);
}

function resolverRequestFromAttackDefinition(attackDefinition, runtimeAttack) {
  if ( !attackDefinition ) return runtimeAttack ?? null;
  return mergeResolverRequest({
    defenseKey: attackDefinition.defenseKey ?? "ac",
    policy: attackDefinition.policy ?? {},
    context: {attackDefinition}
  }, runtimeAttack);
}

function resolverRequestFromSaveDefinition(saveDefinition, runtimeSave, evaluationContext) {
  if ( !saveDefinition ) return runtimeSave ?? null;
  const resolved = saveDefinition.dc
    ? resolveSaveDCDefinition(saveDefinition.dc, evaluationContext)
    : null;
  // Its creature's bonus to the DC (`dc.spell`: Innate Sorcery), which the runtime works out.
  const bonus = Number(runtimeSave?.dcBonus) || 0;
  const dc = (resolved && bonus && Number.isFinite(resolved.value)) ? {...resolved, value: resolved.value + bonus} : resolved;
  return mergeResolverRequest({
    saveKey: saveDefinition.saveKey ?? saveDefinition.ability ?? null,
    dc,
    dcKey: saveDefinition.dcKey ?? "save",
    policy: saveDefinition.policy ?? {},
    context: {saveDefinition}
  }, runtimeSave);
}

function resolverRequestFromDamageDefinition(definition, runtimeDamage, evaluationContext) {
  if ( !definition.damage.length ) return runtimeDamage ?? null;
  const runtimeComponents = normalizeArray(runtimeDamage?.components);
  // Extra damage from the creature's rules (ExtraDamage) follows the Action's own components.
  const extras = normalizeArray(runtimeDamage?.extraComponents)
    .map((component, index) => normalizeDamageDefinition(component, definition.damage.length + index));
  // A larger die rolled in place of the weapon's own (Martial Arts with a Monk weapon: `baseExpression`).
  const own = runtimeDamage?.baseExpression ? definition.damage.map(component => ((component.provenance === "weapon-base")
    ? {...component, expression: clonePlain(runtimeDamage.baseExpression)} : component)) : definition.damage;
  // A spell's damage says so (Spell Resistance: Resistance to damage from spells).
  const spell = (definition.tags ?? []).includes("spell");
  // Its dice's floor (Great Weapon Fighting: a 1 or 2 counts as 3), rolled as their `min` modifier: the highest that
  // applies to its damage type.
  const floors = normalizeArray(runtimeDamage?.dieMinimums);
  const floored = component => {
    const minimum = Math.max(0, ...floors.filter(entry => !entry.damageTypes?.length || entry.damageTypes.includes(component.damageType))
      .map(entry => Number(entry.minimum) || 0));
    return (component.dice && (minimum >= 2) && (minimum <= Number(component.dice.faces)))
      ? {...component, dice: {...component.dice, modifiers: [...new Set([...(component.dice.modifiers ?? []), `min${minimum}`])]}} : component;
  };
  // Its weapon's dice rolled twice, the higher kept (Savage Attacker: `bestOfTwo`).
  const twice = component => ((runtimeDamage?.bestOfTwo && (component.provenance === "weapon-base") && component.dice)
    ? {...component, dice: {...component.dice, metadata: {...(component.dice.metadata ?? {}), bestOfTwo: true}}} : component);
  const resolved = [...own, ...extras].map((component, index) => twice(floored(damageComponentForResolver({
    component: spell ? {...component, tags: [...new Set([...(component.tags ?? []), "spell"])]} : component,
    index,
    runtimeComponents,
    evaluationContext
  }))));
  // A Critical Hit's extra dice (Piercer: `criticalDice`), on the first component of a damage type each names.
  const criticalDice = new Map();
  for ( const entry of normalizeArray(runtimeDamage?.criticalDice) ) {
    const index = resolved.findIndex(component => !entry.damageTypes?.length || entry.damageTypes.includes(component.damageType));
    if ( index >= 0 ) criticalDice.set(index, (criticalDice.get(index) ?? 0) + (Number(entry.dice) || 0));
  }
  const components = resolved.map((component, index) => (criticalDice.get(index)
    ? {...component, metadata: {...(component.metadata ?? {}), criticalDice: criticalDice.get(index)}} : component));
  return mergeResolverRequest({
    components,
    saveOutcomePolicy: firstDefined(definition.damage.map(component => component.outcomePolicy?.saveOutcomePolicy ?? component.saveOutcomePolicy)),
    weaponSize: firstDefined(definition.damage.map(component => component.weaponSize)),
    context: {damageDefinitions: definition.damage}
  }, runtimeDamage && !runtimeDamage.components ? runtimeDamage : {...(runtimeDamage ?? {}), components});
}

function resolverRequestFromHealingDefinition(definition, runtimeHealing, evaluationContext) {
  if ( !definition.healing.length ) return runtimeHealing ?? null;
  const runtimeComponents = normalizeArray(runtimeHealing?.components);
  const components = definition.healing.map((component, index) => healingComponentForResolver({
    component,
    index,
    runtimeComponents,
    evaluationContext
  }));
  return mergeResolverRequest({
    components,
    context: {healingDefinitions: definition.healing}
  }, runtimeHealing && !runtimeHealing.components ? runtimeHealing : {...(runtimeHealing ?? {}), components});
}

function resolverRequestFromEffectsDefinition(definition, runtimeEffects) {
  if ( !definition.effects.length ) return runtimeEffects ?? null;
  const conditions = definition.effects
    .filter(effect => (effect.type === "condition") || (effect.type === "effect"))
    .map(effect => ({
      id: effect.id,
      conditionId: (effect.type === "effect") ? customEffectId(definition.id, effect) : (effect.conditionId ?? effect.ref),
      // A custom effect is a one-off condition: it carries its own definition, and V14 runs its native duration.
      ...((effect.type === "effect") ? {conditionDefinitions: {[customEffectId(definition.id, effect)]: {
        id: customEffectId(definition.id, effect), name: effect.name, img: effect.img ?? null, custom: true,
        // One that starts at several levels counts them down (Mirror Image's three duplicates).
        ...((effect.levels > 1) ? {stacking: true, maxLevel: effect.levels} : {stacking: false}),
        ruleElements: clonePlain(effect.ruleElements ?? []), duration: clonePlain(effect.duration ?? null),
        ...(effect.endsWhen ? {endsWhen: effect.endsWhen} : {}),
        // Applied again, a new one beside it rather than the old one refreshed (a second Dash: `stack: "separate"`).
        ...((effect.stack === "separate") ? {separate: true} : {}),
        // Actor#rest reads it from the applied effect (Resurrection Sickness, a Hit Point drain).
        ...(effect.restsLeft ? {restsLeft: effect.restsLeft} : {}),
        // Worked out for each creature as it lands, then written into its rules (stampEffectAmount).
        ...(effect.amount ? {amount: clonePlain(effect.amount)} : {})}}} : {}),
      levels: ((effect.type === "effect") && !(effect.levels > 1)) ? 1 : effect.levels,
      saveOutcomePolicy: effect.application?.saveOutcomePolicy ?? effect.saveOutcomePolicy ?? null,
      duration: (effect.type === "effect") ? null : (effect.duration ?? definition.duration),
      concentration: effect.concentration,
      // Only on a creature no bigger than this (Eldritch Smite's Prone), only on one its Action damaged (a fall's Prone).
      ...(effect.maxSize ? {maxSize: effect.maxSize} : {}),
      ...(effect.whenDamaged ? {whenDamaged: true} : {}),
      ...(effect.appliesTo === "source" ? {appliesTo: "source"} : {}),
      // Its source is the Action's user (the resolver's), never the Item: "until the start of your next turn" and
      // "frightened of you" name a creature. The Item is its origin.
      ...(effect.source ? {source: effect.source} : {}),
      origin: effect.origin ?? definition.source,
      metadata: {
        ...(effect.metadata ?? {}),
        actionDefinitionId: definition.id,
        effectDefinitionId: effect.id,
        // Its timing, and whether its creature taking damage repeats it too (Dominate Person); the Action's save stamps the
        // ability and DC when it resolves (action-pipeline-resolver.mjs).
        // A failed repeat's damage too (`damage`), as configured: a higher slot's dice reach it (applyScaleDamageEffect).
        ...((effect.repeatSave || effect.repeatOnDamage) ? {repeatSave: {...(effect.repeatSave ? {timing: effect.repeatSave} : {}),
          ...(effect.repeatOnDamage ? {onDamage: true} : {}), ...(effect.repeatDamage?.length ? {damage: clonePlain(effect.repeatDamage)} : {})}} : {})
      }
    }));
  return mergeResolverRequest({
    conditions,
    metadata: {actionDefinitionId: definition.id}
  }, runtimeEffects);
}

function damageComponentForResolver({component, index, runtimeComponents, evaluationContext}) {
  const overlay = componentRuntimeOverlay(component, index, runtimeComponents);
  // A table of dice (damage growing with level) is its row for this creature before anything is rolled.
  const expression = selectTableRows(overlay.expression ?? overlay.valueExpression ?? expressionFromAmountFields(overlay)
    ?? component.expression, evaluationContext);
  const amount = finiteNumber(overlay.amount ?? overlay.total ?? overlay.value)
    ?? evaluateComponentExpression(expression, evaluationContext);
  const dice = overlay.dice ?? diceFromExpression(expression);
  // Every die of it given up (a rider's forgone Sneak Attack d6s, on its planned component): nothing to roll.
  if ( dice && (Number(dice.number) === 0) ) return {id: component.id, amount: 0, dice: null, damageType: component.damageType,
    provenance: component.provenance, source: component.source, tags: component.tags,
    metadata: {...(component.metadata ?? {}), actionDefinitionComponent: {id: component.id, index}}};
  return {
    id: component.id,
    amount,
    dice,
    // A rolled sum ("1d8 + 3", "2d8 + mod(wits)") keeps its expression for the dice and its flat part as a bonus.
    ...((amount == null) ? {bonus: rolledBonus(expression, evaluationContext), ...(dice ? {} : {expression: clonePlain(expression)})} : {}),
    damageType: component.damageType,
    provenance: component.provenance,
    scalingCategory: component.scalingCategory,
    weaponSizeScalable: component.weaponSizeScalable,
    source: component.source,
    tags: component.tags,
    ...(component.ignoreResistance ? {ignoreResistance: true} : {}),
    ...(component.ignoreImmunity ? {ignoreImmunity: true} : {}),
    metadata: {
      ...(component.metadata ?? {}),
      ...(overlay.metadata ?? {}),
      actionDefinitionComponent: {
        id: component.id,
        index
      }
    }
  };
}

function healingComponentForResolver({component, index, runtimeComponents, evaluationContext}) {
  const overlay = componentRuntimeOverlay(component, index, runtimeComponents);
  // A table of dice (damage growing with level) is its row for this creature before anything is rolled.
  const expression = selectTableRows(overlay.expression ?? overlay.valueExpression ?? expressionFromAmountFields(overlay)
    ?? component.expression, evaluationContext);
  const amount = finiteNumber(overlay.amount ?? overlay.total ?? overlay.value)
    ?? evaluateComponentExpression(expression, evaluationContext);
  const dice = overlay.dice ?? diceFromExpression(expression);
  return {
    id: component.id,
    amount,
    dice,
    // A rolled sum ("1d8 + 3", "2d8 + mod(wits)") keeps its expression for the dice and its flat part as a bonus.
    ...((amount == null) ? {bonus: rolledBonus(expression, evaluationContext), ...(dice ? {} : {expression: clonePlain(expression)})} : {}),
    healingType: component.healingType,
    source: component.source,
    tags: component.tags,
    metadata: {
      ...(component.metadata ?? {}),
      ...(overlay.metadata ?? {}),
      actionDefinitionComponent: {
        id: component.id,
        index
      }
    }
  };
}

function componentRuntimeOverlay(component, index, runtimeComponents) {
  return runtimeComponents.find(candidate => candidate?.id && candidate.id === component.id)
    ?? runtimeComponents[index]
    ?? {};
}

function evaluateComponentExpression(expression, context) {
  if ( expression == null ) return null;
  const result = evaluateValueExpression(expression, context);
  return result.ok ? result.value : null;
}

function resolveSaveDCDefinition(dcDefinition, context) {
  if ( typeof dcDefinition === "number" ) return {value: dcDefinition};
  const valueExpression = dcDefinition.valueExpression ?? dcDefinition.expression ?? null;
  const value = finiteNumber(dcDefinition.value ?? dcDefinition.dc)
    ?? evaluateComponentExpression(valueExpression, context);
  return {
    ...clonePlain(dcDefinition),
    value
  };
}

function mergeResolverRequest(definitionRequest, runtimeRequest) {
  if ( !runtimeRequest ) return definitionRequest;
  return {
    ...definitionRequest,
    ...clonePlain(runtimeRequest),
    policy: {
      ...(definitionRequest.policy ?? {}),
      ...(runtimeRequest.policy ?? {})
    },
    eligibilityPolicy: {
      ...(definitionRequest.eligibilityPolicy ?? {}),
      ...(runtimeRequest.eligibilityPolicy ?? {})
    },
    refinementPolicy: {
      ...(definitionRequest.refinementPolicy ?? {}),
      ...(runtimeRequest.refinementPolicy ?? {})
    },
    metadata: {
      ...(definitionRequest.metadata ?? {}),
      ...(runtimeRequest.metadata ?? {})
    },
    context: {
      ...(definitionRequest.context ?? {}),
      ...(runtimeRequest.context ?? {})
    }
  };
}

function costRequirementForPayment(requirement) {
  return {
    capability: requirement.capability ?? requirement.type,
    amount: requirement.amount,
    unit: requirement.unit ?? null,
    ...(requirement.resourceId ? {resourceId: requirement.resourceId} : {})
  };
}

function validateTransform(transform, errors) {
  if ( !transform ) return;
  const named = [typeof transform.formRef === "string" && transform.formRef, typeof transform.choiceId === "string"
    && transform.choiceId, transform.revert === true].filter(Boolean);
  if ( named.length !== 1 ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "transform",
    "A transform names exactly one of formRef, choiceId or revert."));
}

function validateEnchant(enchant, errors) {
  if ( !enchant ) return;
  if ( (typeof enchant.choiceId !== "string") || !enchant.choiceId ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION,
    "enchant.choiceId", "An enchantment names the choice that picks its Item."));
  if ( !Array.isArray(enchant.effects) || !enchant.effects.length || enchant.effects.some(effect => !Array.isArray(effect?.ruleElements)) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "enchant.effects", "An enchantment has effects, each with its rules."));
  }
}

function validateSummon(summon, errors) {
  if ( !summon ) return;
  const named = [typeof summon.actorRef === "string" && summon.actorRef, typeof summon.choiceId === "string" && summon.choiceId]
    .filter(Boolean);
  if ( named.length !== 1 ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "summon",
    "A summon names exactly one of actorRef or choiceId."));
  const count = summon.count ?? 1;
  if ( !Number.isInteger(count) || (count < 1) || (count > 20) ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION,
    "summon.count", "A summon's count is a whole number from 1 to 20."));
  // Each creature's own count (Dancing Lights), a whole number or a ValueExpression worked out when cast.
  if ( (summon.counts != null) && (!Array.isArray(summon.counts) || summon.counts.some(entry => !entry?.actorRef || (entry.count == null))) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "summon.counts", "A summon's counts by creature are [{actorRef, count}]."));
  }
  // The creature types whose killed targets rise as the summon (Finger of Death: ["humanoid"]).
  if ( (summon.fromKilled != null) && (!Array.isArray(summon.fromKilled.types) || !summon.fromKilled.types.length
    || summon.fromKilled.types.some(type => (typeof type !== "string") || !type)) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "summon.fromKilled", "A summon's fromKilled is {types: [creature types]}."));
  }
  // The lasting area each summoned creature carries (Flaming Sphere's flames): an emanation around it that lasts as it
  // does, so it has no concentration, duration or object of its own.
  const area = summon.area;
  if ( area == null ) return;
  if ( !isPlainObject(area) || (area.shape !== "emanation") ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, "summon.area", "A summon's carried area is an emanation."));
    return;
  }
  if ( area.size ) validateDistanceDefinition(area.size, "summon.area.size", errors);
  const persistence = area.persistence ?? {};
  if ( (persistence.concentration === true) || (persistence.duration != null) || (persistence.onObject != null) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, "summon.area.persistence",
      "A summon's carried area lasts as its summon does: no concentration, duration or onObject of its own."));
  }
  validateAreaPersistence(persistence, errors, "summon.area.persistence");
}

/** The creature sizes, smallest first: a `maxSize` names one. */
export const CREATURE_SIZE_ORDER = Object.freeze(["tiny", "small", "medium", "large", "huge", "gargantuan"]);

/** A choice effect keeping one option's parts of those it lists (either spelling configuration reads). */
export const isKeepEffect = effect => ["keepEffect", "keep-effect"].includes(effect?.type ?? effect?.kind);

/**
 * A draw names one of its configuration choices and either a RollTable or dice. Each option of a rolled choice has a whole
 * `range` of results; `again` (more rolls, its own range rerolled) is a whole number from 1, and its range must leave some
 * result to land on, or it would reroll forever. A rolled choice is never applied as a selection, so what its options do
 * is its keepEffect only: any other effect on it would silently do nothing.
 */
function validateDraw(definition, errors) {
  const draw = definition.draw;
  if ( !draw ) return;
  const fail = message => errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "draw", message));
  if ( !draw.table === !draw.formula ) return fail("A draw has a table or a formula, not both.");
  const choice = definition.configuration.find(entry => entry?.id === draw.choiceId);
  if ( !choice ) return fail("A draw names the configuration choice it fills (choiceId).");
  if ( !draw.formula ) return;
  const bounds = simpleFormulaBounds(draw.formula);
  if ( !bounds ) return fail("A draw's formula is dice and whole numbers (1d8, 1d100).");
  if ( !(choice.effects ?? []).every(isKeepEffect) || (choice.options ?? []).some(option => option?.effects?.length) ) {
    return fail("What a rolled draw's options do is its choice's keepEffect only.");
  }
  for ( const option of choice.options ?? [] ) {
    const [lo, hi] = Array.isArray(option?.range) ? option.range : [];
    if ( !Number.isInteger(lo) || !Number.isInteger(hi) || (lo > hi) ) return fail("Each option of a rolled draw has a range [low, high].");
    if ( option.again == null ) continue;
    if ( !Number.isInteger(option.again) || (option.again < 1) ) return fail("An option's again is a whole number from 1.");
    if ( (lo <= bounds.min) && (hi >= bounds.max) ) return fail("An option rolling again must leave some result to land on.");
  }
}

/**
 * An option its dice draw may use another Action of its creature (`useAction`: that Action's definition id, a Beholder's
 * Eye Rays' ray), which runs once the Action completes, paying nothing. Only a drawn option: a picked one would make
 * any limited Action free at its user's pick.
 */
function validateUseAction(definition, errors) {
  (definition.configuration ?? []).forEach((choice, index) => (choice?.options ?? []).forEach((option, at) => {
    if ( option?.useAction == null ) return;
    const path = `configuration.${index}.options.${at}.useAction`;
    const drawn = Boolean(definition.draw?.formula) && (choice.id === definition.draw.choiceId);
    if ( !drawn ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, path, "Only a drawn option uses another Action."));
    else if ( (typeof option.useAction !== "string") || !option.useAction || (option.useAction === definition.id) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, path, "An option uses another Action by its definition id."));
    }
  }));
}

function validatePush(push, errors, targeting) {
  if ( !push ) return;
  if ( !(Number(push.distance) > 0) ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.distance",
    "A push moves its creature a positive number of feet."));
  if ( (push.maxSize != null) && !CREATURE_SIZE_ORDER.includes(push.maxSize) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.maxSize", `Unknown creature size: ${push.maxSize}`));
  }
  if ( (push.on != null) && !["failure", "success"].includes(push.on) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.on", "A push is on a failed or a successful save."));
  }
  if ( (push.choose != null) && !["space", "line"].includes(push.choose) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.choose", "An aimed push lands on a chosen space or on its line."));
  }
  // Its user aims one creature's landing.
  if ( (push.choose != null) && !((targeting?.type === "single") && ([1, null, undefined].includes(targeting.count))) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.choose", "An aimed push moves one target."));
  }
  if ( (push.inRange != null) && (typeof push.inRange !== "boolean") ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.inRange", "inRange is true or false."));
  }
}

function validateTargetChoice(choice, errors) {
  if ( !choice ) return;
  if ( !["self", "trigger-source", "trigger-target", "creatures", "around"].includes(choice.from) ) errors.push(error(
    ACTION_DEFINITION_CODES.INVALID_DEFINITION, "targetChoice.from", `Unknown reaction target: ${choice.from}`));
  // Its creatures are the ones within `range`: no default distance stands in for a missing one.
  if ( (choice.from === "creatures") && !(Number(choice.range) > 0) ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION,
    "targetChoice.range", "A reaction picking its creature names a positive number of feet."));
}

function validateCosts(costs, errors, prefix="costs") {
  for ( const {requirement, path} of costRequirementEntries(costs, prefix) ) {
    if ( !requirement.capability ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_COST, `${path}.capability`, "Cost requirement needs a capability or resource id."));
    }
    if ( !Number.isFinite(requirement.amount) || requirement.amount < 0 ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_COST, `${path}.amount`, "Cost amount must be a non-negative finite number."));
    }
    validatePredicate(requirement.predicate, `${path}.predicate`, errors);
  }
}

function validatePredicateCandidates(definition, errors) {
  const candidates = [
    {value: definition.targeting?.predicate, path: "targeting.predicate"},
    {value: definition.targeting?.eligibilityPolicy?.predicate, path: "targeting.eligibilityPolicy.predicate"},
    {value: definition.targeting?.refinementPolicy?.predicate, path: "targeting.refinementPolicy.predicate"},
    {value: definition.targeting?.refinementPolicy?.selectionPredicate, path: "targeting.refinementPolicy.selectionPredicate"},
    {value: definition.targeting?.refinementPolicy?.defaultPredicate, path: "targeting.refinementPolicy.defaultPredicate"},
    ...definition.damage.map((component, index) => ({value: component.predicate, path: `damage.${index}.predicate`})),
    ...definition.healing.map((component, index) => ({value: component.predicate, path: `healing.${index}.predicate`})),
    ...definition.effects.map((effect, index) => ({value: effect.predicate, path: `effects.${index}.predicate`})),
    {value: definition.requires, path: "requires"}
  ];
  for ( const candidate of candidates ) validatePredicate(candidate.value, candidate.path, errors);
}

function validatePredicate(predicate, path, errors) {
  if ( predicate == null ) return;
  const result = evaluatePredicate(predicate, {});
  if ( result.code === PREDICATE_CODES.INVALID ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_PREDICATE, path, result.reason));
  }
}

function validateTargeting(definition, errors) {
  const targeting = definition.targeting;
  if ( !targeting ) return;
  if ( targeting.type === ACTION_TARGETING_TYPES.AREA && !definition.area ) {
    errors.push(error(ACTION_DEFINITION_CODES.MISSING_AREA_DEFINITION, "area", "Area targeting requires an AreaDefinition."));
  }
  if ( (targeting.sourceCondition != null) && ((typeof targeting.sourceCondition !== "string") || !targeting.sourceCondition) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "targeting.sourceCondition", "A held target names a condition id."));
  }
  validateValueExpressionShape(targeting.count, "targeting.count", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.minSelections, "targeting.refinementPolicy.minSelections", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.maxSelections, "targeting.refinementPolicy.maxSelections", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.minChoices, "targeting.refinementPolicy.minChoices", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.maxChoices, "targeting.refinementPolicy.maxChoices", errors);
}

function validateArea(area, errors) {
  if ( !area ) return;
  if ( !area.shape ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, "area.shape", "AreaDefinition requires a semantic shape."));
  }
  if ( area.size ) validateDistanceDefinition(area.size, "area.size", errors);
  // How high it reaches (a Cylinder's height, a wall's; a circle on the ground is 0), areas.md.
  if ( area.height ) validateDistanceDefinition(area.height, "area.height", errors);
  if ( area.persistence ) validateAreaPersistence(area.persistence, errors);
}

/** Events a lasting area answers; each trigger's `action` resolves against the affected creature. */
export const AREA_PERSISTENCE_EVENTS = Object.freeze(["area.entered", "area.exited", "area.moved", "turn.started", "turn.ended"]);

/**
 * A lasting area: `{duration: {unit: "round", value}, concentration, oncePerTurn, elevation: {bottom, top},
 * triggers: [{on: [...events], once?: "turn", per?: feet, action: ActionDefinition}], light?: {bright, dim, sunlight, darkness, dispels, spellLevel},
 * onObject?: <configuration choice id>, obscures?: "heavily", budget?: {damage}}`. Elevation is relative to the floor of the caster's Level; a
 * missing bound is open. `light` is shed from its center (Daylight, Darkness); when the `onObject` choice is chosen, the
 * area surrounds the Token at its center and follows it. `obscures` hides those in it from sight (Fog Cloud). A trigger on
 * `area.moved` acts on each step moved in the area; with `per` its damage is once for every `per` feet of it (Spike Growth).
 */
function validateAreaPersistence(persistence, errors, path="area.persistence") {
  const fail = (at, reason) => errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, `${path}${at}`, reason));
  if ( !isPlainObject(persistence) ) return fail("", "A lasting area must be a structured object.");
  const duration = persistence.duration;
  if ( duration != null && !((duration.unit === "round") && Number.isInteger(Number(duration.value)) && (Number(duration.value) > 0)) ) {
    fail(".duration", "A lasting area's duration is a positive whole number of rounds.");
  }
  // Whom its triggers affect: everyone in it (the default), or only its caster's enemies (Spirit Guardians).
  if ( (persistence.affects != null) && (persistence.affects !== "enemies") ) fail(".affects", "A lasting area affects everyone or \"enemies\".");
  if ( (persistence.obscures != null) && (persistence.obscures !== "heavily") ) fail(".obscures", "A lasting area obscures \"heavily\" or not at all.");
  // It ends once its triggers have dealt this much damage in all (Guardian of Faith's 60).
  const budget = persistence.budget;
  if ( (budget != null) && !(isPlainObject(budget) && Number.isInteger(budget.damage) && (budget.damage > 0)) ) {
    fail(".budget", "A lasting area's budget is {damage: a positive whole number}.");
  }
  // Difficult Terrain of some kinds (`{types: ["web"]}`), or of none named.
  const terrain = persistence.difficultTerrain;
  if ( (terrain != null) && (!isPlainObject(terrain) || ((terrain.types != null) && !Array.isArray(terrain.types))) ) {
    fail(".difficultTerrain", "Difficult Terrain is {types: [its kinds]}.");
  }
  const light = persistence.light;
  if ( (light != null) && (!isPlainObject(light) || ["bright", "dim"].some(key => (light[key] != null)
    && !(Number.isFinite(Number(light[key])) && (Number(light[key]) >= 0)))) ) {
    fail(".light", "A lasting area's light has a bright and a dim radius of 0 or more.");
  }
  const {bottom=null, top=null} = persistence.elevation ?? {};
  if ( [bottom, top].some(value => (value !== null) && !Number.isFinite(Number(value))) ) {
    fail(".elevation", "Elevation bounds must be numbers or null.");
  } else if ( (bottom !== null) && (top !== null) && (Number(bottom) > Number(top)) ) {
    fail(".elevation", "Elevation bottom may not be above its top.");
  }
  normalizeArray(persistence.triggers).forEach((trigger, index) => {
    const on = normalizeArray(trigger?.on);
    if ( !on.length || on.some(event => !AREA_PERSISTENCE_EVENTS.includes(event)) ) {
      fail(`.triggers.${index}.on`, `A lasting area answers ${AREA_PERSISTENCE_EVENTS.join(", ")}.`);
    }
    if ( (trigger?.once != null) && (trigger.once !== "turn") ) {
      fail(`.triggers.${index}.once`, "A lasting area's trigger is once a turn on its own record (\"turn\") or shares the area's.");
    }
    if ( (trigger?.per != null) && !(Number.isFinite(Number(trigger.per)) && (Number(trigger.per) > 0)) ) {
      fail(`.triggers.${index}.per`, "A trigger repeats once for every positive number of feet.");
    }
    const action = validateActionDefinition(trigger?.action ?? null);
    if ( !action.ok ) fail(`.triggers.${index}.action`, action.errors?.[0]?.reason ?? action.reason ?? "Invalid ActionDefinition.");
  });
}

function validateAttack(attack, errors) {
  if ( !attack ) return;
  if ( !attack.type ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_ATTACK, "attack.type", "AttackDefinition requires an attack type."));
  }
  if ( !attack.statistic && !attack.ability && !attack.statisticSource ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_ATTACK, "attack.statistic", "AttackDefinition requires a statistic or ability source."));
  }
  // Weapon properties, such as "finesse" (the better of Might and Agility).
  if ( (attack.properties !== undefined) && (!Array.isArray(attack.properties) || attack.properties.some(entry => typeof entry !== "string")) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_ATTACK, "attack.properties", "AttackDefinition properties must be a list of names."));
  }
}

function validateSave(save, errors) {
  if ( !save ) return;
  if ( !save.ability && !save.saveKey ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_SAVE, "save.ability", "SaveDefinition requires a save ability/key."));
  }
  if ( !save.dc ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_SAVE, "save.dc", "SaveDefinition requires a DC source."));
  }
  validateValueExpressionShape(save.dc?.valueExpression ?? save.dc?.expression, "save.dc.valueExpression", errors);
}

/** The acting creature's own ability check against a DC (2024: stabilizing, hiding, escaping a grapple). */
function validateCheck(check, errors) {
  if ( !check ) return;
  if ( !check.ability && !check.skill ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_CHECK, "check.ability", "CheckDefinition requires an ability or skill."));
  }
  if ( !check.dc ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_CHECK, "check.dc", "CheckDefinition requires a DC source."));
  validateValueExpressionShape(check.dc?.valueExpression ?? check.dc?.expression, "check.dc.valueExpression", errors);
}

function validateDamage(components, errors, prefix="damage") {
  components.forEach((component, index) => {
    const path = `${prefix}.${index}`;
    if ( !isValidDamageType(component.damageType) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_DAMAGE_TYPE, `${path}.damageType`, "Damage type must be a stable slug."));
    }
    if ( component.expression == null ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_DAMAGE, `${path}.expression`, "Damage component requires a ValueExpression."));
    }
    validateValueExpressionShape(component.expression, `${path}.expression`, errors);
  });
}

function validateHealing(components, errors) {
  components.forEach((component, index) => {
    const path = `healing.${index}`;
    if ( !component.healingType ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_HEALING, `${path}.healingType`, "Healing component requires a healing type."));
    }
    if ( component.expression == null ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_HEALING, `${path}.expression`, "Healing component requires a ValueExpression."));
    }
    validateValueExpressionShape(component.expression, `${path}.expression`, errors);
  });
}

function validateEffects(effects, errors, {conditionDefinitions=null, effectDefinitions=null}={}) {
  effects.forEach((effect, index) => {
    const path = `effects.${index}`;
    if ( (effect.maxSize != null) && !CREATURE_SIZE_ORDER.includes(effect.maxSize) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.maxSize`, `Unknown creature size: ${effect.maxSize}`));
    }
    if ( (effect.repeatSave != null) && !REPEAT_SAVE_TIMINGS.includes(effect.repeatSave) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.repeatSave`,
        `An effect's save is repeated at: ${REPEAT_SAVE_TIMINGS.join(", ")}.`));
    }
    // The damage a failed repeat of its save deals (Phantasmal Killer): only beside a save repeated at a turn boundary (one
    // its damage repeated would repeat on that damage again).
    if ( effect.repeatDamage?.length ) {
      if ( !effect.repeatSave ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.repeatDamage`,
        "An effect's repeatDamage needs repeatSave."));
      validateDamage(effect.repeatDamage, errors, `${path}.repeatDamage`);
    }
    if ( effect.type === "effect" ) return validateCustomEffect(effect, path, errors);
    if ( effect.type === "condition" ) {
      if ( !effect.conditionId ) {
        errors.push(error(ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE, `${path}.conditionId`, "Condition effect requires a condition id."));
      } else if ( conditionDefinitions && !hasDefinitionKey(conditionDefinitions, effect.conditionId) ) {
        errors.push(error(ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE, `${path}.conditionId`, `Unknown condition effect: ${effect.conditionId}`));
      }
      return;
    }
    // An effect by reference is not applied when an Action runs, so it is refused rather than silently dropped.
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.type`,
      `Effects are a condition or a custom effect; "${effect.type}" is not supported.`));
  });
}

/** A custom effect (a buff or debuff with its own rules): a name, rules the engine knows, and a V14 duration. */
function validateCustomEffect(effect, path, errors) {
  if ( !effect.name ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.name`, "A custom effect needs a name."));
  if ( effect.slug && Object.hasOwn(WILDPATH.CONDITIONS, effect.slug) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.slug`, `"${effect.slug}" is a built-in condition.`));
  }
  (effect.ruleElements ?? []).forEach((ruleElement, ruleIndex) => {
    const validation = validateRuleElementDefinition(ruleElement, {index: ruleIndex});
    if ( !validation.ok ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT, `${path}.ruleElements.${ruleIndex}`, validation.reason ?? validation.code));
    } else if ( !DEFAULT_RULE_ELEMENT_REGISTRY.has(validation.ruleElement.type) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT, `${path}.ruleElements.${ruleIndex}`,
        `Unknown RuleElement type: ${ruleElement.type}`));
    }
  });
  if ( (effect.endsWhen != null) && !CUSTOM_EFFECT_ENDS_WHEN.includes(effect.endsWhen) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.endsWhen`,
      `A custom effect ends early only when: ${CUSTOM_EFFECT_ENDS_WHEN.join(", ")}.`));
  }
  if ( effect.amount ) validateEffectAmount(effect.amount, `${path}.amount`, errors);
  const duration = effect.duration;
  if ( duration && duration.units && !CUSTOM_EFFECT_DURATION_UNITS.includes(duration.units) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.duration.units`, `Unknown duration unit: ${duration.units}`));
  }
  if ( duration && duration.expiry && !CUSTOM_EFFECT_EXPIRY_EVENTS.includes(duration.expiry) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.duration.expiry`, `Unknown duration expiry: ${duration.expiry}`));
  }
}

/**
 * An effect's amount, worked out for each creature as it lands: the damage its Action dealt it (`damage`: "all", or the
 * damage types counted), or dice its Action's user rolls (`formula`); at most `cap` (a ValueExpression over that creature).
 */
function validateEffectAmount(amount, path, errors) {
  const fail = message => errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, path, message));
  if ( (amount.damage == null) === (amount.formula == null) ) return fail("An effect's amount is its damage taken or a formula, not both.");
  if ( (amount.damage != null) && (amount.damage !== "all")
    && !(Array.isArray(amount.damage) && amount.damage.length && amount.damage.every(type => typeof type === "string")) ) {
    return fail("An effect's damage amount is \"all\" or a list of damage types.");
  }
  if ( (amount.formula != null) && !simpleFormulaBounds(amount.formula) ) return fail("An effect's amount formula is dice and whole numbers (3d6).");
  validateValueExpressionShape(amount.cap, `${path}.cap`, errors);
}

function validateRuleElements(ruleElements, errors) {
  ruleElements.forEach((ruleElement, index) => {
    const validation = validateRuleElementDefinition(ruleElement, {
      source: null,
      index
    });
    if ( !validation.ok ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT, `ruleElements.${index}`, validation.reason ?? validation.code));
    } else if ( validation.code !== RULE_ELEMENT_CODES.OK ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT, `ruleElements.${index}`, validation.reason ?? validation.code));
    }
  });
}

function validateValueExpressionShape(expression, path, errors) {
  if ( expression == null ) return;
  const result = validateExpressionShape(expression);
  if ( !result.ok ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_VALUE_EXPRESSION, path, result.reason));
}

function validateExpressionShape(expression) {
  if ( typeof expression === "number" ) {
    return Number.isFinite(expression)
      ? {ok: true}
      : {ok: false, reason: "ValueExpression number must be finite."};
  }
  if ( !isPlainObject(expression) ) return {ok: false, reason: "ValueExpression must be a number or structured object."};

  switch ( expression.type ) {
    case "constant":
      return Number.isFinite(Number(expression.value))
        ? {ok: true}
        : {ok: false, reason: "Constant ValueExpression must be numeric."};
    case "context":
      return stringOrNull(expression.path)
        ? {ok: true}
        : {ok: false, reason: "Context ValueExpression requires a path."};
    case "ability-score":
    case "abilityScore":
    case "ability-modifier":
    case "abilityModifier":
      return stringOrNull(expression.ability ?? expression.key ?? expression.slug)
        ? {ok: true}
        : {ok: false, reason: "Ability ValueExpression requires an ability key."};
    case "proficiency-bonus":
    case "proficiencyBonus":
    case "controller-proficiency-bonus":
    case "character-level":
    case "characterLevel":
    case "spellcasting-modifier":
    case "spellcastingModifier":
      return {ok: true};
    case "class-level":
    case "classLevel":
      return {ok: true};
    case "resource-current":
    case "resourceCurrent":
    case "resource-max":
    case "resourceMax":
      return stringOrNull(expression.resource ?? expression.resourceId ?? expression.id ?? expression.key)
        ? {ok: true}
        : {ok: false, reason: "Resource ValueExpression requires a resource id."};
    case "add":
    case "multiply":
    case "min":
    case "max":
      return validateExpressionTerms(expression.terms ?? []);
    case "subtract":
      return Array.isArray(expression.terms)
        ? validateExpressionTerms(expression.terms)
        : validateExpressionTerms([expression.left ?? expression.value ?? 0, expression.right ?? expression.minus ?? 0]);
    case "divide":
      return validateExpressionTerms([expression.numerator ?? expression.left, expression.denominator ?? expression.right]);
    case "floor":
    case "ceil":
      return validateExpressionShape(expression.value);
    case "dice":
      return validateDiceExpressionShape(expression);
    case "table": {
      const rows = Object.entries(isPlainObject(expression.rows) ? expression.rows : {});
      if ( !rows.length || rows.some(([threshold]) => !Number.isFinite(Number(threshold))) ) {
        return {ok: false, reason: "Table ValueExpression requires rows keyed by numeric thresholds."};
      }
      for ( const nested of [expression.key, ...rows.map(([, value]) => value), expression.default] ) {
        if ( nested === undefined ) continue;
        const result = validateExpressionShape(nested);
        if ( !result.ok ) return result;
      }
      return expression.key == null ? {ok: false, reason: "Table ValueExpression requires a key."} : {ok: true};
    }
    default:
      return {ok: false, reason: `Unknown ValueExpression type: ${expression.type}`};
  }
}

function validateExpressionTerms(terms) {
  if ( !Array.isArray(terms) ) return {ok: false, reason: "ValueExpression terms must be an array."};
  for ( const term of terms ) {
    const result = validateExpressionShape(term);
    if ( !result.ok ) return result;
  }
  return {ok: true};
}

function validateDiceExpressionShape(expression) {
  // A count worked out when rolled (Divine Spark's dice by Cleric level, a summon's by cast level) is an expression.
  const counted = expression.number ?? expression.count;
  if ( counted && (typeof counted === "object") ) {
    const shape = validateExpressionShape(counted);
    if ( !shape.ok ) return shape;
  }
  const number = (counted && (typeof counted === "object")) ? 1 : finiteNumber(counted ?? 1);
  const faces = finiteNumber(expression.faces ?? expression.sides);
  if ( number == null || faces == null || number < 0 || faces <= 0 ) {
    return {ok: false, reason: "Dice ValueExpression requires non-negative dice count and positive faces."};
  }
  return validateExpressionShape(expression.bonus ?? 0);
}

function normalizeOriginDefinition(origin) {
  if ( !origin ) return {type: ACTION_ORIGIN_TYPES.SELF};
  if ( typeof origin === "string" ) return {type: origin};
  return {
    type: stringOrDefault(origin.type ?? origin.policy, ACTION_ORIGIN_TYPES.SELF),
    ref: stringOrNull(origin.ref ?? origin.sourceRef),
    predicate: clonePlain(origin.predicate ?? null),
    metadata: clonePlain(origin.metadata ?? {}) ?? {}
  };
}

function normalizeActivationDefinition(activation) {
  if ( !activation ) return null;
  if ( typeof activation === "string" ) return {type: activation};
  return clonePlain({
    type: stringOrNull(activation.type ?? activation.capability),
    timing: stringOrNull(activation.timing),
    trigger: clonePlain(activation.trigger ?? null),
    metadata: clonePlain(activation.metadata ?? {}) ?? {}
  });
}

function normalizeCostDefinition(costs) {
  if ( Array.isArray(costs) ) return {allOf: costs.map(normalizeCostRequirement)};
  if ( !costs || !isPlainObject(costs) ) return {allOf: []};
  if ( Array.isArray(costs.anyOf) ) {
    return {
      anyOf: costs.anyOf.map(branch => normalizeCostBranch(branch))
    };
  }
  const requirements = costs.allOf ?? costs.requirements ?? (hasCostRequirementShape(costs) ? [costs] : []);
  return {
    allOf: normalizeArray(requirements).map(normalizeCostRequirement)
  };
}

function normalizeCostBranch(branch) {
  if ( Array.isArray(branch) ) return branch.map(normalizeCostRequirement);
  if ( isPlainObject(branch) && Array.isArray(branch.allOf) ) return branch.allOf.map(normalizeCostRequirement);
  return hasCostRequirementShape(branch) ? [normalizeCostRequirement(branch)] : [];
}

function normalizeCostRequirement(requirement={}) {
  const capability = requirement.capability
    ?? requirement.resourceId
    ?? requirement.resource
    ?? requirement.pool
    ?? requirement.type;
  return {
    type: stringOrDefault(requirement.kind ?? requirement.costType ?? (requirement.resourceId || requirement.resource ? "resource" : "actionEconomy"), "actionEconomy"),
    capability: stringOrNull(capability),
    amount: finiteNumber(requirement.amount ?? 1),
    unit: stringOrNull(requirement.unit),
    predicate: clonePlain(requirement.predicate ?? null),
    source: clonePlain(requirement.source ?? null),
    metadata: clonePlain(requirement.metadata ?? {}) ?? {}
  };
}

function normalizeRangeDefinition(range) {
  if ( !range ) return null;
  if ( typeof range === "string" ) return {type: range};
  return clonePlain({
    type: stringOrDefault(range.type ?? range.mode, ACTION_RANGE_TYPES.SPECIAL),
    distance: normalizeDistanceDefinition(range.distance ?? range.value),
    normal: normalizeDistanceDefinition(range.normal ?? range.normalRange),
    long: normalizeDistanceDefinition(range.long ?? range.longRange),
    unit: stringOrNull(range.unit),
    metadata: clonePlain(range.metadata ?? {}) ?? {}
  });
}

function normalizeTargetingDefinition(targeting) {
  if ( !targeting ) return null;
  if ( typeof targeting === "string" ) return {type: targeting, required: targeting !== ACTION_TARGETING_TYPES.NONE};
  const type = stringOrDefault(targeting.type ?? targeting.mode, ACTION_TARGETING_TYPES.SINGLE);
  return {
    type,
    // An area's placement decides its targets; an area that catches nobody still happens.
    required: targeting.required ?? ![ACTION_TARGETING_TYPES.NONE, ACTION_TARGETING_TYPES.AREA].includes(type),
    count: targeting.count ?? targeting.targetCount ?? targeting.maxTargets ?? null,
    targetPolicy: stringOrNull(targeting.targetPolicy ?? targeting.target),
    predicate: clonePlain(targeting.predicate ?? null),
    eligibilityPolicy: clonePlain(targeting.eligibilityPolicy ?? targeting.eligibility ?? {}) ?? {},
    refinementPolicy: clonePlain(targeting.refinementPolicy ?? targeting.refinement ?? {}) ?? {},
    // How many sizes larger than its source a target may be (2024 Grapple and Shove: one).
    ...(Number.isFinite(Number(targeting.maxSizeAboveSource)) && (targeting.maxSizeAboveSource !== null)
      ? {maxSizeAboveSource: Number(targeting.maxSizeAboveSource)} : {}),
    // A target may not be hostile to its source ("a willing creature": Heightened Focus' carry).
    ...(targeting.notHostile === true ? {notHostile: true} : {}),
    // ... nor its source itself (Help aids another creature).
    ...(targeting.notSelf === true ? {notSelf: true} : {}),
    // ... and has this condition from its source (Reel: "each creature Grappled by it").
    ...(targeting.sourceCondition != null ? {sourceCondition: targeting.sourceCondition} : {}),
    // ... and is its source when none is chosen (a potion drunk unless given to another).
    ...(targeting.selfIfNone === true ? {selfIfNone: true} : {}),
    // Its count may go to one creature more than once, each a separate hit ("direct them to hit one creature or several"),
    // with its own attack roll when it has an attack ("Make a separate attack roll for each beam").
    ...(targeting.repeatable === true ? {repeatable: true} : {}),
    metadata: clonePlain(targeting.metadata ?? {}) ?? {}
  };
}

function normalizeAreaDefinition(area) {
  if ( !area ) return null;
  if ( typeof area === "string" ) return {shape: area};
  return clonePlain({
    shape: stringOrNull(area.shape ?? area.type),
    size: normalizeDistanceDefinition(area.size ?? area.radius ?? area.length),
    width: normalizeDistanceDefinition(area.width),
    placement: clonePlain(area.placement ?? area.placementPolicy ?? null),
    persistence: clonePlain(area.persistence ?? null),
    targetPolicy: clonePlain(area.targetPolicy ?? null),
    metadata: clonePlain(area.metadata ?? {}) ?? {}
  });
}

/** A damage part's ValueExpression, whichever of its accepted spellings it is written in. */
export function damageExpressionOf(component={}) {
  return component.expression
    ?? component.valueExpression
    ?? expressionFromAmountFields(component)
    ?? (component.dice ? {type: "dice", ...clonePlain(component.dice)} : null);
}

function normalizeDamageDefinition(component={}, index=0) {
  const expression = damageExpressionOf(component);
  return {
    id: stringOrDefault(component.id ?? component.slug, `damage:${index}`),
    expression: clonePlain(expression),
    damageType: stringOrDefault(component.damageType ?? component.type, "untyped"),
    provenance: stringOrDefault(component.provenance ?? component.category, "unknown"),
    scalingCategory: stringOrDefault(component.scalingCategory, component.weaponSizeScalable ? "weapon-size" : "none"),
    weaponSizeScalable: component.weaponSizeScalable ?? component.scalingCategory === "weapon-size",
    outcomePolicy: clonePlain(component.outcomePolicy ?? {}) ?? {},
    saveOutcomePolicy: clonePlain(component.saveOutcomePolicy ?? null),
    checkOutcomePolicy: stringOrNull(component.checkOutcomePolicy),
    weaponSize: clonePlain(component.weaponSize ?? component.weaponSizeContext ?? null),
    predicate: clonePlain(component.predicate ?? null),
    targetPolicy: stringOrDefault(component.targetPolicy ?? component.target, "selected"),
    scaling: clonePlain(component.scaling ?? {}) ?? {},
    source: clonePlain(component.source ?? null),
    tags: normalizeStrings(component.tags),
    metadata: clonePlain(component.metadata ?? {}) ?? {},
    ...(component.ignoreResistance === true ? {ignoreResistance: true} : {}),
    ...(component.ignoreImmunity === true ? {ignoreImmunity: true} : {})
  };
}

function normalizeHealingDefinition(component={}, index=0) {
  const expression = component.expression
    ?? component.valueExpression
    ?? expressionFromAmountFields(component)
    ?? (component.dice ? {type: "dice", ...clonePlain(component.dice)} : null);
  return {
    id: stringOrDefault(component.id ?? component.slug, `healing:${index}`),
    expression: clonePlain(expression),
    healingType: stringOrDefault(component.healingType ?? component.type, "healing"),
    checkOutcomePolicy: stringOrNull(component.checkOutcomePolicy),
    targetPolicy: stringOrDefault(component.targetPolicy ?? component.target, "selected"),
    predicate: clonePlain(component.predicate ?? null),
    scaling: clonePlain(component.scaling ?? {}) ?? {},
    source: clonePlain(component.source ?? null),
    tags: normalizeStrings(component.tags),
    metadata: clonePlain(component.metadata ?? {}) ?? {}
  };
}

function normalizeEffectApplicationDefinition(effect={}, index=0) {
  const type = stringOrDefault(effect.type ?? effect.effectType, effect.conditionId ? "condition" : "ref");
  return {
    id: stringOrDefault(effect.id ?? effect.slug, `effect:${index}`),
    type,
    ref: stringOrNull(effect.ref ?? effect.effectRef ?? effect.effectId),
    conditionId: stringOrNull(effect.conditionId ?? (type === "condition" ? effect.ref : null)),
    levels: finiteNumber(effect.levels ?? effect.delta ?? effect.levelDelta ?? 1) ?? 1,
    application: clonePlain(effect.application ?? {}) ?? {},
    duration: normalizeDurationDefinition(effect.duration),
    concentration: clonePlain(effect.concentration ?? null),
    saveOutcomePolicy: clonePlain(effect.saveOutcomePolicy ?? effect.savePolicy ?? null),
    checkOutcomePolicy: stringOrNull(effect.checkOutcomePolicy),
    ...(type === "effect" ? {name: stringOrNull(effect.name), img: stringOrNull(effect.img), slug: stringOrNull(effect.slug),
      ruleElements: normalizeArray(effect.ruleElements).map(clonePlain),
      // It ends after the next attack against its creature (Help, Guiding Bolt), else with its duration.
      ...(effect.endsWhen ? {endsWhen: String(effect.endsWhen)} : {}),
      ...((effect.stack === "separate") ? {stack: "separate"} : {}),
      // It ends after this many of its creature's Long Rests (Resurrection Sickness): Actor#rest.
      ...((Number.isInteger(effect.restsLeft) && (effect.restsLeft > 0)) ? {restsLeft: effect.restsLeft} : {}),
      // A number worked out as it lands, which its rules read as `{type: "context", path: "amount"}` (a Hit Point drain).
      ...(effect.amount ? {amount: clonePlain(effect.amount)} : {}),
      // A RollTable its creature draws as each of its turns starts (Confusion's behavior): the automation dispatcher.
      ...(effect.drawsAtTurnStart ? {drawsAtTurnStart: String(effect.drawsAtTurnStart)} : {})} : {}),
    ...(effect.repeatSave ? {repeatSave: String(effect.repeatSave)} : {}),
    ...(effect.repeatOnDamage === true ? {repeatOnDamage: true} : {}),
    ...(normalizeArray(effect.repeatDamage).length ? {repeatDamage: normalizeArray(effect.repeatDamage).map(normalizeDamageDefinition)} : {}),
    // Only on a creature no bigger than this (Eldritch Smite's Prone: Huge or smaller).
    ...(effect.maxSize ? {maxSize: String(effect.maxSize)} : {}),
    // Only on a creature its Action damaged (a fall's Prone: "unless it avoids taking damage from the fall").
    ...(effect.whenDamaged === true ? {whenDamaged: true} : {}),
    // On the creature using the Action, whoever it targets (Resurrection's Taxing Cast: its caster is Spell Taxed).
    ...(effect.appliesTo === "source" ? {appliesTo: "source"} : {}),
    predicate: clonePlain(effect.predicate ?? null),
    source: clonePlain(effect.source ?? null),
    origin: clonePlain(effect.origin ?? null),
    metadata: clonePlain(effect.metadata ?? {}) ?? {}
  };
}

function normalizeDurationDefinition(duration) {
  if ( !duration ) return null;
  if ( typeof duration === "string" ) return {type: duration};
  if ( typeof duration === "number" ) return {type: "rounds", value: duration};
  return clonePlain(duration);
}

function normalizePlainComponent(value) {
  if ( !value ) return null;
  return clonePlain(value);
}

function normalizeDistanceDefinition(value) {
  if ( value == null ) return null;
  if ( typeof value === "number" ) return {value, unit: "ft"};
  if ( typeof value === "string" ) return {type: value};
  return clonePlain(value);
}

function validateDistanceDefinition(distance, path, errors) {
  if ( !distance ) return;
  const hasValue = distance.value != null;
  if ( hasValue && (!Number.isFinite(Number(distance.value)) || Number(distance.value) < 0) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, `${path}.value`, "Distance values must be non-negative finite numbers."));
  }
}

function expressionFromAmountFields(component) {
  const amount = finiteNumber(component.amount ?? component.total ?? component.value);
  return amount == null ? null : {type: "constant", value: amount};
}

/** The flat part of a rolled expression: what "1d8 + 3" or "1d8 + mod(might)" adds after its dice. */
function rolledBonus(expression, context) {
  if ( !expression || (typeof expression !== "object") ) return 0;
  if ( expression.type === "dice" ) return finiteNumber(expression.bonus) ?? 0;
  const terms = Array.isArray(expression.terms) ? expression.terms : [];
  const part = term => (containsDice(term) ? rolledBonus(term, context) : (evaluateComponentExpression(term, context) ?? 0));
  if ( expression.type === "add" ) return terms.reduce((sum, term) => sum + part(term), 0);
  if ( (expression.type === "subtract") && terms.length ) return terms.slice(1).reduce((sum, term) => sum - part(term), part(terms[0]));
  return 0;
}

function containsDice(expression) {
  if ( !expression || (typeof expression !== "object") ) return false;
  return (expression.type === "dice") || Object.values(expression).some(value => (Array.isArray(value)
    ? value.some(containsDice) : containsDice(value)));
}

function diceFromExpression(expression) {
  if ( expression?.type !== "dice" ) return null;
  return {
    number: Math.max(Math.floor(finiteNumber(expression.number ?? expression.count) ?? 0), 0),
    faces: Math.max(Math.floor(finiteNumber(expression.faces ?? expression.sides) ?? 0), 0),
    formula: expression.formula ?? null,
    metadata: clonePlain(expression.metadata ?? {}) ?? {}
  };
}

function validateRuleElementSource(definition) {
  return {
    type: "actionDefinition",
    id: definition.id,
    name: definition.label ?? null
  };
}

function actionDefinitionRuleElementSource(definition) {
  return validateRuleElementSource(definition);
}

function validationFailure(code, reason, path, definition=null) {
  return {
    ok: false,
    code,
    definition,
    errors: [error(code, path, reason)]
  };
}

function error(code, path, reason) {
  return {code, path, reason};
}

function costRequirementEntries(costs, prefix="costs") {
  if ( costs?.anyOf ) {
    return costs.anyOf.flatMap((branch, branchIndex) => {
      return branch.map((requirement, requirementIndex) => ({
        requirement,
        path: `${prefix}.anyOf.${branchIndex}.${requirementIndex}`
      }));
    });
  }
  return (costs?.allOf ?? []).map((requirement, index) => ({
    requirement,
    path: `${prefix}.allOf.${index}`
  }));
}

function isValidDamageType(value) {
  return typeof value === "string" && DAMAGE_TYPE_PATTERN.test(value);
}

function hasCostRequirementShape(value) {
  return isPlainObject(value) && (
    "capability" in value
    || "resourceId" in value
    || "resource" in value
    || "pool" in value
    || "amount" in value
  );
}

function hasDefinitionKey(definitions, key) {
  if ( !definitions || !key ) return false;
  if ( definitions instanceof Map ) return definitions.has(key);
  if ( Array.isArray(definitions) ) return definitions.some(definition => (definition.id ?? definition.ref) === key);
  return Object.hasOwn(definitions, key);
}

function hasAuthoredDefinition(value) {
  if ( !isPlainObject(value) ) return false;
  return Object.entries(value).some(([key, entry]) => {
    if ( ["schemaVersion", "metadata"].includes(key) ) return false;
    return hasMeaningfulValue(entry);
  });
}

function hasMeaningfulValue(value) {
  if ( value == null ) return false;
  if ( typeof value === "string" ) return value.trim() !== "";
  if ( typeof value === "number" || typeof value === "boolean" ) return true;
  if ( Array.isArray(value) ) return value.length > 0;
  if ( value instanceof Set ) return value.size > 0;
  if ( isPlainObject(value) ) return Object.values(value).some(hasMeaningfulValue);
  return false;
}

function sourceFromItem(item) {
  if ( !item ) return null;
  return {
    type: "item",
    ref: item.uuid ? `uuid:${item.uuid}` : (item.id ? `item:${item.id}` : null),
    uuid: item.uuid ?? null,
    id: item.id ?? null,
    itemType: item.type ?? null,
    name: item.name ?? null
  };
}

function safeLegacyActivationCost(system) {
  if ( typeof system?.getActivationCost !== "function" ) return null;
  if ( typeof system?.getActionDefinition === "function" ) return null;
  return system.getActivationCost();
}

function normalizeSchemaVersion(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeArray(value) {
  if ( value == null ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  if ( typeof value[Symbol.iterator] === "function" && typeof value !== "string" ) return [...value];
  return [value];
}

function normalizeStrings(value) {
  return [...new Set(normalizeArray(value).filter(entry => entry != null && entry !== "").map(String))];
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function stringOrDefault(value, fallback) {
  return stringOrNull(value) ?? fallback;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDefined(values) {
  return values.find(value => value != null);
}

function findNonSerializable(value, path="value", seen=new Set()) {
  const type = typeof value;
  if ( type === "function" || type === "symbol" || type === "bigint" ) {
    return {path, reason: `${path} contains non-serializable ${type}.`};
  }
  if ( type === "number" && !Number.isFinite(value) ) {
    return {path, reason: `${path} contains a non-finite number.`};
  }
  if ( value == null || type !== "object" ) return null;
  if ( seen.has(value) ) return {path, reason: `${path} contains a circular reference.`};
  seen.add(value);
  if ( Array.isArray(value) ) {
    for ( let index = 0; index < value.length; index++ ) {
      const issue = findNonSerializable(value[index], `${path}.${index}`, seen);
      if ( issue ) return issue;
    }
    seen.delete(value);
    return null;
  }
  if ( !isPlainObject(value) ) {
    return {path, reason: `${path} must contain plain JSON data.`};
  }
  for ( const [key, entry] of Object.entries(value) ) {
    const issue = findNonSerializable(entry, `${path}.${key}`, seen);
    if ( issue ) return issue;
  }
  seen.delete(value);
  return null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if ( (typeof value !== "object") || value === null || Array.isArray(value) ) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

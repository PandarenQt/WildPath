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
import {withWeaponMastery} from "./weapon-mastery.mjs";
import {withMetamagic} from "./metamagic.mjs";
import {mysticArcanumPoolId, spellBaseLevel} from "./spellcasting.mjs";

/** When a custom effect ends early: its creature is attacked, attacked by the creature that applied it, or attacks. */
export const CUSTOM_EFFECT_ENDS_WHEN = Object.freeze(["attacked", "attackedBySource", "attackedByOther", "attacks", "saves"]);

/**
 * When a creature an effect reached repeats the save that let it in (2024: "At the end of each of its turns, the target
 * repeats the save, ending the spell on itself on a success"): `turnEnd` or `turnStart` of its own turns.
 */
export const REPEAT_SAVE_TIMINGS = Object.freeze(["turnEnd", "turnStart"]);

/** V14's ActiveEffect duration units and expiry events (CONST), for a custom effect's native duration. */
export const CUSTOM_EFFECT_DURATION_UNITS = Object.freeze(["years", "months", "days", "hours", "minutes", "seconds", "rounds", "turns"]);
export const CUSTOM_EFFECT_EXPIRY_EVENTS = Object.freeze(["combatStart", "roundStart", "turnStart", "combatEnd", "roundEnd", "turnEnd"]);

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
    healing: normalizeArray(raw.healing ?? raw.healingDefinitions ?? raw.healingComponents).map(normalizeHealingDefinition),
    effects: normalizeArray(raw.effects ?? raw.effectApplications ?? raw.effectApplicationDefinitions).map(normalizeEffectApplicationDefinition),
    duration: normalizeDurationDefinition(raw.duration),
    // The creature takes a form when the Action completes: a fixed `formRef`, the form a `choiceId` configuration
    // choice picked, or `revert` to end its transformation (transformations: classes-and-spellcasting.md).
    transform: normalizePlainComponent(raw.transform),
    // Creatures the Action summons when it completes (companions.md): a fixed `actorRef` or a `choiceId`
    // configuration choice of creatures, `count`, and optionally `rounds` and `concentration`.
    summon: normalizePlainComponent(raw.summon),
    // Forced movement (areas.md): each creature it hits, or that fails its save, is pushed `distance` feet away from
    // its source, or pulled toward it (`toward`); only one no bigger than `maxSize` when it has one. `on: "success"`
    // pushes the creatures that succeed on its save instead.
    push: normalizePlainComponent(raw.push),
    // Moves its creature's lasting area left by the Action `of` (its definition id) up to `distance` feet (areas.md).
    ...(raw.moveArea ? {moveArea: normalizePlainComponent(raw.moveArea)} : {}),
    // Teleports its own creature up to `distance` feet to a space it chooses (Misty Step, Dimension Door).
    ...(raw.teleport ? {teleport: normalizePlainComponent(raw.teleport)} : {}),
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
  validatePush(definition.push, errors);
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
  const raw = withMysticArcanum(withMetamagic(withOwnWeapons(withWeaponMastery(withExtraAttacks(system.definition ?? system.actionDefinition
    ?? item?.definition ?? item?.actionDefinition ?? null, item), item?.actor ?? null), item?.actor ?? null), item?.actor ?? null), item);
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
  if ( !Array.isArray(choices) || !choices.some(choice => choice?.optionsFrom?.type === "weapons") ) return raw;
  const items = [...(actor?.items ?? [])];
  const attacks = items.filter(item => (item.type === "action") && item.system?.definition?.attack?.weapon);
  return {...raw, configuration: choices.map(choice => {
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
 * 2024 Mystic Arcanum: the spell its warlock chose for a level 6 to 9 (`flags.wildpath.arcanum`) may also be cast at its
 * own level from that level's arcanum (`mystic-arcanum.<level>`, once per Long Rest), while its creature has that pool.
 */
function withMysticArcanum(raw, item) {
  const choice = item?.flags?.wildpath?.arcanum ? raw?.configuration?.find(entry => entry?.id === "spell-slot") : null;
  const level = choice ? spellBaseLevel(raw) : null;
  if ( !(level >= 6) ) return raw;
  const capability = mysticArcanumPoolId(level);
  if ( !(item.actor?.system?.pools ?? []).some(pool => pool.id === capability) ) return raw;
  return {...raw, configuration: raw.configuration.map(entry => ((entry !== choice) ? entry : {...entry,
    cost: {anyOf: [...(entry.cost?.anyOf ?? []), [{capability, amount: 1}]]},
    levelByResourceId: {...(entry.levelByResourceId ?? {}), [capability]: level}}))};
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
    targeting: targetingFromDefinition(normalized, {source, targeting}),
    attack: resolverRequestFromAttackDefinition(normalized.attack, attack),
    save: resolverRequestFromSaveDefinition(normalized.save, save, evaluationContext),
    check: normalized.check ? mergeResolverRequest({ability: normalized.check.ability ?? null, skill: normalized.check.skill ?? null,
      dc: resolveSaveDCDefinition(normalized.check.dc, evaluationContext), policy: normalized.check.policy ?? {}}, check) : check ?? null,
    damage: resolverRequestFromDamageDefinition(normalized, damage, evaluationContext),
    healing: resolverRequestFromHealingDefinition(normalized, healing, evaluationContext),
    effects: resolverRequestFromEffectsDefinition(normalized, effects)
  };

  return {
    ...base,
    targets: targets.length ? targets.map(clonePlain) : []
  };
}

/* -------------------------------------------- */

function targetingFromDefinition(definition, {source, targeting}) {
  const targetDefinition = definition.targeting;
  if ( !targetDefinition ) return targeting ?? null;

  const count = targetDefinition.count;
  const refinementPolicy = {
    ...(targetDefinition.refinementPolicy ?? {}),
    ...(count != null ? {
      // "Up to three creatures" sets its own minimum; otherwise a required count is exact.
      minSelections: targetDefinition.refinementPolicy?.minSelections ?? (targetDefinition.required ? count : 0),
      maxSelections: count
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
  const components = [...definition.damage, ...extras].map((component, index) => damageComponentForResolver({
    component,
    index,
    runtimeComponents,
    evaluationContext
  }));
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
        id: customEffectId(definition.id, effect), name: effect.name, img: effect.img ?? null, custom: true, stacking: false,
        ruleElements: clonePlain(effect.ruleElements ?? []), duration: clonePlain(effect.duration ?? null),
        ...(effect.endsWhen ? {endsWhen: effect.endsWhen} : {})}}} : {}),
      levels: (effect.type === "effect") ? 1 : effect.levels,
      saveOutcomePolicy: effect.application?.saveOutcomePolicy ?? effect.saveOutcomePolicy ?? null,
      duration: (effect.type === "effect") ? null : (effect.duration ?? definition.duration),
      concentration: effect.concentration,
      source: effect.source ?? definition.source,
      origin: effect.origin ?? definition.source,
      metadata: {
        ...(effect.metadata ?? {}),
        actionDefinitionId: definition.id,
        effectDefinitionId: effect.id,
        // Its timing; the Action's save stamps the ability and DC when it resolves (action-pipeline-resolver.mjs).
        ...(effect.repeatSave ? {repeatSave: {timing: effect.repeatSave}} : {})
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
}

/** The creature sizes, smallest first: a `maxSize` names one. */
export const CREATURE_SIZE_ORDER = Object.freeze(["tiny", "small", "medium", "large", "huge", "gargantuan"]);

function validatePush(push, errors) {
  if ( !push ) return;
  if ( !(Number(push.distance) > 0) ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.distance",
    "A push moves its creature a positive number of feet."));
  if ( (push.maxSize != null) && !CREATURE_SIZE_ORDER.includes(push.maxSize) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.maxSize", `Unknown creature size: ${push.maxSize}`));
  }
  if ( (push.on != null) && !["failure", "success"].includes(push.on) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "push.on", "A push is on a failed or a successful save."));
  }
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
export const AREA_PERSISTENCE_EVENTS = Object.freeze(["area.entered", "area.exited", "turn.started", "turn.ended"]);

/**
 * A lasting area: `{duration: {unit: "round", value}, concentration, oncePerTurn, elevation: {bottom, top},
 * triggers: [{on: [...events], action: ActionDefinition}], light?: {bright, dim, sunlight, darkness, dispels, spellLevel},
 * onObject?: <configuration choice id>}`. Elevation is relative to the floor of the caster's Level; a missing bound is
 * open. `light` is shed from its center (Daylight, Darkness); when the `onObject` choice is chosen, the area surrounds
 * the Token at its center and follows it.
 */
function validateAreaPersistence(persistence, errors) {
  const path = "area.persistence";
  const fail = (at, reason) => errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, `${path}${at}`, reason));
  if ( !isPlainObject(persistence) ) return fail("", "A lasting area must be a structured object.");
  const duration = persistence.duration;
  if ( duration != null && !((duration.unit === "round") && Number.isInteger(Number(duration.value)) && (Number(duration.value) > 0)) ) {
    fail(".duration", "A lasting area's duration is a positive whole number of rounds.");
  }
  // Whom its triggers affect: everyone in it (the default), or only its caster's enemies (Spirit Guardians).
  if ( (persistence.affects != null) && (persistence.affects !== "enemies") ) fail(".affects", "A lasting area affects everyone or \"enemies\".");
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

function validateDamage(components, errors) {
  components.forEach((component, index) => {
    const path = `damage.${index}`;
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
  const duration = effect.duration;
  if ( duration && duration.units && !CUSTOM_EFFECT_DURATION_UNITS.includes(duration.units) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.duration.units`, `Unknown duration unit: ${duration.units}`));
  }
  if ( duration && duration.expiry && !CUSTOM_EFFECT_EXPIRY_EVENTS.includes(duration.expiry) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_EFFECT, `${path}.duration.expiry`, `Unknown duration expiry: ${duration.expiry}`));
  }
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

function normalizeDamageDefinition(component={}, index=0) {
  const expression = component.expression
    ?? component.valueExpression
    ?? expressionFromAmountFields(component)
    ?? (component.dice ? {type: "dice", ...clonePlain(component.dice)} : null);
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
    metadata: clonePlain(component.metadata ?? {}) ?? {}
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
      ...(effect.endsWhen ? {endsWhen: String(effect.endsWhen)} : {})} : {}),
    ...(effect.repeatSave ? {repeatSave: String(effect.repeatSave)} : {}),
    // Only on a creature no bigger than this (Eldritch Smite's Prone: Huge or smaller).
    ...(effect.maxSize ? {maxSize: String(effect.maxSize)} : {}),
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

import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_CONFIGURATION_CODES,
  ACTION_CHOICE_TYPES,
  createResolvedActionPreview,
  discoverActionConfigurationChoices,
  resolveActionConfiguration,
  validateResolvedActionConfiguration
} from "../module/helpers/action-configuration.mjs";

function actorSystem(overrides={}) {
  return {
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? [
      {id: "spell-slot.3", label: "3rd-level Spell Slot", value: 1, max: 1},
      {id: "spell-slot.4", label: "4th-level Spell Slot", value: 1, max: 1},
      {id: "spell-slot.5", label: "5th-level Spell Slot", value: 1, max: 1},
      {id: "pact-slot.5", label: "5th-level Pact Slot", value: 1, max: 1},
      {id: "sorcery-point", label: "Sorcery Point", value: 2, max: 2}
    ]
  };
}

function scalableSpellDefinition() {
  return {
    schemaVersion: 1,
    id: "action:elemental-burst",
    label: "Elemental Burst",
    tags: ["spell"],
    costs: {allOf: []},
    targeting: {type: "area", required: true},
    area: {shape: "radial", size: {value: 20, unit: "ft"}},
    save: {ability: "agility", dc: {value: 15}},
    damage: [{
      id: "burst",
      expression: {type: "dice", number: 8, faces: 6},
      damageType: "fire",
      provenance: "spell-base"
    }],
    configuration: [{
      id: "casting-resource",
      type: ACTION_CHOICE_TYPES.RESOURCE,
      label: "Cast At",
      required: true,
      cost: {
        anyOf: [
          [{capability: "spell-slot.3", amount: 1}],
          [{capability: "spell-slot.4", amount: 1}],
          [{capability: "spell-slot.5", amount: 1}],
          [{capability: "pact-slot.5", amount: 1}]
        ]
      },
      levelByResourceId: {
        "spell-slot.3": 3,
        "spell-slot.4": 4,
        "spell-slot.5": 5,
        "pact-slot.5": 5
      },
      effects: [{
        type: "scaleDamage",
        componentIds: ["burst"],
        levelChoiceId: "casting-resource",
        baseLevel: 3,
        dice: {number: 1, faces: 6}
      }]
    }]
  };
}

function conversionFeature() {
  return [
    {
      id: "enable-conversion",
      type: ACTION_CHOICE_TYPES.BOOLEAN,
      label: "Elemental Conversion",
      source: {type: "feature", slug: "elemental-conversion"},
      effects: [{
        type: "addCost",
        cost: {allOf: [{capability: "sorcery-point", amount: 1}]}
      }]
    },
    {
      id: "conversion-type",
      type: ACTION_CHOICE_TYPES.DAMAGE_TYPE,
      label: "Replacement Damage Type",
      required: true,
      dependsOn: {choiceId: "enable-conversion", equals: true},
      allowedDamageTypes: ["cold", "lightning"],
      source: {type: "feature", slug: "elemental-conversion"},
      effects: [{
        type: "replaceDamageType",
        componentIds: ["burst"],
        damageTypeChoiceId: "conversion-type"
      }]
    }
  ];
}

test("ActionConfiguration discovers spell slot and Pact-style payment choices without mutation", () => {
  const system = actorSystem();
  const before = structuredClone(system);
  const discovery = discoverActionConfigurationChoices({
    definition: scalableSpellDefinition(),
    actorSystem: system
  });
  const request = discovery.requests.find(choice => choice.id === "casting-resource");

  assert.equal(discovery.ok, true);
  assert.equal(request.type, ACTION_CHOICE_TYPES.RESOURCE);
  assert.deepEqual(request.options.map(option => option.resources[0].resourceId).sort(), [
    "pact-slot.5",
    "spell-slot.3",
    "spell-slot.4",
    "spell-slot.5"
  ]);
  assert.equal(request.options.find(option => option.resources[0].resourceId === "pact-slot.5").metadata.castingLevel, 5);
  assert.deepEqual(system, before);
});

test("ResolvedActionPreview scales 3rd-level base damage to a selected 5th-level slot", () => {
  const result = createResolvedActionPreview({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"}
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.configuration.castingLevel, 5);
  assert.equal(result.preview.damage.components[0].formula, "10d6");
  assert.equal(result.preview.damage.components[0].before.formula, "8d6");
  assert.equal(result.preview.damageExpressions[0].formula, "10d6");
  assert.equal(result.preview.costs.payment.selectedPaymentPlan.resources[0].resourceId, "spell-slot.5");
  assert.deepEqual(result.preview.deltas.filter(delta => delta.type === "damage-expression").map(delta => delta.after.formula), ["10d6"]);
});

test("ActionConfiguration treats ordinary slots and Pact-style slots as resource options", () => {
  const result = createResolvedActionPreview({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    choices: {
      "casting-resource": {resourceId: "pact-slot.5"}
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.configuration.castingLevel, 5);
  assert.equal(result.preview.damage.components[0].formula, "10d6");
  assert.equal(result.preview.costs.payment.selectedPaymentPlan.resources[0].resourceId, "pact-slot.5");
});

test("damage-type choices are contributed by rules sources and appear only after dependencies", () => {
  const hidden = discoverActionConfigurationChoices({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    configurationContributions: conversionFeature()
  });
  const visible = discoverActionConfigurationChoices({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    configurationContributions: conversionFeature(),
    choices: {
      "enable-conversion": true
    }
  });

  assert.equal(hidden.requests.some(choice => choice.id === "conversion-type"), false);
  const request = visible.requests.find(choice => choice.id === "conversion-type");
  assert.equal(request.type, ACTION_CHOICE_TYPES.DAMAGE_TYPE);
  assert.deepEqual(request.options.map(option => option.id), ["cold", "lightning"]);
});

test("resource alternatives get distinct option ids, so a prompt answer can select any of them", () => {
  const discovery = discoverActionConfigurationChoices({definition: scalableSpellDefinition(), actorSystem: actorSystem()});
  const options = discovery.requests[0].options;
  assert.equal(new Set(options.map(option => option.id)).size, options.length, "anyOf branches must not share payment-1");
  const slot5 = options.find(option => option.resources[0]?.resourceId === "spell-slot.5");
  const preview = createResolvedActionPreview({definition: scalableSpellDefinition(), actorSystem: actorSystem(),
    choices: {"casting-resource": {paymentOptionId: slot5.id}}});
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.preview.damage.components[0].formula, "10d6");
});

test("resource-keyed configuration maps also resolve in the shape Foundry persists them", () => {
  // Foundry expands dotted keys in Document data: {"spell-slot.5": 5} is stored as {"spell-slot": {"5": 5}}.
  const definition = scalableSpellDefinition();
  definition.configuration[0].levelByResourceId = {"spell-slot": {3: 3, 4: 4, 5: 5}, "pact-slot": {5: 5}};
  const preview = createResolvedActionPreview({definition, actorSystem: actorSystem(),
    choices: {"casting-resource": {resourceId: "spell-slot.5"}}});
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.preview.damage.components[0].formula, "10d6");
});

test("compatible configuration options compose damage scaling, replacement type, and added costs", () => {
  const preview = createResolvedActionPreview({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    configurationContributions: [
      ...conversionFeature(),
      {
        id: "empowered",
        type: ACTION_CHOICE_TYPES.BOOLEAN,
        label: "Empowered",
        source: {type: "feature", slug: "empowered"},
        effects: [{
          type: "addCost",
          cost: {allOf: [{capability: "sorcery-point", amount: 1}]}
        }]
      }
    ],
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"},
      "enable-conversion": true,
      "conversion-type": "lightning",
      empowered: true
    }
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.preview.damage.components[0].formula, "10d6");
  assert.equal(preview.preview.damage.components[0].damageType, "lightning");
  assert.deepEqual(preview.preview.actionEconomyPayments.map(payment => payment.resourceId).sort(), [
    "sorcery-point",
    "sorcery-point",
    "spell-slot.5"
  ]);
  assert.deepEqual(preview.preview.deltas.map(delta => delta.type).sort(), [
    "cost-added",
    "cost-added",
    "cost-added",
    "damage-expression",
    "damage-type"
  ]);
});

test("configuration validation rejects incompatible and invalid choices structurally", () => {
  const conflict = resolveActionConfiguration({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    configurationContributions: [
      ...conversionFeature(),
      {
        id: "exclusive-shaping",
        type: ACTION_CHOICE_TYPES.BOOLEAN,
        conflictsWith: ["enable-conversion"],
        source: {type: "feature", slug: "exclusive-shaping"}
      }
    ],
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"},
      "enable-conversion": true,
      "conversion-type": "lightning",
      "exclusive-shaping": true
    }
  });
  const invalidDamageType = resolveActionConfiguration({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    configurationContributions: conversionFeature(),
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"},
      "enable-conversion": true,
      "conversion-type": "acid"
    }
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, ACTION_CONFIGURATION_CODES.CONFLICTING_SELECTIONS);
  assert.equal(invalidDamageType.ok, false);
  assert.equal(invalidDamageType.code, ACTION_CONFIGURATION_CODES.INVALID_CHOICE);
});

test("configuration discovery, resolution, and preview are deterministic and non-mutating", () => {
  const definition = scalableSpellDefinition();
  const system = actorSystem();
  const beforeDefinition = structuredClone(definition);
  const beforeSystem = structuredClone(system);
  const input = {
    definition,
    actorSystem: system,
    configurationContributions: conversionFeature(),
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"},
      "enable-conversion": true,
      "conversion-type": "lightning"
    }
  };
  const first = createResolvedActionPreview(input);
  const second = createResolvedActionPreview(input);

  assert.equal(first.ok, true);
  assert.deepEqual(first.preview, second.preview);
  assert.deepEqual(definition, beforeDefinition);
  assert.deepEqual(system, beforeSystem);
});

test("a resource removed after preview causes resolved configuration revalidation to fail", () => {
  const preview = createResolvedActionPreview({
    definition: scalableSpellDefinition(),
    actorSystem: actorSystem(),
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"}
    }
  });
  const missingSlot = actorSystem({
    pools: [
      {id: "spell-slot.3", label: "3rd-level Spell Slot", value: 1, max: 1}
    ]
  });
  const validation = validateResolvedActionConfiguration({
    configuration: preview.configuration,
    actorSystem: missingSlot
  });

  assert.equal(preview.ok, true);
  assert.equal(validation.ok, false);
  assert.equal(validation.code, ACTION_CONFIGURATION_CODES.RESOURCE_UNAVAILABLE);
});

test("a higher slot can add healing dice and targets, as it adds damage dice", () => {
  const slot = {id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
    cost: {anyOf: [[{capability: "spell-slot.3", amount: 1}], [{capability: "spell-slot.5", amount: 1}]]},
    levelByResourceId: {"spell-slot.3": 3, "spell-slot.5": 5}};
  const definition = {schemaVersion: 1, id: "action:mend-many", tags: ["spell"], costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    healing: [{id: "heal", expression: {type: "dice", number: 2, faces: 8}, healingType: "healing"}],
    configuration: [{...slot, effects: [
      {type: "scaleHealing", levelChoiceId: "spell-slot", baseLevel: 3, componentIds: ["heal"], dice: {number: 2, faces: 8}},
      {type: "scaleTargets", levelChoiceId: "spell-slot", baseLevel: 3, perLevel: 1}]}]};
  const result = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId: "spell-slot.5"}}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.configuration.effectiveDefinition.healing[0].expression, {type: "dice", number: 6, faces: 8});
  assert.deepEqual(result.configuration.effectiveDefinition.targeting.type, "multiple");
  assert.equal(result.configuration.effectiveDefinition.targeting.count, 3);
  assert.equal(result.configuration.effectiveDefinition.targeting.refinementPolicy.minSelections, 1,
    "up to three: \"you can target one additional creature\", so one is still enough");
  const base = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId: "spell-slot.3"}}});
  assert.equal(base.configuration.effectiveDefinition.targeting.count, 1, "the spell's own level adds nothing");
});

test("a lasting area's repeat grows with the slot too: Moonbeam at 3rd level repeats 3d10", () => {
  const damage = [{id: "damage-1", expression: {type: "dice", number: 2, faces: 10}, damageType: "radiant"}];
  const definition = {schemaVersion: 1, id: "action:moonbeam", tags: ["spell"], costs: {allOf: []},
    targeting: {type: "area"}, area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence: {duration: {unit: "round", value: 10},
      triggers: [{on: ["area.entered", "turn.ended"], action: {schemaVersion: 1, id: "action:moonbeam:lasting", costs: {allOf: []},
        save: {ability: "fortitude", dc: {value: 15}}, damage: structuredClone(damage)}}]}},
    save: {ability: "fortitude", dc: {value: 15}}, damage,
    configuration: [{id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
      cost: {anyOf: [[{capability: "spell-slot.3", amount: 1}], [{capability: "spell-slot.5", amount: 1}]]},
      levelByResourceId: {"spell-slot.3": 3, "spell-slot.5": 5},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 2, componentIds: ["damage-1"], dice: {number: 1, faces: 10}}]}]};
  const result = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId: "spell-slot.3"}}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const effective = result.configuration.effectiveDefinition;
  assert.deepEqual(effective.damage[0].expression, {type: "dice", number: 3, faces: 10}, "the cast");
  assert.deepEqual(effective.area.persistence.triggers[0].action.damage[0].expression, {type: "dice", number: 3, faces: 10}, "and its repeat");
  assert.deepEqual(definition.area.persistence.triggers[0].action.damage[0].expression, {type: "dice", number: 2, faces: 10},
    "the stored definition is untouched");
});

test("a keepEffect choice applies only the chosen one of its effects (Hex's ability)", async () => {
  const {resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const definition = {schemaVersion: 1, id: "action:hex", label: "Hex", costs: {allOf: [{capability: "bonus-action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1},
    effects: [{id: "effect-1", type: "effect", name: "Hexed Might", ruleElements: []}, {id: "effect-2", type: "effect", name: "Hexed Agility",
      ruleElements: []}, {id: "other", type: "condition", conditionId: "prone"}],
    configuration: [{id: "effect-choice", type: "option", label: "Ability", required: true,
      options: [{id: "effect-1", label: "Hexed Might", value: "effect-1"}, {id: "effect-2", label: "Hexed Agility", value: "effect-2"}],
      effects: [{type: "keepEffect", effectIds: ["effect-1", "effect-2"]}]}]};
  const resolved = resolveActionConfiguration({definition, actorSystem: {resources: {bonus: {value: 1, max: 1}}, pools: []},
    choices: {"effect-choice": "effect-2"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.configuration.effectiveDefinition.effects.map(entry => entry.id), ["effect-2", "other"]);
});

test("a keepEffect option keeps its whole group (one dnd5e effect may be several conditions)", async () => {
  const {resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const definition = {schemaVersion: 1, id: "action:word", label: "Word", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1},
    effects: [{id: "effect-1", type: "condition", conditionId: "blinded"}, {id: "effect-2", type: "condition", conditionId: "deafened"},
      {id: "effect-3", type: "condition", conditionId: "deafened"}],
    configuration: [{id: "effect-choice", type: "option", label: "Effect", required: true,
      options: [{id: "effect-option-1", label: "Blinded, Deafened", value: "effect-option-1"},
        {id: "effect-option-2", label: "Deafened", value: "effect-option-2"}],
      effects: [{type: "keepEffect", effectIds: ["effect-1", "effect-2", "effect-3"],
        keep: {"effect-option-1": ["effect-1", "effect-2"], "effect-option-2": ["effect-3"]}}]}]};
  const resolved = resolveActionConfiguration({definition, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    choices: {"effect-choice": "effect-option-1"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.configuration.effectiveDefinition.effects.map(entry => entry.id), ["effect-1", "effect-2"]);
});

test("a chosen damage type reaches a lasting area's repeat too (Spirit Guardians' necrotic)", async () => {
  const {resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const burst = {id: "damage-1", expression: {type: "dice", number: 3, faces: 8}, damageType: "radiant"};
  const definition = {schemaVersion: 1, id: "action:guardians", label: "Guardians", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "area"}, area: {shape: "emanation", size: {value: 15, unit: "ft"}, persistence: {duration: {unit: "round", value: 100},
      triggers: [{on: "turn.started", action: {schemaVersion: 1, id: "action:guardians:turn", save: {ability: "wits", dc: {value: 13}},
        damage: [structuredClone(burst)]}}]}},
    save: {ability: "wits", dc: {value: 13}}, damage: [burst],
    configuration: [{id: "damage-type-1", type: "damage-type", label: "Damage type", required: true, allowedDamageTypes: ["radiant", "necrotic"],
      effects: [{type: "replaceDamageType", componentIds: ["damage-1"], damageTypeChoiceId: "damage-type-1"}]}]};
  const resolved = resolveActionConfiguration({definition, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    choices: {"damage-type-1": "necrotic"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const effective = resolved.configuration.effectiveDefinition;
  assert.deepEqual([effective.damage[0].damageType, effective.area.persistence.triggers[0].action.damage[0].damageType], ["necrotic", "necrotic"]);
});

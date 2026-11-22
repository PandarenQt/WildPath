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

test("Pact Magic slots pay for a slot up to their level, once, cast at their level", () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const spell = (base) => ({...scalableSpellDefinition(), damage: [{id: "burst", expression: {type: "dice", number: 3, faces: 10},
    damageType: "fire", provenance: "spell-base"}], configuration: [{id: "casting-resource", type: ACTION_CHOICE_TYPES.RESOURCE,
    label: "Cast At", required: true, cost: {anyOf: levels.filter(level => level >= base).map(level => [{capability: `spell-slot.${level}`, amount: 1}])},
    levelByResourceId: Object.fromEntries(levels.filter(level => level >= base).map(level => [`spell-slot.${level}`, level])),
    effects: [{type: "scaleDamage", componentIds: ["burst"], levelChoiceId: "casting-resource", baseLevel: base, dice: {number: 1, faces: 10}}]}]});
  const system = actorSystem({pools: [{id: "spell-slot.1", label: "Level 1", value: 2, max: 2},
    {id: "spell-slot.pact", label: "Pact Magic slots", value: 2, max: 2}]});
  system.classes = [{id: "warlock", level: 5, spellcasting: {progression: "pact"}}];
  const request = discoverActionConfigurationChoices({definition: spell(1), actorSystem: system}).requests.find(choice => choice.id === "casting-resource");
  assert.deepEqual(request.options.map(option => option.resources[0].resourceId).sort(), ["spell-slot.1", "spell-slot.pact"], "the pact pool once");
  assert.equal(request.options.find(option => option.resources[0].resourceId === "spell-slot.pact").metadata.castingLevel, 3);
  const result = createResolvedActionPreview({definition: spell(1), actorSystem: system, choices: {"casting-resource": {resourceId: "spell-slot.pact"}}});
  assert.equal(result.configuration.castingLevel, 3);
  assert.equal(result.preview.damage.components[0].formula, "5d10", "cast at level 3: two more dice");
  assert.deepEqual(result.preview.costs.payment.selectedPaymentPlan.resources.map(entry => entry.resourceId), ["spell-slot.pact"],
    "the pool chosen pays, not another with the same capability");
  const higher = discoverActionConfigurationChoices({definition: spell(4), actorSystem: system}).requests.find(choice => choice.id === "casting-resource");
  assert.equal(higher.options.length, 0, "a level-4 spell is above the pact slots' level");
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

test("a higher slot can add a flat amount per level, alone or beside dice", () => {
  const slot = {id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
    cost: {anyOf: [[{capability: "spell-slot.3", amount: 1}], [{capability: "spell-slot.5", amount: 1}]]},
    levelByResourceId: {"spell-slot.3": 3, "spell-slot.5": 5}};
  const definition = {schemaVersion: 1, id: "action:flat", tags: ["spell"], costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    healing: [{id: "heal", expression: {type: "constant", value: 70}, healingType: "healing"}],
    damage: [{id: "hurt", expression: {type: "dice", number: 2, faces: 6}, damageType: "fire"}],
    configuration: [{...slot, effects: [
      {type: "scaleHealing", levelChoiceId: "spell-slot", baseLevel: 3, componentIds: ["heal"], bonus: 10},
      {type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 3, componentIds: ["hurt"], dice: {number: 1, faces: 6}, bonus: 2}]}]};
  const at = resourceId => resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId}}});
  const higher = at("spell-slot.5");
  assert.equal(higher.ok, true, JSON.stringify(higher.errors));
  assert.deepEqual(higher.configuration.effectiveDefinition.healing[0].expression, {type: "constant", value: 90}, "70 + 10 a level");
  assert.deepEqual(higher.configuration.effectiveDefinition.damage[0].expression, {type: "add", terms: [{type: "dice", number: 4, faces: 6},
    {type: "constant", value: 4}]}, "1d6 + 2 a level");
  assert.equal(higher.configuration.effectiveDefinition.healing[0].metadata.configurationChanges[0].addedBonus, 20);
  const base = at("spell-slot.3");
  assert.deepEqual([base.configuration.effectiveDefinition.healing[0].expression, base.configuration.effectiveDefinition.damage[0].expression],
    [{type: "constant", value: 70}, {type: "dice", number: 2, faces: 6}], "its own level adds nothing");
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

test("what a wall's opened sections leave grows with the slot too: Frigid Air at 7th level is 6d6 (sections.leaves)", () => {
  const frigid = {id: "frigid-air", expression: {type: "dice", number: 5, faces: 6}, damageType: "cold"};
  const definition = {schemaVersion: 1, id: "action:ice-wall", tags: ["spell"], costs: {allOf: []}, targeting: {type: "area"},
    area: {shape: "wall", size: {value: 100, unit: "ft"}, persistence: {blocks: ["move"], sections: {size: 10, ac: 12, hp: 30,
      leaves: {triggers: [{on: ["area.entered", "area.exited"], once: "turn", action: {schemaVersion: 1, id: "action:frigid-air",
        costs: {allOf: []}, save: {ability: "fortitude", dc: {value: 15}}, damage: [frigid]}}]}}}},
    save: {ability: "agility", dc: {value: 15}}, damage: [{id: "damage-1", expression: {type: "dice", number: 10, faces: 6}, damageType: "cold"}],
    configuration: [{id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
      cost: {anyOf: [[{capability: "spell-slot.6", amount: 1}], [{capability: "spell-slot.7", amount: 1}]]},
      levelByResourceId: {"spell-slot.6": 6, "spell-slot.7": 7},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 6, componentIds: ["damage-1"], dice: {number: 2, faces: 6}},
        {type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 6, componentIds: ["frigid-air"], dice: {number: 1, faces: 6}}]}]};
  const pools = [6, 7].map(level => ({id: `spell-slot.${level}`, label: `Level ${level} Spell Slot`, value: 1, max: 1}));
  const at = resourceId => resolveActionConfiguration({definition, actorSystem: actorSystem({pools}), choices: {"spell-slot": {resourceId}}})
    .configuration.effectiveDefinition;
  const leaves = effective => effective.area.persistence.sections.leaves.triggers[0].action.damage[0].expression.number;
  assert.deepEqual([at("spell-slot.6").damage[0].expression.number, leaves(at("spell-slot.6"))], [10, 5], "its own level adds nothing");
  assert.deepEqual([at("spell-slot.7").damage[0].expression.number, leaves(at("spell-slot.7"))], [12, 6], "each its own dice a level");
  assert.equal(frigid.expression.number, 5, "the stored definition is untouched");
});

test("a GM card entry's damage grows with the slot too (gmPrompt)", () => {
  const objects = {id: "objects", expression: {type: "dice", number: 2, faces: 8}, damageType: "thunder"};
  const definition = {schemaVersion: 1, id: "action:shatter", tags: ["spell"], costs: {allOf: []},
    save: {ability: "fortitude", dc: {value: 13}}, damage: [{id: "damage-1", expression: {type: "dice", number: 3, faces: 8}, damageType: "thunder"}],
    gmPrompt: [{for: "picked", action: {schemaVersion: 1, id: "action:shatter:objects", costs: {allOf: []}, damage: [objects]}}],
    configuration: [{id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
      cost: {anyOf: [[{capability: "spell-slot.3", amount: 1}]]}, levelByResourceId: {"spell-slot.3": 3},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 2, componentIds: ["damage-1", "objects"], dice: {number: 1, faces: 8}}]}]};
  const result = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId: "spell-slot.3"}}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.configuration.effectiveDefinition.gmPrompt[0].action.damage[0].expression, {type: "dice", number: 3, faces: 8});
  assert.equal(objects.expression.number, 2, "the stored definition is untouched");
});

test("a summon's carried area grows with the slot too: Flaming Sphere at 3rd level burns 3d6 (summon.area)", () => {
  const definition = {schemaVersion: 1, id: "action:sphere", tags: ["spell"], costs: {allOf: []},
    summon: {actorRef: "Actor.sphere", count: 1, area: {shape: "emanation", size: {value: 5, unit: "ft"}, persistence: {
      triggers: [{on: ["turn.ended"], action: {schemaVersion: 1, id: "action:sphere:lasting", costs: {allOf: []},
        save: {ability: "agility", dc: {value: 13}}, damage: [{id: "damage-1", expression: {type: "dice", number: 2, faces: 6}, damageType: "fire"}]}}]}}},
    configuration: [{id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
      cost: {anyOf: [[{capability: "spell-slot.3", amount: 1}]]}, levelByResourceId: {"spell-slot.3": 3},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 2, componentIds: ["damage-1"], dice: {number: 1, faces: 6}}]}]};
  const result = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId: "spell-slot.3"}}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.configuration.effectiveDefinition.summon.area.persistence.triggers[0].action.damage[0].expression,
    {type: "dice", number: 3, faces: 6});
  assert.equal(definition.summon.area.persistence.triggers[0].action.damage[0].expression.number, 2, "the stored definition is untouched");
});

test("an effect's failed repeated save grows with the slot too: Phantasmal Killer at 5th level repeats 5d10", () => {
  const damage = [{id: "damage-1", expression: {type: "dice", number: 4, faces: 10}, damageType: "psychic"}];
  const definition = {schemaVersion: 1, id: "action:killer", tags: ["spell"], costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "wits", dc: {value: 15}}, damage,
    effects: [{id: "effect-1", type: "effect", name: "Fears Manifested", ruleElements: [], saveOutcomePolicy: "failure", repeatSave: "turnEnd",
      repeatDamage: structuredClone(damage)}],
    configuration: [{id: "spell-slot", type: ACTION_CHOICE_TYPES.RESOURCE, required: true,
      cost: {anyOf: [[{capability: "spell-slot.4", amount: 1}], [{capability: "spell-slot.5", amount: 1}]]},
      levelByResourceId: {"spell-slot.4": 4, "spell-slot.5": 5},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 4, componentIds: ["damage-1"], dice: {number: 1, faces: 10}}]}]};
  const result = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"spell-slot": {resourceId: "spell-slot.5"}}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const effective = result.configuration.effectiveDefinition;
  assert.deepEqual([effective.damage[0].expression, effective.effects[0].repeatDamage[0].expression],
    [{type: "dice", number: 5, faces: 10}, {type: "dice", number: 5, faces: 10}], "the cast and its repeat");
  assert.deepEqual(definition.effects[0].repeatDamage[0].expression, {type: "dice", number: 4, faces: 10}, "the stored definition is untouched");
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

test("a chosen damage type reaches an effect's failed repeated save too (repeatDamage)", () => {
  const burst = {id: "damage-1", expression: {type: "dice", number: 4, faces: 10}, damageType: "fire"};
  const definition = {schemaVersion: 1, id: "action:curse", label: "Curse", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "wits", dc: {value: 13}}, damage: [burst],
    effects: [{id: "effect-1", type: "effect", name: "Curse", ruleElements: [], saveOutcomePolicy: "failure", repeatSave: "turnEnd",
      repeatDamage: [structuredClone(burst)]}],
    configuration: [{id: "damage-type-1", type: "damage-type", label: "Damage type", required: true, allowedDamageTypes: ["fire", "cold"],
      effects: [{type: "replaceDamageType", componentIds: ["damage-1"], damageTypeChoiceId: "damage-type-1"}]}]};
  const resolved = resolveActionConfiguration({definition, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    choices: {"damage-type-1": "cold"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const effective = resolved.configuration.effectiveDefinition;
  assert.deepEqual([effective.damage[0].damageType, effective.effects[0].repeatDamage[0].damageType], ["cold", "cold"]);
});

test("a number chosen when used is spent from a pool and is the amount (Lay on Hands)", () => {
  const definition = {schemaVersion: 1, id: "action:lay-on-hands", costs: {allOf: [{capability: "bonus-action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, healing: [{id: "healing-1", expression: {type: "constant", value: 1}, healingType: "healing"}],
    configuration: [{id: "points", type: ACTION_CHOICE_TYPES.NUMBER, label: "Points", required: true, min: 1,
      effects: [{type: "spendAmount", resourceId: "lay-on-hands", componentIds: ["healing-1"]}]}]};
  const system = actorSystem();
  const result = resolveActionConfiguration({definition, actorSystem: {...system, pools: [...(system.pools ?? []),
    {id: "lay-on-hands", value: 25, max: 25}]}, choices: {points: 7}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.configuration.effectiveDefinition.healing[0].expression, {type: "constant", value: 7});
  const costs = JSON.stringify(result.configuration.effectiveDefinition.costs);
  assert.ok(costs.includes("lay-on-hands") && costs.includes("7"), costs);
});

test("a number chosen when used with `faces` is that many dice (Staff of Striking: 1d6 per charge spent)", () => {
  const definition = {schemaVersion: 1, id: "action:staff-charge", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, healing: [{id: "healing-1", expression: {type: "constant", value: 1}, healingType: "healing"}],
    configuration: [{id: "points", type: ACTION_CHOICE_TYPES.NUMBER, label: "Charges", required: true, min: 1,
      effects: [{type: "spendAmount", resourceId: "staff", componentIds: ["healing-1"], faces: 6}]}]};
  const system = actorSystem();
  const result = resolveActionConfiguration({definition, actorSystem: {...system, pools: [...(system.pools ?? []),
    {id: "staff", value: 10, max: 10}]}, choices: {points: 3}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.configuration.effectiveDefinition.healing[0].expression, {type: "dice", number: 3, faces: 6});
  const costs = JSON.stringify(result.configuration.effectiveDefinition.costs);
  assert.ok(costs.includes("staff") && costs.includes("3"), costs);
});

test("a number chosen for a summon is how many come, spent per creature when it names a pool (Pipes of the Sewers)", () => {
  const pipes = resourceId => ({schemaVersion: 1, id: "action:pipes", costs: {allOf: [{capability: "bonus-action", amount: 1}]},
    targeting: {type: "self"}, summon: {actorRef: "Actor.rats", count: 1},
    configuration: [{id: "summon-count", type: ACTION_CHOICE_TYPES.NUMBER, label: "Creatures", required: true, min: 1, max: 3,
      effects: [{type: "spendAmount", collection: "summon", ...(resourceId ? {resourceId} : {})}]}]});
  const system = actorSystem();
  const withPool = {...system, pools: [...(system.pools ?? []), {id: "pipes", value: 3, max: 3}]};
  const result = resolveActionConfiguration({definition: pipes("pipes"), actorSystem: withPool, choices: {"summon-count": 2}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.configuration.effectiveDefinition.summon.count, 2);
  const costs = JSON.stringify(result.configuration.effectiveDefinition.costs);
  assert.ok(costs.includes("pipes") && costs.includes("2"), costs);
  // A Horn of Valhalla's spirits: chosen, nothing more spent.
  const horn = resolveActionConfiguration({definition: pipes(null), actorSystem: system, choices: {"summon-count": 3}});
  assert.equal(horn.configuration.effectiveDefinition.summon.count, 3);
  assert.equal(JSON.stringify(horn.configuration.effectiveDefinition.costs).includes("pipes"), false);
});

test("an enchantment picks one of its creature's own weapons, and binds it and the slot's level into its effect (Magic Weapon)", async () => {
  const {resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const fs = await import("node:fs");
  const stored = JSON.parse(fs.readFileSync("packs/_source/srd-items/magic-weapon-phbsplMagicWeapo.json", "utf8")).system.definition;
  const weaponAction = (id, gear, base, type="melee") => ({id, type: "action", name: `${base} attack`, flags: {wildpath: {grantedBy: gear}},
    system: {definition: {attack: {type, statistic: "weapon", weapon: {base}}}}});
  const actor = {items: [{id: "sword", type: "gear", name: "Longsword"}, weaponAction("sword-attack", "sword", "longsword"),
    weaponAction("sword-thrown", "sword", "longsword", "ranged"), {id: "dagger", type: "gear", name: "Dagger"},
    weaponAction("dagger-attack", "dagger", "dagger"), {id: "fist", type: "action", name: "Unarmed Strike",
      system: {definition: {attack: {type: "melee", statistic: "weapon"}}}}]};
  const read = actionDefinitionFromItem({id: "mw", type: "action", name: "Magic Weapon", actor, system: {definition: stored}});
  assert.equal(read.ok, true, JSON.stringify(read.errors));
  const choice = read.definition.configuration.find(entry => entry.id === "weapon");
  assert.deepEqual(choice.options.map(option => [option.value, option.label]), [["sword", "Longsword"], ["dagger", "Dagger"]],
    "one per weapon, named for it; an Unarmed Strike is no weapon");
  const actorSystem = {resources: {bonus: {value: 1, max: 1}}, pools: [{id: "spell-slot.4", value: 1, max: 1}]};
  const resolved = resolveActionConfiguration({definition: read.definition, actorSystem,
    choices: {"spell-slot": {resourceId: "spell-slot.4"}, weapon: "sword"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const [rule] = resolved.configuration.effectiveDefinition.effects[0].ruleElements;
  assert.deepEqual(rule.predicate, {tagsAny: ["weapon:sword"]});
  assert.deepEqual(rule.data.valueExpression.key, {type: "constant", value: 4}, "the slot's level, a number");
  assert.equal(resolved.configuration.effectiveDefinition.effects[0].magicWeapon, "sword", "the weapon it makes magical (Q109)");
  const forged = resolveActionConfiguration({definition: read.definition, actorSystem,
    choices: {"spell-slot": {resourceId: "spell-slot.4"}, weapon: "someone-elses"}});
  assert.equal(forged.ok, false, "not one of its weapons");
});

test("Eldritch Hex adds its marker to Hex (synthetic): the hexed creature's saves of the chosen ability have Disadvantage too", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
  const hexed = (id, name, key) => ({_id: id, name, transfer: false, statuses: ["cursed"], duration: {value: 3600, units: "seconds"},
    system: {changes: [{key: `system.abilities.${key}.check.roll.mode`, value: -1, type: "add"}]}});
  const [hex] = convertItem({_id: "testHex000000001", name: "Hex", type: "spell", img: "icons/svg/daze.svg",
    effects: [hexed("s", "Hexed Strength", "str"), hexed("d", "Hexed Dexterity", "dex")], system: {source: SRD, identifier: "hex", level: 1,
      preparation: {mode: "prepared"}, properties: ["vocal", "concentration"], activation: {type: "bonus"}, range: {units: "ft", value: 90},
      target: {affects: {type: "creature", count: 1}, template: {}}, activities: {a: {_id: "actutility", type: "utility", name: "Place Curse",
        activation: {type: "bonus", override: false}, range: {override: false}, target: {affects: {type: "creature", count: 1}, template: {}},
        effects: [{_id: "s"}, {_id: "d"}], consumption: {targets: []}}}}}).items;
  const [feature] = convertItem({_id: "eldritchhex00000", name: "Eldritch Hex", type: "feat", effects: [], system: {source: SRD,
    identifier: "eldritch-hex", activities: {}, description: {value: ""}}}).items;
  const read = items => actionDefinitionFromItem({id: "hex", type: "action", name: hex.name, flags: hex.flags, system: hex.system, actor: {items}});
  assert.equal(read([]).definition.configuration.some(choice => choice.id === "eldritch-hex"), false, "not without the feature");
  const {definition} = read([feature]);
  assert.deepEqual(definition.configuration.find(choice => choice.id === "eldritch-hex").defaultValue, "on");
  // Its own choice beside Hex's (its slot left out here), offered "on".
  const resolved = resolveActionConfiguration({definition: {...definition, configuration: definition.configuration
    .filter(choice => choice.id !== "spell-slot")}, actorSystem: actorSystem(), choices: {"effect-choice": "effect-option-2", "eldritch-hex": "on"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const {effects} = resolved.configuration.effectiveDefinition;
  assert.deepEqual(effects.map(effect => effect.slug), ["hex", "hex-saves"], "the chosen hex, and the marker its save rule reads");
  assert.deepEqual(effects[0].ruleElements.filter(rule => rule.predicate?.hasCondition === "hex-saves").map(rule => rule.data.domains), [["save.agility"]]);
  assert.equal(effects[1].concentration, true, "it ends with the caster's concentration");
});

test("Restoring Touch adds its conditions to Lay on Hands: 5 points each, ended on the target, none of them healing", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const fs = await import("node:fs");
  const pack = file => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8"));
  const hands = pack("lay-on-hands-heal-phbpdnLayOnHands");
  const touch = pack("restoring-touch-phbpdnRestoringT");
  const read = active => actionDefinitionFromItem({id: "loh", type: "action", name: hands.name, flags: hands.flags, system: hands.system,
    actor: {items: [{...touch, system: {...touch.system, active}}]}});
  assert.equal(read(false).definition.configuration.some(choice => choice.id === "restoring-touch"), false, "not without the feature");
  const {definition} = read(true);
  const choice = definition.configuration.find(entry => entry.id === "restoring-touch");
  assert.deepEqual(choice.options.map(option => option.value), ["blinded", "charmed", "deafened", "frightened", "paralyzed", "stunned"]);
  const system = pool => ({resources: {bonus: {value: 1, max: 1}}, pools: [{id: "lay-on-hands", value: pool, max: 70}]});
  const resolved = resolveActionConfiguration({definition, actorSystem: system(12), choices: {points: 0, "restoring-touch": ["blinded", "stunned"]}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const effective = resolved.configuration.effectiveDefinition;
  assert.deepEqual(effective.healing, [], "0 points heal nothing");
  assert.deepEqual(effective.effects.map(effect => [effect.conditionId, effect.levels]), [["blinded", -1], ["stunned", -1]]);
  assert.deepEqual(effective.costs.allOf.filter(cost => cost.capability === "lay-on-hands").map(cost => cost.amount), [5, 5]);
  const healed = resolveActionConfiguration({definition, actorSystem: system(12), choices: {points: 2, "restoring-touch": ["charmed"]}});
  assert.deepEqual([healed.configuration.effectiveDefinition.healing[0].expression.value,
    healed.configuration.effectiveDefinition.costs.allOf.filter(cost => cost.capability === "lay-on-hands").map(cost => cost.amount)], [2, [2, 5]]);
  // V14's form gives each unticked checkbox of the choice as null.
  const ticked = resolveActionConfiguration({definition, actorSystem: system(12),
    choices: {points: 0, "restoring-touch": {values: ["blinded"]}}});
  assert.equal(ticked.ok, true, JSON.stringify(ticked.errors));
  const nothing = resolveActionConfiguration({definition, actorSystem: system(12), choices: {points: 0, "restoring-touch": {values: []}}});
  assert.equal(nothing.ok, false, "0 points and no condition: nothing to do");
  const twice = actionDefinitionFromItem({id: "loh", type: "action", name: hands.name, flags: hands.flags, system: hands.system,
    actor: {items: [touch, {...touch, _id: "copy"}]}}).definition;
  assert.equal(twice.configuration.filter(choice => choice.id === "restoring-touch").length, 1, "a feature held twice adds its choice once");
  const plain = read(false).definition;
  assert.equal(resolveActionConfiguration({definition: plain, actorSystem: system(12), choices: {points: 0}}).ok, false,
    "without Restoring Touch, 0 points is refused");
});

test("a declined \"you can\" does nothing: every part that acts is dropped, a later choice's too; only its identity, aim and choices stay", () => {
  // The use choice first and a restoring choice after it (Arcane Recovery's shape), on an Action that does everything.
  const definition = {schemaVersion: 1, id: "action:everything", slug: "everything", label: "Everything", tags: ["spell"],
    costs: {allOf: [{capability: "reaction", amount: 1}]}, range: {type: "ranged", normal: {value: 60, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1}, targetChoice: {from: "creatures", range: 60},
    attack: {type: "spell", statistic: "attack.spell"}, save: {ability: "wisdom", dc: {value: 15}}, check: {skill: "athletics", dc: {value: 15}},
    damage: [{id: "fire", expression: {type: "constant", value: 5}, damageType: "fire"}],
    effects: [{id: "prone", type: "condition", conditionId: "prone"}], transform: {formRef: "Actor.wolf"},
    summon: {actorRef: "Actor.wolf", count: 1}, push: {distance: 10}, ends: {statuses: ["charmed"]}, metadata: {spellLevel: 2},
    configuration: [
      {id: "use", type: "option", label: "Use", required: true, defaultValue: "use",
        options: [{id: "use", label: "Use it", value: "use"}, {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]},
      {id: "slot", type: "option", label: "Slot", required: false,
        options: [{id: "third", label: "3rd", value: 3, effects: [{type: "restore", resourceId: "spell-slot.3", amount: 1}]}]}]};
  const system = actorSystem({pools: [{id: "spell-slot.3", value: 0, max: 1}]});
  const declined = resolveActionConfiguration({definition, actorSystem: system, choices: {use: "decline", slot: 3}});
  assert.equal(declined.ok, true, JSON.stringify(declined.errors));
  const effective = declined.configuration.effectiveDefinition;
  for ( const key of ["attack", "save", "check", "transform", "summon", "push", "ends", "restores"] ) {
    assert.ok(!effective[key], `${key} dropped`);
  }
  assert.deepEqual([effective.damage, effective.effects, effective.costs.allOf], [[], [], []]);
  assert.deepEqual([effective.id, effective.slug, effective.label, effective.tags, effective.targeting.type, effective.targetChoice.from, effective.range.type,
    effective.configuration.map(choice => choice.id), effective.metadata.spellLevel],
  ["action:everything", "everything", "Everything", ["spell"], "single", "creatures", "ranged", ["use", "slot"], 2]);

  const used = resolveActionConfiguration({definition, actorSystem: system, choices: {use: "use", slot: 3}});
  assert.equal(used.ok, true, JSON.stringify(used.errors));
  const kept = used.configuration.effectiveDefinition;
  assert.deepEqual([kept.save.ability, kept.transform.formRef, kept.summon.actorRef, kept.push.distance, kept.ends.statuses,
    kept.targetChoice.from, kept.restores.map(entry => entry.resourceId), kept.costs.allOf.map(cost => cost.capability)],
  ["wisdom", "Actor.wolf", "Actor.wolf", 10, ["charmed"], "creatures", ["spell-slot.3"], ["reaction"]], "not declined: unchanged");
});

test("a declined \"you can\" area Action keeps its area's shape (still valid and placeable) but not the lasting area it would leave", async () => {
  const {startsConcentration} = await import("../module/helpers/action-definitions.mjs");
  const definition = {schemaVersion: 1, id: "action:cloud", label: "Cloud", costs: {allOf: []}, targeting: {type: "area", required: true},
    area: {shape: "sphere", size: {value: 20, unit: "ft"}, persistence: {concentration: true, triggers: []}},
    save: {ability: "fortitude", dc: {value: 15}},
    configuration: [{id: "use", type: "option", label: "Use", required: true, defaultValue: "use",
      options: [{id: "use", label: "Use it", value: "use"}, {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]}]};
  const declined = resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {use: "decline"}});
  assert.equal(declined.ok, true, JSON.stringify(declined.errors));
  const effective = declined.configuration.effectiveDefinition;
  assert.deepEqual([effective.targeting.type, effective.area.shape, effective.area.size.value, effective.area.persistence ?? null, effective.save ?? null],
    ["area", "sphere", 20, null, null]);
  assert.equal(startsConcentration(effective), false, "it starts no concentration");
  assert.equal(definition.area.persistence.concentration, true, "the Action as written is untouched");
});

test("Fast Hands (Q63) lets a magic item's Action-cost use cost a Bonus Action; never a spell, a weapon's attack, a feature's, or a Bonus Action", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const fs = await import("node:fs");
  const pack = file => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8"));
  const hands = pack("fast-hands-use-an-object-1zgmeh1lyy66t000");
  // Each Action as its creature holds it, brought by an Item of type `by` (`flags.wildpath.grantedBy`): a gear Item's own.
  const read = (file, items=[hands], by="gear") => {
    const item = pack(file);
    return actionDefinitionFromItem({id: item._id, type: "action", name: item.name, system: item.system,
      flags: {...item.flags, wildpath: {...item.flags.wildpath, ...(by ? {grantedBy: "granter"} : {})}},
      actor: {items: [...items, {id: "granter", type: by}]}}).definition;
  };
  const offered = (file, items, by) => (read(file, items, by).configuration ?? []).some(choice => choice.id === "fast-hands");
  assert.equal(offered("elemental-gem-red-corundum-dmgRedElementalG"), true, "a magic item's Magic action");
  assert.equal(offered("ring-of-the-ram-attack-dmgRingOfTheRam0"), true, "an item's own spell attack is a use of the item, not a spell");
  assert.equal(offered("elemental-gem-red-corundum-dmgRedElementalG", []), false, "not without Fast Hands");
  assert.equal(offered("breath-weapon-breath-weapon-cone-phbsptBreathWeap", undefined, "species"), false, "a species' magical Action");
  assert.equal(offered("elemental-gem-red-corundum-dmgRedElementalG", undefined, null), false, "an Action no gear brought");
  for ( const [file, why] of [["wand-of-fireballs-fireball-1jmo8r3pdhyg3000", "a spell cast from it (Q121's default)"],
    ["dagger-of-venom-attack-dmgDaggerOfVenom", "a magic weapon's attack (the Attack action)"], ["potion-of-healing-dmgPotionOfHeali", "already a Bonus Action"],
    ["longsword-phbwepLongsword0", "not magical"], ["portable-hole-escape-check-s2klun1hcgkuv000", "an ability check, not a Magic action"],
    ["dimensional-shackles-attempt-escape-rrc3te1blwdc0000", "an escape check either"],
    ["fast-hands-use-an-object-1zgmeh1lyy66t000", "its own Action"]] ) assert.equal(offered(file), false, why);
  const definition = read("elemental-gem-red-corundum-dmgRedElementalG");
  const system = actorSystem({pools: [{id: "elemental-gem-red-corundum", value: 1, max: 1}]});
  const paid = choice => {
    const resolved = resolveActionConfiguration({definition, actorSystem: system, choices: {"fast-hands": choice}});
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
    return resolved.configuration.effectiveDefinition.costs.allOf.map(cost => cost.capability);
  };
  assert.deepEqual(paid("bonus-action"), ["bonus-action", "elemental-gem-red-corundum"], "a Bonus Action, and still the gem itself");
  assert.deepEqual(paid("no"), ["action", "elemental-gem-red-corundum"], "the Action stays its default");
});

test("Rage of the Wilds (Q62) is chosen as Rage starts: each option adds to Rage's own effect, so it lasts and ends with that Rage", async () => {
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const fs = await import("node:fs");
  const rage = JSON.parse(fs.readFileSync("packs/_source/srd-items/rage-phbbrbRage000000.json", "utf8"));
  const [eagle] = convertItem({_id: "ragewilds0000001", name: "Rage of the Wilds", type: "feat", img: "icons/svg/walk.svg", effects: [],
    system: {source: {license: "CC-BY-4.0", rules: "2024", book: ""}, identifier: "rage-of-the-wilds", activation: {type: "bonus"}, range: {},
      target: {affects: {}, template: {}}, description: {value: "<p><strong>Eagle.</strong> While your Rage is active, you can take a Bonus "
        + "Action to take both of those actions.</p>"}, activities: {a: {_id: "actEagle", type: "utility", name: "Eagle",
        activation: {type: "bonus", override: false}, range: {override: false}, target: {affects: {}, template: {}}, effects: [],
        consumption: {targets: []}}}}}).items;
  const read = items => actionDefinitionFromItem({id: "rage", type: "action", name: rage.name, flags: rage.flags, system: rage.system,
    actor: {items}}).definition;
  assert.equal((read([]).configuration ?? []).some(choice => choice.id === "rage-of-the-wilds"), false, "not without the feature");
  const definition = read([eagle]);
  const system = actorSystem({pools: [{id: "rage", value: 2, max: 2}]});
  const raged = (option, using=definition) => resolveActionConfiguration({definition: using, actorSystem: system,
    choices: {"rage-of-the-wilds": option}});
  const effects = option => {
    const resolved = raged(option);
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
    return resolved.configuration.effectiveDefinition.effects;
  };
  const [bear] = effects("bear");
  assert.deepEqual([bear.slug, bear.statuses, bear.ruleElements.at(-1).id, bear.ruleElements.at(-1).data.damageTypes.includes("fire"),
    ["force", "necrotic", "psychic", "radiant"].some(type => bear.ruleElements.at(-1).data.damageTypes.includes(type))],
  ["raging", undefined, "rage-of-the-wilds-bear", true, false], "Bear's Resistances are on the Rage's own effect");
  assert.deepEqual(effects("eagle").map(effect => [effect.slug, effect.statuses ?? null]),
    [["raging", ["rage-eagle"]], ["disengaged", null], ["dashing", null]], "Eagle's status on the Rage, and Disengage and Dash as it starts");
  assert.deepEqual(effects("wolf")[0].ruleElements.at(-1).data.ruleElements[0].predicate,
    {oneOf: {path: "source.bearerTokenId", valuesPath: "attack.attackerAllies"}}, "Wolf's aura grants its bearer's allies alone");
  // Eagle's own Bonus Action only in a Rage that took Eagle.
  const requires = eagle.system.definition.requires;
  assert.deepEqual([evaluatePredicate(requires, {conditions: ["raging", "rage-eagle"]}).ok, evaluatePredicate(requires, {conditions: ["raging"]}).ok],
    [true, false]);
  // An option adding to an effect its Action lacks is refused, not dropped.
  const broken = {...definition, configuration: definition.configuration.map(choice => ((choice.id !== "rage-of-the-wilds") ? choice
    : {...choice, options: choice.options.map(option => ({...option, effects: option.effects.map(effect => ((effect.type === "add-to-effect")
      ? {...effect, effect: "missing"} : effect))}))}))};
  assert.equal(raged("bear", broken).ok, false);
});

test("Physician's Touch adds Poisoned, until the end of the monk's next turn, to Hand of Harm's own hit offer", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
  const [harm] = convertItem({_id: "testHandOfHarm01", name: "Hand of Harm", type: "feat", effects: [], system: {source: SRD,
    identifier: "hand-of-harm", description: {value: "<p>Once per turn when you hit a creature with an Unarmed Strike, you can deal extra "
      + "Necrotic damage.</p>"}, activities: {a: {_id: "actharm", type: "damage", name: "", activation: {type: "", condition: "", override: false},
      range: {units: "self", override: false}, target: {affects: {type: "creature", count: "1"}, template: {}}, consumption: {targets: []},
      damage: {parts: [{number: 1, denomination: 6, types: ["necrotic"], bonus: ""}]}}}}}).items.filter(item => item.type === "action");
  const [touch] = convertItem({_id: "testPhysicians01", name: "Physician's Touch", type: "feat", effects: [], system: {source: SRD,
    identifier: "physicians-touch", activities: {}, description: {value: ""}}}).items;
  const read = items => actionDefinitionFromItem({id: "harm", type: "action", name: harm.name, flags: harm.flags, system: harm.system,
    actor: {items}}).definition;
  assert.equal(read([]).configuration?.some(choice => choice.id === "physicians-touch") ?? false, false, "not without the feature");
  const definition = read([touch]);
  const effects = value => resolveActionConfiguration({definition, actorSystem: actorSystem(), choices: {"physicians-touch": value}})
    .configuration.effectiveDefinition.effects ?? [];
  assert.deepEqual(effects("poisoned").map(effect => [effect.conditionId, effect.duration]),
    [["poisoned", {value: 1, units: "rounds", expiry: "sourceTurnEnd"}]]);
  assert.deepEqual(effects("no"), [], "it may be left out");
});

test("Font of Magic: a slot level's own effects cost its points and give back its slot; a full or missing slot is refused", async () => {
  const fs = await import("node:fs");
  const read = file => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8")).system.definition;
  const create = read("font-of-magic-regain-spell-slot-phbscrFontOfMagi");
  const convert = read("font-of-magic-regain-sorcery-points-1qw9xnc13fzrn000");
  const system = (slot2, points=5) => ({resources: {bonus: {value: 1, max: 1}},
    pools: [{id: "font-of-magic", value: points, max: 5}, {id: "spell-slot.2", value: slot2, max: 3}, {id: "spell-slot.3", value: 2, max: 2}]});
  const made = resolveActionConfiguration({definition: create, actorSystem: system(1), choices: {"slot-level": "level-2"}});
  assert.equal(made.ok, true, JSON.stringify(made.errors));
  assert.deepEqual(made.configuration.effectiveDefinition.restores, [{resourceId: "spell-slot.2", amount: 1}]);
  const costs = made.configuration.effectiveDefinition.costs.allOf.map(cost => [cost.capability, cost.amount]);
  assert.deepEqual(costs, [["bonus-action", 1], ["font-of-magic", 3]]);
  assert.equal(resolveActionConfiguration({definition: create, actorSystem: system(3), choices: {"slot-level": "level-2"}}).ok, false, "slots full");
  assert.equal(resolveActionConfiguration({definition: create, actorSystem: system(1), choices: {"slot-level": "level-4"}}).ok, false, "no level-4 slots");
  const converted = resolveActionConfiguration({definition: convert, actorSystem: system(1, 1),
    choices: {slot: {resourceId: "spell-slot.3"}}});
  assert.equal(converted.ok, true, JSON.stringify(converted.errors));
  assert.deepEqual(converted.configuration.effectiveDefinition.restores, [{resourceId: "font-of-magic", amount: 3}], "a level-3 slot gives 3 points");
  assert.equal(resolveActionConfiguration({definition: convert, actorSystem: system(1), choices: {slot: {resourceId: "spell-slot.3"}}}).ok, false,
    "points full");
});

test("a fixed cast level (a monster's upcast spell) scales its damage and is the cast's level", () => {
  const definition = {schemaVersion: 1, id: "action:bolt", label: "Lightning Bolt", costs: {allOf: []},
    damage: [{id: "damage-1", expression: {type: "dice", number: 8, faces: 6}, damageType: "lightning"}],
    configuration: [{id: "spell-slot", type: "option", required: true, fromCast: true,
      options: [{id: "level-7", label: "7", value: 7, metadata: {castingLevel: 7}}],
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 3, componentIds: ["damage-1"], dice: {number: 1, faces: 6}}]}]};
  const resolved = resolveActionConfiguration({definition, actorSystem: {}, choices: {"spell-slot": 7}});
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.configuration.effectiveDefinition.damage[0].expression, {type: "dice", number: 12, faces: 6});
  assert.equal(resolved.configuration.castingLevel, 7);
});

test("an area that grows with the level chosen (Confusion: 5 feet more per slot level above 4th)", () => {
  const definition = {schemaVersion: 1, id: "action:confusion", label: "Confusion", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape: "radial", size: {value: 10, unit: "ft"}},
    configuration: [{id: "cast-level", type: "option", required: true, options: [4, 5, 6].map(value => ({id: `level-${value}`, value}))
      .map(option => ({...option, label: String(option.value)})),
      effects: [{type: "scaleArea", levelChoiceId: "cast-level", baseLevel: 4, perLevel: 5}]}]};
  const sized = level => resolveActionConfiguration({definition, actorSystem: {}, choices: {"cast-level": level}})
    .configuration.effectiveDefinition.area.size.value;
  assert.deepEqual([sized(4), sized(6)], [10, 20]);
});

test("a number choice's maximum may read its creature (Healing Light: up to its Charisma modifier, at least 1)", () => {
  const max = {type: "max", terms: [{type: "constant", value: 1}, {type: "ability-modifier", ability: "presence"}]};
  const definition = {schemaVersion: 1, id: "action:healing-light", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, healing: [{id: "healing-1", expression: {type: "constant", value: 1}, healingType: "healing"}],
    configuration: [{id: "spent", type: ACTION_CHOICE_TYPES.NUMBER, label: "Dice", required: true, min: 1, max,
      effects: [{type: "spendAmount", resourceId: "light", componentIds: ["healing-1"], faces: 6}]}]};
  const system = actorSystem();
  const withPresence = score => ({...system, abilities: {...(system.abilities ?? {}), presence: {value: score}},
    pools: [...(system.pools ?? []), {id: "light", value: 9, max: 9}]});
  assert.equal(resolveActionConfiguration({definition, actorSystem: withPresence(16), choices: {spent: 3}}).ok, true, "Presence 16: up to 3");
  assert.equal(resolveActionConfiguration({definition, actorSystem: withPresence(16), choices: {spent: 4}}).ok, false, "not 4");
  assert.equal(resolveActionConfiguration({definition, actorSystem: withPresence(8), choices: {spent: 1}}).ok, true, "at least 1");
});

test("Arcane Recovery: after a Short Rest, slots whose levels add up to half its wizard level at most, none above 5", async () => {
  const fs = await import("node:fs");
  const recovery = JSON.parse(fs.readFileSync("packs/_source/srd-items/arcane-recovery-phbwzdArcaneReco.json", "utf8"));
  const trigger = recovery.system.ruleElements.find(rule => rule.type === "Trigger");
  assert.deepEqual([trigger.data.event, trigger.data.predicate.all[0].equals.value], ["rest.completed", "shortRest"]);
  const definition = trigger.data.action;
  assert.equal(definition.configuration[1].options.every(option => option.value <= 5), true, "none of level 6 or higher");
  const actorSystem = {classes: [{id: "wizard", level: 6}], resources: {}, pools: [{id: "arcane-recovery", value: 1, max: 1},
    ...[1, 2, 3].map(level => ({id: `spell-slot.${level}`, value: 0, max: 3}))]};
  const pick = (...ids) => resolveActionConfiguration({definition, actorSystem, choices: {use: "use", slots: {values: ids}}});
  const restored = result => result.configuration.effectiveDefinition.restores.map(entry => entry.resourceId);
  assert.deepEqual(restored(pick("level-3-1")), ["spell-slot.3"], "3 of a budget of 3");
  assert.deepEqual(restored(pick("level-2-1", "level-1-1")), ["spell-slot.2", "spell-slot.1"]);
  assert.equal(pick("level-3-1", "level-1-1").ok, false, "4 is over half of 6");
  assert.equal(resolveActionConfiguration({definition, actorSystem: {...actorSystem, classes: []}, choices: {use: "use",
    slots: {values: ["level-1-1"]}}}).ok, false, "no wizard levels: a budget it can't work out allows nothing");
});

test("Overchannel (synthetic feat) on a wizard spell: maximum damage; its first use free, then 2d12, 3d12... per slot level", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const fs = await import("node:fs");
  const [feature] = convertItem({_id: "overchannel00000", name: "Overchannel", type: "feat", effects: [], system: {
    source: {license: "CC-BY-4.0", rules: "2024", book: "SRD 5.2"}, identifier: "overchannel", activities: {},
    uses: {max: "20", recovery: [{period: "lr", type: "recoverAll"}]}, description: {value: ""}}}).items;
  const fireball = JSON.parse(fs.readFileSync("packs/_source/srd-items/fireball-phbsplFireball00.json", "utf8"));
  const read = (system=fireball.system) => actionDefinitionFromItem({id: "fireball", type: "action", name: fireball.name, flags: fireball.flags,
    system, actor: {items: [feature]}}).definition;
  const definition = read();
  assert.deepEqual(definition.configuration.find(choice => choice.id === "overchannel").options.map(option => option.value), ["no", "overchannel"]);
  const cleric = {...fireball.system, definition: {...fireball.system.definition, metadata: {spellLevel: 3, spellLists: ["cleric"]}}};
  assert.equal(read(cleric).configuration.some(choice => choice.id === "overchannel"), false, "not a wizard spell");
  const harmless = {...fireball.system, definition: {...fireball.system.definition, damage: []}};
  assert.equal(read(harmless).configuration.some(choice => choice.id === "overchannel"), false, "deals no damage");
  const cast = (left, slot=3, use="overchannel") => resolveActionConfiguration({definition, actorSystem: actorSystem({pools: [
    {id: `spell-slot.${slot}`, value: 1, max: 1}, {id: "overchannel", value: left, max: 20}]}),
  choices: {"spell-slot": {resourceId: `spell-slot.${slot}`}, overchannel: use}});
  const first = cast(20);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const effective = first.configuration.effectiveDefinition;
  assert.equal(effective.metadata.maximized, true, "its damage dice deal their maximum");
  assert.deepEqual(effective.sourceDamage.map(entry => [entry.expression.number, entry.damageType, entry.ignoreResistance, entry.ignoreImmunity]),
    [[0, "necrotic", true, true]], "the first use since a Long Rest deals its caster nothing");
  assert.deepEqual(effective.costs.allOf.filter(cost => cost.capability === "overchannel").map(cost => cost.amount), [1], "a use is spent");
  assert.deepEqual(cast(19).configuration.effectiveDefinition.sourceDamage[0].expression, {type: "dice", number: 6, faces: 12},
    "the second use: 2d12 for each of the slot's 3 levels");
  assert.equal(cast(18, 5).configuration.effectiveDefinition.sourceDamage[0].expression.number, 15, "the third: 3d12 for each of 5 levels");
  assert.equal(cast(19, 6).ok, false, "not with a slot above level 5");
  const plain = cast(19, 3, "no").configuration.effectiveDefinition;
  assert.deepEqual([plain.metadata.maximized, plain.sourceDamage, plain.costs.allOf.some(cost => cost.capability === "overchannel")],
    [undefined, undefined, false], "not used: no maximum, no backlash, no use spent");
});

test("a payment sees the tags a Forbid tests an Action by, so a Dash is paid from an extra action given for it (Haste)", () => {
  const dash = {schemaVersion: 1, id: "common:dash", label: "Dash", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "self"}, range: {type: "self"}};
  const result = resolveActionConfiguration({definition: dash, actorSystem: actorSystem({resources: {action: {value: 0, max: 1}},
    pools: [{id: "haste-extra-action", value: 1, max: 1, recovery: "turn", pays: ["action"], actions: {tagsAny: ["id:common:dash"]}}]})});
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.selectedPaymentPlan.resources.map(entry => entry.resourceId), ["haste-extra-action"]);
});

test("a choice of its creature's own spells (optionsFrom spells): its castings that pass the predicate, each holding the slot choice to its level", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const slot = (id, base, extra={}) => ({id, type: ACTION_CHOICE_TYPES.RESOURCE, label: id, required: true,
    cost: {anyOf: [...(extra.free ? [[]] : []), ...levels.filter(level => level >= base).map(level => [{capability: `spell-slot.${level}`, amount: 1}])]},
    levelByResourceId: Object.fromEntries(levels.filter(level => level >= base).map(level => [`spell-slot.${level}`, level])),
    ...(extra.free ? {metadata: {freeCastLevel: 0}} : {})});
  const spell = (id, level, {cost="action", targeting={type: "single"}, data={}, metadata={}, system={}, flags={}}={}) => ({id, type: "action",
    name: id, flags, system: {...system, definition: {schemaVersion: 1, id: `action:${id}`, tags: ["spell"], costs: {allOf: [{capability: cost, amount: 1}]},
      targeting, metadata: {spellLevel: level, ...metadata}, configuration: level ? [slot("spell-slot", level)] : [], ...data}}});
  // Contingency's own: cast at 6th level, then a spell of 5th level or lower that costs an Action and can target its caster.
  const contingency = spell("contingency", 6, {targeting: {type: "self"}, data: {configuration: [slot("spell-slot", 6),
    {id: "contingent", type: "select-one", label: "Contingent spell", required: true, options: [], optionsFrom: {type: "spells",
      slotChoice: "contingent-slot", actions: {all: [{tagsAll: ["cost:action"]}, {atMost: {path: "spellLevel", value: 5}},
        {any: [{equals: {path: "targeting.type", value: "self"}}, {all: [{oneOf: {path: "targeting.type", values: ["single", "multiple"]}},
          {not: {equals: {path: "targeting.notSelf", value: true}}}]}]}]}}},
    slot("contingent-slot", 1, {free: true})]}});
  const items = [contingency, spell("stoneskin", 4), spell("fly", 3), spell("light", 0, {targeting: {type: "self"}}),
    spell("initiate-light", 0, {flags: {wildpath: {grantedBy: "magic-initiate"}}}), {id: "magic-initiate", type: "feature", name: "Magic Initiate", system: {}},
    spell("staff-light", 0, {flags: {wildpath: {grantedBy: "staff"}}}), {id: "staff", type: "gear", name: "Staff", system: {}},
    spell("big", 6), spell("fireball", 3, {targeting: {type: "area"}}), spell("help-other", 2, {targeting: {type: "single", notSelf: true}}),
    spell("quick", 1, {cost: "bonus-action", targeting: {type: "self"}}), spell("unready", 2, {system: {prepared: false}}),
    spell("asleep", 1, {system: {active: false}}), spell("claws", 2, {metadata: {followUp: true}, data: {configuration: []}}),
    spell("again", 2, {metadata: {followUp: true}}), spell("wand-cast", 2, {data: {configuration: []}}),
    spell("blade-attack", 0, {data: {configuration: [{id: "cast", type: "select-one", label: "Cast", options: ["a"], fromCast: true}]}}),
    {id: "dash", type: "action", name: "Dash", system: {definition: {schemaVersion: 1, id: "common:dash", costs: {allOf: [{capability: "action", amount: 1}]}, targeting: {type: "self"}}}}];
  const actor = {items, system: {pools: []}};
  for ( const item of items ) item.actor = actor;
  const definition = actionDefinitionFromItem(contingency).definition;
  const contingent = definition.configuration.find(choice => choice.id === "contingent");
  assert.deepEqual(contingent.options.map(option => option.value), ["stoneskin", "fly", "light", "initiate-light"],
    "a feat's cantrip, but not gear's cantrip, a 6th-level, area, notSelf, Bonus Action, unprepared or inactive spell, a follow-up or a cast without a slot choice, a non-spell, nor itself");
  assert.deepEqual(contingent.options[0].effects, [{type: "require-level", levelChoiceId: "contingent-slot", min: 4}], "its level or higher");
  assert.deepEqual(contingent.options[2].effects, [{type: "require-level", levelChoiceId: "contingent-slot", min: 0, max: 0}], "a cantrip: no slot");

  const system = (sixth=1) => actorSystem({pools: levels.map(level => ({id: `spell-slot.${level}`, label: `Level ${level}`,
    value: (level === 6) ? sixth : 1, max: 2}))});
  const freeOption = discoverActionConfigurationChoices({definition, actorSystem: system()}).requests
    .find(choice => choice.id === "contingent-slot").options.find(option => !option.resources.length);
  assert.deepEqual([freeOption.label, freeOption.labelData], ["WILDPATH.PROMPT.NoResource", undefined],
    "a cantrip's free option (level 0) is not \"Free, at level 0\"");
  const free = freeOption.id;
  const configure = (picked, contingentSlot, sixth) => resolveActionConfiguration({definition, actorSystem: system(sixth),
    choices: {"spell-slot": {resourceId: "spell-slot.6"}, contingent: picked, "contingent-slot": contingentSlot}});
  assert.equal(configure("fly", {resourceId: "spell-slot.1"}).ok, false, "a 3rd-level spell is not stored with a 1st-level slot");
  assert.equal(configure("fly", free).ok, false, "nor with no slot");
  const upcast = configure("fly", {resourceId: "spell-slot.4"});
  assert.equal(upcast.ok, true, JSON.stringify(upcast.errors));
  assert.equal(upcast.configuration.castingLevel, 6, "Contingency's own slot comes first, so it is cast at 6th level");
  assert.deepEqual(upcast.configuration.selectedPaymentPlan.resources.map(entry => entry.resourceId).sort(), ["economy.action", "spell-slot.4", "spell-slot.6"]);
  assert.equal(configure("light", free).ok, true, "a cantrip with no slot");
  assert.equal(configure("light", {resourceId: "spell-slot.1"}).ok, false, "a cantrip wastes no slot");
  assert.equal(configure("big", {resourceId: "spell-slot.6"}).ok, false, "a spell that is not an option is refused");
  assert.equal(configure("stoneskin", {resourceId: "spell-slot.6"}, 2).ok, true, "two 6th-level slots, both spent");
  assert.equal(configure("stoneskin", {resourceId: "spell-slot.6"}, 1).ok, false, "one 6th-level slot left pays for one");
});

test("a choiceFor or spells predicate reads the Action's spell level and targeting", async () => {
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const choice = {id: "boost", type: "select-one", label: "Boost", options: ["no", "yes"]};
  const feature = {id: "feat", type: "feature", system: {}, flags: {wildpath: {choiceFor: {choice,
    actions: {all: [{atMost: {path: "spellLevel", value: 2}}, {equals: {path: "targeting.type", value: "single"}}]}}}}};
  const spell = (level, targeting) => ({id: `s${level}`, type: "action", name: "Spell", system: {definition: {schemaVersion: 1,
    id: `action:s${level}`, tags: ["spell"], costs: {allOf: []}, targeting, metadata: {spellLevel: level}}}});
  const offered = item => {
    item.actor = {items: [feature, item], system: {pools: []}};
    return actionDefinitionFromItem(item).definition.configuration?.some(entry => entry.id === "boost") ?? false;
  };
  assert.equal(offered(spell(2, {type: "single"})), true);
  assert.equal(offered(spell(3, {type: "single"})), false, "above 2nd level");
  assert.equal(offered(spell(1, "single")), true, "a targeting written as its type alone is read as one");
  assert.equal(offered(spell(1, {type: "self"})), false, "not a single target");
});

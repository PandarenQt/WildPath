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

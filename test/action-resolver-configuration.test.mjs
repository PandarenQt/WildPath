import {test} from "node:test";
import assert from "node:assert/strict";
import {createResolvedActionPreview} from "../module/helpers/action-configuration.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {
  ACTION_RESOLVER_CODES,
  planActionResolution
} from "../module/resolvers/action-resolver.mjs";

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
      {id: "sorcery-point", label: "Sorcery Point", value: 2, max: 2}
    ]
  };
}

function actionItem(definition) {
  return {
    id: "item-action",
    uuid: "Item.item-action",
    type: "action",
    name: definition.label ?? "Action",
    system: {
      definition,
      cost: {action: 0, bonus: 0, reaction: 0, movement: 0, custom: []}
    }
  };
}

function configurableActionDefinition() {
  return {
    schemaVersion: 1,
    id: "action:configured-burst",
    label: "Configured Burst",
    tags: ["spell"],
    costs: {allOf: []},
    targeting: {type: "single", required: true},
    damage: [{
      id: "burst",
      expression: {type: "dice", number: 8, faces: 6},
      damageType: "fire",
      provenance: "spell-base"
    }],
    configuration: [{
      id: "casting-resource",
      type: "resource",
      label: "Cast At",
      required: true,
      cost: {
        anyOf: [
          [{capability: "spell-slot.3", amount: 1}],
          [{capability: "spell-slot.4", amount: 1}],
          [{capability: "spell-slot.5", amount: 1}]
        ]
      },
      levelByResourceId: {
        "spell-slot.3": 3,
        "spell-slot.4": 4,
        "spell-slot.5": 5
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
      type: "boolean",
      source: {type: "feature", slug: "elemental-conversion"},
      effects: [{
        type: "addCost",
        cost: {allOf: [{capability: "sorcery-point", amount: 1}]}
      }]
    },
    {
      id: "conversion-type",
      type: "damage-type",
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

test("ActionResolver consumes configured ActionDefinitions for damage and payment planning", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(),
    action: actionItem(configurableActionDefinition()),
    source: {actorId: "caster"},
    targets: [{id: "orc", actorId: "actor-orc", disposition: "enemy"}],
    configuration: {
      choices: {
        "casting-resource": {resourceId: "spell-slot.5"},
        "enable-conversion": true,
        "conversion-type": "lightning"
      }
    },
    configurationContributions: conversionFeature(),
    damage: {
      components: [{id: "burst", amount: 35}]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.context.metadata.resolvedActionConfiguration.castingLevel, 5);
  assert.deepEqual(result.context.metadata.resolvedActionConfiguration.selectedDamageTypes, {
    "conversion-type": "lightning"
  });
  assert.equal(result.context.action.metadata.actionDefinition.id, "action:configured-burst");
  const damage = result.consequences.find(consequence => consequence.type === "damageResolved").damageResolution;
  assert.equal(damage.results[0].components[0].damageType, "lightning");
  assert.equal(damage.results[0].components[0].metadata.actionDefinitionComponent.id, "burst");
  const payment = result.consequences.find(consequence => consequence.type === "resourcePayment").paymentPlan;
  assert.deepEqual(payment.resources.map(resource => resource.resourceId).sort(), [
    "sorcery-point",
    "spell-slot.5"
  ]);
  const resourcePlan = result.mutationPlans.find(plan => plan.type === "resourcePayment").plan;
  assert.deepEqual(resourcePlan.payments.map(payment => payment.resourceId).sort(), [
    "sorcery-point",
    "spell-slot.5"
  ]);
});

test("ActionResolver revalidates resolved configurations and fails before payment when resources change", () => {
  const preview = createResolvedActionPreview({
    definition: configurableActionDefinition(),
    actorSystem: actorSystem(),
    choices: {
      "casting-resource": {resourceId: "spell-slot.5"}
    }
  });
  const result = planActionResolution({
    actorSystem: actorSystem({
      pools: [
        {id: "spell-slot.3", label: "3rd-level Spell Slot", value: 1, max: 1}
      ]
    }),
    action: actionItem(configurableActionDefinition()),
    source: {actorId: "caster"},
    targets: [{id: "orc", actorId: "actor-orc", disposition: "enemy"}],
    configuration: preview.configuration,
    damage: {
      components: [{id: "burst", amount: 35}]
    }
  });

  assert.equal(preview.ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.ACTION_CONFIGURATION_INVALID);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

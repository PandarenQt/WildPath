import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_DEFINITION_CODES,
  actionDefinitionActivationCost,
  actionDefinitionFromItem,
  actionDefinitionToResolverInput,
  serializeActionDefinition,
  validateActionDefinition
} from "../module/helpers/action-definitions.mjs";
import {TARGET_DEFAULT_SELECTION} from "../module/helpers/targeting.mjs";

const ACTOR_SYSTEM = {
  abilities: {
    might: {value: 18},
    wits: {value: 14}
  },
  details: {level: 5},
  resources: {
    focus: {value: 2, max: 3}
  }
};

function meleeFixture() {
  return {
    schemaVersion: 1,
    id: "action:longsword-strike",
    slug: "longsword-strike",
    label: "Longsword Strike",
    tags: ["weapon-attack", "melee"],
    source: {type: "item", ref: "item:longsword"},
    origin: {type: "self"},
    activation: {type: "action"},
    costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "reach", distance: {value: 5, unit: "ft"}},
    targeting: {
      type: "single",
      required: true,
      count: {type: "constant", value: 1},
      eligibilityPolicy: {
        kinds: ["creature"],
        dispositions: ["enemy"],
        predicate: {tagsAny: ["hostile"]}
      },
      refinementPolicy: {
        defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
        maxSelections: {type: "constant", value: 1}
      }
    },
    attack: {
      type: "melee",
      statistic: "attack.melee.weapon",
      ability: "might",
      proficiency: "proficient",
      rangeMode: "reach",
      selectors: ["weapon-attack"]
    },
    damage: [{
      id: "weapon-base",
      expression: {type: "constant", value: 8},
      damageType: "slashing",
      provenance: "weapon-base",
      scalingCategory: "weapon-size",
      predicate: {tagsAny: ["weapon-attack"]}
    }],
    ruleElements: [{
      schemaVersion: 1,
      id: "strike.audit",
      type: "Modifier",
      data: {
        domains: ["attack.melee.weapon"],
        valueExpression: {type: "constant", value: 1}
      }
    }]
  };
}

test("ActionDefinition serialization round-trips without mutating authored data", () => {
  const authored = meleeFixture();
  const before = structuredClone(authored);
  const serialized = serializeActionDefinition(authored);
  const roundTrip = serializeActionDefinition(JSON.parse(JSON.stringify(serialized.definition)));

  assert.equal(serialized.ok, true);
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(roundTrip.definition, serialized.definition);
  assert.deepEqual(authored, before);
});

test("ActionDefinition maps legacy Action Item cost into a migration-safe domain definition", () => {
  const item = {
    id: "item-dash",
    uuid: "Item.item-dash",
    type: "action",
    name: "Dash",
    system: {
      cost: {action: 1, bonus: 0, reaction: 0, movement: 0, custom: []},
      getActivationCost: () => ({allOf: [{capability: "action", amount: 1}]})
    }
  };
  const result = actionDefinitionFromItem(item);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.definition.id, "item-dash");
  assert.deepEqual(actionDefinitionActivationCost(result.definition), {
    allOf: [{capability: "action", amount: 1, unit: null}]
  });
  assert.equal(result.definition.metadata.migration.from, "legacy-action-cost");
  assert.equal(result.definition.source.ref, "uuid:Item.item-dash");
});

test("ActionDefinition preserves melee reach, attack, damage, Predicate, and RuleElement data", () => {
  const result = validateActionDefinition(meleeFixture());

  assert.equal(result.ok, true);
  assert.equal(result.definition.range.type, "reach");
  assert.equal(result.definition.range.distance.value, 5);
  assert.equal(result.definition.attack.statistic, "attack.melee.weapon");
  assert.equal(result.definition.damage[0].damageType, "slashing");
  assert.deepEqual(result.definition.targeting.eligibilityPolicy.predicate, {tagsAny: ["hostile"]});
  assert.equal(result.definition.ruleElements[0].type, "Modifier");
});

test("ActionDefinition preserves ranged normal and long range without scene fields", () => {
  const definition = {
    ...meleeFixture(),
    id: "action:longbow-shot",
    range: {
      type: "ranged",
      normal: {value: 150, unit: "ft"},
      long: {value: 600, unit: "ft"}
    },
    attack: {
      type: "ranged",
      statistic: "attack.ranged.weapon",
      ability: "agility",
      proficiency: "proficient",
      rangeMode: "normal-long"
    }
  };
  const result = validateActionDefinition(definition);

  assert.equal(result.ok, true);
  assert.equal(result.definition.range.normal.value, 150);
  assert.equal(result.definition.range.long.value, 600);
  assert.equal(result.definition.range.fields, undefined);
});

test("ActionDefinition adapts Area save half-damage definitions into resolver input", () => {
  const definition = {
    schemaVersion: 1,
    id: "action:ember-burst",
    source: {type: "item", ref: "item:ember-burst"},
    activation: {type: "action"},
    costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {
      type: "area",
      required: true
    },
    area: {
      shape: "radial",
      size: {value: 20, unit: "ft"},
      placement: {type: "chosen-origin"}
    },
    save: {
      ability: "agility",
      dc: {
        valueExpression: {
          type: "add",
          terms: [
            {type: "constant", value: 8},
            {type: "proficiency-bonus"},
            {type: "ability-modifier", ability: "wits"}
          ]
        },
        ability: "wits"
      }
    },
    damage: [{
      id: "fire",
      expression: {type: "constant", value: 14},
      damageType: "fire",
      provenance: "spell-base",
      outcomePolicy: {
        saveOutcomePolicy: {success: "half", failure: "full"}
      }
    }]
  };
  const resolverInput = actionDefinitionToResolverInput(definition, {actorSystem: ACTOR_SYSTEM});

  assert.equal(validateActionDefinition(definition).ok, true);
  assert.equal(resolverInput.targeting.required, true);
  assert.equal(resolverInput.targeting.metadata.area.shape, "radial");
  assert.equal(resolverInput.save.saveKey, "agility");
  assert.equal(resolverInput.save.dc.value, 13);
  assert.deepEqual(resolverInput.damage.saveOutcomePolicy, {success: "half", failure: "full"});
  assert.equal(resolverInput.damage.components[0].amount, 14);
});

test("ActionDefinition adapts target count ValueExpressions and target Predicates", () => {
  const definition = {
    ...meleeFixture(),
    id: "action:focus-command",
    targeting: {
      type: "multiple",
      required: true,
      count: {type: "resource-current", resource: "focus"},
      eligibilityPolicy: {
        kinds: ["creature"],
        predicate: {tagsAny: ["ally"]}
      }
    }
  };
  const resolverInput = actionDefinitionToResolverInput(definition, {actorSystem: ACTOR_SYSTEM});

  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(resolverInput.targeting.refinementPolicy.maxSelections, {type: "resource-current", resource: "focus"});
  assert.deepEqual(resolverInput.targeting.eligibilityPolicy.predicate, {tagsAny: ["ally"]});
});

test("ActionDefinition keeps healing separate from damage", () => {
  const definition = {
    schemaVersion: 1,
    id: "action:cure",
    source: {type: "item", ref: "item:cure"},
    costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "touch"},
    targeting: {
      type: "single",
      required: true,
      eligibilityPolicy: {dispositions: ["ally"]}
    },
    healing: [{
      id: "cure",
      expression: {
        type: "add",
        terms: [
          {type: "constant", value: 4},
          {type: "ability-modifier", ability: "wits"}
        ]
      },
      healingType: "vitality"
    }]
  };
  const resolverInput = actionDefinitionToResolverInput(definition, {actorSystem: ACTOR_SYSTEM});

  assert.equal(validateActionDefinition(definition).ok, true);
  assert.equal(resolverInput.damage, null);
  assert.equal(resolverInput.healing.components[0].amount, 6);
  assert.equal(resolverInput.healing.components[0].healingType, "vitality");
});

test("ActionDefinition represents condition applications through structured effect definitions", () => {
  const definition = {
    ...meleeFixture(),
    id: "action:trip",
    effects: [{
      id: "trip-prone",
      type: "condition",
      conditionId: "prone",
      application: {target: "hit"},
      duration: {type: "rounds", value: 1},
      concentration: false
    }]
  };
  const resolverInput = actionDefinitionToResolverInput(definition);

  assert.equal(validateActionDefinition(definition, {conditionDefinitions: {prone: {id: "prone"}}}).ok, true);
  assert.deepEqual(resolverInput.effects.conditions.map(effect => effect.conditionId), ["prone"]);
  assert.deepEqual(resolverInput.effects.conditions[0].duration, {type: "rounds", value: 1});
});

test("ActionDefinition supports multiple damage components and runtime roll overlays", () => {
  const definition = {
    ...meleeFixture(),
    id: "action:flame-brand",
    damage: [
      {
        id: "blade",
        expression: {type: "dice", number: 1, faces: 8},
        damageType: "slashing",
        provenance: "weapon-base",
        scalingCategory: "weapon-size"
      },
      {
        id: "flame",
        expression: {type: "dice", number: 1, faces: 6},
        damageType: "fire",
        provenance: "additional"
      }
    ]
  };
  const resolverInput = actionDefinitionToResolverInput(definition, {
    damage: {
      components: [
        {id: "blade", amount: 5},
        {id: "flame", amount: 3}
      ]
    }
  });

  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(resolverInput.damage.components.map(component => component.amount), [5, 3]);
  assert.deepEqual(resolverInput.damage.components.map(component => component.damageType), ["slashing", "fire"]);
});

test("ActionDefinition rejects malformed definitions with structured validation", () => {
  const cases = [
    {
      definition: {...meleeFixture(), attack: {type: "melee"}},
      code: ACTION_DEFINITION_CODES.INVALID_ATTACK
    },
    {
      definition: {...meleeFixture(), targeting: {type: "area", required: true}, area: null},
      code: ACTION_DEFINITION_CODES.MISSING_AREA_DEFINITION
    },
    {
      definition: {...meleeFixture(), damage: [{id: "bad", expression: {type: "constant", value: 1}, damageType: "Fire Damage!"}]},
      code: ACTION_DEFINITION_CODES.INVALID_DAMAGE_TYPE
    },
    {
      definition: {...meleeFixture(), damage: [{id: "bad", expression: {type: "not-real"}, damageType: "fire"}]},
      code: ACTION_DEFINITION_CODES.INVALID_VALUE_EXPRESSION
    },
    {
      definition: {...meleeFixture(), effects: [{id: "missing", type: "ref", ref: "effect:missing"}]},
      options: {effectDefinitions: {}},
      code: ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE
    },
    {
      definition: {...meleeFixture(), costs: {allOf: [{capability: "action", amount: -1}]}},
      code: ACTION_DEFINITION_CODES.INVALID_COST
    }
  ];

  for ( const entry of cases ) {
    const result = validateActionDefinition(entry.definition, entry.options ?? {});
    assert.equal(result.ok, false);
    assert.equal(result.code, entry.code);
    assert.equal(result.errors.length > 0, true);
  }
});

test("ActionDefinition rejects non-serializable persisted data", () => {
  const definition = meleeFixture();
  definition.metadata = {};
  definition.metadata.bad = () => false;
  const result = validateActionDefinition(definition);

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_DEFINITION_CODES.NON_SERIALIZABLE);
});

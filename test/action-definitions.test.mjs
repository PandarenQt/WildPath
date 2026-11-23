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

test("a target count that is a table is its row for the creature (Eldritch Blast's beams by character level)", () => {
  const beams = {...meleeFixture(), id: "action:beams", targeting: {type: "multiple", required: true, repeatable: true,
    count: {type: "table", key: {type: "character-level"}, rows: {1: 1, 5: 2, 11: 3, 17: 4}}, refinementPolicy: {minSelections: 1}}};
  assert.equal(validateActionDefinition(beams).ok, true, JSON.stringify(validateActionDefinition(beams).errors));
  const at = level => actionDefinitionToResolverInput(beams, {actorSystem: {details: {level}}}).targeting.refinementPolicy;
  assert.deepEqual(at(5), {minSelections: 1, maxSelections: 2, instances: 2}, "two beams at level 5");
  assert.deepEqual([at(1).instances, at(16).instances, at(17).instances], [1, 3, 4]);
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

test("healing for its own user (appliesTo) is validated, kept when stored, and kept apart from its targets' healing", () => {
  const base = {schemaVersion: 1, id: "action:bite", label: "Bite", targeting: {type: "single", required: true, count: 1}};
  const paths = healing => validateActionDefinition({...base, healing}).errors.map(entry => entry.path);
  const share = {id: "share", healingType: "healing", appliesTo: "source", amount: {damage: ["necrotic"]}, saveOutcomePolicy: "failure"};
  assert.deepEqual(paths([share]), [], "an amount with no expression is that amount");
  const stored = serializeActionDefinition({...base, healing: [share]}).definition.healing[0];
  assert.deepEqual([stored.appliesTo, stored.amount, stored.saveOutcomePolicy, stored.expression],
    ["source", {damage: ["necrotic"]}, "failure", {type: "context", path: "amount"}]);
  assert.equal("appliesTo" in serializeActionDefinition({...base, healing: [{id: "cure", expression: 4}]}).definition.healing[0], false,
    "absent stays absent");
  const dice = {id: "boon", healingType: "temporary", expression: {type: "dice", number: 1, faces: 10}};
  assert.deepEqual([
    paths([{...dice, appliesTo: "target"}]), paths([{...dice, appliesTo: {from: "everyone"}}]), paths([{...dice, appliesTo: {from: "target"}}]),
    paths([{...dice, appliesTo: {from: "area", includeSelf: "yes"}}]), paths([{...share, amount: {damage: ["Not a type"]}}]),
    paths([{...dice, saveOutcomePolicy: "failure"}]), paths([{...dice, appliesTo: "source", saveOutcomePolicy: "half"}]),
    paths([{...dice, appliesTo: {from: "area"}}, {...dice, id: "two", appliesTo: {from: "target", range: 5}}]),
    paths([{...dice, appliesTo: {from: "target", range: 10, includeSelf: true}}]),
    paths([{id: "leech", healingType: "healing", amount: {damage: "all"}}]), paths([{...share, amount: {damage: "all", cap: 5}}])
  ], [["healing.0.appliesTo"], ["healing.0.appliesTo"], ["healing.0.appliesTo.range"], ["healing.0.appliesTo.includeSelf"],
    ["healing.0.amount"], ["healing.0.saveOutcomePolicy"], ["healing.0.saveOutcomePolicy"], ["healing"], [],
    ["healing.0.amount"], ["healing.0.amount"]], "an amount only beside an appliesTo, and no cap it would not read");
  const input = actionDefinitionToResolverInput({...base, healing: [{id: "cure", healingType: "healing", expression: {type: "constant", value: 5}},
    share, {...dice, appliesTo: {from: "target", range: 10, includeSelf: true}}]}, {actorSystem: ACTOR_SYSTEM});
  assert.deepEqual(input.healing.components.map(component => component.id), ["cure"], "its targets' only");
  assert.deepEqual(input.ownHealing.components.map(component => [component.id, component.amount, component.share ?? null,
    component.dice?.faces ?? null, component.appliesTo]), [["share", null, {damage: ["necrotic"]}, null, "source"],
    ["boon", null, null, 10, {from: "target", range: 10, includeSelf: true}]]);
  assert.equal(actionDefinitionToResolverInput({...base, healing: [share]}, {actorSystem: ACTOR_SYSTEM, healing: {modifierTotal: 2}}).healing, null,
    "nothing healing its targets: no target healing, a runtime healing bonus or not");
});

test("a rider's healing (rider.healing) is healing entries for the user of the Action it rides, validated as healing is", () => {
  const base = {schemaVersion: 1, id: "action:drain", label: "Drain", targeting: {type: "self"}};
  const paths = healing => validateActionDefinition({...base, rider: {healing}}).errors.map(entry => entry.path);
  const drain = {id: "drain", appliesTo: "source", amount: {damage: ["necrotic"]}, healingType: "temporary"};
  assert.deepEqual(paths([drain]), [], "an amount of the damage dealt, with no expression");
  assert.deepEqual(serializeActionDefinition({...base, rider: {healing: [drain]}}).definition.rider.healing, [drain], "kept as written");
  assert.deepEqual([
    paths([{...drain, appliesTo: undefined}]), paths([{...drain, appliesTo: {from: "target", range: 10}}]),
    paths([drain, {...drain, amount: {damage: ["Not a type"]}}]), paths(drain)
  ], [["rider.healing.0.amount", "rider.healing.0.appliesTo"], ["rider.healing.0.appliesTo"], ["rider.healing.1.amount"], ["rider.healing"]],
  "only its Action's user, never its targets or a pick; each entry checked as healing at its own path");
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
      // An effect by reference would be dropped when the Action runs, so it is refused.
      definition: {...meleeFixture(), effects: [{id: "missing", type: "ref", ref: "effect:missing"}]},
      code: ACTION_DEFINITION_CODES.INVALID_EFFECT
    },
    {
      definition: {...meleeFixture(), effects: [{id: "bless", type: "effect", ruleElements: []}]},
      code: ACTION_DEFINITION_CODES.INVALID_EFFECT
    },
    {
      definition: {...meleeFixture(), effects: [{id: "fake", type: "effect", name: "Fake", slug: "prone"}]},
      code: ACTION_DEFINITION_CODES.INVALID_EFFECT
    },
    {
      definition: {...meleeFixture(), effects: [{id: "odd", type: "effect", name: "Odd", ruleElements: [{schemaVersion: 1, id: "x", type: "Nope"}]}]},
      code: ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT
    },
    {
      definition: {...meleeFixture(), effects: [{id: "long", type: "effect", name: "Long", duration: {value: 1, units: "weeks"}}]},
      code: ACTION_DEFINITION_CODES.INVALID_EFFECT
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

test("a save's own outcomes (save.rollOutcomes) are checked as the Action is, not skipped when the save runs", () => {
  const demons = {schemaVersion: 1, id: "demons", type: "RollOutcome", data: {domains: ["save"], outcome: "automatic-success"},
    predicate: {equals: {path: "save.saverSubtype", value: "demon"}}};
  const withOutcomes = rollOutcomes => ({...meleeFixture(), save: {ability: "fortitude", dc: {value: 15}, rollOutcomes}});
  assert.equal(validateActionDefinition(withOutcomes([demons, {...demons, id: "agile", data: {domains: ["save.agility"], outcome: "evasion"}}])).ok, true);
  for ( const [bad, why] of [
    [{...demons, data: {domains: ["save"], outcome: "automatic-sucess"}}, "a misspelled outcome"],
    [{...demons, data: {domains: ["saves"], outcome: "automatic-success"}}, "a domain the save never reads"],
    [{...demons, data: {outcome: "automatic-success"}}, "no domains"],
    [{...demons, type: "RollMode"}, "another kind of rule"],
    [{...demons, predicate: {nope: true}}, "a malformed predicate"]
  ] ) {
    const result = validateActionDefinition(withOutcomes([demons, bad]));
    assert.equal(result.ok, false, why);
    assert.deepEqual(result.errors.map(entry => [entry.path, entry.code]),
      [["save.rollOutcomes.1", ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT]], why);
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

test("ActionDefinition rejects non-plain persisted objects before lossy JSON cloning", () => {
  const withMap = meleeFixture();
  withMap.metadata = {bad: new Map([["lost", true]])};
  const withDate = meleeFixture();
  withDate.source = {createdAt: new Date("2026-08-30T00:00:00Z")};

  for ( const definition of [withMap, withDate] ) {
    const result = validateActionDefinition(definition);
    assert.equal(result.ok, false);
    assert.equal(result.code, ACTION_DEFINITION_CODES.NON_SERIALIZABLE);
    assert.match(result.errors[0].reason, /plain JSON data/);
  }
});

test("`requires` is kept as a predicate, and an invalid one is refused", async () => {
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const requires = {equals: {path: "actorSystem.resources.movement.spent", value: 0}};
  const ok = validateActionDefinition({schemaVersion: 1, id: "action:aim", costs: {allOf: []}, requires});
  assert.deepEqual(ok.definition.requires, requires);
  assert.equal(validateActionDefinition({schemaVersion: 1, id: "action:aim", costs: {allOf: []}, requires: {bogus: 1}}).ok, false);
});

test("a custom effect may last some Long Rests (Resurrection Sickness): restsLeft is kept, a non-count dropped", () => {
  const definition = restsLeft => ({schemaVersion: 1, id: "action:raise-dead", label: "Raise Dead", costs: {allOf: []},
    effects: [{id: "sick", type: "effect", name: "Resurrection Sickness (Day 3)", ruleElements: [], restsLeft}]});
  const kept = actionDefinitionFromItem({type: "action", name: "Raise Dead", system: {definition: definition(3)}});
  assert.equal(kept.definition.effects[0].restsLeft, 3);
  const dropped = actionDefinitionFromItem({type: "action", name: "Raise Dead", system: {definition: definition("3")}});
  assert.equal(dropped.definition.effects[0].restsLeft, undefined);
});

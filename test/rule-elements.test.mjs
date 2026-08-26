import {test} from "node:test";
import assert from "node:assert/strict";
import {
  RULE_ELEMENT_CODES,
  RULE_ELEMENT_TRACE_STATUS,
  RuleElementRegistry,
  collectRuleElementContributions,
  evaluateRuleElement,
  modifiersFromRuleElements,
  serializeRuleElementDefinition,
  validateRuleElementDefinition
} from "../module/helpers/rule-elements.mjs";
import {WildPathStatistic} from "../module/helpers/modifiers.mjs";
import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  collectTriggeredAutomations,
  createAutomationEvent
} from "../module/helpers/automation-events.mjs";
import {adjustDamageResult} from "../module/resolvers/damage-adjustment-resolver.mjs";

test("Modifier RuleElements contribute modifiers through Predicate and ValueExpression", () => {
  const result = modifiersFromRuleElements({
    domain: "attack.melee",
    source: {type: "item", uuid: "Item.dueling-style", id: "dueling-style"},
    context: {
      actorSystem: {
        abilities: {might: {value: 16}},
        flags: {fightingStyle: "dueling"}
      }
    },
    ruleElements: [{
      id: "dueling-attack",
      type: "Modifier",
      label: "Dueling",
      predicate: {equals: {path: "actorSystem.flags.fightingStyle", value: "dueling"}},
      data: {
        selector: "attack.melee",
        domains: ["attack.melee"],
        modifierType: "status",
        valueExpression: {
          type: "add",
          terms: [1, {type: "ability-modifier", ability: "might"}]
        }
      }
    }]
  });
  const statistic = new WildPathStatistic("attack.melee", result.modifiers, {
    context: {
      actorSystem: {
        abilities: {might: {value: 16}},
        flags: {fightingStyle: "dueling"}
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.modifiers.length, 1);
  assert.equal(statistic.totalModifier, 4);
  assert.equal(statistic.applied[0].id, "dueling-attack");
  assert.equal(result.traces[0].status, RULE_ELEMENT_TRACE_STATUS.CONTRIBUTED);
  assert.deepEqual(result.modifiers[0].source, {
    type: "ruleElement",
    ruleElementId: "dueling-attack",
    ruleElementType: "Modifier",
    parent: {type: "item", uuid: "Item.dueling-style", id: "dueling-style"}
  });
});

test("RuleElement collection traces disabled, suppressed, and predicate-failed entries", () => {
  const result = collectRuleElementContributions({
    context: {domain: "attack.melee"},
    ruleElements: [
      {id: "disabled", type: "Modifier", enabled: false, data: {domains: ["attack.melee"], value: 1}},
      {id: "suppressed", type: "Modifier", suppressed: true, data: {domains: ["attack.melee"], value: 1}},
      {
        id: "ranged-only",
        type: "Modifier",
        predicate: {equals: {path: "domain", value: "attack.ranged"}},
        data: {domains: ["attack.melee"], value: 1}
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.contributions.modifiers.length, 0);
  assert.deepEqual(result.traces.map(trace => trace.status), [
    RULE_ELEMENT_TRACE_STATUS.DISABLED,
    RULE_ELEMENT_TRACE_STATUS.PREDICATE_FAILED,
    RULE_ELEMENT_TRACE_STATUS.SUPPRESSED
  ]);
});

test("unknown RuleElement types fail explicitly", () => {
  const result = evaluateRuleElement({id: "mystery", type: "InventedBranch"});

  assert.equal(result.ok, false);
  assert.equal(result.code, RULE_ELEMENT_CODES.UNKNOWN_TYPE);
  assert.equal(result.trace.status, RULE_ELEMENT_TRACE_STATUS.FAILED);
});

test("RuleElementRegistry rejects duplicate registrations unless explicitly replaced", () => {
  const registry = new RuleElementRegistry();
  const first = () => ({ok: true, contributions: {}});
  const second = () => ({ok: true, contributions: {resources: []}});

  registry.register("modifier", first);
  assert.throws(() => registry.register("Modifier", second), /already registered/);

  registry.register("Modifier", second, {replace: true});
  assert.equal(registry.get("Modifier"), second);
});

test("invalid RuleElement predicates and payloads fail with structured diagnostics", () => {
  const invalidPredicate = evaluateRuleElement({
    id: "bad-predicate",
    type: "Modifier",
    predicate: {script: "return true"},
    data: {domains: ["attack.melee"], value: 1}
  });
  const invalidTrigger = evaluateRuleElement({
    id: "bad-trigger",
    type: "Trigger",
    data: {payload: {actionRef: "item:danger"}}
  });
  const executablePayload = validateRuleElementDefinition({
    id: "function-payload",
    type: "Modifier",
    data: {
      domains: ["attack.melee"],
      value: () => 1
    }
  });
  const invalidSchemaVersion = validateRuleElementDefinition({
    schemaVersion: 0,
    id: "bad-version",
    type: "Modifier",
    data: {domains: ["attack.melee"], value: 1}
  });

  assert.equal(invalidPredicate.ok, false);
  assert.equal(invalidPredicate.code, RULE_ELEMENT_CODES.INVALID);
  assert.match(invalidPredicate.reason, /Invalid Predicate/);
  assert.equal(invalidTrigger.ok, false);
  assert.equal(invalidTrigger.code, RULE_ELEMENT_CODES.INVALID);
  assert.match(invalidTrigger.reason, /requires an event type/);
  assert.equal(executablePayload.ok, false);
  assert.equal(executablePayload.code, RULE_ELEMENT_CODES.INVALID);
  assert.match(executablePayload.reason, /JSON-serializable/);
  assert.equal(invalidSchemaVersion.ok, false);
  assert.match(invalidSchemaVersion.reason, /schemaVersion/);
});

test("RuleElement definitions round-trip as persisted JSON without changing behavior", () => {
  const definition = {
    schemaVersion: 1,
    id: "feature.fast-movement",
    type: "Modifier",
    label: "Fast Movement",
    data: {
      domains: ["movement.walk"],
      modifierType: "untyped",
      valueExpression: {type: "constant", value: 10}
    },
    metadata: {ruleset: "house"}
  };
  const serialized = serializeRuleElementDefinition(definition, {
    source: {type: "item", uuid: "Item.fast-movement"}
  });
  const reloaded = JSON.parse(JSON.stringify(serialized.definition));
  const result = modifiersFromRuleElements({
    ruleElements: [reloaded],
    domain: "movement.walk"
  });
  const statistic = new WildPathStatistic("movement.walk", result.modifiers);

  assert.equal(serialized.ok, true);
  assert.deepEqual(reloaded, serialized.definition);
  assert.equal(result.ok, true);
  assert.equal(statistic.totalModifier, 10);
  assert.equal(result.traces[0].schemaVersion, 1);
});

test("resource RuleElements evaluate ValueExpressions without mutating Actor resources", () => {
  const result = collectRuleElementContributions({
    context: {
      actorSystem: {
        level: 5,
        resources: {
          focus: {value: 2, max: 2}
        }
      }
    },
    ruleElements: [
      {
        id: "ki-resource",
        type: "GrantResource",
        data: {
          resourceId: "ki",
          maximum: {
            type: "add",
            terms: [2, {type: "proficiency-bonus"}]
          },
          current: {type: "resource-current", resource: "focus"},
          recovery: "shortRest"
        }
      },
      {
        id: "quickened-bonus",
        type: "GrantActionEconomyResource",
        data: {
          category: "bonus-action",
          maximum: 1,
          refresh: ["turnStart"]
        }
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contributions.resources.map(resource => ({
    id: resource.id,
    current: resource.current,
    maximum: resource.maximum,
    recovery: resource.recovery
  })), [{
    id: "ki",
    current: 2,
    maximum: 5,
    recovery: "shortRest"
  }]);
  assert.equal(result.contributions.economyResources[0].id, "quickened-bonus");
  assert.deepEqual(result.contributions.economyResources[0].paymentCapabilities, ["bonus-action"]);
});

test("RuleElement evaluation is repeatable and does not mutate definitions or contexts", () => {
  const definition = {
    id: "repeatable-resource",
    type: "GrantResource",
    data: {
      resourceId: "focus",
      maximum: {type: "context", path: "actorSystem.level"},
      current: 1
    }
  };
  const context = {
    actorSystem: {
      level: 4,
      resources: {health: {value: 7, max: 10}}
    }
  };
  const definitionBefore = JSON.stringify(definition);
  const contextBefore = JSON.stringify(context);
  const first = collectRuleElementContributions({ruleElements: [definition], context});
  const second = collectRuleElementContributions({ruleElements: [definition], context});

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.contributions.resources, second.contributions.resources);
  assert.equal(JSON.stringify(definition), definitionBefore);
  assert.equal(JSON.stringify(context), contextBefore);
});

test("damage adjustment RuleElements produce profiles that damage adjustment can consume", () => {
  const result = collectRuleElementContributions({
    ruleElements: [
      {id: "fire-resistant", type: "GrantResistance", data: {damageType: "fire"}},
      {id: "poison-immune", type: "GrantImmunity", data: {damageType: "poison"}}
    ]
  });
  const adjusted = adjustDamageResult({
    ok: true,
    components: [
      {id: "flame", amount: 11, damageType: "fire"},
      {id: "venom", amount: 3, damageType: "poison"}
    ],
    total: 14
  }, result.contributions.damageAdjustments);

  assert.equal(result.ok, true);
  assert.equal(adjusted.ok, true);
  assert.equal(adjusted.damageResult.total, 5);
  assert.deepEqual(adjusted.damageResult.byDamageType, {fire: 5, poison: 0});
});

test("movement and trigger RuleElements adapt into existing domain primitives", () => {
  let actionExecuted = false;
  const result = collectRuleElementContributions({
    context: {movementBonus: 20},
    ruleElements: [
      {
        id: "winged-flight",
        type: "GrantMovement",
        data: {
          mode: "fly",
          distance: {type: "context", path: "movementBonus"}
        }
      },
      {
        id: "fire-retaliation",
        type: "Trigger",
        data: {
          event: AUTOMATION_EVENT_TYPES.DAMAGE_APPLIED,
          match: {phase: AUTOMATION_EVENT_PHASES.AFTER, tagsAny: ["fire"]},
          payload: {
            action: "retaliate",
            actionRef: "item:retaliate"
          }
        }
      }
    ]
  });
  const event = createAutomationEvent({
    id: "damage-1",
    type: AUTOMATION_EVENT_TYPES.DAMAGE_APPLIED,
    phase: AUTOMATION_EVENT_PHASES.AFTER,
    tags: ["fire"]
  });
  const triggered = collectTriggeredAutomations({
    triggers: result.contributions.triggers,
    event
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contributions.movement[0].capability, {
    mode: "fly",
    distance: 20,
    unit: "ft"
  });
  assert.deepEqual(triggered.matches.map(match => match.triggerId), ["fire-retaliation"]);
  assert.equal(triggered.matches[0].payload.action, "retaliate");
  assert.equal(actionExecuted, false);
});

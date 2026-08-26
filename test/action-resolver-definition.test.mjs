import {test} from "node:test";
import assert from "node:assert/strict";
import {ACTION_RESOLUTION_STAGES} from "../module/helpers/action-resolution.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {
  ACTION_RESOLVER_CODES,
  planActionResolution
} from "../module/resolvers/action-resolver.mjs";

function actorSystem(actionValue=1) {
  return {
    resources: {
      action: {value: actionValue, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30}
    },
    pools: []
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

function attackCandidate(id, defense=null) {
  return {
    id,
    target: {
      id,
      actorId: `actor-${id}`,
      tokenId: `token-${id}`,
      disposition: "enemy",
      defenses: defense == null ? {} : {ac: {value: defense}}
    },
    actor: {id: `actor-${id}`, name: id},
    disposition: "enemy",
    kind: "creature",
    tags: ["hostile"]
  };
}

function saveCandidate(id, total=null) {
  return {
    id,
    target: {
      id,
      actorId: `actor-${id}`,
      tokenId: `token-${id}`,
      disposition: "enemy",
      saves: total == null ? {} : {agility: {total, die: Math.max(total - 5, 1)}}
    },
    actor: {id: `actor-${id}`, name: id},
    disposition: "enemy",
    kind: "creature"
  };
}

test("ActionResolver derives target, attack, damage, and payment requests from a persisted ActionDefinition", () => {
  const definition = {
    schemaVersion: 1,
    id: "action:longsword-strike",
    label: "Longsword Strike",
    tags: ["weapon-attack", "melee"],
    source: {type: "item", ref: "item:longsword"},
    activation: {type: "action"},
    costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "reach", distance: {value: 5, unit: "ft"}},
    targeting: {
      type: "single",
      required: true,
      count: {type: "constant", value: 1},
      eligibilityPolicy: {
        dispositions: ["enemy"],
        predicate: {tagsAny: ["hostile"]}
      }
    },
    attack: {
      type: "melee",
      statistic: "attack.melee.weapon",
      ability: "might"
    },
    damage: [{
      id: "blade",
      expression: {type: "constant", value: 8},
      damageType: "slashing",
      provenance: "weapon-base"
    }]
  };

  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: actionItem(definition),
    source: {actorId: "actor-hero"},
    targeting: {
      candidates: [attackCandidate("orc", 14)]
    },
    attack: {
      roll: {total: 18, die: 13}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.stage), [
    ACTION_RESOLUTION_STAGES.VALIDATION,
    ACTION_RESOLUTION_STAGES.TARGETING,
    ACTION_RESOLUTION_STAGES.ROLL,
    ACTION_RESOLUTION_STAGES.CONSEQUENCE,
    ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    ACTION_RESOLUTION_STAGES.COMPLETE
  ]);
  assert.equal(result.context.action.id, "action:longsword-strike");
  assert.equal(result.context.action.metadata.actionDefinition.migrated, false);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    AUTOMATION_EVENT_TYPES.ATTACK_ROLL,
    AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  const damage = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE).data.damageResolution;
  assert.deepEqual(damage.totals, {orc: 8});
  assert.equal(damage.results[0].components[0].metadata.actionDefinitionComponent.id, "blade");
  assert.deepEqual(result.mutationPlans.map(plan => plan.type), ["resourcePayment"]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver derives Area save and half-on-success damage from a persisted ActionDefinition", () => {
  const definition = {
    schemaVersion: 1,
    id: "action:ember-burst",
    label: "Ember Burst",
    costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "area", required: true},
    area: {
      shape: "radial",
      size: {value: 20, unit: "ft"}
    },
    save: {
      ability: "agility",
      dc: {value: 15}
    },
    damage: [{
      id: "fire",
      expression: {type: "constant", value: 10},
      damageType: "fire",
      outcomePolicy: {
        saveOutcomePolicy: {success: "half", failure: "full"}
      }
    }]
  };
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: actionItem(definition),
    source: {actorId: "caster"},
    targeting: {
      candidates: [
        saveCandidate("rogue", 18),
        saveCandidate("ogre", 9)
      ]
    }
  });

  assert.equal(result.ok, true);
  const save = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.ROLL).data.saveResolution;
  const damage = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE).data.damageResolution;

  assert.deepEqual(save.successes.map(entry => entry.target.id), ["rogue"]);
  assert.deepEqual(save.failures.map(entry => entry.target.id), ["ogre"]);
  assert.deepEqual(damage.totals, {rogue: 5, ogre: 10});
});

test("ActionResolver derives healing components from a persisted ActionDefinition", () => {
  const definition = {
    schemaVersion: 1,
    id: "action:cure",
    label: "Cure",
    costs: {allOf: [{capability: "bonus-action", amount: 1}]},
    targeting: {
      type: "single",
      required: true,
      eligibilityPolicy: {dispositions: ["ally"]}
    },
    healing: [{
      id: "cure",
      expression: {type: "constant", value: 6},
      healingType: "vitality"
    }]
  };
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: actionItem(definition),
    source: {actorId: "healer"},
    targets: [{id: "ally", actorId: "actor-ally", disposition: "ally"}]
  });

  assert.equal(result.ok, true);
  const healing = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE).data.healingResolution;
  assert.deepEqual(healing.totals, {ally: 6});
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.bonus.value": 0});
});

test("ActionResolver derives condition effects from a persisted ActionDefinition", () => {
  const definition = {
    schemaVersion: 1,
    id: "action:trip",
    label: "Trip",
    costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true},
    effects: [{
      id: "trip-prone",
      type: "condition",
      conditionId: "prone",
      duration: {unit: "round", value: 1}
    }]
  };
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: actionItem(definition),
    source: {actorId: "fighter"},
    targets: [{id: "orc", actorId: "actor-orc", disposition: "enemy"}]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlans.map(plan => plan.type), ["conditionEffect", "resourcePayment"]);
  const effects = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.EFFECTS).data.effectResolution;
  assert.deepEqual(effects.conditionPlans.map(plan => plan.conditionId), ["prone"]);
  assert.deepEqual(effects.conditionPlans[0].duration, {unit: "round", value: 1});
});

test("ActionResolver rejects invalid persisted ActionDefinitions before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: actionItem({
      schemaVersion: 1,
      id: "action:bad",
      costs: {allOf: [{capability: "action", amount: 1}]},
      attack: {type: "melee"}
    }),
    source: {actorId: "actor-hero"}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.ACTION_DEFINITION_INVALID);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.VALIDATION);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

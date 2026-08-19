import {test} from "node:test";
import assert from "node:assert/strict";
import {ACTION_RESOLUTION_STAGES, ACTION_RESULT_STATUS} from "../module/helpers/action-resolution.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {TARGET_DEFAULT_SELECTION, TARGET_OPERATIONS} from "../module/helpers/targeting.mjs";
import {WEAPON_SIZE_POLICY_IDS} from "../module/helpers/weapon-sizing.mjs";
import {
  DAMAGE_SCALING_CATEGORIES
} from "../module/resolvers/damage-resolver.mjs";
import {
  ACTION_RESOLVER_CODES,
  executeActionResolution,
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

function targetActorSystem(value=14, max=20) {
  return {
    resources: {
      health: {value, max}
    },
    pools: []
  };
}

function action(cost={allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}) {
  return {
    id: "strike",
    type: "action",
    name: "Strike",
    system: {
      tags: ["weapon-attack"],
      getActivationCost: () => cost
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
    kind: "creature"
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
      saves: total == null ? {} : {dex: {total, die: Math.max(total - 5, 1)}}
    },
    actor: {id: `actor-${id}`, name: id},
    disposition: "enemy",
    kind: "creature"
  };
}

function damageComponent(id="base", amount=6, damageType="slashing") {
  return {id, amount, damageType};
}

const CONDITION_DEFINITIONS = {
  restrained: {
    id: "restrained",
    name: "Restrained"
  },
  prone: {
    id: "prone",
    name: "Prone"
  }
};

test("ActionResolver plans current cost-only action resolution without mutating Actor system", () => {
  const system = actorSystem(1);
  const result = planActionResolution({
    actorSystem: system,
    action: action(),
    source: {actorId: "actor-a", tokenId: "token-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, ACTION_RESULT_STATUS.SUCCEEDED);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
  assert.equal(system.resources.action.value, 1);
});

test("ActionResolver can spend an Action for a Bonus Action activity after Bonus Actions are depleted", () => {
  const system = actorSystem(1);
  system.resources.bonus.value = 0;
  const result = planActionResolution({
    actorSystem: system,
    action: action({allOf: [{capability: ECONOMY_CAPABILITIES.BONUS_ACTION, amount: 1}]}),
    source: {actorId: "actor-a", tokenId: "token-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.consequences.at(-1).paymentPlan.mode, "alternative");
  assert.equal(result.consequences.at(-1).paymentPlan.resources[0].resourceId, "economy.action");
  assert.equal(result.consequences.at(-1).paymentPlan.resources[0].policy, "action-for-spent-bonus-action");
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
  assert.equal(system.resources.action.value, 1);
});

test("ActionResolver reports payment failure as a failed action result", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(0),
    action: action(),
    source: {actorId: "actor-a"}
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, ACTION_RESULT_STATUS.FAILED);
  assert.equal(result.code, ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver can resolve explicit targets before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "target-a", actorId: "actor-b", disposition: "enemy"}],
    targeting: {
      required: true,
      eligibilityPolicy: {dispositions: ["enemy"]}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  assert.deepEqual(result.context.targets.map(target => target.id), ["target-a"]);
  assert.equal(result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.TARGETING).code, "OK");
});

test("ActionResolver can resolve an attack after targeting and before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [
        attackCandidate("orc", 14),
        attackCandidate("knight", 19)
      ],
      eligibilityPolicy: {dispositions: ["enemy"]}
    },
    attack: {
      roll: {total: 17, die: 12}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.stage), [
    ACTION_RESOLUTION_STAGES.VALIDATION,
    ACTION_RESOLUTION_STAGES.TARGETING,
    ACTION_RESOLUTION_STAGES.ROLL,
    ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    ACTION_RESOLUTION_STAGES.COMPLETE
  ]);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    AUTOMATION_EVENT_TYPES.ATTACK_ROLL,
    AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    AUTOMATION_EVENT_TYPES.ATTACK_MISS,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  const attackStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.ROLL);
  assert.deepEqual(attackStep.data.attackResolution.hits.map(hit => hit.target.id), ["orc"]);
  assert.deepEqual(attackStep.data.attackResolution.misses.map(miss => miss.target.id), ["knight"]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver can resolve saves after targeting and before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [
        saveCandidate("rogue", 18),
        saveCandidate("ogre", 9)
      ]
    },
    save: {
      saveKey: "dex",
      dc: {value: 15, ability: "dex"}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.stage), [
    ACTION_RESOLUTION_STAGES.VALIDATION,
    ACTION_RESOLUTION_STAGES.TARGETING,
    ACTION_RESOLUTION_STAGES.ROLL,
    ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    ACTION_RESOLUTION_STAGES.COMPLETE
  ]);
  const saveStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.ROLL);
  assert.deepEqual(saveStep.data.saveResolution.successes.map(save => save.target.id), ["rogue"]);
  assert.deepEqual(saveStep.data.saveResolution.failures.map(save => save.target.id), ["ogre"]);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    AUTOMATION_EVENT_TYPES.SAVE_ROLL,
    AUTOMATION_EVENT_TYPES.SAVE_SUCCESS,
    AUTOMATION_EVENT_TYPES.SAVE_ROLL,
    AUTOMATION_EVENT_TYPES.SAVE_FAILURE,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  assert.deepEqual(result.consequences.map(consequence => consequence.type), [
    "targetsSelected",
    "saveResolved",
    "resourcePayment"
  ]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver can resolve damage for attack hits before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [
        attackCandidate("orc", 14),
        attackCandidate("knight", 19)
      ]
    },
    attack: {
      roll: {total: 17, die: 12}
    },
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
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
  const damageStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.deepEqual(damageStep.data.damageResolution.totals, {orc: 6});
  assert.deepEqual(damageStep.data.damageResolution.results.map(target => target.target.id), ["orc"]);
  assert.deepEqual(result.consequences.map(consequence => consequence.type), [
    "targetsSelected",
    "attackResolved",
    "damageResolved",
    "resourcePayment"
  ]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver can attach target durability plans to resolved damage", () => {
  const orcSystem = targetActorSystem(14, 20);
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc"}],
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    },
    durability: {
      targetSystems: {
        "actor:actor-orc": orcSystem
      }
    }
  });

  assert.equal(result.ok, true);
  const damageStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.deepEqual(damageStep.data.damageResolution.totals, {orc: 6});
  assert.equal(damageStep.data.durabilityResolution.ok, true);
  assert.deepEqual(damageStep.data.durabilityResolution.mutationPlans[0].plan.updates, {
    "system.resources.health.value": 8
  });
  assert.deepEqual(result.mutationPlans.map(plan => plan.type), ["durabilityDamage", "resourcePayment"]);
  assert.equal(orcSystem.resources.health.value, 14);
});

test("ActionResolver stops before payment when requested durability target systems are missing", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "orc", actorId: "actor-orc"}],
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    },
    durability: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.DAMAGE_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver can attach target durability plans to resolved healing", () => {
  const allySystem = targetActorSystem(3, 12);
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "ally", actorId: "actor-ally", tokenId: "token-ally"}],
    healing: {
      components: [{id: "cure", amount: 6, healingType: "vitality"}]
    },
    durability: {
      targetSystems: {
        "actor:actor-ally": allySystem
      }
    }
  });

  assert.equal(result.ok, true);
  const healingStep = result.steps.find(step => step.data.healingResolution);
  assert.deepEqual(healingStep.data.healingResolution.totals, {ally: 6});
  assert.equal(healingStep.data.durabilityResolution.ok, true);
  assert.deepEqual(healingStep.data.durabilityResolution.mutationPlans[0].plan.updates, {
    "system.resources.health.value": 9
  });
  assert.deepEqual(result.mutationPlans.map(plan => plan.type), ["durabilityHealing", "resourcePayment"]);
  assert.equal(allySystem.resources.health.value, 3);
});

test("ActionResolver can apply save outcome policies to per-target damage", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [
        saveCandidate("rogue", 18),
        saveCandidate("ogre", 9)
      ]
    },
    save: {
      saveKey: "dex",
      dc: {value: 15, ability: "dex"}
    },
    damage: {
      saveOutcomePolicy: {
        success: "half",
        failure: "full"
      },
      components: [damageComponent("burst", 9, "fire")]
    }
  });

  const damageResolution = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE)
    .data.damageResolution;
  const rogueDamage = damageResolution.results.find(entry => entry.target.id === "rogue");
  const ogreDamage = damageResolution.results.find(entry => entry.target.id === "ogre");

  assert.equal(result.ok, true);
  assert.deepEqual(damageResolution.totals, {rogue: 4, ogre: 9});
  assert.equal(rogueDamage.components[0].metadata.saveOutcomeDamagePolicy.multiplier, 0.5);
  assert.equal(rogueDamage.components[0].metadata.saveOutcomeDamagePolicy.originalAmount, 9);
  assert.equal(ogreDamage.components[0].metadata.saveOutcomeDamagePolicy, undefined);
});

test("ActionResolver plans save-gated condition effects only for matching save outcomes", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "caster"},
    targeting: {
      required: true,
      candidates: [
        saveCandidate("rogue", 18),
        saveCandidate("ogre", 9)
      ]
    },
    save: {
      saveKey: "dex",
      dc: {value: 15, ability: "dex"}
    },
    effects: {
      conditionDefinitions: CONDITION_DEFINITIONS,
      conditions: [{
        conditionId: "restrained",
        saveOutcomePolicy: {applyOn: ["failure"]},
        duration: {
          unit: "round",
          value: 1,
          expires: "sourceTurnEnd"
        },
        concentration: true,
        origin: "item:ensnaring-strike"
      }]
    }
  });

  const effectsStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.EFFECTS);
  const effectResolution = effectsStep.data.effectResolution;
  const conditionPlan = effectResolution.conditionPlans[0];

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlans.map(plan => plan.type), ["conditionEffect", "resourcePayment"]);
  assert.deepEqual(effectResolution.conditionPlans.map(plan => plan.target.id), ["ogre"]);
  assert.deepEqual(effectResolution.skipped.map(entry => entry.target.id), ["rogue"]);
  assert.equal(conditionPlan.conditionId, "restrained");
  assert.equal(conditionPlan.mutationPlan.metadata.saveOutcome, "failure");
  assert.equal(conditionPlan.mutationPlan.duration.expires, "sourceTurnEnd");
  assert.equal(conditionPlan.mutationPlan.concentration.required, true);
  assert.equal(conditionPlan.mutationPlan.concentration.originRef, "item:ensnaring-strike");
});

test("ActionResolver fails before payment when condition effect data is invalid", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "caster"},
    targets: [{id: "target-a", actorId: "actor-target"}],
    effects: {
      conditionDefinitions: CONDITION_DEFINITIONS,
      conditions: [{
        conditionId: "not-real"
      }]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.EFFECTS_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.EFFECTS);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver applies WeaponSizePolicy to manufactured weapon damage before resolution", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [attackCandidate("ogre", 12)]
    },
    attack: {
      roll: {total: 18, die: 13}
    },
    damage: {
      weaponSize: {
        manufactured: true,
        ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
        effectiveWielderSize: CREATURE_SIZES.LARGE,
        effectiveWeaponSize: CREATURE_SIZES.LARGE
      },
      components: [
        {
          id: "weapon-base",
          amount: 7,
          dice: {number: 1, faces: 8},
          damageType: "slashing",
          scalingCategory: DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
        },
        {
          id: "flame",
          amount: 4,
          dice: {number: 1, faces: 6},
          damageType: "fire"
        }
      ]
    }
  });

  const damageResolution = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE)
    .data.damageResolution;
  const [weaponBase, flame] = damageResolution.results[0].components;

  assert.equal(result.ok, true);
  assert.equal(damageResolution.weaponDamageScaling.multiplier, 2);
  assert.equal(weaponBase.dice.number, 2);
  assert.equal(weaponBase.metadata.weaponSizeScaling.multiplier, 2);
  assert.equal(flame.dice.number, 1);
  assert.deepEqual(damageResolution.totals, {ogre: 11});
});

test("ActionResolver does not apply WeaponSizePolicy without a manufactured weapon marker", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "bear", actorId: "actor-bear"}],
    damage: {
      weaponSize: {
        weapon: {kind: "natural"},
        ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
        effectiveWielderSize: CREATURE_SIZES.LARGE,
        effectiveWeaponSize: CREATURE_SIZES.LARGE
      },
      components: [{
        id: "claw",
        amount: 8,
        dice: {number: 1, faces: 8},
        damageType: "slashing",
        scalingCategory: DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
      }]
    }
  });

  const damageResolution = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE)
    .data.damageResolution;

  assert.equal(result.ok, true);
  assert.equal(damageResolution.weaponDamageScaling, undefined);
  assert.equal(damageResolution.results[0].components[0].dice.number, 1);
});

test("ActionResolver skips damage when an attack misses but still plans payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [attackCandidate("armored", 20)]
    },
    attack: {
      roll: {total: 12, die: 7}
    },
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    }
  });

  assert.equal(result.ok, true);
  const damageStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.deepEqual(damageStep.data.damageResolution.totals, {});
  assert.deepEqual(damageStep.data.damageResolution.skipped.map(skip => skip.target.id), ["armored"]);
  assert.equal(damageStep.data.damageResolution.skipped[0].reason, "attack did not hit");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), true);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver stops before payment when damage data is invalid", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "target-a", actorId: "actor-b", disposition: "enemy"}],
    damage: {
      components: [{id: "missing-amount", damageType: "fire"}]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.DAMAGE_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.equal(result.errors[0].reason, "MISSING_AMOUNT");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver stops before payment when attack data is invalid", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [attackCandidate("unknown")]
    },
    attack: {
      roll: {total: 17, die: 12}
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.ATTACK_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.ROLL);
  assert.equal(result.errors[0].reason, "MISSING_DEFENSE");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver stops before payment when save data is invalid", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "target-a", actorId: "actor-b"}],
    save: {
      dc: {value: 15}
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.SAVE_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.ROLL);
  assert.equal(result.errors[0].reason, "MISSING_SAVE_TOTAL");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver stops before payment when required targets are missing", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {required: true}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.TARGETING_FAILED);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver preserves TargetResolver refinement failures", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [
      {id: "target-a", actorId: "actor-a"},
      {id: "target-b", actorId: "actor-b"}
    ],
    targeting: {
      required: true,
      refinementPolicy: {
        defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
        allowedOperations: [TARGET_OPERATIONS.SELECT],
        maxSelections: 1
      },
      decisions: [
        {operation: TARGET_OPERATIONS.SELECT, targetId: "target-a"},
        {operation: TARGET_OPERATIONS.SELECT, targetId: "target-b"}
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.TARGETING_FAILED);
  assert.equal(result.errors[0].reason, "TARGETING_FAILED");
});

test("ActionResolver execution commits resource plans and emits payment committed", async () => {
  const calls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await executeActionResolution({actor, action: action()});

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{"system.resources.action.value": 0}]);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED,
    AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED
  ]);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.COMPLETE);
});

test("ActionResolver execution commits payment after an attack miss", async () => {
  const calls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targeting: {
      required: true,
      candidates: [attackCandidate("armored", 20)]
    },
    attack: {
      roll: {total: 12, die: 7}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{"system.resources.action.value": 0}]);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.ATTACK_MISS), true);
  assert.equal(result.events.at(-1).type, AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED);
});

test("ActionResolver execution requires explicit authority for target durability commits", async () => {
  const calls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targets: [{id: "orc", actorId: "actor-orc"}],
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    },
    durability: true,
    targetActors: {
      "actor:actor-orc": {id: "actor-orc", system: targetActorSystem()}
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.MUTATION_COMMIT_FAILED);
  assert.deepEqual(calls, []);
});

test("ActionResolver execution commits target durability plans with active GM authority", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      sourceCalls.push(updates);
    }
  };
  const targetActor = {
    id: "actor-orc",
    system: targetActorSystem(14, 20),
    async update(updates) {
      targetCalls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targets: [{id: "orc", actorId: "actor-orc"}],
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    },
    durability: true,
    targetActors: {"actor:actor-orc": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(targetCalls, [{"system.resources.health.value": 8}]);
  assert.deepEqual(sourceCalls, [{"system.resources.action.value": 0}]);
  assert.equal(result.events.at(-1).type, AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED);
});

test("ActionResolver execution commits target absorption plans with active GM authority", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      sourceCalls.push(updates);
    }
  };
  const targetActor = {
    id: "actor-salamander",
    system: targetActorSystem(10, 20),
    async update(updates) {
      targetCalls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targets: [{id: "salamander", actorId: "actor-salamander"}],
    damage: {
      components: [{id: "flame", amount: 10, damageType: "fire"}]
    },
    durability: {
      adjustmentProfiles: {
        "actor:actor-salamander": {
          absorptions: [{id: "fire-feed", damageTypes: ["fire"], scale: 0.5, resourceId: "health"}]
        }
      }
    },
    targetActors: {"actor:actor-salamander": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(targetCalls, [
    {"system.resources.health.value": 5},
    {"system.resources.health.value": 10}
  ]);
  assert.deepEqual(sourceCalls, [{"system.resources.action.value": 0}]);
});

test("ActionResolver execution rolls target mutations back when source payment commit fails", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      sourceCalls.push(updates);
      throw new Error("payment failed");
    }
  };
  const targetActor = {
    id: "actor-orc",
    system: targetActorSystem(14, 20),
    async update(updates) {
      targetCalls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targets: [{id: "orc", actorId: "actor-orc"}],
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    },
    durability: true,
    targetActors: {"actor:actor-orc": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.RESOURCE_COMMIT_FAILED);
  assert.deepEqual(sourceCalls, [{"system.resources.action.value": 0}]);
  assert.deepEqual(targetCalls, [
    {"system.resources.health.value": 8},
    {"system.resources.health.value": 14}
  ]);
  assert.equal(result.steps.at(-1).data.transaction.rolledBack, true);
});

test("ActionResolver execution rolls back earlier target mutations when a later target commit fails", async () => {
  const sourceCalls = [];
  const orcCalls = [];
  const knightCalls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      sourceCalls.push(updates);
    }
  };
  const orcActor = {
    id: "actor-orc",
    system: targetActorSystem(14, 20),
    async update(updates) {
      orcCalls.push(updates);
    }
  };
  const knightActor = {
    id: "actor-knight",
    system: targetActorSystem(16, 20),
    async update(updates) {
      knightCalls.push(updates);
      throw new Error("target failed");
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targets: [
      {id: "orc", actorId: "actor-orc"},
      {id: "knight", actorId: "actor-knight"}
    ],
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    },
    durability: true,
    targetActors: {
      "actor:actor-orc": orcActor,
      "actor:actor-knight": knightActor
    },
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.MUTATION_COMMIT_FAILED);
  assert.deepEqual(sourceCalls, []);
  assert.deepEqual(orcCalls, [
    {"system.resources.health.value": 8},
    {"system.resources.health.value": 14}
  ]);
  assert.deepEqual(knightCalls, [{"system.resources.health.value": 10}]);
  assert.equal(result.steps.at(-1).data.transaction.rolledBack, true);
});

test("ActionResolver execution commits target healing durability plans with active GM authority", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      sourceCalls.push(updates);
    }
  };
  const targetActor = {
    id: "actor-ally",
    system: targetActorSystem(3, 12),
    async update(updates) {
      targetCalls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action(),
    targets: [{id: "ally", actorId: "actor-ally"}],
    healing: {
      components: [{id: "cure", amount: 6}]
    },
    durability: true,
    targetActors: {"actor:actor-ally": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(targetCalls, [{"system.resources.health.value": 9}]);
  assert.deepEqual(sourceCalls, [{"system.resources.action.value": 0}]);
});

test("ActionResolver execution supports zero-cost actions without Actor updates", async () => {
  const calls = [];
  const actor = {
    id: "actor-a",
    system: actorSystem(1),
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action({allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 0}]})
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);
  assert.equal(result.events.at(-1).type, AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED);
});

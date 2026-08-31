import {test} from "node:test";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {
  ACTION_CHOICE_TYPES,
  createResolvedActionPreview
} from "../module/helpers/action-configuration.mjs";
import {
  AREA_SHAPES,
  createRadialFootprint
} from "../module/helpers/tactical-areas.mjs";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES
} from "../module/helpers/grid-footprints.mjs";
import {createTargetSet} from "../module/helpers/targeting.mjs";
import {
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS
} from "../module/helpers/resolution-state.mjs";
import {ROLL_TYPES} from "../module/helpers/rolls.mjs";
import {ATTACK_OUTCOMES} from "../module/resolvers/attack-resolver.mjs";
import {
  createChoiceCoordinator
} from "../module/resolvers/choice-coordinator.mjs";
import {
  createTestRollProvider,
  executeRollRequest
} from "../module/resolvers/roll-provider-resolver.mjs";
import {
  ACTION_PIPELINE_CODES,
  ACTION_PIPELINE_STAGE_IDS,
  executeStagedActionResolution,
  planStagedActionResolution,
  resumeStagedActionResolution
} from "../module/resolvers/action-pipeline-resolver.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {
  FOUNDRY_GRID_TYPES,
  FOUNDRY_HEX_OFFSET_VARIANTS,
  createFoundryV14TacticalGridAdapter
} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";

const HEX_DIRECTIONS = [
  {q: 1, r: 0},
  {q: 1, r: -1},
  {q: 0, r: -1},
  {q: -1, r: 0},
  {q: -1, r: 1},
  {q: 0, r: 1}
];

function actorSystem(overrides={}) {
  return {
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? []
  };
}

function spellcastingActorSystem() {
  return actorSystem({
    pools: [
      {id: "spell-slot.1", label: "1st-level Slot", value: 1, max: 1},
      {id: "spell-slot.2", label: "2nd-level Slot", value: 1, max: 1},
      {id: "spell-slot.3", label: "3rd-level Slot", value: 1, max: 1},
      {id: "sorcery-point", label: "Sorcery Point", value: 1, max: 1}
    ]
  });
}

function targetActorSystem(value=20, max=20) {
  return {
    resources: {
      health: {value, max}
    },
    pools: []
  };
}

function actorDocument(id, {system=actorSystem(), effects=[]}={}) {
  return {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system,
    effects
  };
}

function actionItem(definition) {
  return {
    id: definition.id,
    type: "action",
    name: definition.label,
    system: {definition}
  };
}

function actionCost() {
  return {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]};
}

function meleeStrikeDefinition({damage=9}={}) {
  return {
    schemaVersion: 1,
    id: "action:test-melee-strike",
    label: "Test Melee Strike",
    costs: actionCost(),
    range: {type: "reach", distance: {value: 5, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{
      id: "weapon",
      expression: {type: "constant", value: damage},
      damageType: "slashing",
      provenance: "weapon-base"
    }]
  };
}

function rangedStrikeDefinition() {
  return {
    schemaVersion: 1,
    id: "action:test-ranged-strike",
    label: "Test Ranged Strike",
    costs: actionCost(),
    range: {
      type: "ranged",
      normal: {value: 30, unit: "ft"},
      long: {value: 120, unit: "ft"}
    },
    targeting: {type: "single", required: true, count: 1},
    attack: {type: "ranged", statistic: "weapon", defenseKey: "ac"},
    damage: [{
      id: "shot",
      expression: {type: "constant", value: 7},
      damageType: "piercing",
      provenance: "weapon-base"
    }]
  };
}

function burstDefinition() {
  return {
    schemaVersion: 1,
    id: "action:test-burst",
    label: "Test Burst",
    costs: actionCost(),
    targeting: {type: "area", required: true},
    area: {shape: AREA_SHAPES.RADIAL, size: {value: 10, unit: "ft"}},
    save: {ability: "dex", dc: {value: 15}},
    damage: [{
      id: "burst",
      expression: {type: "constant", value: 10},
      damageType: "fire",
      provenance: "spell-base",
      saveOutcomePolicy: {
        success: "half",
        failure: "full"
      }
    }]
  };
}

function healingDefinition() {
  return {
    schemaVersion: 1,
    id: "action:test-healing-action",
    label: "Test Healing Action",
    costs: actionCost(),
    targeting: {type: "single", required: true, count: 1},
    healing: [{
      id: "mend",
      expression: {type: "constant", value: 8},
      healingType: "healing"
    }]
  };
}

function effectDefinition() {
  return {
    schemaVersion: 1,
    id: "action:apply-test-condition",
    label: "Apply Test Condition",
    costs: actionCost(),
    targeting: {type: "single", required: true, count: 1},
    effects: [{
      id: "apply-prone",
      type: "condition",
      conditionId: "prone",
      duration: {unit: "round", value: 1}
    }]
  };
}

function scalingBurstDefinition() {
  return {
    schemaVersion: 1,
    id: "action:test-scaling-burst",
    label: "Test Scaling Burst",
    tags: ["spell"],
    costs: {allOf: []},
    targeting: {type: "area", required: true},
    area: {shape: AREA_SHAPES.RADIAL, size: {value: 10, unit: "ft"}},
    damage: [{
      id: "burst",
      expression: {type: "dice", number: 2, faces: 6},
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
          [{capability: "spell-slot.1", amount: 1}],
          [{capability: "spell-slot.2", amount: 1}],
          [{capability: "spell-slot.3", amount: 1}]
        ]
      },
      levelByResourceId: {
        "spell-slot.1": 1,
        "spell-slot.2": 2,
        "spell-slot.3": 3
      },
      effects: [{
        type: "scaleDamage",
        componentIds: ["burst"],
        levelChoiceId: "casting-resource",
        baseLevel: 1,
        dice: {number: 1, faces: 6}
      }]
    }]
  };
}

function conversionChoices() {
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

function spatialContext(adapter, sourceFootprint, targetFootprints) {
  return {
    spatial: {
      sceneContext: adapter.getSceneContext().context,
      gridDistance: adapter.getSceneContext().context.grid.distance,
      sourceFootprint,
      targetFootprints
    }
  };
}

async function provideNextRoll(state, rollInput, services={}) {
  assert.ok(state.pendingRequests[0], `Expected a pending roll request, got status ${state.status}.`);
  const request = state.pendingRequests[0].payload.rollRequest;
  const provided = await executeRollRequest({
    request,
    providers: [createTestRollProvider({result: rollInput})]
  });
  assert.equal(provided.ok, true, provided.reason ?? provided.code);
  const resumed = resumeStagedActionResolution({
    state,
    response: {
      resolutionId: state.id,
      requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: provided.result
    },
    services
  });
  return {request, provided, resumed};
}

function actionPipelineResume({state, response, services}) {
  return resumeStagedActionResolution({state, response, services});
}

test("persisted melee strike uses adapted square footprints and commits once", async () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: "square-melee"});
  const sourceToken = fakeToken({
    id: "source",
    actorId: "actor-source",
    scene,
    grid,
    offset: {i: 0, j: 0},
    size: CREATURE_SIZES.LARGE
  });
  const targetToken = fakeToken({
    id: "ogre",
    actorId: "actor-ogre",
    scene,
    grid,
    offset: {i: 2, j: 0},
    size: CREATURE_SIZES.HUGE
  });
  scene.tokens = [sourceToken, targetToken];
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const sourceFootprint = adapter.tokenToFootprint(sourceToken).footprint;
  const adaptedTargetFootprint = adapter.tokenToTargetFootprint(targetToken, {disposition: "enemy"}).tokenFootprint;
  const targetFootprint = {
    ...adaptedTargetFootprint,
    target: {
      ...adaptedTargetFootprint.target,
      defenses: {ac: {value: 12}}
    }
  };
  const actor = actorDocument("actor-source", {system: actorSystem()});
  const targetActor = actorDocument("actor-ogre", {system: targetActorSystem(30, 30)});
  const persistencePort = createTestDocumentPersistenceAdapter();
  const targetActors = {"actor:actor-ogre": targetActor};
  const action = actionItem(meleeStrikeDefinition());

  const waiting = planStagedActionResolution({
    id: "resolution:melee-large-huge",
    actor,
    action,
    source: {actorId: "actor-source", tokenId: "source"},
    targeting: {required: true, candidates: [targetFootprint]},
    durability: true,
    targetActors,
    context: spatialContext(adapter, sourceFootprint, [targetFootprint])
  });
  const rolled = await provideNextRoll(waiting.state, {natural: 20, total: 20}, {targetActors});
  const committed = await executeStagedActionResolution({
    state: rolled.resumed.state,
    actor,
    action,
    targetActors,
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort
  });
  const repeated = await executeStagedActionResolution({
    state: committed.state,
    actor,
    action,
    targetActors,
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort
  });

  assert.equal(waiting.state.pendingRequests[0].payload.rollRequest.type, ROLL_TYPES.ATTACK);
  assert.equal(waiting.state.results.rangeResolution.checks[0].fields, 1);
  assert.equal(rolled.resumed.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.CRITICAL_HIT);
  assert.equal(committed.ok, true);
  assert.equal(targetActor.system.resources.health.value, 21);
  assert.equal(actor.system.resources.action.value, 0);
  assert.equal(repeated.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(persistencePort.operations.filter(operation => operation.type === "updateActor").length, 2);
  assert.equal(committed.state.trace.some(entry => entry.stageId === ACTION_PIPELINE_STAGE_IDS.LEGACY_RESOLUTION), false);
});

test("melee strike misses on natural 1 and rejects targets outside footprint reach", async () => {
  const adjacent = squareAttackFixture({targetOffset: {i: 1, j: 0}});
  const actor = actorDocument("actor-source", {system: actorSystem()});
  const targetActor = actorDocument("actor-orc", {system: targetActorSystem(14, 20)});
  const persistencePort = createTestDocumentPersistenceAdapter();
  const targetActors = {"actor:actor-orc": targetActor};
  const action = actionItem(meleeStrikeDefinition());
  const waiting = planStagedActionResolution({
    id: "resolution:melee-miss",
    actor,
    action,
    source: {actorId: "actor-source", tokenId: "source"},
    targeting: {required: true, candidates: [adjacent.targetFootprint]},
    durability: true,
    targetActors,
    context: spatialContext(adjacent.adapter, adjacent.sourceFootprint, [adjacent.targetFootprint])
  });
  const rolled = await provideNextRoll(waiting.state, {natural: 1, total: 1}, {targetActors});
  const committed = await executeStagedActionResolution({
    state: rolled.resumed.state,
    actor,
    action,
    targetActors,
    authority: true,
    persistencePort
  });

  const distant = squareAttackFixture({targetOffset: {i: 4, j: 0}});
  const outOfReach = planStagedActionResolution({
    id: "resolution:melee-out-of-reach",
    actorSystem: actorSystem(),
    action,
    source: {actorId: "actor-source", tokenId: "source"},
    targeting: {required: true, candidates: [distant.targetFootprint]},
    context: spatialContext(distant.adapter, distant.sourceFootprint, [distant.targetFootprint])
  });

  assert.equal(rolled.resumed.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.CRITICAL_MISS);
  assert.equal(committed.ok, true);
  assert.equal(targetActor.system.resources.health.value, 14);
  assert.equal(actor.system.resources.action.value, 0);
  assert.equal(outOfReach.ok, false);
  assert.equal(outOfReach.code, ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE);
  assert.equal(outOfReach.state.pendingRequests.length, 0);
});

test("ranged strike validates normal, long, and out-of-range bands before damage", () => {
  const action = actionItem(rangedStrikeDefinition());
  const normal = planRangedAtOffset({id: "resolution:ranged-normal", action, targetOffset: {i: 6, j: 0}});
  const long = planRangedAtOffset({id: "resolution:ranged-long", action, targetOffset: {i: 7, j: 0}});
  const out = planRangedAtOffset({id: "resolution:ranged-out", action, targetOffset: {i: 25, j: 0}});

  assert.equal(normal.ok, true);
  assert.equal(normal.state.results.rangeResolution.checks[0].band, "normal");
  assert.equal(long.ok, true);
  assert.equal(long.state.results.rangeResolution.checks[0].band, "long");
  assert.equal(out.ok, false);
  assert.equal(out.code, ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE);
});

test("save-based burst resolves square and hex area candidates through adapter footprints", async () => {
  for ( const topology of [GRID_TOPOLOGIES.SQUARE, GRID_TOPOLOGIES.HEX] ) {
    const fixture = areaFixture(topology);
    const actor = actorDocument(`actor-source-${topology}`, {system: actorSystem()});
    const insideActor = actorDocument(`actor-inside-${topology}`, {system: targetActorSystem(20, 20)});
    const hugeActor = actorDocument(`actor-huge-${topology}`, {system: targetActorSystem(30, 30)});
    const outsideActor = actorDocument(`actor-outside-${topology}`, {system: targetActorSystem(20, 20)});
    const persistencePort = createTestDocumentPersistenceAdapter();
    const targetActors = {
      [`actor:actor-inside-${topology}`]: insideActor,
      [`actor:actor-huge-${topology}`]: hugeActor,
      [`actor:actor-outside-${topology}`]: outsideActor
    };
    const candidates = fixture.candidates.map(candidate => ({
      ...candidate,
      target: {
        ...candidate.target,
        saves: candidate.target.actorId.includes("huge")
          ? {dex: {total: 17, die: 12}}
          : {dex: {total: 10, die: 5}}
      }
    }));
    const targetSet = createTargetSet(candidates, {
      footprint: fixture.footprint,
      metadata: {topology}
    });

    const result = await executeStagedActionResolution({
      id: `resolution:${topology}:burst`,
      actor,
      action: actionItem(burstDefinition()),
      source: {actorId: actor.id, tokenId: "source"},
      targeting: {
        required: true,
        targetSet
      },
      durability: true,
      targetActors,
      authority: true,
      persistencePort,
      context: spatialContext(fixture.adapter, fixture.sourceFootprint, candidates)
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.results.targetResolution.targetContexts.length, 2);
    assert.deepEqual(result.state.results.saveResolution.results.map(entry => ({
      actorId: targetActorId(entry.targetContext),
      total: entry.roll.total,
      success: entry.success
    })).sort((a, b) => a.actorId.localeCompare(b.actorId)), [
      {actorId: `actor-huge-${topology}`, total: 17, success: true},
      {actorId: `actor-inside-${topology}`, total: 10, success: false}
    ]);
    assert.deepEqual(result.state.results.targetResolution.targetContexts.map(targetActorId).sort(), [
      `actor-huge-${topology}`,
      `actor-inside-${topology}`
    ]);
    assert.equal(insideActor.system.resources.health.value, 10);
    assert.equal(hugeActor.system.resources.health.value, 25);
    assert.equal(outsideActor.system.resources.health.value, 20);
    assert.equal(persistencePort.operations.filter(operation => operation.type === "updateActor" && operation.actorRef.includes("huge")).length, 1);
  }
});

test("healing is capped at max HP and rolls back when later payment commit fails", async () => {
  const actor = actorDocument("actor-source", {system: actorSystem()});
  const ally = actorDocument("actor-ally", {system: targetActorSystem(16, 20)});
  const targetActors = {"actor:actor-ally": ally};
  const persistencePort = createTestDocumentPersistenceAdapter({
    failOn: operation => operation.type === "updateActor" && operation.actorRef === "Actor.actor-source"
  });
  const action = actionItem(healingDefinition());
  const target = {id: "ally", actorId: "actor-ally", disposition: "ally"};
  const planned = planStagedActionResolution({
    id: "resolution:healing-rollback",
    actor,
    action,
    targets: [target],
    durability: true,
    targetActors
  });
  const result = await executeStagedActionResolution({
    state: planned.state,
    actor,
    action,
    targetActors,
    authority: true,
    persistencePort
  });

  assert.equal(planned.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(ally.system.resources.health.value, 16);
  assert.equal(actor.system.resources.action.value, 1);
  assert.equal(result.ok, false);
  assert.equal(result.state.results.actionResult.steps.at(-1).data.transaction.rolledBack, true);
  assert.equal(persistencePort.operations.length, 3);
  assert.equal(persistencePort.operations[0].actorRef, "Actor.actor-ally");
  assert.equal(persistencePort.operations[1].actorRef, "Actor.actor-source");
  assert.equal(persistencePort.operations[2].actorRef, "actor:actor-ally");
});

test("condition effect actions persist through effect persistence operations", async () => {
  const actor = actorDocument("actor-source", {system: actorSystem()});
  const targetActor = actorDocument("actor-orc", {system: targetActorSystem(14, 20), effects: []});
  const persistencePort = createTestDocumentPersistenceAdapter();
  const targetActors = {"actor:actor-orc": targetActor};
  const result = await executeStagedActionResolution({
    id: "resolution:effect",
    actor,
    action: actionItem(effectDefinition()),
    source: {actorId: "actor-source"},
    targets: [{id: "orc", actorId: "actor-orc", disposition: "enemy"}],
    targetActors,
    authority: true,
    persistencePort
  });

  assert.equal(result.ok, true);
  assert.equal(targetActor.effects.length, 1);
  assert.equal(targetActor.effects[0].system.type, "prone");
  assert.equal(targetActor.effects[0].flags.wildpath.conditionEffect.originRef, "item:action:apply-test-condition");
  assert.equal(persistencePort.operations.some(operation => operation.type === "createEmbeddedDocuments"), true);
  assert.equal(persistencePort.operations.some(operation => operation.type === "updateDocument"), false);
});

test("configured scaling burst preview matches resolved damage and spends resources only at commit", async () => {
  const fixture = areaFixture(GRID_TOPOLOGIES.SQUARE);
  const system = spellcastingActorSystem();
  const actor = actorDocument("actor-source", {system});
  const targetActor = actorDocument("actor-inside-square", {system: targetActorSystem(20, 20)});
  const targetActors = {"actor:actor-inside-square": targetActor};
  const persistencePort = createTestDocumentPersistenceAdapter();
  const definition = scalingBurstDefinition();
  const choices = {
    "casting-resource": {resourceId: "spell-slot.3"},
    "enable-conversion": true,
    "conversion-type": "lightning"
  };
  const preview = createResolvedActionPreview({
    definition,
    actorSystem: system,
    configurationContributions: conversionChoices(),
    choices
  });
  const waiting = planStagedActionResolution({
    id: "resolution:configured-burst",
    actor,
    action: actionItem(definition),
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      targetSet: createTargetSet([fixture.candidates.find(candidate => candidate.target.actorId === "actor-inside-square")], {
        footprint: fixture.footprint
      })
    },
    durability: true,
    configurationContributions: conversionChoices(),
    targetActors,
    context: spatialContext(fixture.adapter, fixture.sourceFootprint, fixture.candidates)
  });
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        [waiting.state.pendingRequests[0].id]: {choices}
      }
    })],
    resume: actionPipelineResume
  });
  const configured = await coordinator.coordinate({state: waiting.state, services: {targetActors}});
  const rolled = await provideNextRoll(configured.state, {total: 14}, {targetActors});
  assert.equal(system.pools.find(pool => pool.id === "spell-slot.3").value, 1);
  assert.equal(system.pools.find(pool => pool.id === "sorcery-point").value, 1);
  const committed = await executeStagedActionResolution({
    state: rolled.resumed.state,
    actor,
    action: actionItem(definition),
    targetActors,
    authority: true,
    persistencePort
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.preview.damage.components[0].formula, "4d6");
  assert.equal(preview.preview.damage.components[0].damageType, "lightning");
  assert.equal(configured.state.results.preview.damage.components[0].formula, "4d6");
  assert.equal(rolled.resumed.state.input.damage.components[0].damageType, "lightning");
  assert.equal(rolled.resumed.state.input.damage.components[0].amount, 14);
  assert.equal(committed.ok, true);
  assert.equal(targetActor.system.resources.health.value, 6);
  assert.equal(system.pools.find(pool => pool.id === "spell-slot.3").value, 0);
  assert.equal(system.pools.find(pool => pool.id === "sorcery-point").value, 0);
});

function squareAttackFixture({targetOffset}) {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: `square-${targetOffset.i}-${targetOffset.j}`});
  const sourceToken = fakeToken({
    id: "source",
    actorId: "actor-source",
    scene,
    grid,
    offset: {i: 0, j: 0},
    size: CREATURE_SIZES.MEDIUM
  });
  const targetToken = fakeToken({
    id: "orc",
    actorId: "actor-orc",
    scene,
    grid,
    offset: targetOffset,
    size: CREATURE_SIZES.MEDIUM
  });
  scene.tokens = [sourceToken, targetToken];
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  return {
    adapter,
    sourceFootprint: adapter.tokenToFootprint(sourceToken).footprint,
    targetFootprint: withTargetDefense(adapter.tokenToTargetFootprint(targetToken, {disposition: "enemy"}).tokenFootprint)
  };
}

function withTargetDefense(tokenFootprint, ac=12) {
  return {
    ...tokenFootprint,
    target: {
      ...tokenFootprint.target,
      defenses: {ac: {value: ac}}
    }
  };
}

function targetActorId(entry) {
  const target = entry?.target ?? entry;
  return target?.actorId
    ?? target?.target?.actorId
    ?? target?.actor?.id
    ?? null;
}

function planRangedAtOffset({id, action, targetOffset}) {
  const fixture = squareAttackFixture({targetOffset});
  return planStagedActionResolution({
    id,
    actorSystem: actorSystem(),
    action,
    source: {actorId: "actor-source", tokenId: "source"},
    targeting: {
      required: true,
      candidates: [{
        ...fixture.targetFootprint,
        target: {
          ...fixture.targetFootprint.target,
          defenses: {ac: {value: 12}}
        }
      }]
    },
    attack: {roll: {total: 17, die: 12}},
    damage: {components: [{id: "shot", amount: 7, damageType: "piercing"}]},
    context: spatialContext(fixture.adapter, fixture.sourceFootprint, [fixture.targetFootprint])
  });
}

function areaFixture(topology) {
  const grid = topology === GRID_TOPOLOGIES.HEX
    ? new FakeHexGrid(FOUNDRY_GRID_TYPES.HEXODDR)
    : new FakeSquareGrid();
  const scene = fakeScene(grid, {id: `${topology}-area`});
  const sourceToken = fakeToken({
    id: "source",
    actorId: `actor-source-${topology}`,
    scene,
    grid,
    offset: {i: 0, j: 0},
    size: CREATURE_SIZES.MEDIUM
  });
  const insideToken = fakeToken({
    id: "inside",
    actorId: `actor-inside-${topology}`,
    scene,
    grid,
    offset: {i: 1, j: 0},
    size: CREATURE_SIZES.MEDIUM
  });
  const hugeToken = fakeToken({
    id: "huge",
    actorId: `actor-huge-${topology}`,
    scene,
    grid,
    offset: {i: 2, j: 0},
    size: CREATURE_SIZES.HUGE
  });
  const outsideToken = fakeToken({
    id: "outside",
    actorId: `actor-outside-${topology}`,
    scene,
    grid,
    offset: {i: 6, j: 0},
    size: CREATURE_SIZES.MEDIUM
  });
  scene.tokens = [sourceToken, insideToken, hugeToken, outsideToken];
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const sourceFootprint = adapter.tokenToFootprint(sourceToken).footprint;
  const origin = topology === GRID_TOPOLOGIES.HEX ? {q: 0, r: 0} : {x: 0, y: 0};
  const footprint = createRadialFootprint({
    topology,
    origin,
    radiusDistance: 10,
    gridDistance: 5
  });
  const area = adapter.resolveAreaTargetCandidates({
    footprint,
    tokens: [insideToken, hugeToken, outsideToken]
  });
  return {
    adapter,
    sourceFootprint,
    footprint,
    candidates: area.candidates
  };
}

class FakeSquareGrid {
  constructor({distance=5, units="ft", size=50}={}) {
    this.type = FOUNDRY_GRID_TYPES.SQUARE;
    this.isSquare = true;
    this.isHexagonal = false;
    this.isGridless = false;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }

  getOffset(point) {
    return {
      i: Math.floor(Number(point.x) / this.sizeX),
      j: Math.floor(Number(point.y) / this.sizeY)
    };
  }

  getCenterPoint(offset) {
    return {
      x: (Number(offset.i) + 0.5) * this.sizeX,
      y: (Number(offset.j) + 0.5) * this.sizeY
    };
  }

  getVertices(offset) {
    const x = Number(offset.i) * this.sizeX;
    const y = Number(offset.j) * this.sizeY;
    return [
      {x, y},
      {x: x + this.sizeX, y},
      {x: x + this.sizeX, y: y + this.sizeY},
      {x, y: y + this.sizeY}
    ];
  }

  getAdjacentOffsets(offset) {
    return [
      {i: offset.i, j: offset.j - 1},
      {i: offset.i + 1, j: offset.j},
      {i: offset.i, j: offset.j + 1},
      {i: offset.i - 1, j: offset.j}
    ];
  }

  getSnappedPoint(point) {
    const offset = this.getOffset(point);
    return this.getVertices(offset)
      .sort((a, b) => squaredDistance(a, point) - squaredDistance(b, point))[0];
  }
}

class FakeHexGrid {
  constructor(type, {distance=5, units="ft", size=50}={}) {
    this.type = type;
    this.isSquare = false;
    this.isHexagonal = true;
    this.isGridless = false;
    this.columns = type === FOUNDRY_GRID_TYPES.HEXODDQ || type === FOUNDRY_GRID_TYPES.HEXEVENQ;
    this.even = type === FOUNDRY_GRID_TYPES.HEXEVENR || type === FOUNDRY_GRID_TYPES.HEXEVENQ;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }

  get variant() {
    if ( this.columns ) return this.even ? FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q : FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q;
    return this.even ? FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R : FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R;
  }

  getOffset(point) {
    return {
      i: Math.floor(Number(point.x) / this.sizeX),
      j: Math.floor(Number(point.y) / this.sizeY)
    };
  }

  getCenterPoint(offset) {
    return {
      x: (Number(offset.i) + 0.5) * this.sizeX,
      y: (Number(offset.j) + 0.5) * this.sizeY
    };
  }

  getVertices(offset) {
    const center = this.getCenterPoint(offset);
    return Array.from({length: 6}, (_, index) => {
      const angle = (Math.PI / 3) * index;
      return {
        x: center.x + (Math.cos(angle) * this.sizeX * 0.5),
        y: center.y + (Math.sin(angle) * this.sizeY * 0.5)
      };
    });
  }

  getAdjacentOffsets(offset) {
    const field = offsetToAxial(offset, this.variant);
    return HEX_DIRECTIONS.map(direction => axialToOffset({
      q: field.q + direction.q,
      r: field.r + direction.r
    }, this.variant));
  }
}

function fakeScene(grid, data={}) {
  return {
    id: data.id ?? "scene-a",
    uuid: data.uuid ?? `Scene.${data.id ?? "scene-a"}`,
    name: data.name ?? "Vertical Slice Scene",
    grid,
    dimensions: {
      distance: grid.distance,
      units: grid.units,
      size: grid.size,
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 1000,
      sceneHeight: 1000,
      columns: 20,
      rows: 20
    },
    tokens: data.tokens ?? []
  };
}

function fakeToken({id, actorId, scene, grid, offset, size=CREATURE_SIZES.MEDIUM, disposition=-1}) {
  return {
    documentName: "Token",
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    name: id,
    parent: scene,
    sceneId: scene.id,
    actor: {
      id: actorId,
      uuid: `Actor.${actorId}`,
      name: actorId,
      type: "npc",
      system: {traits: {size}}
    },
    x: Number(offset.i) * grid.sizeX,
    y: Number(offset.j) * grid.sizeY,
    disposition,
    wildpathSize: size,
    getOccupiedGridSpaceOffsets() {
      return [offset];
    }
  };
}

function offsetToAxial(offset, variant) {
  const i = Number(offset.i);
  const j = Number(offset.j);
  switch ( variant ) {
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q:
      return {q: i, r: j - Math.floor((i + 1) / 2)};
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q:
      return {q: i, r: j - Math.floor(i / 2)};
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R:
      return {q: i - Math.floor((j + 1) / 2), r: j};
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R:
    default:
      return {q: i - Math.floor(j / 2), r: j};
  }
}

function axialToOffset(field, variant) {
  const q = Number(field.q);
  const r = Number(field.r);
  switch ( variant ) {
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q:
      return {i: q, j: r + Math.floor((q + 1) / 2)};
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q:
      return {i: q, j: r + Math.floor(q / 2)};
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R:
      return {i: q + Math.floor((r + 1) / 2), j: r};
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R:
    default:
      return {i: q + Math.floor(r / 2), j: r};
  }
}

function squaredDistance(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return (dx * dx) + (dy * dy);
}

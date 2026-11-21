import {test} from "node:test";
import assert from "node:assert/strict";
import {
  commitConditionEffectMutationPlan,
  rollbackConditionEffectMutationPlan
} from "../module/resolvers/condition-effect-commit-resolver.mjs";

test("a creature immune to a condition is not given it, and nothing needs rolling back", async () => {
  const actor = actorWithEffects();
  actor.getConditionImmunities = () => ["charmed"];
  const result = await commitConditionEffectMutationPlan(actor, {type: "conditionEffect", conditionId: "charmed", levels: 1});
  assert.equal(result.ok, true);
  assert.equal(result.immune, true);
  assert.equal(actor.effects.length, 0);
  assert.equal(await rollbackConditionEffectMutationPlan(actor, null, null, result), true);
});

function actorWithEffects(effects=[]) {
  const actor = {
    effects: [],
    async createEmbeddedDocuments(documentName, documents) {
      assert.equal(documentName, "ActiveEffect");
      const created = documents.map(document => effectDocument(actor, {
        id: document.id ?? `effect-${actor.effects.length + 1}`,
        ...document
      }));
      actor.effects.push(...created);
      return created;
    }
  };
  actor.effects = effects.map(effect => effectDocument(actor, effect));
  return actor;
}

function effectDocument(actor, data) {
  const effect = {
    id: data.id,
    uuid: data.uuid ?? null,
    type: data.type ?? "condition",
    name: data.name ?? data.system?.type ?? "Condition",
    statuses: [...(data.statuses ?? [])],
    system: structuredClone(data.system ?? {}),
    duration: structuredClone(data.duration ?? null),
    origin: data.origin ?? null,
    flags: structuredClone(data.flags ?? {}),
    async update(updates) {
      for ( const [path, value] of Object.entries(updates) ) {
        const parts = path.split(".");
        let cursor = effect;
        for ( const part of parts.slice(0, -1) ) {
          cursor[part] ??= {};
          cursor = cursor[part];
        }
        cursor[parts.at(-1)] = structuredClone(value);
      }
      return effect;
    },
    async delete(operation={}) {
      // What the deleteActiveEffect hook would see: an ending, or not (`{wildpath: {ended: false}}`).
      actor.deleted = [...(actor.deleted ?? []), [effect.name, operation]];
      actor.effects = actor.effects.filter(candidate => candidate !== effect);
      return true;
    },
    toObject() {
      return {
        id: effect.id,
        uuid: effect.uuid,
        type: effect.type,
        name: effect.name,
        system: structuredClone(effect.system),
        duration: structuredClone(effect.duration),
        origin: effect.origin,
        flags: structuredClone(effect.flags)
      };
    }
  };
  return effect;
}

test("condition effect commit adapter rolls stacking updates back to the previous snapshot", async () => {
  const actor = actorWithEffects([{
    id: "effect-exhaustion",
    name: "Exhaustion (2)",
    system: {type: "exhaustion", level: 2}
  }]);
  const plan = {
    type: "conditionEffect",
    conditionId: "exhaustion",
    levels: 2,
    action: "update",
    stacking: true,
    maxLevel: 6,
    definition: {name: "Exhaustion"},
    duration: {unit: "round", value: 3},
    concentration: null,
    sourceRef: "actor:caster",
    originRef: "item:spell",
    metadata: {}
  };

  const commit = await commitConditionEffectMutationPlan(actor, plan);
  assert.equal(commit.ok, true);
  assert.equal(actor.effects[0].system.level, 4);
  assert.equal(actor.effects[0].name, "Exhaustion (4)");
  assert.deepEqual(actor.effects[0].duration, {unit: "round", value: 3});

  const rollback = await rollbackConditionEffectMutationPlan(actor, plan, plan, commit);
  assert.equal(rollback, true);
  assert.equal(actor.effects[0].system.level, 2);
  assert.equal(actor.effects[0].name, "Exhaustion (2)");
  assert.equal(actor.effects[0].duration, null);
});

test("a condition lasting until its source's next turn (Stunning Strike) shows V14's turnStart; the lifecycle keeps whose turn", async () => {
  const actor = actorWithEffects([{id: "stunned", name: "Stunned", system: {type: "stunned"}}]);
  const plan = {type: "conditionEffect", conditionId: "stunned", levels: 1, action: "update", definition: {name: "Stunned"},
    duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"}, concentration: null, sourceRef: "token:monk", originRef: null,
    metadata: {}};
  const commit = await commitConditionEffectMutationPlan(actor, plan);
  assert.equal(commit.ok, true);
  // The monk's is its own instance beside the GM's unflagged Stunned (Q19 (d)).
  const monks = actor.effects.find(effect => effect.id === commit.effectId);
  assert.deepEqual(monks.duration, {value: 1, units: "rounds", expiry: "turnStart"});
  assert.equal(monks.flags.wildpath.conditionEffect.duration.expiry, "sourceTurnStart");
  assert.deepEqual([actor.effects.length, actor.effects[0].duration], [2, null], "the GM's Stunned is left as it was");
});

// An Action's custom effect names its Item as its source, so V14 starts its duration on the turn in progress (the monk's,
// for Step of the Wind's Bonus Action): `turnEnd` is that turn's end. It must never start on the target's own Combatant.
test("a custom effect lasting to turnEnd on another creature reaches V14 as turnEnd, never started on that creature's Combatant", async () => {
  const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const definition = {schemaVersion: 1, id: "action:carry", label: "Carry", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    effects: [{id: "carried", type: "effect", name: "Carried", slug: "carried", duration: {value: 0, units: "turns", expiry: "turnEnd"}, ruleElements: []}]};
  const mutation = planStagedActionResolution({id: "resolution:carry", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: definition.id, type: "action", name: "Carry", system: {definition}}, source: {actorId: "monk", tokenId: "monk-token"},
    targets: [{id: "ally", actorId: "actor-ally", tokenId: "ally-token"}]}).state.mutationPlans.find(entry => entry.type === "conditionEffect");
  const previous = globalThis.game;
  globalThis.game = {time: {worldTime: 600}, combat: {id: "combat-1", started: true, round: 2, turn: 1,
    combatants: [{id: "combatant-ally", tokenId: "ally-token"}, {id: "combatant-monk", tokenId: "monk-token", initiative: 14}]}};
  try {
    const actor = actorWithEffects();
    const created = [];
    const create = actor.createEmbeddedDocuments;
    actor.createEmbeddedDocuments = async (name, documents) => { created.push(...structuredClone(documents)); return create(name, documents); };
    assert.equal((await commitConditionEffectMutationPlan(actor, mutation)).ok, true);
    assert.deepEqual(created[0].duration, {value: 0, units: "turns", expiry: "turnEnd"}, "a V14 expiry, as written");
    // Through the pipeline the plan's source is the Action's user, so its duration starts on the source's Combatant: the
    // whole start record, as V14 validates `time` on creation and reads `combatant` only with its `combat`.
    assert.deepEqual(created[0].start, {time: 600, combat: "combat-1", combatant: "combatant-monk", initiative: 14, round: 2, turn: 1});
  } finally {
    globalThis.game = previous;
  }
});

// A summon with no Combatant (an Arcane Eye, a spectral pack) takes its turns on its controller's: what its own Move gives it
// "until the end of the turn" ends as that turn ends, where with no start V14 would never end it.
test("a custom effect a creature with no Combatant gives itself starts on its controller's Combatant (Q33)", async () => {
  const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const definition = {schemaVersion: 1, id: "action:move", label: "Move", costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
    effects: [{id: "effect-1", type: "effect", name: "Move", duration: {value: 0, units: "turns", expiry: "turnEnd"}, ruleElements: []}]};
  const mutation = planStagedActionResolution({id: "resolution:move", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: definition.id, type: "action", name: "Move", system: {definition}},
    source: {actorId: "eye", tokenId: "eye-token", uuid: "Scene.s.Token.eye-token.Actor.eye"}, targets: [{id: "eye", actorId: "eye", tokenId: "eye-token"}]})
    .state.mutationPlans.find(entry => entry.type === "conditionEffect");
  const previous = {game: globalThis.game, fromUuidSync: globalThis.fromUuidSync};
  const controllers = [];
  globalThis.fromUuidSync = uuid => ((uuid === "Scene.s.Token.eye-token.Actor.eye") ? {system: {companion: {controllers}}} : null);
  globalThis.game = {time: {worldTime: 600}, combat: {id: "combat-1", started: true, round: 2, turn: 1,
    combatants: [{id: "combatant-goblin", tokenId: "goblin-token", actor: {uuid: "Actor.goblin"}},
      {id: "combatant-wizard", tokenId: "wizard-token", actor: {uuid: "Actor.wizard"}, initiative: 15}]}};
  try {
    const started = async () => {
      const actor = actorWithEffects();
      const created = [];
      const create = actor.createEmbeddedDocuments;
      actor.createEmbeddedDocuments = async (name, documents) => { created.push(...structuredClone(documents)); return create(name, documents); };
      assert.equal((await commitConditionEffectMutationPlan(actor, mutation)).ok, true);
      return created[0].start;
    };
    assert.equal(await started(), undefined, "an uncontrolled one keeps V14's own start");
    controllers.push("Actor.wizard");
    assert.deepEqual(await started(), {time: 600, combat: "combat-1", combatant: "combatant-wizard", initiative: 15, round: 2, turn: 1});
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("condition effect commit adapter restores deleted condition snapshots", async () => {
  const actor = actorWithEffects([{
    id: "effect-prone",
    name: "Prone",
    system: {type: "prone", level: null}
  }]);
  const plan = {
    type: "conditionEffect",
    conditionId: "prone",
    levels: -1,
    action: "delete",
    stacking: false,
    maxLevel: null,
    definition: {name: "Prone"},
    duration: null,
    concentration: null,
    sourceRef: null,
    originRef: null,
    metadata: {}
  };

  const commit = await commitConditionEffectMutationPlan(actor, plan);
  assert.equal(commit.ok, true);
  assert.equal(actor.effects.length, 0);

  const rollback = await rollbackConditionEffectMutationPlan(actor, plan, plan, commit);
  assert.equal(rollback, true);
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].id, "effect-prone");
  assert.equal(actor.effects[0].system.type, "prone");
});

test("an Action's custom effect commits as an ordinary effect with its rules and a native duration, and refreshes when reapplied", async () => {
  const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const definition = {schemaVersion: 1, id: "action:bless", label: "Bless", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    effects: [{id: "blessed", type: "effect", name: "Blessed", slug: "blessed", img: "icons/bless.svg",
      ruleElements: [{schemaVersion: 1, id: "bless-attacks", type: "Modifier", data: {domains: ["attack"], value: 2}}],
      duration: {value: 10, units: "rounds", expiry: "turnStart"}}]};
  const plan = () => planStagedActionResolution({id: "resolution:bless", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: definition.id, type: "action", name: "Bless", system: {definition}}, source: {actorId: "cleric"},
    targets: [{id: "ally", actorId: "actor-ally"}]}).state.mutationPlans.find(entry => entry.type === "conditionEffect");
  const mutation = plan();
  assert.equal(mutation.conditionId, "blessed");
  assert.equal(mutation.definition.custom, true);
  const actor = actorWithEffects();
  const committed = await commitConditionEffectMutationPlan(actor, mutation);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(actor.effects.length, 1);
  const [effect] = actor.effects;
  assert.equal(effect.type, "effect", "an ordinary effect, not a condition status");
  assert.equal(effect.name, "Blessed");
  assert.deepEqual(effect.system.ruleElements.map(rule => rule.id), ["bless-attacks"]);
  assert.deepEqual(effect.duration, {value: 10, units: "rounds", expiry: "turnStart"}, "V14 runs this duration");
  assert.equal(effect.flags.wildpath.conditionEffect.definition.custom, true);
  assert.equal(effect.flags.wildpath.conditionEffect.conditionId, "blessed");

  const again = await commitConditionEffectMutationPlan(actor, {...plan(), existingEffectId: null});
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(actor.effects.length, 1, "the same effect again refreshes it; it does not stack");

  await rollbackConditionEffectMutationPlan(actor, mutation, null, committed);
  assert.equal(actor.effects.length, 0, "rolling the first application back removes the effect it created");
  assert.deepEqual(actor.deleted, [["Blessed", {wildpath: {ended: false}}]], "which is no ending of it");
});

test("a custom effect's content keys reach its committed effect, where their readers find them (magicWeapon, drawsAtTurnStart)", async () => {
  const {planStagedActionResolution, resumeStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const {RESOLUTION_REQUEST_TYPES} = await import("../module/helpers/resolution-state.mjs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {createFoundryAutomationDispatcher} = await import("../module/adapters/foundry-v14-automation-dispatcher.mjs");
  const definition = {schemaVersion: 1, id: "action:hex-blade", label: "Hex Blade", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    configuration: [{id: "weapon", type: "select-one", label: "Weapon", required: true,
      options: [{value: "sword", label: "Longsword"}], effects: [{type: "bindChoice"}]}],
    effects: [{id: "hexed", type: "effect", name: "Hexed", ruleElements: [], magicWeapon: "{{weapon}}",
      drawsAtTurnStart: "RollTable.behavior"}]};
  const waiting = planStagedActionResolution({id: "resolution:hex", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: definition.id, type: "action", name: "Hex Blade", system: {definition}}, source: {actorId: "warlock"},
    targets: [{id: "ally", actorId: "actor-ally"}]});
  const resumed = resumeStagedActionResolution({state: waiting.state, response: {resolutionId: "resolution:hex",
    requestId: "request:resolution:hex:configuration", type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
    value: {choices: {weapon: "sword"}}}});
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const mutation = resumed.state.mutationPlans.find(entry => entry.type === "conditionEffect");
  const actor = actorWithEffects();
  const committed = await commitConditionEffectMutationPlan(actor, mutation);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const stored = actor.effects[0].flags.wildpath.conditionEffect.definition;
  assert.deepEqual([stored.magicWeapon, stored.drawsAtTurnStart], ["sword", "RollTable.behavior"], "the chosen weapon, bound");

  // Magic Weapon's reader: the committed effect makes its weapon magical, so a nonmagical-only choice leaves it out.
  actor.items = [{id: "sword", type: "gear", name: "Longsword", system: {}}, {id: "club", type: "gear", name: "Club", system: {}},
    ...["sword", "club"].map(id => ({id: `${id}-attack`, type: "action", name: id, flags: {wildpath: {grantedBy: id}},
      system: {definition: {attack: {weapon: {base: id}}}}}))];
  const nonmagical = actionDefinitionFromItem({type: "action", actor, system: {definition: {schemaVersion: 1, id: "action:pick",
    label: "Pick", costs: {allOf: []}, targeting: {type: "self"}, configuration: [{id: "weapon", type: "select-one", label: "Weapon",
      required: true, options: [], optionsFrom: {type: "weapons", magical: false}}]}}});
  assert.deepEqual(nonmagical.definition.configuration[0].options.map(option => option.value), ["club"]);

  // Confusion's reader: its creature draws the table as its turn starts.
  const drawn = [];
  const automation = createFoundryAutomationDispatcher({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}}, coordinator: {},
    resolveAction: () => null, fromUuid: uuid => ({draw: async () => (drawn.push(uuid), {results: [], roll: {total: 1}}),
      toMessage: async () => null})});
  await automation.dispatch("turn.started", {actor: Object.assign(actor, {id: "a", uuid: "Actor.a", statuses: new Set()})});
  assert.deepEqual(drawn, ["RollTable.behavior"]);
});

test("a custom effect applied again with another content key value replaces it; an older one lacking the key does too", async () => {
  const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const plan = weapon => {
    const definition = {schemaVersion: 1, id: "action:blade", label: "Blessed Blade", costs: {allOf: []}, targeting: {type: "self"},
      effects: [{id: "blade", type: "effect", name: "Blessed Blade", ruleElements: [], magicWeapon: weapon}]};
    return planStagedActionResolution({id: `resolution:${weapon}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: definition.id, type: "action", name: "Blessed Blade", system: {definition}}, source: {actorId: "cleric"},
      targets: [{id: "cleric", actorId: "actor-cleric"}]}).state.mutationPlans.find(entry => entry.type === "conditionEffect");
  };
  const actor = actorWithEffects();
  const magicWeapons = () => actor.effects.map(effect => effect.flags.wildpath.conditionEffect.definition.magicWeapon);
  assert.equal((await commitConditionEffectMutationPlan(actor, plan("axe"))).ok, true);
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("sword"), existingEffectId: null})).ok, true);
  assert.deepEqual(magicWeapons(), ["sword"], "the sword is magical now, not the axe");
  delete actor.effects[0].flags.wildpath.conditionEffect.definition.magicWeapon;
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("sword"), existingEffectId: null})).ok, true);
  assert.deepEqual([magicWeapons(), actor.deleted.length], [["sword"], 2], "an effect committed before the key reached its definition gets it");
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("sword"), existingEffectId: null})).ok, true);
  assert.equal(actor.deleted.length, 2, "the same weapon again refreshes it");
});

test("a removal planned without seeing the target (Lesser Restoration's noop plan) ends its condition on the live creature", async () => {
  const actor = actorWithEffects([{id: "effect-poisoned", name: "Poisoned", system: {type: "poisoned", level: null}},
    {id: "effect-exhaustion", name: "Exhaustion", system: {type: "exhaustion", level: 3}}]);
  const removal = (conditionId, stacking) => ({type: "conditionEffect", conditionId, levels: -1, action: "noop", stacking,
    maxLevel: stacking ? 6 : null, definition: {name: conditionId}, duration: null, concentration: null, sourceRef: null, originRef: null,
    metadata: {}});
  assert.equal((await commitConditionEffectMutationPlan(actor, removal("poisoned", false))).ok, true);
  assert.equal((await commitConditionEffectMutationPlan(actor, removal("exhaustion", true))).ok, true);
  assert.deepEqual(actor.effects.map(effect => [effect.system.type, effect.system.level]), [["exhaustion", 2]], "Poisoned ends; Exhaustion 3 -> 2");
  assert.deepEqual(actor.deleted, [["Poisoned", {}]], "an ending");
  assert.equal((await commitConditionEffectMutationPlan(actor, removal("blinded", false))).ok, true, "a condition it lacks: nothing to do");
});

test("rolling back a second separate effect (a second Dash) removes that copy, not the first one of the same status", async () => {
  const dash = () => ({type: "conditionEffect", conditionId: "dashed", levels: 1, action: "create", stacking: false,
    definition: {id: "dashed", name: "Dashed", custom: true, separate: true,
      ruleElements: [{schemaVersion: 1, id: "dash-speed", type: "Modifier", data: {domains: ["speed"], value: 30}}]},
    metadata: {}});
  const actor = actorWithEffects();
  assert.equal((await commitConditionEffectMutationPlan(actor, dash())).ok, true);
  const second = await commitConditionEffectMutationPlan(actor, dash());
  assert.equal(second.ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["effect-1", "effect-2"], "a separate effect is new each time");
  assert.equal(await rollbackConditionEffectMutationPlan(actor, dash(), null, second), true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["effect-1"], "the rolled-back copy goes; the first Dash stays");

  // A plan naming its effect (a spent added die's payment) ends that one, wherever it sits among others of its status.
  assert.equal((await commitConditionEffectMutationPlan(actor, dash())).ok, true);
  const spend = {type: "conditionEffect", conditionId: "dashed", levels: -1, action: "delete", stacking: false,
    existingEffectId: actor.effects[1].id, definition: {id: "dashed", custom: true}, metadata: {}};
  assert.equal((await commitConditionEffectMutationPlan(actor, spend)).ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["effect-1"], "the named copy ends, not the first one");
});

test("another choice of the same custom effect replaces it: Elemental Affinity's Cold after its Fire", async () => {
  const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const affinity = type => ({id: type, type: "effect", name: `Elemental Affinity (${type})`, slug: "elemental-affinity",
    ruleElements: [{schemaVersion: 1, id: `affinity-${type}`, type: "GrantResistance", data: {damageTypes: [type]}}]});
  const plan = type => {
    const definition = {schemaVersion: 1, id: "action:affinity", label: "Elemental Affinity", costs: {allOf: []},
      targeting: {type: "single", required: true, count: 1}, effects: [affinity(type)]};
    return planStagedActionResolution({id: `resolution:${type}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: definition.id, type: "action", name: "Elemental Affinity", system: {definition}}, source: {actorId: "sorcerer"},
      targets: [{id: "sorcerer", actorId: "actor-sorcerer"}]})
      .state.mutationPlans.find(entry => entry.type === "conditionEffect");
  };
  const actor = actorWithEffects();
  assert.equal((await commitConditionEffectMutationPlan(actor, plan("fire"))).ok, true);
  const coldPlan = {...plan("cold"), existingEffectId: null};
  const replaced = await commitConditionEffectMutationPlan(actor, coldPlan);
  assert.equal(replaced.ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.system.ruleElements[0].data.damageTypes), [["cold"]], "Cold replaces Fire");
  assert.equal(await rollbackConditionEffectMutationPlan(actor, coldPlan, null, replaced), true);
  assert.deepEqual(actor.effects.map(effect => effect.system.ruleElements[0].data.damageTypes), [["fire"]],
    "rolled back: Fire again, and no Cold beside it");
  const notEnded = {wildpath: {ended: false}};
  assert.deepEqual(actor.deleted, [["Elemental Affinity (fire)", notEnded], ["Elemental Affinity (cold)", notEnded]],
    "neither the replacement nor the rollback is an ending (no effect.ended Triggers run)");
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("cold"), existingEffectId: null})).ok, true);
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("cold"), existingEffectId: null})).ok, true);
  assert.equal(actor.effects.length, 1, "the same choice again refreshes it");
});

test("a custom effect's statuses go on it beside its own, and another option's statuses replace it (Rage of the Wilds)", async () => {
  const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const plan = option => {
    const definition = {schemaVersion: 1, id: "action:rage", label: "Rage", costs: {allOf: []}, targeting: {type: "self"},
      effects: [{id: "effect-1", type: "effect", name: "Rage", slug: "raging", ruleElements: [], statuses: [`rage-${option}`]}]};
    return planStagedActionResolution({id: `resolution:${option}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: definition.id, type: "action", name: "Rage", system: {definition}}, source: {actorId: "barbarian"},
      targets: [{id: "barbarian", actorId: "actor-barbarian"}]}).state.mutationPlans.find(entry => entry.type === "conditionEffect");
  };
  const actor = actorWithEffects();
  assert.equal((await commitConditionEffectMutationPlan(actor, plan("eagle"))).ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.statuses), [["raging", "rage-eagle"]]);
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("bear"), existingEffectId: null})).ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.statuses), [["raging", "rage-bear"]], "a Bear Rage after an Eagle one is no longer Eagle");
  assert.equal((await commitConditionEffectMutationPlan(actor, {...plan("bear"), existingEffectId: null})).ok, true);
  assert.equal(actor.deleted.length, 1, "the same option again refreshes it");
});

/** A condition instance one Action gave from one source (Q19). */
function sourcedCondition(id, conditionId, sourceRef, actionDefinitionId, system={}) {
  return {id, name: conditionId[0].toUpperCase() + conditionId.slice(1), statuses: [conditionId], system: {type: conditionId, ...system},
    flags: {wildpath: {conditionEffect: {conditionId, sourceRef, metadata: {actionDefinitionId}}}}};
}

test("a condition from a second source is its own instance beside the first, made with its rules; its own source refreshes it (Q19)", async () => {
  const rules = {ruleElements: [{schemaVersion: 1, id: "condition.burning.turn-start-damage", type: "Trigger"}]};
  const actor = actorWithEffects([sourcedCondition("first", "burning", "uuid:Actor.mage", "action:fire-bolt", rules)]);
  const toggled = [];
  // V14: `true`, creating nothing, while a single-status effect of that status exists.
  actor.toggleStatusEffect = async id => {
    toggled.push(id);
    return actor.effects.some(effect => effect.statuses.includes(id)) ? true : undefined;
  };
  const plan = (sourceRef, actionDefinitionId, duration=null) => ({type: "conditionEffect", conditionId: "burning", levels: 1,
    action: "create", definition: {name: "WILDPATH.CONDITIONS.Burning"}, duration, sourceRef, metadata: {actionDefinitionId}});
  const second = await commitConditionEffectMutationPlan(actor, plan("uuid:Actor.dragon", "action:fire-breath"));
  assert.equal(second.ok, true);
  assert.deepEqual(toggled, [], "created directly, not through toggleStatusEffect");
  assert.deepEqual(actor.effects.map(effect => [effect.id, effect.flags.wildpath.conditionEffect.sourceRef]),
    [["first", "uuid:Actor.mage"], ["effect-2", "uuid:Actor.dragon"]], "the first keeps its own source");
  const made = actor.effects[1];
  assert.deepEqual([made.name, made.statuses, made.system.type, made.system.ruleElements], ["Burning", ["burning"], "burning", rules.ruleElements],
    "the status data of the instance already there (its Trigger), not a lang key with no rules");

  await commitConditionEffectMutationPlan(actor, plan("uuid:Actor.dragon", "action:fire-breath", {value: 2, units: "rounds"}));
  assert.deepEqual([actor.effects.length, actor.effects[1].duration, actor.effects[0].duration], [2, {value: 2, units: "rounds"}, null],
    "the dragon again refreshes its own");

  const third = await commitConditionEffectMutationPlan(actor, plan("uuid:Actor.imp", "action:fire-bolt"));
  assert.equal(await rollbackConditionEffectMutationPlan(actor, null, null, third), true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["first", "effect-2"], "rolling a new instance back deletes that one only");

  const fourth = await commitConditionEffectMutationPlan(actor, plan("uuid:Actor.imp", "action:fire-bolt"));
  actor.effects = actor.effects.filter(effect => effect.id !== fourth.effectId);
  assert.equal(await rollbackConditionEffectMutationPlan(actor, null, null, fourth), true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["first", "effect-2"], "a new instance already gone: no other source's deleted instead");
});

test("an every-instance removal failing partway brings back the instances it had already deleted", async () => {
  const actor = actorWithEffects([sourcedCondition("net", "restrained", "uuid:Actor.hunter", "action:net"),
    sourcedCondition("web", "restrained", "uuid:Actor.mage", "action:web"), {id: "gm", system: {type: "restrained"}}]);
  actor.effects[2].delete = async () => { throw new Error("deletion refused"); };
  const commit = await commitConditionEffectMutationPlan(actor, {type: "conditionEffect", conditionId: "restrained", levels: -1,
    action: "delete", allInstances: true, definition: {}, metadata: {}});
  assert.equal(commit.ok, false);
  assert.deepEqual(actor.effects.map(effect => [effect.id, effect.flags?.wildpath?.conditionEffect?.sourceRef ?? null]).sort(),
    [["gm", null], ["net", "uuid:Actor.hunter"], ["web", "uuid:Actor.mage"]], "the Net's and the Web's holds are back");
});

test("a removal naming no instance ends every source's, and rollback brings each back as it was (Q19 (b))", async () => {
  const actor = actorWithEffects([sourcedCondition("net", "restrained", "uuid:Actor.hunter", "action:net"),
    sourcedCondition("web", "restrained", "uuid:Actor.mage", "action:web"), {id: "prone", system: {type: "prone"}}]);
  const commit = await commitConditionEffectMutationPlan(actor, {type: "conditionEffect", conditionId: "restrained", levels: -1,
    action: "delete", allInstances: true, definition: {}, metadata: {}});
  assert.equal(commit.ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["prone"]);
  assert.equal(await rollbackConditionEffectMutationPlan(actor, null, null, commit), true);
  assert.deepEqual(actor.effects.map(effect => [effect.id, effect.flags?.wildpath?.conditionEffect?.sourceRef ?? null]).sort(),
    [["net", "uuid:Actor.hunter"], ["prone", null], ["web", "uuid:Actor.mage"]], "each restored with its own source, none over another");
});

test("a removal naming its instance (an Escape's hold) ends that one, and none once it is gone (Q19 (a))", async () => {
  const actor = actorWithEffects([sourcedCondition("net", "restrained", "uuid:Actor.hunter", "action:net"),
    sourcedCondition("web", "restrained", "uuid:Actor.mage", "action:web")]);
  const escape = {type: "conditionEffect", conditionId: "restrained", levels: -1, action: "delete", definition: {}, metadata: {effectId: "web"}};
  assert.equal((await commitConditionEffectMutationPlan(actor, escape)).ok, true);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["net"]);
  await commitConditionEffectMutationPlan(actor, escape);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["net"], "the web's hold already gone: the Net's is not ended in its place");
});

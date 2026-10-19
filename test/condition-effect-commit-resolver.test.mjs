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
    async delete() {
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
  assert.deepEqual(actor.effects[0].duration, {value: 1, units: "rounds", expiry: "turnStart"});
  assert.equal(actor.effects[0].flags.wildpath.conditionEffect.duration.expiry, "sourceTurnStart");
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
  assert.equal((await commitConditionEffectMutationPlan(actor, removal("blinded", false))).ok, true, "a condition it lacks: nothing to do");
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {
  commitConditionEffectMutationPlan,
  rollbackConditionEffectMutationPlan
} from "../module/resolvers/condition-effect-commit-resolver.mjs";

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

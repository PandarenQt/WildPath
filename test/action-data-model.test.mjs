import {test} from "node:test";
import assert from "node:assert/strict";

class Field {
  constructor(options={}) {
    this.options = options;
  }
}

class SchemaField extends Field {
  constructor(fields={}, options={}) {
    super(options);
    this.fields = fields;
  }
}

class ArrayField extends Field {
  constructor(element, options={}) {
    super(options);
    this.element = element;
  }
}

class TypeDataModel {
  static defineSchema() {
    return {};
  }

  static migrateData(source) {
    return source;
  }
}

globalThis.foundry = {
  abstract: {TypeDataModel},
  data: {
    fields: {
      SchemaField,
      NumberField: Field,
      StringField: Field,
      ArrayField,
      SetField: ArrayField,
      BooleanField: Field,
      ObjectField: Field,
      HTMLField: Field
    }
  }
};

test("WildPathAction DataModel persists a composed ActionDefinition field", async () => {
  const {default: WildPathAction} = await import("../module/data/item/action.mjs");
  const schema = WildPathAction.defineSchema();

  assert.equal(schema.definition instanceof SchemaField, true);
  assert.equal(schema.definition.fields.schemaVersion instanceof Field, true);
  assert.equal(schema.definition.fields.damage instanceof ArrayField, true);
  assert.equal(schema.definition.fields.ruleElements instanceof ArrayField, true);
  assert.equal(schema.definition.fields.attack instanceof Field, true);
});

test("WildPathBaseActor DataModel persists canonical defense baselines for runtime combat statistics", async () => {
  const {default: WildPathBaseActor} = await import("../module/data/actor/base.mjs");
  const schema = WildPathBaseActor.defineSchema();

  assert.equal(schema.defenses instanceof SchemaField, true);
  assert.equal(schema.defenses.fields.ac instanceof SchemaField, true);
  assert.equal(schema.defenses.fields.ac.fields.value instanceof Field, true);
  assert.equal(schema.defenses.fields.ac.fields.value.options.initial, null, "blank: worked out from armor and Agility");
  assert.equal(schema.defenses.fields.ac.fields.value.options.nullable, true);
});

test("WildPathAction translates persisted definition costs before legacy cost shortcuts", async () => {
  const {default: WildPathAction} = await import("../module/data/item/action.mjs");
  const system = Object.create(WildPathAction.prototype);
  Object.assign(system, {
    definition: {
      schemaVersion: 1,
      id: "action:quick-step",
      costs: {allOf: [{capability: "bonus-action", amount: 1}]}
    },
    cost: {action: 1, bonus: 0, reaction: 0, movement: 0, custom: []}
  });
  system.parent = {
    id: "item-quick-step",
    uuid: "Item.item-quick-step",
    type: "action",
    name: "Quick Step",
    system
  };

  const definition = system.getActionDefinition();

  assert.equal(definition.ok, true);
  assert.equal(definition.migrated, false);
  assert.deepEqual(system.getActivationCost(), {
    allOf: [{capability: "bonus-action", amount: 1, unit: null}]
  });
});

test("WildPathAction keeps legacy cost shortcuts when no definition is authored", async () => {
  const {default: WildPathAction} = await import("../module/data/item/action.mjs");
  const system = Object.create(WildPathAction.prototype);
  Object.assign(system, {
    definition: {
      schemaVersion: 1,
      id: "",
      costs: {},
      damage: [],
      healing: [],
      effects: [],
      ruleElements: [],
      metadata: {}
    },
    cost: {action: 1, bonus: 0, reaction: 0, movement: 0, custom: []}
  });
  system.parent = {
    id: "item-legacy",
    uuid: "Item.item-legacy",
    type: "action",
    name: "Legacy Action",
    system
  };

  const definition = system.getActionDefinition();

  assert.equal(definition.ok, true);
  assert.equal(definition.migrated, true);
  assert.deepEqual(system.getActivationCost(), {
    allOf: [{capability: "action", amount: 1}]
  });
});

test("a character keeps Heroic Inspiration as a pool of 4; the old checkbox counts as one point (BG3, G8)", async () => {
  const {default: WildPathCharacter} = await import("../module/data/actor/character.mjs");
  const pool = source => source.pools.find(entry => entry.id === "heroic-inspiration");
  const old = WildPathCharacter.migrateData({heroicInspiration: true, pools: [{id: "hit-die.d10", value: 2}]});
  assert.deepEqual([pool(old).value, pool(old).base, pool(old).max, "heroicInspiration" in old], [1, 4, 4, false]);
  assert.equal(pool(WildPathCharacter.migrateData({heroicInspiration: false, pools: []})).value, 0);
  assert.equal(pool(WildPathCharacter.migrateData({})).value, 0, "a new character starts with the pool");
  const kept = WildPathCharacter.migrateData({pools: [{id: "heroic-inspiration", base: 4, value: 3}]});
  assert.deepEqual(kept.pools.map(entry => entry.value), [3], "an existing pool is left alone");
  assert.equal(WildPathCharacter.migrateData({resources: {}}, {partial: true}).pools, undefined, "a partial update gains no pools");
});

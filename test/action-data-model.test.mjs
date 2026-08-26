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

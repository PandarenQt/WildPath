import {readFileSync} from "node:fs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";

const RESERVED_ACTIVE_EFFECT_SUBTYPES = new Set(["base"]);

class FakeDataField {
  constructor(...args) {
    this.args = args;
  }
}

class FakeSchemaField extends FakeDataField {
  constructor(fields={}, options={}) {
    super(fields, options);
    this.fields = fields;
    this.options = options;
  }
}

class FakeArrayField extends FakeDataField {
  constructor(element, options={}) {
    super(element, options);
    this.element = element;
    this.options = options;
  }
}

class FakeActiveEffectTypeDataModel {
  static defineSchema() {
    return {
      changes: new FakeArrayField(new FakeSchemaField({
        type: new FakeDataField({required: true}),
        phase: new FakeDataField({required: true}),
        priority: new FakeDataField({required: true, integer: true})
      }))
    };
  }
}

function readProjectText(path) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

function activeEffectManifestTypes() {
  const manifest = JSON.parse(readProjectText("system.json"));
  return Object.keys(manifest.documentTypes?.ActiveEffect ?? {}).sort();
}

function activeEffectDataModelKeys() {
  const source = readProjectText("wildpath.mjs");
  const match = source.match(/CONFIG\.ActiveEffect\.dataModels\s*=\s*\{(?<body>[\s\S]*?)\n\s*\};/u);
  assert.ok(match?.groups?.body, "wildpath.mjs should register CONFIG.ActiveEffect.dataModels");
  return [...match.groups.body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)]
    .map(entry => entry[1])
    .sort();
}

function activeEffectDefaultType() {
  const source = readProjectText("wildpath.mjs");
  const match = source.match(/CONFIG\.ActiveEffect\.defaultType\s*=\s*"([^"]+)"/u);
  assert.ok(match, "wildpath.mjs should set CONFIG.ActiveEffect.defaultType");
  return match[1];
}

function installFoundryDataModelStub() {
  const previousFoundry = globalThis.foundry;
  globalThis.foundry = {
    data: {
      ActiveEffectTypeDataModel: FakeActiveEffectTypeDataModel,
      fields: {
        SchemaField: FakeSchemaField,
        NumberField: FakeDataField,
        StringField: FakeDataField,
        ArrayField: FakeArrayField,
        SetField: FakeDataField,
        BooleanField: FakeDataField,
        ObjectField: FakeDataField
      }
    }
  };
  return () => {
    if ( previousFoundry === undefined ) delete globalThis.foundry;
    else globalThis.foundry = previousFoundry;
  };
}

test("WildPath manifest does not register reserved ActiveEffect subtypes", () => {
  const activeEffectTypes = activeEffectManifestTypes();

  assert.deepEqual(activeEffectTypes, ["condition", "effect"]);
  assert.equal(activeEffectTypes.some(type => RESERVED_ACTIVE_EFFECT_SUBTYPES.has(type)), false);
});

test("ActiveEffect runtime data model registration matches the manifest", () => {
  const activeEffectTypes = activeEffectManifestTypes();
  const dataModelKeys = activeEffectDataModelKeys();
  const defaultType = activeEffectDefaultType();

  assert.deepEqual(dataModelKeys, activeEffectTypes);
  assert.equal(defaultType, "effect");
  assert.equal(activeEffectTypes.includes(defaultType), true);
  assert.equal(RESERVED_ACTIVE_EFFECT_SUBTYPES.has(defaultType), false);
});

test("WildPath ActiveEffect data models preserve inherited V14 changes schema", async () => {
  const restoreFoundry = installFoundryDataModelStub();
  try {
    const {default: WildPathBaseEffect} = await import("../module/data/active-effect/base.mjs");
    const {default: WildPathConditionEffect} = await import("../module/data/active-effect/condition.mjs");

    assert.equal(Object.getPrototypeOf(WildPathBaseEffect), FakeActiveEffectTypeDataModel);
    assert.equal(WildPathConditionEffect.prototype instanceof WildPathBaseEffect, true);

    const baseSchema = WildPathBaseEffect.defineSchema();
    assert.ok(baseSchema.changes, "generic ActiveEffect schema should keep inherited changes");
    assert.ok(baseSchema.changes.element.fields.type, "changes entries should keep Foundry change type");
    assert.ok(baseSchema.changes.element.fields.phase, "changes entries should keep Foundry change phase");
    assert.ok(baseSchema.changes.element.fields.priority, "changes entries should keep Foundry change priority");
    assert.ok(baseSchema.modifiers, "generic ActiveEffect schema should keep WildPath modifiers");
    assert.ok(baseSchema.ruleElements, "generic ActiveEffect schema should keep WildPath ruleElements");

    const conditionSchema = WildPathConditionEffect.defineSchema();
    assert.ok(conditionSchema.changes, "condition ActiveEffect schema should inherit changes");
    assert.ok(conditionSchema.modifiers, "condition ActiveEffect schema should inherit WildPath modifiers");
    assert.ok(conditionSchema.ruleElements, "condition ActiveEffect schema should inherit WildPath ruleElements");
    assert.ok(conditionSchema.type, "condition ActiveEffect schema should add condition type");
    assert.ok(conditionSchema.level, "condition ActiveEffect schema should add condition level");
    assert.ok(conditionSchema.dot, "condition ActiveEffect schema should preserve legacy dot data");
  } finally {
    restoreFoundry();
  }
});

test("WildPath status effects create condition ActiveEffects", () => {
  const source = readProjectText("wildpath.mjs");

  assert.match(source, /CONFIG\.statusEffects\s*=\s*Object\.values\(WILDPATH\.CONDITIONS\)\.map\(c\s*=>\s*\(\{[\s\S]*type:\s*"condition"/u);
  assert.match(source, /system:\s*\{[\s\S]*type:\s*c\.id[\s\S]*level:\s*null/u);
});

test("WildPath startup uses V14 sheet registration API instead of deprecated globals", () => {
  const source = readProjectText("wildpath.mjs");
  const registrations = source.match(/DocumentSheetConfig\.registerSheet\(/gu) ?? [];

  assert.doesNotMatch(source, /\bActors\.registerSheet\(/u);
  assert.doesNotMatch(source, /\bItems\.registerSheet\(/u);
  assert.equal(registrations.length, 2);
  assert.match(source, /DocumentSheetConfig\.registerSheet\(WildPathActor,\s*"wildpath",\s*WildPathActorSheet/u);
  assert.match(source, /DocumentSheetConfig\.registerSheet\(WildPathItem,\s*"wildpath",\s*WildPathItemSheet/u);
});

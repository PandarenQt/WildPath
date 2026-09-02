import {readFileSync} from "node:fs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";

const RESERVED_ACTIVE_EFFECT_SUBTYPES = new Set(["base"]);

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

test("WildPath status effects create condition ActiveEffects", () => {
  const source = readProjectText("wildpath.mjs");

  assert.match(source, /CONFIG\.statusEffects\s*=\s*Object\.values\(WILDPATH\.CONDITIONS\)\.map\(c\s*=>\s*\(\{[\s\S]*type:\s*"condition"/u);
  assert.match(source, /system:\s*\{[\s\S]*type:\s*c\.id[\s\S]*level:\s*null/u);
});

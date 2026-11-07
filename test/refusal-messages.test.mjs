import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import test from "node:test";
import {ACTION_CONFIGURATION_CODES} from "../module/helpers/action-configuration.mjs";
import {ACTION_DEFINITION_CODES} from "../module/helpers/action-definitions.mjs";
import {ACTION_RESULT_CODES} from "../module/helpers/action-resolution.mjs";
import {refusalMessage} from "../module/helpers/refusal-messages.mjs";
import {RESOLUTION_PIPELINE_CODES} from "../module/helpers/resolution-state.mjs";

const root = new URL("../", import.meta.url);
const lang = JSON.parse(readFileSync(new URL("lang/en.json", root), "utf8"));
const lookup = key => key.split(".").reduce((node, part) => node?.[part], lang);
// A GM sees an unknown reason itself, so any code without words comes back marked as raw.
const gm = {user: {isGM: true}, i18n: {
  localize: key => (typeof lookup(key) === "string" ? lookup(key) : `MISSING ${key}`),
  format: (key, {reason}) => `RAW ${reason}`
}};

/** Every code a resolver can fail with: each resolver's own, and the helpers' the pipeline passes on as its reason. */
async function failureCodes() {
  const enums = {ACTION_CONFIGURATION_CODES, ACTION_DEFINITION_CODES, ACTION_RESULT_CODES, RESOLUTION_PIPELINE_CODES};
  for ( const file of readdirSync(new URL("module/resolvers/", root)).filter(name => name.endsWith(".mjs")) ) {
    const exports = await import(new URL(`module/resolvers/${file}`, root));
    for ( const [name, value] of Object.entries(exports) ) if ( name.endsWith("_CODES") ) enums[name] = value;
  }
  const notFailures = new Set(["OK", "WAITING", "COMPLETED"]);
  return new Set(Object.values(enums).flatMap(codes => Object.values(codes)).filter(code => !notFailures.has(code)));
}

test("a resolver's failure code reaches a player in words from lang/en.json, and the GM as words or the code itself", async () => {
  const codes = await failureCodes();
  assert.ok(codes.size > 100, `found only ${codes.size} codes`);
  const player = {...gm, user: {isGM: false}};
  for ( const code of codes ) {
    const error = {code: "FAILED", reason: code};
    assert.doesNotMatch(refusalMessage(error, player), /^(?:RAW|MISSING) /u, code);
    assert.doesNotMatch(refusalMessage(error, gm), /^MISSING /u, code);
  }
});

test("a fault its user can't fix reaches the GM as its code; a known wrapper code wins over the code it wraps", () => {
  assert.equal(refusalMessage({code: "SAVE_FAILED", reason: "INVALID_STAGE_RESULT"}, gm), "RAW INVALID_STAGE_RESULT");
  // The payment stage wraps the resource resolver's COMMIT_FAILED (the chosen resource is short), not a failed write.
  assert.equal(refusalMessage({code: "PAYMENT_UNAVAILABLE", reason: "COMMIT_FAILED"}, gm), lang.WILDPATH.NOTIFY.PaymentUnavailable);
});

test("a save with no DC (a caster with no spellcasting ability) says so instead of MISSING_DC", () => {
  assert.equal(refusalMessage({code: "SAVE_FAILED", reason: "MISSING_DC"}, gm), lang.WILDPATH.REFUSAL.NoSaveDC);
  assert.equal(refusalMessage({code: "MISSING_DC"}, {...gm, user: {isGM: false}}), lang.WILDPATH.REFUSAL.NoSaveDC);
  // A reason that is no code, even one named like an Object method, still reaches the GM as it is.
  assert.equal(refusalMessage({code: "SAVE_FAILED", reason: "toString"}, gm), "RAW toString");
});

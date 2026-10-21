import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import {WILDPATH} from "../module/config.mjs";

const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const lookup = key => key.split(".").reduce((node, part) => node?.[part], lang);
const format = (key, data={}) => String(lookup(key) ?? key).replace(/\{(\w+)\}/gu, (_, name) => data[name] ?? "");

function withGlobals(t) {
  const previous = {game: globalThis.game, CONFIG: globalThis.CONFIG};
  globalThis.game = {i18n: {localize: key => format(key), format}};
  globalThis.CONFIG = {WILDPATH};
  t.after(() => Object.assign(globalThis, previous));
}

const bonus = {schemaVersion: 1, id: "bonus", type: "Modifier", data: {domains: ["attack.melee"], value: 1}};
const aura = {schemaVersion: 1, id: "aura", type: "Aura", data: {radius: 10, affects: "allies", ruleElements: [
  {schemaVersion: 1, id: "ward", type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]}};

test("rule rows are named by list and index, an aura's own rules under it", async t => {
  withGlobals(t);
  const {ruleRowsContext} = await import("../module/applications/rule-rows.mjs");
  const {rows} = ruleRowsContext([bonus, aura], {prefix: "wildpath.rules", list: "item"});
  assert.deepEqual(rows.map(row => [row.name, row.kind]), [["wildpath.rules.0", "bonus"], ["wildpath.rules.1", "aura"]]);
  assert.equal(rows[0].isBonus, true);
  assert.equal(rows[1].rules[0].name, "wildpath.rules.1.rules.0", "the aura's rule is named under it");
  assert.equal(rows[1].rules[0].path, "1.0");
});

test("a draft's typed values and errors show on their rows", async t => {
  withGlobals(t);
  const {ruleRowsContext} = await import("../module/applications/rule-rows.mjs");
  const {rows} = ruleRowsContext([bonus], {prefix: "wildpath.rules", list: "item", draft: {0: {amount: "2 * prof +"}},
    errors: [{field: "wildpath.rules.0.amount", key: "Unexpected", data: {token: "+"}}]});
  assert.equal(rows[0].amount, "2 * prof +", "what was typed stays");
  assert.equal(typeof rows[0].errors.amount, "string");
  assert.doesNotMatch(rows[0].errors.amount, /^WILDPATH\./u, "the error is in words");
});

test("a statistic is named in words, and every choice a rule row offers has copy", async t => {
  withGlobals(t);
  const {ruleRowsContext} = await import("../module/applications/rule-rows.mjs");
  const {rows, ctx} = ruleRowsContext([bonus], {prefix: "wildpath.rules", list: "item"});
  const domains = rows[0].appliesToChoices;
  assert.equal(domains["attack.melee"], lookup("WILDPATH.RULES.Domain.attackMelee"));
  assert.equal(domains["save.agility"], format("WILDPATH.RULES.Domain.saveOf", {ability: format(WILDPATH.ABILITIES.agility.label)}));
  const labels = Object.entries(ctx).filter(([name]) => !["list", "editable", "recharge"].includes(name))
    .flatMap(([, choices]) => Object.values(choices)).filter(label => typeof label === "string" && label.startsWith("WILDPATH."));
  assert.ok(labels.length > 50);
  assert.deepEqual(labels.filter(label => typeof lookup(label) !== "string"), []);
  assert.deepEqual(ctx.recharge.map(entry => entry.value), ["", 6, 5, 4, 3, 2], "No recharge first, then 6 down to 2");
});

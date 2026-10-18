import {test} from "node:test";
import assert from "node:assert/strict";
import {WILDPATH} from "../module/config.mjs";
import {addRule, defaultRule, removeRule, ruleGaps, ruleIssues, rowsToRules, rulesToRows} from "../module/helpers/rule-builder.mjs";
import {collectRuleElementContributions} from "../module/helpers/rule-elements.mjs";

const abilities = Object.keys(WILDPATH.ABILITIES);
const form = rows => Object.fromEntries(rows.map((row, index) => [index, {...row, rules: row.rules.length ? form(row.rules) : undefined}]));

/** Submit the rows of `rules` with `changes` (index → fields) applied. */
function submit(rules, changes) {
  const rows = form(rulesToRows(rules, {abilities}));
  for ( const [index, fields] of Object.entries(changes) ) Object.assign(rows[index], fields);
  return rowsToRules(rows, rules, {abilities});
}

test("an unchanged form gives back every condition's rules exactly", () => {
  for ( const [id, condition] of Object.entries(WILDPATH.CONDITIONS) ) {
    const rules = condition.ruleElements ?? [];
    const result = rowsToRules(form(rulesToRows(rules, {abilities})), rules, {abilities});
    assert.equal(result.changed, false, id);
    assert.equal(result.ruleElements, rules, id);
  }
});

test("the release examples are rows: Rage damage, a once-per-turn rider, an AC aura and Spirit Points", () => {
  let rules = addRule([], "bonus");
  rules = submit(rules, {0: {appliesTo: "damage.melee", amount: "2", while: "raging"}}).ruleElements;
  assert.deepEqual(rules[0], {schemaVersion: 1, id: "rule-1", type: "Modifier", predicate: {hasCondition: "raging"},
    data: {domains: ["damage.melee"], value: 2, modifierType: "untyped"}});

  rules = addRule(rules, "extraDamage");
  assert.deepEqual(rules[1].data, {domains: ["damage.melee"], expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", once: "turn"});

  rules = addRule(rules, "aura");
  assert.deepEqual(rules[2].data, {radius: 10, affects: "allies", ruleElements: [{schemaVersion: 1, id: "rule-3-1", type: "Modifier",
    data: {domains: ["defense.ac"], value: 1, modifierType: "untyped"}}]});

  rules = addRule(rules, "resource");
  rules = submit(rules, {3: {resourceId: "spirit-points", resourceLabel: "Spirit Points", maximum: "2 * prof", recovery: "longRest"}}).ruleElements;
  assert.deepEqual(rules[3].data, {resourceId: "spirit-points", label: "Spirit Points", recovery: "longRest",
    maximum: {type: "multiply", terms: [{type: "constant", value: 2}, {type: "proficiency-bonus"}]}});

  assert.deepEqual(ruleIssues(rules), []);
  const raging = collectRuleElementContributions({ruleElements: rules, context: {conditions: ["raging"], actorSystem: {attributes: {prof: 2}}}});
  assert.equal(raging.contributions.modifiers.find(modifier => modifier.id === "rule-1").value, 2);
  assert.equal(raging.contributions.auras.length, 1);
  assert.equal(raging.contributions.extraDamage[0].once, "turn");
});

test("a changed field is written into the rule's data; what the row does not show survives", () => {
  const stored = [{id: "ward", type: "Modifier", label: "Ward", priority: 50, domains: ["defense.ac"], value: 1, metadata: {note: "kept"}}];
  const result = submit(stored, {0: {amount: "3"}});
  assert.deepEqual(result.ruleElements[0], {id: "ward", type: "Modifier", label: "Ward", priority: 50, metadata: {note: "kept"},
    domains: ["defense.ac"], data: {value: 3}}, "the root value no longer overrides the written one");
  const level = submit(stored, {0: {amount: "level / 2"}}).ruleElements[0];
  assert.deepEqual(level.data, {valueExpression: {type: "divide", numerator: {type: "character-level"}, denominator: {type: "constant", value: 2},
    round: "floor"}});
  assert.equal(submit(stored, {0: {appliesTo: "save.agility"}}).ruleElements[0].data.domains[0], "save.agility");
});

test("unreadable text is an error on its field, and nothing is written", () => {
  const stored = [defaultRule("bonus", "a"), defaultRule("extraDamage", "b")];
  const bad = submit(stored, {0: {amount: "1d4"}, 1: {formula: "1d6 + nope"}});
  assert.equal(bad.changed, false);
  assert.equal(bad.ruleElements, stored);
  assert.deepEqual(bad.errors.map(error => [error.field, error.key]), [["rules.0.amount", "DiceNotAllowed"], ["rules.1.formula", "UnknownWord"]]);
});

test("changing a row's kind gives a fresh valid rule; a lasting condition gate is kept", () => {
  const stored = [{...defaultRule("bonus", "a"), predicate: {hasCondition: "raging"}}];
  const resisted = submit(stored, {0: {kind: "resistance"}}).ruleElements[0];
  assert.deepEqual(resisted, {schemaVersion: 1, id: "a", type: "GrantResistance", data: {damageTypes: ["fire"]}, predicate: {hasCondition: "raging"}});
  const types = submit([resisted], {0: {damageTypes: "Bludgeoning, piercing,slashing"}}).ruleElements[0];
  assert.deepEqual(types.data.damageTypes, ["bludgeoning", "piercing", "slashing"]);
  assert.equal("predicate" in submit([resisted], {0: {while: ""}}).ruleElements[0], false);
  const immune = submit([defaultRule("conditionImmunity", "b")], {0: {conditions: "Charmed, frightened"}}).ruleElements[0];
  assert.deepEqual(immune, {schemaVersion: 1, id: "b", type: "ConditionImmunity", data: {conditions: ["charmed", "frightened"]}});
  assert.deepEqual(ruleIssues([immune]), []);
});

test("an aura's own rules are rows too, and can be added and removed by path", () => {
  let rules = [defaultRule("aura", "aura")];
  const rows = form(rulesToRows(rules, {abilities}));
  rows[0].radius = 30;
  rows[0].rules[0].amount = "2";
  rules = rowsToRules(rows, rules, {abilities}).ruleElements;
  assert.equal(rules[0].data.radius, 30);
  assert.equal(rules[0].data.ruleElements[0].data.value, 2);
  rules = addRule(rules, "rollMode", [0]);
  assert.deepEqual(rules[0].data.ruleElements.map(rule => rule.type), ["Modifier", "RollMode"]);
  assert.deepEqual(ruleIssues(rules), []);
  rules = removeRule(rules, 0, [0]);
  assert.deepEqual(rules[0].data.ruleElements.map(rule => rule.type), ["RollMode"]);
  assert.deepEqual(removeRule(rules, 0).length, 0);
});

test("rules a row cannot show stay read-only; their issues are named", () => {
  const trigger = {id: "t", type: "Trigger", data: {event: "turn.started"}};
  const custom = {id: "c", type: "Modifier", data: {domains: ["defense.ac", "save"], value: 1}};
  const rows = rulesToRows([trigger, custom], {abilities});
  assert.equal(rows[0].kind, "other");
  assert.deepEqual([rows[1].appliesTo, rows[1].appliesToText], ["", "defense.ac, save"]);
  const result = submit([trigger, custom], {1: {amount: "2"}});
  assert.deepEqual(result.ruleElements[0], trigger);
  assert.deepEqual(result.ruleElements[1].data.domains, ["defense.ac", "save"]);
  assert.deepEqual(ruleIssues([{id: "x", type: "Modifier", data: {value: 1}}]).map(issue => issue.index), [0]);
  assert.match(ruleIssues([{id: "y", type: "Nope"}])[0].text, /Unknown RuleElement type/);
});

test("resource rows set where a pool starts, emptying each turn, Recharge and a partial regain; named \"while\" conditions", () => {
  const breath = {id: "b", type: "GrantResource", data: {resourceId: "fire-breath", label: "Fire Breath", maximum: 1, recovery: "none", recharge: 5}};
  const pool = {id: "p", type: "GrantResource", data: {resourceId: "extra-attack", label: "Extra Attack", maximum: 1, current: 0,
    recovery: "none", emptiesAtTurnStart: true}};
  const wand = {id: "w", type: "GrantResource", data: {resourceId: "wand", label: "Wand", maximum: 7, recovery: "none",
    regain: {longRest: {type: "add", terms: [{type: "dice", number: 1, faces: 6}, {type: "constant", value: 1}]}}}};
  const magic = {id: "m", type: "RollMode", data: {domains: ["save"], mode: "advantage"}, predicate: {tagsAny: ["magical"]}};
  const rules = [breath, pool, wand, magic];
  assert.deepEqual(ruleGaps(rules, {abilities}), [], "the rows can rebuild all four");
  const rows = rulesToRows(rules, {abilities});
  assert.deepEqual([rows[0].recharge, rows[1].current, rows[1].emptiesAtTurnStart, rows[2].regainLong, rows[3].while],
    [5, 0, true, "1d6 + 1", "@magical"]);
  assert.equal(submit(rules, {}).changed, false);
  const result = submit(rules, {0: {recharge: "6"}, 1: {emptiesAtTurnStart: false, current: ""}, 2: {regainShort: "1", regainLong: ""},
    3: {while: "@allyNearTarget"}});
  assert.equal(result.ruleElements[0].data.recharge, 6);
  assert.deepEqual([result.ruleElements[1].data.emptiesAtTurnStart, result.ruleElements[1].data.current], [undefined, undefined]);
  assert.deepEqual(result.ruleElements[2].data.regain, {shortRest: 1});
  assert.deepEqual(result.ruleElements[3].predicate, {equals: {path: "attack.allyNearTarget", value: true}});
  assert.deepEqual(ruleGaps([{id: "t", type: "Trigger", data: {}}, {id: "h", type: "GrantMovement", data: {mode: "fly", distance: 30, hover: true}},
    {id: "s", type: "RollMode", data: {domains: ["check.perception"], mode: "advantage"}}], {abilities}),
  ["GrantMovement.hover", "RollMode.domains", "Trigger"], "what the rows cannot rebuild is named");
});

test("a rule only Advanced can edit survives a form that posts nothing for it, wherever it stands (no data loss)", () => {
  const pool = {id: "pool", type: "GrantResource", data: {resourceId: "extra-attack", label: "Extra Attack", maximum: 1, recovery: "none"}};
  const extra = {id: "extra", type: "ExtraAttack", data: {resourceId: "extra-attack"}};
  const [poolRow] = rulesToRows([pool], {abilities});
  // Extra Attack's feature: the pool's row is posted, the ExtraAttack rule shows no inputs.
  const after = rowsToRules({0: {...poolRow, maximum: "2"}}, [pool, extra], {abilities});
  assert.deepEqual(after.ruleElements.map(rule => rule.id), ["pool", "extra"]);
  assert.equal(after.ruleElements[0].data.maximum, 2);
  assert.deepEqual(after.ruleElements[1], extra);
  const before = rowsToRules({1: {...poolRow, maximum: "3"}}, [extra, pool], {abilities});
  assert.deepEqual(before.ruleElements[0], extra, "rows stay matched by their index");
  assert.equal(before.ruleElements[1].data.maximum, 3);
});

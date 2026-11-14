import {test} from "node:test";
import assert from "node:assert/strict";
import {
  VALUE_EXPRESSION_CODES,
  evaluateValueExpression,
  evaluateValueExpressionNumber
} from "../module/helpers/value-expressions.mjs";

const context = {
  actorSystem: {
    abilities: {
      might: {value: 18},
      wits: {value: 9}
    },
    details: {level: 9},
    classes: {
      fighter: {level: 5}
    },
    resources: {
      health: {value: 12, max: 20}
    },
    pools: [
      {id: "focus", value: 1, max: 3}
    ],
    spellcasting: {ability: "might"}
  }
};

test("ValueExpression evaluates actor-derived values without JavaScript formulas", () => {
  assert.equal(evaluateValueExpression({type: "ability-score", ability: "might"}, context).value, 18);
  assert.equal(evaluateValueExpression({type: "ability-modifier", ability: "might"}, context).value, 4);
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, context).value, 4);
  assert.equal(evaluateValueExpression({type: "character-level"}, context).value, 9);
  assert.equal(evaluateValueExpression({type: "class-level", class: "fighter"}, context).value, 5);
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, context).value, 4);
});

test("ValueExpression resolves resource current and max values for built-in and custom pools", () => {
  assert.equal(evaluateValueExpression({type: "resource-current", resource: "health"}, context).value, 12);
  assert.equal(evaluateValueExpression({type: "resource-max", resource: "health"}, context).value, 20);
  assert.equal(evaluateValueExpression({type: "resource-current", resource: "focus"}, context).value, 1);
  assert.equal(evaluateValueExpression({type: "resource-max", resource: "focus"}, context).value, 3);
});

test("ValueExpression supports safe arithmetic composition", () => {
  const expression = {
    type: "floor",
    value: {
      type: "divide",
      numerator: {
        type: "subtract",
        terms: [
          {type: "resource-max", resource: "health"},
          {type: "resource-current", resource: "health"}
        ]
      },
      denominator: {type: "constant", value: 3}
    }
  };

  assert.equal(evaluateValueExpression(expression, context).value, 2);
});

test("ValueExpression can represent dice safely with explicit total or average mode", () => {
  assert.equal(evaluateValueExpression({type: "dice", number: 2, faces: 6, total: 7}, context).value, 7);
  assert.equal(evaluateValueExpression({
    type: "dice",
    number: 2,
    faces: 6,
    bonus: {type: "ability-modifier", ability: "might"},
    evaluation: "average"
  }, context).value, 11);

  const unresolved = evaluateValueExpression({type: "dice", number: 1, faces: 8}, context);
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.code, VALUE_EXPRESSION_CODES.INVALID_EXPRESSION);
});

test("ValueExpression numeric wrapper returns fallback for unresolved expressions", () => {
  const value = evaluateValueExpressionNumber({type: "resource-current", resource: "missing"}, context, 99);
  assert.equal(value, 99);
});


test("a table ValueExpression steps by its key, e.g. a class level, with a default below its first row", () => {
  const sneak = {type: "table", key: {type: "class-level", class: "rogue"}, rows: {1: 1, 3: 2, 5: 3}};
  const at = level => evaluateValueExpression(sneak, {classLevels: [{slug: "rogue", level}]});
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(level => at(level).value), [1, 1, 2, 2, 3, 3]);
  assert.equal(evaluateValueExpression({...sneak, key: 0}).ok, false, "no row at or below the key and no default");
  assert.equal(evaluateValueExpression({...sneak, key: 0, default: 0}).value, 0);
  assert.equal(evaluateValueExpression({type: "table", key: 2, rows: {1: {type: "add", terms: [1, 1]}}}).value, 2,
    "rows may themselves be expressions");
});

test("ActionDefinition validation accepts a table ValueExpression and rejects one without numeric rows or a key", async () => {
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const strike = expression => ({schemaVersion: 1, id: "action:t", label: "T", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    damage: [{id: "d", expression, damageType: "fire"}]});
  assert.equal(validateActionDefinition(strike({type: "table", key: {type: "character-level"}, rows: {1: 2, 5: 4}})).ok, true);
  assert.equal(validateActionDefinition(strike({type: "table", key: 3, rows: {one: 2}})).ok, false);
  assert.equal(validateActionDefinition(strike({type: "table", rows: {1: 2}})).ok, false);
});

test("a class-based caster's source snapshot: level from its classes, spellcasting from its spellcasting class", () => {
  // The authority reads source data: `details.level` is the stored default, and `spellcasting` is not prepared.
  const snapshot = {actorSystem: {abilities: {intellect: {value: 16}}, details: {level: 1},
    classes: [{id: "wizard", name: "Wizard", level: 5, original: true, spellcasting: {progression: "full", ability: "intellect"}}]}};
  assert.equal(evaluateValueExpression({type: "character-level"}, snapshot).value, 5);
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, snapshot).value, 3);
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, snapshot).value, 3);
  const dc = {type: "add", terms: [{type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]};
  assert.equal(evaluateValueExpression(dc, snapshot).value, 14, "a 5th-level wizard with Intellect 16 has spell save DC 14");
});

test("a spellcasting ability that is not one of the creature's abilities (a hand-edited 'wis') is warned about by name, once", t => {
  const warn = t.mock.method(console, "warn", () => {});
  const dc = {type: "add", terms: [{type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]};
  const prepared = {actor: {system: {abilities: {wits: {value: 16}}, details: {level: 5}, spellcasting: {ability: "wis"}}}};
  assert.equal(evaluateValueExpression(dc, prepared).ok, false, "no DC is made up from a key with no score");
  evaluateValueExpression(dc, prepared);
  assert.equal(warn.mock.callCount(), 1, "told once, not on every lookup");
  assert.match(warn.mock.calls[0].arguments[0], /"wis" is not one of the creature's abilities \(wits\)/);
  // A class's own record (a multiclass caster's named class) is checked the same way.
  const record = {actorSystem: {abilities: {presence: {value: 14}},
    classes: [{id: "warlock", name: "Warlock", level: 3, spellcasting: {progression: "pact", ability: "cha"}}]}};
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier", class: "warlock"}, record).ok, false);
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[1].arguments[0], /"cha"/);
  // A known ability, or no creature to read abilities from, is no such fault.
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, {actorSystem: {abilities: {wits: {value: 16}},
    spellcasting: {ability: "wits"}}}).value, 3);
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, {spellcastingAbility: "intellect"}).ok, false);
  assert.equal(warn.mock.callCount(), 2);
  // An authored ability-modifier reads the same lookup.
  assert.equal(evaluateValueExpression({type: "ability-modifier", ability: "str"}, prepared).ok, false);
  assert.equal(warn.mock.callCount(), 3);
  assert.match(warn.mock.calls[2].arguments[0], /"str"/);
});

test("a creature without a character level takes its proficiency bonus from its threat; an effective bonus wins", () => {
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, {actorSystem: {details: {threat: 9}}}).value, 4);
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, {actorSystem: {details: {threat: 9}, proficiencyBonus: 6}}).value, 6);
});

test("a table of dice becomes the row for the creature's level before it is rolled", async () => {
  const {selectTableRows} = await import("../module/helpers/value-expressions.mjs");
  const dice = (number, faces) => ({type: "dice", number, faces});
  const cantrip = {type: "table", key: {type: "character-level"}, rows: {1: dice(1, 10), 5: dice(2, 10), 11: dice(3, 10), 17: dice(4, 10)}};
  const at = level => ({actorSystem: {details: {level}}});
  assert.deepEqual(selectTableRows(cantrip, at(4)), dice(1, 10));
  assert.deepEqual(selectTableRows(cantrip, at(11)), dice(3, 10));
  assert.deepEqual(selectTableRows({type: "add", terms: [cantrip, {type: "constant", value: 2}]}, at(5)),
    {type: "add", terms: [dice(2, 10), {type: "constant", value: 2}]});
  assert.deepEqual(selectTableRows(cantrip, {}), cantrip, "without a level the table stays");
});

test("a table with a default is that default when its key can't be read: Hunter's Mark's d6 for a non-ranger, d10 at ranger 20", async () => {
  const {selectTableRows: rows, evaluateValueExpression: evaluate} = await import("../module/helpers/value-expressions.mjs");
  const fs = await import("node:fs");
  const mark = JSON.parse(fs.readFileSync("packs/_source/srd-items/hunter-s-mark-mark-creature-phbsplHuntersMar.json", "utf8"))
    .system.definition.effects.find(effect => effect.slug === "hunters-mark").ruleElements.find(rule => rule.type === "ExtraDamage");
  const faces = classes => rows(mark.data.expression, {actorSystem: {classes}}).faces;
  assert.deepEqual([faces({ranger: {levels: 20}}), faces({ranger: {levels: 19}}), faces({fighter: {levels: 20}}), faces(undefined)], [10, 6, 6, 6]);
  const table = {type: "table", key: {type: "class-level", class: "warlock"}, rows: {5: 2}, default: 1};
  assert.deepEqual([evaluate(table, {actorSystem: {classes: {}}}).value, evaluate({...table, default: undefined}, {actorSystem: {classes: {}}}).ok],
    [1, false], "no default: still a failure");
});

test("a controller's proficiency bonus (Primal Bond): its companion's controller's, 0 with none", async () => {
  const {evaluateValueExpression} = await import("../module/helpers/value-expressions.mjs");
  assert.equal(evaluateValueExpression({type: "controller-proficiency-bonus"}, {actor: {controllerProficiencyBonus: 4}}).value, 4);
  assert.equal(evaluateValueExpression({type: "controller-proficiency-bonus"}, {actor: {controllerProficiencyBonus: null}}).value, 0, "no controller");
});

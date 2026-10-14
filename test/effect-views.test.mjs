import {test} from "node:test";
import assert from "node:assert/strict";
import {activeEffectViews} from "../module/helpers/effect-views.mjs";
import {WILDPATH} from "../module/config.mjs";

test("a creature's condition icons explain themselves: rules summary, level and time left, then its custom effects", () => {
  const effects = [
    {id: "e1", system: {type: "exhaustion", level: 2}},
    {id: "e2", name: "Dodging", img: "dodge.svg", isTemporary: true, duration: {remaining: 1, label: "1 Round"},
      flags: {wildpath: {conditionEffect: {conditionId: "dodging"}}}},
    {id: "e3", system: {type: "prone"}, isTemporary: true, duration: {remaining: Infinity, label: "None"}},
    {id: "e4", name: "Sheet note", img: "note.svg"},
    {id: "e5", system: {type: "blinded"}, disabled: true}
  ];
  const views = activeEffectViews(effects, Object.values(WILDPATH.CONDITIONS));
  assert.deepEqual(views.map(view => [view.id, view.level, view.summary, view.remaining]), [
    ["prone", null, "WILDPATH.CONDITIONS.Summary.Prone", null],
    ["exhaustion", 2, "WILDPATH.CONDITIONS.Summary.Exhaustion", null],
    ["e2", null, null, "1 Round"]
  ], "an endless duration shows no time; a sheet-made effect and a disabled one are not shown");
  assert.equal(WILDPATH.CONDITIONS_2014.exhaustion.summary, "WILDPATH.CONDITIONS.Summary.Exhaustion2014");
});

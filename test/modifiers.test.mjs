import {test} from "node:test";
import assert from "node:assert/strict";
import {WildPathModifier, WildPathStatistic} from "../module/helpers/modifiers.mjs";

// NOTE: every modifier below supplies an explicit `slug` so the constructor never falls back to
// `label.slugify()`, which is a Foundry client runtime polyfill unavailable under plain Node.

test("WildPathStatistic sums untyped/circumstance modifiers without limit", () => {
  const modifiers = [
    new WildPathModifier({slug: "a", label: "A", type: "untyped", value: 1}),
    new WildPathModifier({slug: "b", label: "B", type: "untyped", value: 2}),
    new WildPathModifier({slug: "c", label: "C", type: "circumstance", value: 3})
  ];
  const statistic = new WildPathStatistic("test.domain", modifiers);
  assert.equal(statistic.totalModifier, 6);
});

test("WildPathStatistic keeps only the highest bonus and lowest penalty per type", () => {
  const modifiers = [
    new WildPathModifier({slug: "item-1", label: "Item 1", type: "item", value: 1}),
    new WildPathModifier({slug: "item-2", label: "Item 2", type: "item", value: 2}),
    new WildPathModifier({slug: "status-1", label: "Status 1", type: "status", value: -1}),
    new WildPathModifier({slug: "status-2", label: "Status 2", type: "status", value: -3})
  ];
  const statistic = new WildPathStatistic("test.domain", modifiers);
  // Only the +2 item bonus and the -3 status penalty should apply: 2 + -3 = -1.
  assert.equal(statistic.totalModifier, -1);
  assert.equal(statistic.applied.length, 2);
});

test("WildPathStatistic de-duplicates by slug, keeping the higher-magnitude enabled instance", () => {
  const modifiers = [
    new WildPathModifier({slug: "rage", label: "Rage", type: "untyped", value: 2}),
    new WildPathModifier({slug: "rage", label: "Rage", type: "untyped", value: 5})
  ];
  const statistic = new WildPathStatistic("test.domain", modifiers);
  assert.equal(statistic.totalModifier, 5);
  assert.equal(statistic.modifiers.length, 1);
});

test("WildPathStatistic ignores disabled modifiers", () => {
  const modifiers = [
    new WildPathModifier({slug: "a", label: "A", type: "untyped", value: 5, enabled: false}),
    new WildPathModifier({slug: "b", label: "B", type: "untyped", value: 1})
  ];
  const statistic = new WildPathStatistic("test.domain", modifiers);
  assert.equal(statistic.totalModifier, 1);
});

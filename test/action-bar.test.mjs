import {test} from "node:test";
import assert from "node:assert/strict";
import {actionBarContext} from "../module/helpers/action-bar-context.mjs";

const action = (id, capability) => ({id, type: "action", name: id, img: `icons/${id}.svg`,
  system: {getActivationCost: () => ({allOf: [{capability, amount: 1}]})}});

function creature({action: actions=1}={}) {
  return {
    name: "Hero", img: "hero.webp",
    items: [action("Strike", "action"), action("Jab", "bonus-action"), {id: "cloak", type: "gear", name: "Cloak"}],
    effects: [{system: {type: "exhaustion", level: 2}}, {system: {type: "prone"}}, {system: {type: "blinded"}, disabled: true}],
    system: {resources: {movement: {value: 30, max: 30}, reaction: {value: 1, max: 1}, bonus: {value: 1, max: 1},
      action: {value: actions, max: 1}}, pools: [{id: "ki", label: "Ki", value: 2, max: 3}]}
  };
}
const conditions = [{id: "prone", name: "Prone", img: "prone.svg"}, {id: "exhaustion", name: "Exhaustion", img: "ex.svg", stacking: true},
  {id: "blinded", name: "Blinded", img: "blind.svg"}];

test("the action bar shows the economy counters first, then pools, and Actions grouped by what they cost", () => {
  const bar = actionBarContext({actor: creature(), conditions});
  assert.deepEqual(bar.resources.map(resource => [resource.id, resource.current, resource.maximum]), [
    ["economy.action", 1, 1], ["economy.bonus-action", 1, 1], ["economy.reaction", 1, 1], ["economy.movement", 30, 30], ["ki", 2, 3]]);
  assert.deepEqual(bar.groups.map(group => [group.id, group.label, group.actions.map(entry => [entry.label, entry.enabled])]), [
    ["action", "WILDPATH.ACTIONBAR.Group.action", [["Strike", true]]],
    ["bonus-action", "WILDPATH.ACTIONBAR.Group.bonus", [["Jab", true]]]], "gear is not an Action");
});

test("a spent Action greys out its Actions with the reason, and the bar shows active conditions with levels", () => {
  const bar = actionBarContext({actor: creature({action: 0}), conditions});
  const strike = bar.groups.find(group => group.id === "action").actions[0];
  assert.deepEqual([strike.enabled, typeof strike.disabledCode], [false, "string"]);
  assert.equal(bar.resources[0].depleted, true);
  assert.deepEqual(bar.conditions.map(condition => [condition.id, condition.level]), [["prone", null], ["exhaustion", 2]],
    "a disabled condition effect is not shown");
});

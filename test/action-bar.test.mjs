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

test("each reaction on the bar shows whether it asks, is used automatically, or never", () => {
  const hero = creature();
  hero.items.push(action("Parry", "reaction"), {...action("Riposte", "reaction"), flags: {wildpath: {reactionPolicy: "always"}}});
  const reactions = actionBarContext({actor: hero, conditions}).groups.find(group => group.id === "reaction").actions;
  assert.deepEqual(reactions.map(entry => [entry.label, entry.policy.id, entry.policy.label]), [
    ["Parry", "ask", "WILDPATH.ACTIONBAR.Policy.Ask"], ["Riposte", "always", "WILDPATH.ACTIONBAR.Policy.Always"]]);
  assert.equal(actionBarContext({actor: hero, conditions}).groups[0].actions[0].policy, undefined, "only reactions have one");
});

test("odds show as a badge, a range over several targets, and one tooltip line per target", async () => {
  const {oddsView} = await import("../module/helpers/action-bar-context.mjs");
  const {d20Chance} = await import("../module/helpers/rolls.mjs");
  assert.equal(d20Chance({modifier: 5, target: 15}), 0.55, "11 faces of 20");
  assert.equal(d20Chance({modifier: 0, target: 30, natural: true}), 0.05, "a natural 20 always hits");
  assert.equal(d20Chance({modifier: 30, target: 10, natural: true}), 0.95, "a natural 1 always misses");
  assert.equal(d20Chance({modifier: 30, target: 10}), 1, "a save has no natural 1");
  assert.equal(d20Chance({modifier: 0, target: 11, rollMode: "advantage"}), 0.75);
  assert.equal(d20Chance({modifier: 0, target: 11, rollMode: "disadvantage"}), 0.25);

  assert.equal(oddsView([]), null);
  const attack = oddsView([{name: "Goblin", kind: "attack", chance: 0.7975, modifier: 4, defense: 14, rollMode: "advantage"}]);
  assert.equal(attack.badge, "80%");
  assert.deepEqual(attack.lines[0], {key: "WILDPATH.ODDS.Hit", mode: "WILDPATH.ODDS.Mode.advantage", ability: null,
    data: {name: "Goblin", chance: 80, modifier: "+4", defense: 14}});
  const saves = oddsView([{name: "Orc", kind: "save", chance: 0.45, modifier: -1, dc: 13, ability: "wits", rollMode: "normal"},
    {name: "Ogre", kind: "save", chance: 1, automatic: true, modifier: 0, dc: 13, ability: "wits", rollMode: "normal"}]);
  assert.equal(saves.badge, "45–100%");
  assert.deepEqual(saves.lines.map(line => [line.key, line.ability, line.data.modifier ?? null]), [
    ["WILDPATH.ODDS.Fails", "WILDPATH.ABILITIES.Wits", "-1"], ["WILDPATH.ODDS.AlwaysFails", "WILDPATH.ABILITIES.Wits", null]]);
});

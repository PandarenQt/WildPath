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

test("an Action an effect caps at 0 (Incapacitated) reads as spent and unavailable, with a tooltip saying why", () => {
  const hero = creature();
  hero.system.resources.action = {value: 0, max: 0};
  hero.system.resources.movement = {value: 5, max: 5};
  hero.system.resourceCaps = {action: 0, movement: 5};
  const resources = new Map(actionBarContext({actor: hero, conditions}).resources.map(resource => [resource.id, resource]));
  assert.deepEqual([resources.get("economy.action").depleted, resources.get("economy.action").capped], [true, true]);
  assert.deepEqual([resources.get("economy.movement").depleted, resources.get("economy.movement").capped], [false, true],
    "a cap above 0 limits the resource but leaves it usable");
  assert.deepEqual([resources.get("economy.bonus-action").depleted, resources.get("economy.bonus-action").capped], [false, false]);
  const wolf = creature();
  wolf.system.resources.movement = {value: 30, max: 30};
  wolf.system.resourceCaps = {movement: 40};
  assert.equal(actionBarContext({actor: wolf, conditions}).resources.find(resource => resource.id === "economy.movement").capped,
    false, "a cap above the Speed (a Werewolf's 40-foot wolf form on a Speed of 30) limits nothing");
  const uncapped = creature();
  uncapped.system.resources.action = {value: 0, max: 0};
  assert.equal(actionBarContext({actor: uncapped, conditions}).resources[0].depleted, false, "a resource it never had is not spent");
});

test("Legendary Resistance's counter shows its setting: Ask by default, the creature's own", () => {
  const dragon = creature();
  dragon.system.pools.push({id: "legendary-resistance", label: "Legendary Resistance", value: 3, max: 3});
  const policy = actor => actionBarContext({actor, conditions}).resources.find(resource => resource.id === "legendary-resistance").policy.id;
  assert.equal(policy(dragon), "ask");
  assert.equal(policy({...dragon, flags: {wildpath: {commonPolicies: {"legendary-resistance": "always"}}}}), "always");
  assert.equal(actionBarContext({actor: dragon, conditions}).resources.find(resource => resource.id === "ki").policy, undefined);
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
  // One it can't fail (Trance) is a 0% chance it fails, not "always fails".
  assert.equal(oddsView([{name: "Elf", kind: "save", chance: 0, automatic: true, modifier: 0, dc: 13, ability: "wits", rollMode: "normal"}])
    .lines[0].key, "WILDPATH.ODDS.Fails");
});

test("a magic item's Action is unavailable while its item is unequipped or not attuned", () => {
  const wand = {id: "wand", type: "gear", name: "Wand", system: {active: false, attunement: "required"}};
  const fireball = {id: "fireball", type: "action", name: "Wand: Fireball", flags: {wildpath: {grantedBy: "wand"}},
    system: {active: true, definition: {schemaVersion: 1, id: "action:fireball", label: "Wand: Fireball",
      costs: {allOf: [{capability: "action", amount: 1}]}}}};
  const actor = {name: "Hero", items: [wand, fireball], effects: [], system: {resources: {action: {value: 1, max: 1},
    bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1}, movement: {value: 30, max: 30}}, pools: []}};
  const entry = () => actionBarContext({actor}).groups.flatMap(group => group.actions).find(action => action.id === "fireball");
  assert.deepEqual([entry().enabled, entry().disabledCode], [false, "ITEM_NOT_READY"]);
  assert.deepEqual(entry().reason, {key: "WILDPATH.ACTIONBAR.Reason.ItemNotReady", name: "Wand"});
  wand.system.active = true;
  assert.equal(entry().enabled, false, "equipped but not attuned");
  wand.system.attunement = "attuned";
  assert.equal(entry().enabled, true);
});

test("an unavailable Action says what has run out", () => {
  const fireball = {id: "fb", type: "action", name: "Fireball", activationCost: {allOf: [{capability: "action", amount: 1},
    {capability: "spell-slot.3", amount: 1}]}};
  const actor = {name: "Hero", items: [fireball], effects: [], system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1},
    reaction: {value: 1, max: 1}, movement: {value: 30, max: 30}}, pools: [{id: "spell-slot.3", label: "3rd-level slot", value: 0, max: 1}]}};
  const entry = () => actionBarContext({actor}).groups.flatMap(group => group.actions).find(action => action.id === "fb");
  assert.deepEqual(entry().reason, {key: "WILDPATH.ACTIONBAR.Reason.Spent", name: "3rd-level slot"});
  actor.system.pools[0].value = 1;
  assert.equal(entry().reason, undefined, "available: no reason");
});

test("spells go by level with a button per slot they can use; magic items' Actions go together", async () => {
  const {readdirSync, readFileSync} = await import("node:fs");
  const read = prefix => JSON.parse(readFileSync(`packs/_source/srd-items/${readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const fireball = {...read("fireball-phb"), id: "fireball"};
  const bolt = {...read("fire-bolt-"), id: "bolt"};
  const wand = {id: "wand", type: "gear", name: "Wand", system: {active: true, attunement: "attuned"}};
  const wandFireball = {...fireball, id: "wand-fireball", flags: {wildpath: {grantedBy: "wand"}}};
  const actor = {name: "Mage", items: [fireball, bolt, wand, wandFireball], effects: [], system: {resources: {action: {value: 1, max: 1},
    bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1}, movement: {value: 30, max: 30}},
    pools: [{id: "spell-slot.3", label: "3rd-level slot", value: 1, max: 2}, {id: "spell-slot.4", label: "4th-level slot", value: 0, max: 1},
      {id: "spell-slot.5", label: "5th-level slot", value: 1, max: 1}]}};
  const groups = actionBarContext({actor}).groups;
  assert.deepEqual(groups.map(group => [group.id, group.actions.map(action => action.id)]),
    [["spell-0", ["bolt"]], ["spell-3", ["fireball"]], ["items", ["wand-fireball"]]]);
  assert.equal(groups[0].label, "WILDPATH.ACTIONBAR.Group.SpellsCantrips");
  assert.deepEqual(groups[1].actions[0].slots.map(slot => [slot.level, slot.choiceId]), [[3, "spell-slot"], [5, "spell-slot"]],
    "a spent 4th-level slot has no button");
  assert.equal(groups[0].actions[0].slots, undefined, "a cantrip spends no slot");
});

test("Steady Aim (SRD) is greyed once its creature has moved this turn (`requires`)", async () => {
  const fs = await import("node:fs");
  const aim = JSON.parse(fs.readFileSync("packs/_source/srd-items/steady-aim-phbrgeSteadyAim0.json", "utf8"));
  const actor = {name: "Rogue", items: [{id: "aim", type: "action", name: aim.name, system: aim.system}], effects: [],
    system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30, spent: 0}}, pools: []}};
  const entry = () => actionBarContext({actor}).groups.flatMap(group => group.actions).find(action => action.id === "aim");
  assert.equal(entry().enabled, true);
  actor.system.resources.movement = {value: 25, max: 30, spent: 5};
  assert.deepEqual([entry().enabled, entry().disabledCode, entry().reason.key], [false, "REQUIRES_NOT_MET", "WILDPATH.ACTIONBAR.Reason.Requires"]);
});

test("Reckless Attack (SRD) is greyed once its creature has made an attack roll this combat turn", async () => {
  const fs = await import("node:fs");
  const reckless = JSON.parse(fs.readFileSync("packs/_source/srd-items/reckless-attack-18a07pfv69929000.json", "utf8"));
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 2, turn: 1, started: true}};
  try {
    const actor = {name: "Barbarian", flags: {}, items: [{id: "reckless", type: "action", name: reckless.name, system: reckless.system}],
      effects: [], system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1},
        movement: {value: 30, max: 30, spent: 0}}, pools: []}};
    const entry = () => actionBarContext({actor}).groups.flatMap(group => group.actions).find(action => action.id === "reckless");
    actor.flags = {wildpath: {attackTurn: "c:2:0"}};
    assert.equal(entry().enabled, true, "an attack on an earlier turn doesn't count");
    actor.flags = {wildpath: {attackTurn: "c:2:1"}};
    assert.deepEqual([entry().enabled, entry().disabledCode], [false, "REQUIRES_NOT_MET"], "it already attacked this turn");
  } finally {
    globalThis.game = previous;
  }
});

test("an Action's unavailability is the reason its bar button gives: spent, forbidden, a common action's, or none", async () => {
  const {actionUnavailableReason} = await import("../module/helpers/action-bar-context.mjs");
  const hero = creature();
  const strike = hero.items[0];
  assert.equal(actionUnavailableReason({actor: hero, action: strike}), null, "an Action it can pay for is available");
  assert.equal(actionUnavailableReason({actor: hero, action: {id: "cloak"}}), null, "what the bar does not show is left to the authority");
  assert.deepEqual(actionUnavailableReason({actor: creature({action: 0}), action: strike}),
    {key: "WILDPATH.ACTIONBAR.Reason.Spent", name: "WILDPATH.RESOURCES.Action"});
  const transformed = {...hero, forbiddingRule: () => ({reason: "WILDPATH.REFUSAL.Transformed", name: "Polymorph"})};
  assert.deepEqual(actionUnavailableReason({actor: transformed, action: strike}),
    {key: "WILDPATH.REFUSAL.Transformed", name: "Hero", by: "Polymorph"});
  // A common action is no Item of the creature's: it is checked as the bar's common group checks it.
  assert.equal(actionUnavailableReason({actor: creature({action: 0}), action: action("common-dash", "action")}).key,
    "WILDPATH.ACTIONBAR.Reason.Spent");
});

test("Item#use refuses an Action it can't pay for or is forbidden before any choice or area is asked", async t => {
  const keys = ["Item", "game", "ui"];
  const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  t.after(() => { for ( const key of keys ) globalThis[key] = saved[key]; });
  globalThis.Item = class { constructor(data) { Object.assign(this, data); } };
  const {default: WildPathItem} = await import("../module/documents/item.mjs");
  const declared = [];
  const warnings = [];
  globalThis.game = {wildpath: {executeActionIntent: async intent => { declared.push(intent); return {ok: true}; }},
    i18n: {localize: key => `<${key}>`, format: (key, data) => `${key}${JSON.stringify(data)}`}};
  globalThis.ui = {notifications: {warn: message => warnings.push(message)}};
  const use = async actor => {
    // It would ask a choice first (a dialog this test has no Foundry for): only the early refusal keeps it from asking.
    const item = new WildPathItem({...action("Strike", "action"), uuid: "Actor.a.Item.Strike", actor});
    item.system.definition = {configuration: [{id: "slot", options: [{id: "x"}]}]};
    actor.items = [item];
    return item.use();
  };
  assert.equal(await use(creature({action: 0})), false);
  assert.match(warnings.pop(), /^WILDPATH\.ITEM\.Unavailable.*WILDPATH\.ACTIONBAR\.Reason\.Spent.*<WILDPATH\.RESOURCES\.Action>/);
  assert.equal(await use({...creature(), forbiddingRule: () => ({reason: "WILDPATH.REFUSAL.Transformed", name: "Polymorph"})}), false);
  assert.match(warnings.pop(), /^WILDPATH\.ITEM\.Unavailable.*WILDPATH\.REFUSAL\.Transformed/);
  assert.deepEqual(declared, [], "nothing is declared to the authority");
});

import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {withMetamagic} from "../module/helpers/metamagic.mjs";
import {resolveActionConfiguration} from "../module/helpers/action-configuration.mjs";
import {withSeekingSpell} from "../module/resolvers/foundry-multiplayer-runtime.mjs";

const spell = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
  .find(file => file.startsWith(`${prefix}-`))}`, "utf8")).system.definition;
const feature = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
  .find(file => file.startsWith(`${prefix}-spell-phbmmo`))}`, "utf8"));
const sorcerer = (known, {points=5, flags={}}={}) => ({uuid: "Actor.sorc", flags,
  items: known.map(option => feature(option)),
  system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1}},
    pools: [{id: "font-of-magic", value: points, max: 5}, {id: "spell-slot.3", value: 2, max: 2}]}});
const options = definition => definition.configuration.find(choice => choice.id === "metamagic")?.options.map(option => option.id);

test("Metamagic: a sorcerer's spells offer the options it knows, and a non-sorcerer's are unchanged", () => {
  const fireBolt = spell("fire-bolt");
  assert.deepEqual(options(withMetamagic(fireBolt, sorcerer(["quickened", "careful", "seeking"]))), ["none", "quickened", "careful"],
    "known options only; Seeking is a reroll offer instead");
  assert.equal(withMetamagic(fireBolt, {items: [], system: {pools: []}}), fireBolt);
  assert.equal(withMetamagic(fireBolt, sorcerer(["quickened"], {points: 0})), fireBolt, "no Sorcery Points");
  assert.equal(options(withMetamagic(fireBolt, sorcerer(["quickened", "careful"], {points: 1}))).includes("quickened"), false,
    "Quickened's 2 points are more than it has");
  assert.deepEqual(options(withMetamagic(fireBolt, sorcerer(["transmuted"]))),
    ["none", "transmuted-acid", "transmuted-cold", "transmuted-lightning", "transmuted-poison", "transmuted-thunder"]);
  assert.equal(options(withMetamagic(spell("fireball"), sorcerer(["twinned"]))), undefined, "Fireball targets no more creatures: no choice");
});

test("Metamagic: Quickened Fireball costs a Bonus Action, its slot and 2 points; not after another slot spell this turn", () => {
  const actor = sorcerer(["quickened"]);
  const read = withMetamagic(spell("fireball"), actor);
  const resolved = resolveActionConfiguration({definition: read, actorSystem: actor.system,
    choices: {"spell-slot": {resourceId: "spell-slot.3"}, metamagic: "quickened"}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const costs = JSON.stringify(resolved.configuration.effectiveDefinition.costs);
  assert.ok(costs.includes("bonus-action") && !costs.includes("\"action\"") && costs.includes("spell-slot.3") && costs.includes("font-of-magic"), costs);
  const previous = globalThis.game;
  globalThis.game = {combat: {started: true, id: "c", round: 2, turn: 1}};
  try {
    assert.deepEqual(options(withMetamagic(spell("fireball"), sorcerer(["quickened", "careful"], {flags: {wildpath: {slotSpellTurn: "c:2:1"}}}))),
      ["none", "careful"]);
  } finally { globalThis.game = previous; }
});

test("Metamagic: Twinned Hold Person at level 3 holds 3; Distant doubles its range; Extended doubles Bless", () => {
  const actor = sorcerer(["twinned", "distant", "extended"]);
  const hold = withMetamagic(spell("hold-person"), actor);
  const twinned = resolveActionConfiguration({definition: hold, actorSystem: actor.system,
    choices: {"spell-slot": {resourceId: "spell-slot.3"}, metamagic: "twinned"}});
  assert.equal(twinned.ok, true, JSON.stringify(twinned.errors));
  assert.equal(twinned.configuration.effectiveDefinition.targeting.count, 3);
  const distant = resolveActionConfiguration({definition: hold, actorSystem: actor.system,
    choices: {"spell-slot": {resourceId: "spell-slot.3"}, metamagic: "distant"}});
  assert.equal(distant.configuration.effectiveDefinition.range.normal.value, 120);
  const bless = resolveActionConfiguration({definition: withMetamagic(spell("bless"), actor), actorSystem: actor.system,
    choices: {"spell-slot": {resourceId: "spell-slot.3"}, metamagic: "extended"}});
  assert.equal(bless.ok, true, JSON.stringify(bless.errors));
  assert.equal(bless.configuration.effectiveDefinition.effects[0].duration.value, 120);
});

test("Seeking Spell: a missed spell attack may be rerolled for 1 Sorcery Point, by a sorcerer who knows it", () => {
  const actor = sorcerer(["seeking"]);
  const offer = withSeekingSpell(null, actor, actor.system, null);
  assert.equal(offer.options.length, 1);
  assert.equal(offer.options[0].addDice, undefined, "a reroll, nothing added");
  assert.equal(withSeekingSpell(null, sorcerer(["careful"]), sorcerer(["careful"]).system, null), null);
  assert.equal(withSeekingSpell(null, actor, sorcerer(["seeking"], {points: 0}).system, null), null);
});

test("Metamagic: Extended doubles to 24 hours at most, with Advantage on Concentration; only for 1 minute or longer", () => {
  const actor = sorcerer(["extended", "subtle"]);
  const lasting = hours => ({schemaVersion: 1, id: "action:lasting", label: "Lasting", tags: ["spell", "component:verbal", "component:somatic"],
    costs: {allOf: [{capability: "action", amount: 1}]}, targeting: {type: "self"}, concentration: {duration: {value: hours, units: "hours"}},
    effects: [{id: "effect-1", type: "effect", name: "Lasting", duration: {value: hours, units: "hours"}}]});
  const extended = hours => resolveActionConfiguration({definition: withMetamagic(lasting(hours), actor), actorSystem: actor.system,
    choices: {metamagic: "extended"}}).configuration.effectiveDefinition;
  assert.deepEqual([extended(8).effects[0].duration.value, extended(16).effects[0].duration.value, extended(16).concentration.duration.value],
    [16, 24, 24], "8 hours doubles to 16; 16 hours stops at 24");
  assert.equal(extended(8).concentration.advantage, true);
  const instant = {...lasting(1), concentration: null, effects: [{id: "effect-1", type: "effect", name: "Brief", duration: {value: 5, units: "rounds"}}]};
  assert.equal(options(withMetamagic(instant, actor)).includes("extended"), false, "30 seconds: not Extended");
  // Subtle: its components go, so Counterspell can't see it; a costly material would stay.
  const subtle = resolveActionConfiguration({definition: withMetamagic(lasting(1), actor), actorSystem: actor.system,
    choices: {metamagic: "subtle"}}).configuration.effectiveDefinition;
  assert.deepEqual(subtle.tags, ["spell", "component:none"]);
});

test("Metamagic: after a Quickened spell this turn, a level 1+ spell is greyed on the bar; a cantrip is not", async () => {
  const {actionBarContext} = await import("../module/helpers/action-bar-context.mjs");
  const previous = globalThis.game;
  globalThis.game = {combat: {started: true, id: "c", round: 1, turn: 0}};
  try {
    const item = (id, prefix) => ({id, type: "action", name: id, system: {definition: spell(prefix)}});
    const actor = {name: "Sorcerer", flags: {wildpath: {quickenedTurn: "c:1:0"}}, effects: [], items: [item("bolt", "fire-bolt"), item("ball", "fireball")],
      system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1}}, pools: [{id: "spell-slot.3", value: 2, max: 2}]}};
    const enabled = id => actionBarContext({actor}).groups.flatMap(group => group.actions).find(action => action.id === id)?.enabled;
    assert.deepEqual([enabled("bolt"), enabled("ball")], [true, false]);
  } finally { globalThis.game = previous; }
});

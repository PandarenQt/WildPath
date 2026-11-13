import {test} from "node:test";
import assert from "node:assert/strict";
import {convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {noteReason, realGapNotes} from "../module/helpers/conversion-notes.mjs";

// Synthetic documents in dnd5e 6.x's shape (mechanics only), not copies of its compendium: a Hit Point drain's wordings.
const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
const activity = (type, data={}) => ({_id: `act${type}`, type, sort: 0, activation: {type: "action", override: false},
  range: {override: false}, target: {override: false, template: {}, affects: {}}, effects: [], consumption: {targets: []}, ...data});
const doc = (type, name, identifier, system={}, effects=[]) => ({_id: `${identifier.replace(/-/g, "")}`.padEnd(16, "0").slice(0, 16), name, type,
  img: "icons/svg/item-bag.svg", effects, system: {source: SRD, identifier, description: {value: ""}, properties: [], ...system}});
const attack = (parts, data={}) => activity("attack", {attack: {type: {value: "melee"}}, damage: {parts}, ...data});
const save = (parts, data={}) => activity("save", {save: {ability: ["con"], dc: {calculation: "", formula: "14"}},
  target: {override: false, template: {}, affects: {type: "creature", count: "1"}}, range: {units: "ft", value: "5", override: false},
  damage: {parts, onSave: "none"}, ...data});
const necrotic = (number, denomination) => ({number, denomination, types: ["necrotic"]});
const drainsOf = result => result.items.flatMap(item => item.system?.definition?.effects ?? [])
  .filter(effect => effect.ruleElements?.[0]?.id === "hit-point-drain");

test("a drain by the damage taken: on a hit, on a failed save, on either outcome, by one damage type, and capped at 1", () => {
  const wraith = convertItem(doc("feat", "Life Drain", "life-drain", {description: {value: "<p>[[/attack extended]]. [[/damage average extended]]. "
    + "If the target is a creature, its Hit Point maximum decreases by an amount equal to the damage taken.</p>"},
  activities: {a: attack([necrotic(4, 8)])}}));
  const [drain] = drainsOf(wraith);
  assert.deepEqual([drain.amount, drain.restsLeft, drain.stack, drain.saveOutcomePolicy], [{damage: "all"}, 1, "separate", undefined]);
  assert.deepEqual(drain.ruleElements[0].data, {domains: ["resources.health.max"],
    valueExpression: {type: "multiply", terms: [{type: "context", path: "amount"}, -1]}});
  assert.equal(validateActionDefinition(wraith.items[0].system.definition).ok, true);
  assert.deepEqual(wraith.notes, []);

  const bite = convertItem(doc("feat", "Bite", "bite", {description: {value: "<p><em>Constitution Saving Throw</em>: DC 14. <em>Failure</em>: "
    + "[[/damage average]] damage. The target's Hit Point maximum decreases by an amount equal to the Necrotic damage taken, and the "
    + "[[lookup @name lowercase]]{monster} regains Hit Points equal to that amount.</p>"},
  activities: {a: save([{number: 1, denomination: 4, types: ["piercing"]}, necrotic(3, 6)])}}));
  assert.deepEqual(drainsOf(bite).map(entry => [entry.amount, entry.saveOutcomePolicy]), [[{damage: ["necrotic"]}, "failure"]]);
  assert.deepEqual(bite.notes, ["drain: its user regaining Hit Points equal to that amount is by hand"]);
  assert.equal(noteReason(bite.notes[0]), "drain: its user's healing by the amount (by hand)");

  const kiss = convertItem(doc("feat", "Draining Kiss", "draining-kiss", {description: {value: "<p><em>Failure</em>: [[/damage average]] damage. "
    + "<em>Success</em>: Half damage. <em>Failure or Success</em>: The target's Hit Point maximum decreases by an amount equal to the damage taken.</p>"},
  activities: {a: save([{number: 3, denomination: 8, types: ["psychic"]}], {damage: {parts: [{number: 3, denomination: 8, types: ["psychic"]}], onSave: "half"}})}}));
  assert.deepEqual(drainsOf(kiss).map(entry => entry.saveOutcomePolicy), [undefined], "on either outcome");

  const harm = convertItem(doc("spell", "Harm", "harm", {level: 6, description: {value: "<p>The target makes a Constitution saving throw. On a "
    + "failed save, it takes 14d6 Necrotic damage, and its Hit Point maximum is reduced by an amount equal to the Necrotic damage it took. On a "
    + "successful save, it takes half as much damage only. This spell can't reduce a target's Hit Point maximum below 1.</p>"},
  activities: {a: save([necrotic(14, 6)], {damage: {parts: [necrotic(14, 6)], onSave: "half"}, save: {ability: "con", dc: {calculation: "spellcasting"}}})}}));
  const [harmed] = drainsOf(harm);
  assert.deepEqual([harmed.amount, harmed.saveOutcomePolicy], [{damage: ["necrotic"], cap: {type: "subtract",
    left: {type: "resource-max", resource: "health"}, right: {type: "constant", value: 1}}}, "failure"]);
});

test("a drain by dice on a failed save is rolled; one whose outcome or ending is elsewhere in its text stays by hand", () => {
  const energy = convertItem(doc("feat", "Energy Drain", "energy-drain", {description: {value: "<p><em>Constitution Saving Throw</em>: DC 19. "
    + "<em>Failure</em>: The target's Hit Point maximum decreases by 14 ([[/r 4d6]]).</p>"}, activities: {a: save([])}}));
  assert.deepEqual(drainsOf(energy).map(entry => [entry.amount, entry.saveOutcomePolicy]), [[{formula: "4d6"}, "failure"]]);
  assert.deepEqual(energy.notes, [], "no marker, no \"rolled (save)\" note: the drain is what it does");

  const legacy = convertItem(doc("feat", "Life Drain", "life-drain", {description: {value: "<p>Hit: 21 (4d8 + 3) necrotic damage. The target "
    + "must succeed on a DC 14 Constitution saving throw or its hit point maximum is reduced by an amount equal to the damage taken.</p>"},
  activities: {a: attack([necrotic(4, 8)])}}));
  assert.deepEqual(drainsOf(legacy), [], "a 2014 save the attack does not carry");
  assert.equal(realGapNotes(legacy.notes).length, 1);
  assert.equal(noteReason(legacy.notes[0]), "drain: its outcome or ending elsewhere in its text (by hand)");

  const restored = convertItem(doc("feat", "Slam", "slam", {description: {value: "<p>Hit: 16 (2d10 + 5) bludgeoning damage, and the target's "
    + "hit point maximum is reduced by an amount equal to the damage taken. This reduction lasts until it is removed by the greater "
    + "restoration spell or other magic.</p>"}, activities: {a: attack([{number: 2, denomination: 10, types: ["bludgeoning"]}])}}));
  assert.deepEqual(drainsOf(restored), [], "an ending its effect has no field for");
  const rest = convertItem(doc("feat", "Slam", "slam", {description: {value: "<p>Hit: 16 (2d10 + 5) bludgeoning damage, and the target's "
    + "hit point maximum is reduced by an amount equal to the damage taken. This reduction lasts until the target finishes a long rest.</p>"},
  activities: {a: attack([{number: 2, denomination: 10, types: ["bludgeoning"]}])}}));
  assert.deepEqual(drainsOf(rest).map(entry => [entry.amount, entry.restsLeft]), [[{damage: "all"}, 1]], "the 2014 long rest wording");

  // A Death Dog's: its dice on "Subsequent Failures", rolled by a utility of its own, which keeps its own note.
  const dog = convertItem(doc("feat", "Bite", "bite", {description: {value: "<p><em>First Failure</em>: The target has the Poisoned condition. "
    + "<em>Subsequent Failures</em>: The Poisoned target's Hit Point maximum decreases by 5 ([[/r 1d10]]).</p>"},
  activities: {a: save([]), b: activity("utility", {_id: "actroll", name: "Max HP Decrease", roll: {formula: "1d10", name: "Max HP Decrease"}})}}));
  assert.deepEqual(drainsOf(dog), []);
  assert.equal(dog.notes.some(note => note.includes("drain")), false);
});

test("a curse's drain every 24 hours (a Mummy's Rotting Fist): a Trigger beside the curse rolling it, its utility folded in", () => {
  const fist = convertItem(doc("feat", "Rotting Fist", "rotting-fist", {description: {value: "<p>[[/attack extended]]. [[/damage average extended]]. "
    + "If the target is a creature, it is cursed. While cursed, the target can't regain Hit Points, its Hit Point maximum doesn't return to "
    + "normal when finishing a Long Rest, and its Hit Point maximum decreases by [[/r 3d6#HP Max Decrease]]{10 (3d6)} every 24 hours that "
    + "elapse.</p>"},
  activities: {a: attack([necrotic(3, 6)], {effects: [{_id: "cursedEffect0001"}]}),
    b: activity("utility", {_id: "actroll", name: "HP Max Decrease", roll: {formula: "3d6", name: "HP Max Decr."}})}},
  [{_id: "cursedEffect0001", name: "Cursed", statuses: ["cursed"], changes: [], duration: {}}]));
  const used = fist.items.filter(item => item.type === "action");
  assert.equal(used.length, 1, "the roll's own utility is no Action of its own");
  const effects = used[0].system.definition.effects;
  const interval = effects.flatMap(effect => effect.ruleElements ?? []).find(rule => rule.type === "Trigger");
  assert.deepEqual([interval.data.event, interval.data.every, interval.data.predicate], ["time.elapsed", {value: 24, units: "hours"},
    {hasCondition: "cursed"}]);
  const [drain] = interval.data.action.effects;
  assert.deepEqual([drain.amount, drain.restsLeft, drain.stack], [{formula: "3d6"}, undefined, "separate"], "kept through a Long Rest");
  assert.equal(validateActionDefinition(interval.data.action).ok, true);
  assert.deepEqual(drainsOf(fist), [], "no drain as it lands: the damage taken is not its wording");
  assert.deepEqual(fist.notes, ["drain: its Hit Point maximum drains stay until removed; keeping its creature's other drains"
    + " through a Long Rest while it lasts, and restoring them after it ends, is by hand"]);
});

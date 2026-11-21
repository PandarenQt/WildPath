import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real Actor class and the vehicle model; a field records what it holds.
class Field { constructor(options) { this.options = options; } }
class Container { constructor(fields, options) { Object.assign(this, {fields, options}); } }
globalThis.Actor = class {};
globalThis.foundry = {
  abstract: {TypeDataModel: class {static defineSchema() { return {}; } prepareBaseData() {} prepareDerivedData() {}}},
  data: {fields: {SchemaField: Container, ArrayField: Container, SetField: Container, NumberField: Field, StringField: Field,
    BooleanField: Field, HTMLField: Field, ObjectField: Field}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {default: WildPathVehicle} = await import("../module/data/actor/vehicle.mjs");
const {adjustDamageResult} = await import("../module/resolvers/damage-adjustment-resolver.mjs");
const {requiresContext} = await import("../module/helpers/combat.mjs");
const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
const {actionBarContext} = await import("../module/helpers/action-bar-context.mjs");
const {convertActor} = await import("../scripts/content/dnd5e-to-wildpath.mjs");

/** A vehicle Actor: the real model's rules over its stored data, with no Items or effects. */
function ship({damageThreshold=15, aboard=[]}={}) {
  const system = Object.assign(Object.create(WildPathVehicle.prototype), {
    resources: {health: {value: 300, max: 300, damageThreshold}, movement: {value: 0, max: 0}},
    immunities: {damage: ["poison", "psychic"], conditions: ["blinded", "unconscious"]}, aboard});
  return Object.assign(Object.create(WildPathActor.prototype), {id: "ship", uuid: "Actor.ship", name: "Sailing Ship", type: "vehicle",
    items: [], effects: [], statuses: new Set(), flags: {}, system, allApplicableEffects: () => []});
}
const hit = (amount, damageType="bludgeoning") => ({ok: true, code: "OK", components: [{id: "ram", amount, damageType}], total: amount,
  byDamageType: {[damageType]: amount}});

test("a vehicle keeps the shapes rules read (AC, Hit Points with a Damage Threshold, Speed) and none of a creature's", () => {
  const schema = WildPathVehicle.defineSchema();
  assert.deepEqual(Object.keys(schema).sort(), ["aboard", "biography", "capacity", "defenses", "immunities", "pools", "resources",
    "travelSpeed"]);
  assert.deepEqual(Object.keys(schema.resources.fields).sort(), ["health", "movement"], "no Action, Bonus Action or Reaction");
  assert.ok("damageThreshold" in schema.resources.fields.health.fields);
  assert.deepEqual(Object.keys(schema.aboard.fields.fields), ["actorUuid", "role"]);
  assert.deepEqual(schema.aboard.fields.fields.role.options.choices, ["crew", "passenger"]);
  assert.deepEqual(Object.keys(schema.capacity.fields), ["crew", "passengers", "cargo"]);
});

test("its Damage Threshold and immunities reach its damage profile and condition immunities; its deck shares spaces", () => {
  const vehicle = ship();
  const profile = vehicle.getDamageProfile();
  assert.equal(profile.damageThreshold, 15);
  assert.equal(adjustDamageResult(hit(14), profile).damageResult.total, 0, "below the threshold: superficial");
  assert.equal(adjustDamageResult(hit(20), profile).damageResult.total, 20);
  assert.equal(adjustDamageResult(hit(30, "poison"), profile).damageResult.total, 0, "immune to Poison");
  assert.deepEqual(vehicle.getConditionImmunities().sort(), ["blinded", "unconscious"]);
  assert.equal(vehicle.getStatistic(["occupancy.share"]).totalModifier, 1, "riders and it don't block one another");
  assert.equal(ship({damageThreshold: 0}).getDamageProfile().damageThreshold, undefined, "no threshold, none added");
});

const aboard = [{actorUuid: "Actor.pilot", role: "crew"}, {actorUuid: "Actor.guest", role: "passenger"}];
const CREW = {equals: {path: "aboard.crew", value: true}};

test("a vehicle prepares like any Actor: its Hit Point maximum from base and bonus, its movement left from what it spent", () => {
  const vehicle = ship();
  const system = Object.assign(new WildPathVehicle(), {parent: vehicle, biography: "", defenses: {ac: {base: 15}}, pools: [],
    resources: {health: {base: 300, bonus: 20, max: 1, value: 300}, movement: {base: 30, bonus: 0, max: 0, value: 0, spent: 10}},
    immunities: {damage: [], conditions: []}, aboard: []});
  vehicle.system = system;
  system.prepareBaseData();
  system.prepareDerivedData();
  assert.deepEqual([system.resources.health.max, system.resources.health.value], [320, 300], "no class records to read");
  assert.deepEqual([system.resources.movement.max, system.resources.movement.value], [30, 20]);
});

/**
 * Any Actor's maxima and Speeds after its rules (the base model's own): each `[domains, value, modifierType?, owner?]` is a
 * Modifier rule on an effect, or on a feature Item when `owner` is "item"; `{modifier}` a plain Modifier on an effect
 * (`system.modifiers`); any other object a rule on an effect.
 */
function preparedWith(...entries) {
  const vehicle = ship();
  const effects = [];
  const items = [];
  entries.forEach((entry, index) => {
    const [domains, value, modifierType="untyped", owner="effect"] = Array.isArray(entry) ? entry : [];
    const rule = Array.isArray(entry) ? {id: `rule${index}`, type: "Modifier", data: {domains, modifierType, value}} : {id: `rule${index}`, ...entry};
    if ( owner === "item" ) items.push({id: `i${index}`, uuid: `Actor.ship.Item.i${index}`, type: "feature",
      system: {active: true, modifiers: [], ruleElements: [rule]}});
    else effects.push({id: `e${index}`, uuid: `Actor.ship.ActiveEffect.e${index}`, disabled: false,
      system: entry.modifier ? {modifiers: [{id: `m${index}`, enabled: true, ...entry.modifier}], ruleElements: []} : {ruleElements: [rule]}});
  });
  Object.assign(vehicle, {items, effects, allApplicableEffects: () => effects});
  const system = Object.assign(new WildPathVehicle(), {parent: vehicle, biography: "", defenses: {ac: {base: 15}}, pools: [],
    resources: {health: {base: 60, bonus: 1, max: 1, value: 61}, movement: {base: 30, bonus: 0, max: 0, value: 0, spent: 0}},
    immunities: {damage: [], conditions: []}, aboard: []});
  vehicle.system = system;
  system.prepareBaseData();
  system.prepareDerivedData();
  return {health: system.resources.health, movement: system.resources.movement.max, speeds: system.speeds};
}

test("`resources.<id>.max.multiplier` factors a maximum after its bonuses, rounded down; factors multiply", () => {
  const halved = preparedWith([["resources.health.max.multiplier"], 0.5]);
  assert.deepEqual([halved.health.max, halved.health.value, halved.movement], [30, 30, 30], "61 halved is 30; Speed untouched");
  assert.equal(preparedWith([["resources.health.max.multiplier"], 0.5], [["resources.health.max.multiplier"], 0.5]).health.max, 15,
    "two halvings quarter it");
  assert.equal(preparedWith([["resources.health.max"], 3]).health.max, 64, "a bonus on the maximum is no factor");
  assert.equal(preparedWith([["all"], 3]).health.max, 64, "nor is a wildcard bonus, which only adds");
  assert.equal(preparedWith().health.max, 61, "no factor, unchanged");
});

test("each maximum's factors are read alone, so typed factors on two maxima both count; Speed's factors still apply", () => {
  const both = preparedWith([["resources.health.max.multiplier"], 0.5, "status"], [["resources.movement.max.multiplier"], 2, "status"]);
  assert.deepEqual([both.health.max, both.movement], [30, 60], "a single read would keep only the larger status factor");
  assert.equal(preparedWith([["speed.multiplier"], 2]).movement, 60, "Haste still doubles walking Speed");
  assert.equal(preparedWith([["speed.multiplier"], 2], [["resources.movement.max.multiplier"], 0.5]).movement, 30, "and the two multiply");
});

test("a maximum's factor scales what its data and Items give it; its effects' Modifiers then count in full", () => {
  const HALF = [["resources.health.max.multiplier"], 0.5];
  assert.equal(preparedWith(HALF, [["resources.health.max"], 5]).health.max, 35, "Aid on a halved creature: 30.5 + 5, not 33");
  assert.equal(preparedWith(HALF, [["resources.health.max"], -18]).health.max, 12, "a Life Drain of 18 counts in full, not 21");
  assert.equal(preparedWith(HALF, {modifier: {domains: ["resources.health.max"], type: "untyped", value: 5}}).health.max, 35,
    "a plain Modifier on an effect too");
  assert.equal(preparedWith(HALF, [["resources.health.max"], 4, "untyped", "item"]).health.max, 32, "its own feature is halved: 65 / 2");
  assert.equal(preparedWith(HALF, [["resources.health.max"], -80]).health.max, 0, "never below 0");
  assert.equal(preparedWith([["resources.health.max"], 5]).health.max, 66, "no factor: every bonus adds as before");
  assert.equal(preparedWith([["speed.multiplier"], 2], [["resources.movement.max"], 10]).movement, 80,
    "Speed's factors still come after every bonus (Longstrider, then Haste)");
});

test("a walking GrantMovement is walking Speed, so the movement maximum's factor reaches it", () => {
  const grant = {type: "GrantMovement", data: {mode: "walk", distance: 40}};
  assert.equal(preparedWith(grant).speeds.walk, 40);
  assert.equal(preparedWith(grant, [["resources.movement.max.multiplier"], 0.5]).speeds.walk, 20, "40 halved, not the grant's 40");
  assert.equal(preparedWith({type: "GrantMovement", data: {mode: "fly", distance: 40}}, [["resources.movement.max.multiplier"], 0.5])
    .speeds.fly, 40, "another mode's Speed is not the movement maximum");
});

test("a crew Action requires the role its user holds aboard (`aboard.crew`); without a user, any creature aboard's", () => {
  const vehicle = ship({aboard});
  const met = controller => evaluatePredicate(CREW, requiresContext(vehicle, {game: {}, controller})).ok;
  assert.equal(met({uuid: "Actor.pilot"}), true);
  assert.equal(met({uuid: "Actor.guest"}), false, "a passenger");
  assert.equal(met({uuid: "Actor.stranger"}), false, "not aboard");
  assert.equal(met(null), true, "someone aboard is crew");
  assert.equal(evaluatePredicate(CREW, requiresContext(ship({aboard: [aboard[1]]}), {game: {}})).ok, false, "only a passenger aboard");
  assert.deepEqual(requiresContext({system: {}}, {game: {}}).aboard, {}, "a creature has no roles");
});

test("on a crew member's action bar a vehicle's Action is ready; on a passenger's it is greyed, with the reason", () => {
  const claw = {id: "claw", type: "action", name: "Claw", img: "claw.svg", system: {getActivationCost: () => ({allOf: []}),
    definition: {requires: CREW}}};
  const vehicle = {name: "Apparatus", items: [claw], effects: [], system: {resources: {}, pools: [], aboard}};
  const view = controller => actionBarContext({actor: vehicle, controller}).groups.flatMap(group => group.actions)[0];
  assert.equal(view({uuid: "Actor.pilot"}).enabled, true);
  const passenger = view({uuid: "Actor.guest"});
  assert.deepEqual([passenger.enabled, passenger.disabledCode, passenger.reason.key], [false, "REQUIRES_NOT_MET",
    "WILDPATH.ACTIONBAR.Reason.Requires"]);
});

test("a vehicle's crew Action is greyed on a crew member's bar once that creature has spent the Action it costs", () => {
  const claw = {id: "claw", type: "action", name: "Claw", img: "claw.svg", system: {getActivationCost: () => ({allOf: []}),
    definition: {requires: CREW, controllerCosts: {allOf: [{capability: "action", amount: 1}]}}}};
  const vehicle = {name: "Apparatus", items: [claw], effects: [], system: {resources: {}, pools: [], aboard}};
  const pilot = spent => ({uuid: "Actor.pilot", system: {resources: {action: {value: 1 - spent, max: 1, spent}}, pools: []}});
  const view = controller => actionBarContext({actor: vehicle, controller, localize: key => `@${key}`}).groups
    .flatMap(group => group.actions)[0];
  assert.equal(view(pilot(0)).enabled, true);
  const spent = view(pilot(1));
  assert.deepEqual([spent.enabled, spent.disabledCode, spent.reason], [false, "INSUFFICIENT_RESOURCE",
    {key: "WILDPATH.ACTIONBAR.Reason.Spent", name: "@WILDPATH.RESOURCES.Action"}]);
});

/** A dnd5e vehicle as its 2024 SRD export has it (numbers only, the crew and Speed in its text), with a crew-worked claw. */
function dnd5eVehicle(overrides={}) {
  return {_id: "vehicleCrab00000", name: "Crab", type: "vehicle", img: "icons/environment/settlement/ship.webp",
    prototypeToken: {width: 2, height: 2},
    system: {source: {license: "CC-BY-4.0", rules: "2024"},
      attributes: {ac: {flat: 20}, hp: {max: 200, dt: 10}, movement: {walk: "30", swim: "30"}, capacity: {creature: "6", cargo: {value: 2}}},
      traits: {size: "lg", di: {value: ["poison", "psychic"]}, ci: {value: ["blinded"]}},
      details: {biography: {value: "<p><strong>Speed:</strong> 1 1/2 mph</p><p><strong>Crew:</strong> 2</p><p><strong>Passengers:</strong> —</p>"}}},
    items: [{_id: "claw000000000000", name: "Claw", type: "feat", system: {source: {license: "CC-BY-4.0", rules: "2024"},
      type: {value: "monster"}, description: {value: ""},
      activities: {a: {_id: "a", type: "attack", activation: {type: "special"}, attack: {flat: true, bonus: "8", type: {value: "melee",
        classification: "weapon"}}, damage: {parts: [{number: 2, denomination: 6, types: ["bludgeoning"]}]},
      range: {value: "5", units: "ft"}}}}}],
    ...overrides};
}

test("the converter makes a CC-BY-4.0 2024 dnd5e vehicle a vehicle Actor, its Items crew Actions at their user's Action", () => {
  const result = convertActor(dnd5eVehicle(), {pack: "actors24"});
  assert.equal(result.ok, true, result.reason);
  const {actor} = result;
  assert.equal(actor.type, "vehicle");
  assert.deepEqual(actor.system, {defenses: {ac: {value: 20}}, resources: {health: {base: 200, value: 200, damageThreshold: 10},
    movement: {base: 30, value: 30}}, travelSpeed: 1.5, capacity: {crew: 2, passengers: 4, cargo: 2},
  immunities: {damage: ["poison", "psychic"], conditions: ["blinded"]}, aboard: []});
  assert.deepEqual([actor.prototypeToken.width, actor.prototypeToken.height], [2, 2]);
  const [claw] = actor.items;
  assert.deepEqual([claw.type, claw.system.definition.costs, claw.system.definition.controllerCosts, claw.system.definition.requires],
    ["action", {allOf: []}, {allOf: [{capability: "action", amount: 1}]}, CREW], "its own turnless cost moves to its crew");
  assert.equal(claw.system.definition.attack.fixedBonus, 8, "the stat block's +8, with no ability scores to add");
  assert.equal(convertActor(dnd5eVehicle({system: {...dnd5eVehicle().system, source: {license: "", rules: "2024"}}})).ok, false,
    "not SRD 5.2");
  const plain = convertActor(dnd5eVehicle({items: [], system: {...dnd5eVehicle().system, details: {}}})).actor.system.capacity;
  assert.deepEqual(plain, {crew: 6, passengers: 0, cargo: 2}, "without its text, everyone it holds is crew");
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {censusNotes, convertActor, convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {conditionImmunitiesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {evaluatePredicate} from "../module/helpers/predicates.mjs";
import {noteReason, realGapNotes} from "../module/helpers/conversion-notes.mjs";

// Synthetic documents in dnd5e 6.x's shape (mechanics only), not copies of its compendium. Identifiers name the converter
// rows they exercise.
const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
const activity = (type, data={}) => ({_id: `act${type}`, type, sort: 0, activation: {type: "action", override: false},
  range: {override: false}, target: {override: false, template: {}, affects: {}}, effects: [], consumption: {targets: []}, ...data});
const passive = (type, data={}) => activity(type, {activation: {type: "", override: false}, ...data});
const doc = (type, name, identifier, system={}, effects=[]) => ({_id: `${identifier.replace(/-/g, "")}`.padEnd(16, "0").slice(0, 16), name, type,
  img: "icons/svg/item-bag.svg", effects, system: {source: SRD, identifier, description: {value: ""}, properties: [], ...system}});
const actions = result => result.items.filter(item => item.type === "action");
const valid = item => assert.equal(validateActionDefinition(item.system.definition).ok, true, item.name);

test("uses that only tell the table something are narrative by their dnd5e names", () => {
  const wight = convertItem(doc("feat", "Life Drain", "life-drain", {description: {value: "<p>A Humanoid slain rises 24 hours later as a Zombie; its Hit Points drop.</p>"},
    activities: {a: passive("summon", {name: "Zombie Rises"}), b: passive("utility", {name: "Damage Rope", _id: "actrope"})}}));
  assert.deepEqual(wight.notes, ["\"Zombie Rises\" is passive or triggered (narrative): not automated",
    "\"Damage Rope\" is passive or triggered (narrative): not automated"]);
  assert.deepEqual(realGapNotes(wight.notes), [], "informational: nothing to automate");
});

test("a Shield that names no armor value is a Shield's +2, with its magic bonus", () => {
  const shield = convertItem(doc("equipment", "Shield, +1, +2, or +3", "shield-1-2-or-3", {type: {value: "shield"}, armor: {value: null}}));
  assert.deepEqual(shield.items[0].system.ruleElements, [{schemaVersion: 1, id: "shield-1-2-or-3", type: "Modifier",
    data: {domains: ["defense.ac"], modifierType: "untyped", value: 2}}]);
  assert.deepEqual(shield.notes, []);
  const magic = convertItem(doc("equipment", "Test Shield", "test-shield", {type: {value: "shield"}, armor: {value: null, magicalBonus: 1}}));
  assert.equal(magic.items[0].system.ruleElements[0].data.value, 3);
  const plate = convertItem(doc("equipment", "Armor, +1", "armor-1", {type: {value: "heavy"}, armor: {value: null}}));
  assert.deepEqual(plate.notes, ["armor: of any kind; give it its armor's AC by hand"], "armor of another kind still needs its base");
});

test("a check whose DC the GM sets is its skill, chosen and checked when used (Search's shape); Thieves' Tools as Sleight of Hand", () => {
  const hands = convertItem(doc("feat", "Fast Hands", "fast-hands", {activities: {
    a: activity("check", {name: "Sleight of Hand", activation: {type: "bonus"}, check: {dc: {calculation: "", formula: ""}, associated: ["slt"], ability: ""}}),
    b: activity("check", {_id: "acttools", name: "Thieves' Tools", activation: {type: "bonus"},
      check: {dc: {calculation: "", formula: ""}, associated: ["thief"], ability: "dex"}})}}));
  const [sleight, tools] = actions(hands);
  assert.deepEqual(sleight.system.definition.metadata, {test: {skills: ["sleight-of-hand"]}});
  assert.deepEqual(tools.system.definition.metadata, {test: {skills: ["sleight-of-hand"]}});
  assert.deepEqual(sleight.system.definition.costs, {allOf: [{capability: "bonus-action", amount: 1}]});
  assert.equal(sleight.system.definition.check, undefined);
  assert.deepEqual(hands.notes, []);
  sleight.system.definition.label = sleight.name;
  valid(sleight);
  // A tool check with no skill to stand for it, and no DC, is still noted.
  const forge = convertItem(doc("feat", "Forge", "forge", {activities: {a: activity("check", {check: {dc: {formula: ""}, associated: ["smith"], ability: ""}})}}));
  assert.ok(forge.notes.some(note => note.startsWith("check: ")));
});

test("a passive check its text frees a held creature with is the hold's escape; one its user takes an action for stays its own", () => {
  const check = (data) => ({check: {dc: {calculation: "", formula: "15"}, associated: ["ath"], ability: "str"}, ...data});
  const bands = convertItem(doc("equipment", "Test Bands", "test-bands", {description: {value: "<p>A creature can take an action to make "
    + "a DC 15 Strength (Athletics) check to break the bands. On a successful check, the item is destroyed.</p>"}, activities: {
    a: passive("check", check({name: "Break Check"})), b: activity("check", check({_id: "actclimb", name: "Climb Out"}))}}));
  assert.deepEqual(actions(bands).map(item => item.name), ["Test Bands (Climb Out)"]);
});

test("a 2014 spell link casts its 2024 SRD spell (a Rod of Alertness's Detect Evil and Good)", () => {
  const detect = doc("spell", "Detect Evil and Good", "detect-evil-and-good", {level: 1, preparation: {mode: "prepared"},
    activities: {a: activity("utility")}});
  detect._id = "phbsplDetectEvil";
  const rod = convertItem(doc("equipment", "Rod of Alertness", "rod-of-alertness", {type: {value: "rod"}, activities: {
    a: activity("cast", {spell: {uuid: "Compendium.dnd5e.spells.Item.Mzh95utKDPIrjiH8", level: 1}})}}), {spells: {phbsplDetectEvil: detect}});
  assert.ok(actions(rod).some(item => item.name === "Rod of Alertness: Detect Evil and Good"));
  assert.equal(rod.notes.some(note => note.startsWith("cast: its spell was not found")), false);
});

test("a part of a licensed stat block dnd5e leaves without a license of its own is the stat block's (a Deva's Divine Aid)", () => {
  const aid = {...doc("feat", "Divine Aid", "divine-aid", {activities: {a: activity("utility", {activation: {type: "bonus"}})}}),
    _id: "divineAid0000001"};
  aid.system.source = {rules: "2024"};
  const deva = {_id: "deva000000000001", name: "Deva", type: "npc", items: [aid], system: {source: SRD, details: {cr: 10},
    abilities: {}, attributes: {hp: {max: 229}, movement: {walk: "30"}, ac: {calc: "natural", flat: 17}}, traits: {size: "med"}}};
  const {actor, notes} = convertActor(deva);
  assert.ok(actor.items.some(item => item.name === "Divine Aid"));
  assert.equal(notes.some(note => note.includes("not SRD 5.2")), false);
  assert.equal(actor.items.find(item => item.name === "Divine Aid").flags.wildpath.source.license, "CC-BY-4.0");
  // The dnd5e documents it holds, for the census to count a feature kept on its own on it: its own id and its source's.
  assert.deepEqual(convertActor({...deva, items: [{...aid, _stats: {compendiumSource: "Compendium.dnd5e.monsterfeatures.Item.mmDivineAid000"}}]}).holds,
    ["divineAid0000001", "mmDivineAid000"]);
  // Not one with rules of another edition.
  const old = {...aid, system: {...aid.system, source: {rules: "2014"}}};
  assert.ok(convertActor({...deva, items: [old]}).notes.some(note => note.includes("not SRD 5.2")));
});

test("Starry Wisp's Illuminated: Dim Light 10 feet, and no benefit from Invisible (an immune condition is suppressed)", () => {
  const wisp = convertItem(doc("spell", "Starry Wisp", "starry-wisp", {level: 0, preparation: {mode: "always"}, range: {value: "60", units: "ft"},
    target: {affects: {count: "1", type: "creature"}, template: {}}, activities: {a: activity("attack", {attack: {type: {value: "ranged"}},
      effects: [{_id: "illuminated"}], damage: {parts: [{number: 1, denomination: 8, types: ["radiant"], scaling: {mode: "whole"}}]}})}},
  [{_id: "illuminated", name: "Illuminated", statuses: [], duration: {units: "seconds", expiry: "sourceEnd"}}]));
  const [effect] = actions(wisp)[0].system.definition.effects;
  assert.deepEqual(effect.duration, {value: 1, units: "rounds", expiry: "sourceTurnEnd"});
  assert.deepEqual(effect.ruleElements.map(rule => [rule.type, rule.data]), [["GrantLight", {bright: 0, dim: 10}],
    ["ConditionImmunity", {conditions: ["invisible"]}]]);
  assert.deepEqual(conditionImmunitiesFromRuleElements([{ruleElements: effect.ruleElements}]), ["invisible"]);
  assert.deepEqual(wisp.notes, []);
});

test("an effect with no status whose text names the condition it gives is that condition (a Poisoned Needle's)", () => {
  const needle = convertItem(doc("equipment", "Poisoned Needle", "poisoned-needle", {description: {value: "<p>The creature makes a DC 11 "
    + "Constitution saving throw. On a failed save, the creature takes 5 (1d10) Poison damage and has the &amp;Reference[Poisoned apply=false] "
    + "condition for 1 hour.</p>"}, activities: {a: passive("save", {name: "Trigger (1-4)", effects: [{_id: "needle", onSave: false}],
    save: {ability: "con", dc: {calculation: "", formula: "11"}}, damage: {onSave: "half", parts: [{number: 1, denomination: 10, types: ["poison"]}]}})}},
  [{_id: "needle", name: "Poisoned Needle", statuses: [], duration: {value: 3600, units: "seconds"}}]));
  const sprung = actions(needle)[0].system.definition.area.persistence.triggers[0].action;
  assert.deepEqual(sprung.effects, [{id: "effect-1", type: "condition", conditionId: "poisoned", saveOutcomePolicy: "failure",
    duration: {value: 3600, units: "seconds"}}]);
  assert.equal(needle.notes.some(note => note.includes("marks its creature")), false);
});

test("uses dnd5e leaves without an activation: by hand (a Bag of Beans' Utilize, a Skull's free summon), a potion's Use Poison, a Candle's Light", () => {
  const beans = convertItem(doc("equipment", "Bag of Beans", "bag-of-beans", {uses: {max: "10", recovery: []}, activities: {
    a: activity("save", {name: "Dump Beans", activation: {type: "special"}, range: {units: "self"}, target: {template: {type: "sphere", size: "10"}, affects: {}},
      save: {ability: "dex", dc: {formula: "15"}}, damage: {onSave: "half", parts: [{number: 5, denomination: 4, types: ["force"]}]},
      consumption: {targets: [{type: "itemUses", value: "1"}]}})}}));
  const dump = actions(beans)[0].system.definition;
  assert.deepEqual(dump.costs.allOf[0], {capability: "action", amount: 1});
  assert.equal(dump.save.dc.value, 15);
  const skull = convertItem(doc("consumable", "Skull", "skull", {type: {value: "trinket"}, activities: {a: passive("summon", {name: "Card Effect",
    profiles: [{count: "1", uuid: "Compendium.dnd5e.actors24.Actor.dmgAvatarofDeath"}]})}}),
  {creatures: {dmgAvatarofDeath: "Compendium.wildpath.srd-creatures.Actor.dmgAvatarofDeath"}});
  const summon = actions(skull)[0].system.definition;
  assert.deepEqual([summon.costs, summon.summon.actorRef], [{allOf: []}, "Compendium.wildpath.srd-creatures.Actor.dmgAvatarofDeath"]);
  assert.deepEqual(skull.notes, []);
  const serum = convertItem(doc("consumable", "Truth Serum", "truth-serum", {type: {value: "potion"}, activities: {a: passive("save", {name: "Use Poison",
    save: {ability: "con", dc: {formula: "10"}}, effects: [{_id: "poisoned"}]})}}, [{_id: "poisoned", name: "Poisoned", statuses: ["poisoned"]}]));
  const use = actions(serum)[0].system.definition;
  assert.deepEqual([use.costs.allOf[0], use.range, use.targeting.type], [{capability: "action", amount: 1},
    {type: "ranged", normal: {value: 5, unit: "ft"}}, "single"]);
  const candle = convertItem(doc("consumable", "Candle", "candle", {type: {value: "trinket"}, activities: {a: passive("utility", {name: "Light"})}}));
  const lit = actions(candle)[0].system.definition;
  assert.deepEqual(lit.costs.allOf[0], {capability: "bonus-action", amount: 1});
  assert.deepEqual(lit.effects[0].ruleElements[0].data, {bright: 5, dim: 10});
  assert.deepEqual(candle.notes, []);
});

test("Deck of Many Things cards are Actions their gear brings, spending the card's one use; Freeze is its feature's own Trigger", () => {
  const card = identifier => convertItem(doc("consumable", identifier, identifier, {type: {value: "trinket"}, uses: {max: "1", recovery: []},
    activities: {a: passive("utility", {name: "Card Effect", consumption: {targets: [{type: "itemUses", value: "1"}]}})}}));
  const fool = card("fool");
  const [gear, action] = fool.items;
  assert.equal(gear.type, "gear");
  assert.deepEqual(gear.flags.wildpath.grants, [action._id], "the card brings its Action");
  assert.deepEqual(action.system.definition.costs, {allOf: [{capability: "fool", amount: 1}]}, "drawn once: it spends its use");
  assert.deepEqual(action.system.ruleElements.find(rule => rule.type === "GrantResource").data.maximum, {type: "constant", value: 1});
  assert.deepEqual(action.system.definition.effects[0].duration, {value: 72, units: "hours"});
  assert.deepEqual(action.system.definition.effects[0].ruleElements[0].data, {domains: ["attack", "check", "save"], mode: "disadvantage"});
  assert.deepEqual(fool.notes, []);
  assert.equal(actions(card("euryale"))[0].system.definition.effects[0].ruleElements[0].data.value, -2);
  assert.deepEqual(actions(card("sun"))[0].system.definition.costs, {allOf: [{capability: "sun", amount: 1}]});
  const dawn = actions(card("sun"))[0].system.definition.effects[0].ruleElements[0].data;
  assert.deepEqual([dawn.event, dawn.action.healing[0].healingType, dawn.action.healing[0].expression.value], ["rest.completed", "temporary", 10]);
  for ( const item of [action, actions(card("sun"))[0]] ) valid(item);

  const freeze = convertItem(doc("feat", "Freeze", "freeze", {activities: {a: activity("utility", {name: "Use", activation: {type: "special"}})}}));
  assert.deepEqual(freeze.items.map(item => item.type), ["feature"], "no clickable Action: a free reaction is its feature's Trigger");
  const trigger = freeze.items[0].system.ruleElements.find(rule => rule.type === "Trigger").data;
  assert.deepEqual([trigger.policy, trigger.match.tagsAll, trigger.action.effects[0].ruleElements[0].data.value], ["always", ["damage:cold"], -20]);
  assert.deepEqual(freeze.notes, []);
});

test("a talisman burns its holder at the end of its turn by creature type; a Robe of Eyes blinds its wearer when Light is cast on it", () => {
  const talisman = convertItem(doc("equipment", "Talisman of Pure Good", "talisman-of-pure-good", {type: {value: "wondrous"}, activities: {
    a: passive("damage", {name: "Fiend and Undead Damage", target: {affects: {count: "1", type: "creature"}, template: {}},
      damage: {parts: [{number: 8, denomination: 6, types: ["radiant"]}]}})}}));
  const [burn] = talisman.items[0].system.ruleElements;
  assert.deepEqual([burn.type, burn.data.event, burn.data.action.damage[0].damageType, burn.data.action.targeting], ["Trigger", "turn.ended",
    "radiant", {type: "self"}]);
  const of = type => ({actor: {system: {details: {type}}}});
  assert.equal(evaluatePredicate(burn.data.predicate, of("undead")).ok, true);
  assert.equal(evaluatePredicate(burn.data.predicate, of("humanoid")).ok, false);
  assert.deepEqual(talisman.notes, []);

  const robe = convertItem(doc("equipment", "Robe of Eyes", "robe-of-eyes", {type: {value: "wondrous"}, activities: {
    a: passive("save", {name: "Light Save", save: {ability: "con", dc: {formula: "11"}}}),
    b: passive("save", {_id: "actdaylight", name: "Daylight Save", save: {ability: "con", dc: {formula: "15"}}})}}));
  const [light] = robe.items[0].system.ruleElements;
  assert.deepEqual([light.data.kind, light.data.policy, light.data.match.tagsAll], ["reaction", "always", ["spell:light"]]);
  assert.deepEqual(light.data.action.effects[0].metadata.repeatSave, {timing: "turnEnd", ability: "fortitude", dc: 11});
  assert.deepEqual(robe.notes, ["\"Daylight Save\" is passive or triggered: not automated"], "Daylight's 5 feet stays by hand");
});

test("a swallower's damage at the start of each of its turns, which dnd5e leaves without an activation, is its condition's", () => {
  const swallow = convertItem(doc("feat", "Swallow", "swallow", {description: {value: "<p>A swallowed creature has the Restrained condition and "
    + "takes 21 (6d6) Acid damage at the start of each of its turns.</p>"}, activities: {
    a: activity("save", {save: {ability: "dex", dc: {formula: "20"}}, effects: [{_id: "held", onSave: false}], damage: {parts: []}}),
    b: passive("damage", {_id: "actturn", name: "Damage: Swallowed", damage: {parts: [{number: 6, denomination: 6, types: ["acid"]}]}})}},
  [{_id: "held", name: "Restrained", statuses: ["restrained"]}]));
  assert.equal(actions(swallow).length, 1, "the later damage is no Action");
  const turn = actions(swallow)[0].system.definition.effects.find(effect => effect.type === "effect").ruleElements[0].data;
  assert.deepEqual([turn.event, turn.predicate, turn.action.damage[0].damageType], ["turn.started", {hasCondition: "restrained"}, "acid"]);
  assert.deepEqual(swallow.notes, []);
});

test("a lasting area repeats its own passive save (Wall of Thorns' Slashing; Stinking Cloud's start of turn in its fog)", () => {
  const thorns = convertItem(doc("spell", "Wall of Thorns", "wall-of-thorns", {level: 6, preparation: {mode: "prepared"}, properties: ["concentration"],
    duration: {value: "10", units: "minute"}, range: {value: "120", units: "ft"},
    description: {value: "<p>The first time a creature enters a space in the wall on a turn or ends its turn there, it makes a Dexterity saving throw. "
      + "A creature makes this save only once per turn.</p>"},
    activities: {a: activity("save", {name: "Create Wall", target: {template: {type: "wall", size: "60", width: "5", height: "10"}, affects: {}},
      save: {ability: "dex", dc: {calculation: "spellcasting"}}, damage: {onSave: "half", parts: [{number: 7, denomination: 8, types: ["piercing"]}]}}),
    b: passive("save", {_id: "acttraverse", name: "Traversal Save", save: {ability: "dex", dc: {calculation: "spellcasting"}},
      damage: {onSave: "half", parts: [{number: 7, denomination: 8, types: ["slashing"]}]}})}}));
  const [wall] = actions(thorns);
  const [trigger, ...rest] = wall.system.definition.area.persistence.triggers;
  assert.deepEqual([trigger.on, trigger.once, rest, wall.system.definition.area.persistence.oncePerTurn],
    [["area.entered", "turn.ended"], undefined, [], undefined], "\"only once per turn\": one trigger on the area's shared record");
  assert.equal(wall.system.definition.damage[0].damageType, "piercing", "its creation is Piercing");
  assert.equal(trigger.action.damage[0].damageType, "slashing", "its repeat is its Traversal Save's");
  assert.equal(thorns.notes.some(note => note.includes("Traversal Save")), false);

  // Without that limit each is its own trigger: entering on its turn and ending it there hits twice (Wall of Fire), entering
  // "for the first time on a turn" once a turn on its own record, and an entering with no such words every time (Grease).
  const unlimited = text => actions(convertItem(doc("spell", "Wall of Thorns", "wall-of-thorns", {level: 6, preparation: {mode: "prepared"}, properties: ["concentration"], duration: {value: "10", units: "minute"}, range: {value: "120", units: "ft"},
    description: {value: `<p>${text}</p>`},
    activities: {a: activity("save", {name: "Create Wall", target: {template: {type: "wall", size: "60", width: "5", height: "10"}, affects: {}},
      save: {ability: "dex", dc: {calculation: "spellcasting"}}, damage: {onSave: "half", parts: [{number: 7, denomination: 8, types: ["piercing"]}]}}),
    b: passive("save", {_id: "acttraverse", name: "Traversal Save", save: {ability: "dex", dc: {calculation: "spellcasting"}},
      damage: {onSave: "half", parts: [{number: 7, denomination: 8, types: ["slashing"]}]}})}})))[0].system.definition.area.persistence;
  const fire = unlimited("A creature takes the same damage when it enters the wall for the first time on a turn or ends its turn there.");
  assert.deepEqual([fire.oncePerTurn, fire.triggers.map(entry => [entry.on, entry.once, entry.action.damage[0].damageType])],
    [false, [[["area.entered"], "turn", "slashing"], [["turn.ended"], undefined, "slashing"]]]);
  const grease = unlimited("A creature that enters the area or ends its turn there must also succeed on that save or fall Prone.");
  assert.deepEqual([grease.oncePerTurn, grease.triggers.map(entry => [entry.on, entry.once])],
    [false, [[["area.entered"], undefined], [["turn.ended"], undefined]]]);

  const cloud = convertItem(doc("spell", "Stinking Cloud", "stinking-cloud", {level: 3, preparation: {mode: "prepared"}, properties: ["concentration"],
    duration: {value: "1", units: "minute"}, range: {value: "90", units: "ft"},
    description: {value: "<p>The cloud is Heavily Obscured. Each creature that starts its turn in the Sphere must succeed on a Constitution saving throw "
      + "or have the Poisoned condition until the end of the current turn.</p>"},
    activities: {a: activity("utility", {name: "Create Cloud", target: {template: {type: "sphere", size: "20"}, affects: {}}}),
      b: passive("save", {_id: "actstart", name: "Start of Turn Save", save: {ability: "con", dc: {calculation: "spellcasting"}},
        effects: [{_id: "stink", onSave: false}], damage: {parts: []}})}},
  [{_id: "stink", name: "Stinking Poison", statuses: ["poisoned"], duration: {value: 1, units: "turns", expiry: "turnStart"}}]));
  const persistence = actions(cloud)[0].system.definition.area.persistence;
  assert.equal(persistence.obscures, "heavily");
  assert.deepEqual(persistence.triggers[0].on, ["turn.started"]);
  const [poisoned, capped] = persistence.triggers[0].action.effects;
  assert.deepEqual([poisoned.conditionId, capped.ruleElements[0].data], ["poisoned", {resources: ["action", "bonus"], maximum: 0}]);
  assert.deepEqual(cloud.notes.filter(note => !note.startsWith("concentration")), []);
});

// Damage for each stretch moved in a lasting area (Spike Growth's shape): one damage activity, its area Difficult Terrain.
const thorns = text => doc("spell", "Test Thorns", "test-thorns", {level: 2, preparation: {mode: "prepared"},
  properties: ["concentration"], duration: {value: "10", units: "minute"}, range: {value: "150", units: "ft"},
  target: {template: {type: "sphere", size: "20"}, affects: {type: "creature"}},
  description: {value: `<p>The area becomes Difficult Terrain for the duration. ${text}</p>`},
  activities: {a: activity("damage", {consumption: {targets: [], spellSlot: true},
    damage: {parts: [{number: 2, denomination: 4, types: ["piercing"], scaling: {mode: "", number: 1}}]}})}});

test("an area that hurts for every 5 feet moved in it repeats its damage per distance on each step, and its cast hurts nobody", () => {
  const converted = convertItem(thorns("When a creature moves into or within the area, it takes 2d4 Piercing damage for every 5 feet it travels."));
  const [cast] = actions(converted);
  valid(cast);
  const {damage, area} = cast.system.definition;
  assert.equal(damage, undefined, "casting only makes the area: a creature already in it takes nothing yet");
  assert.deepEqual([area.persistence.difficultTerrain, area.persistence.triggers.map(({on, per}) => [on, per])],
    [{types: []}, [[["area.moved"], 5]]]);
  const [{action}] = area.persistence.triggers;
  assert.deepEqual(action.damage.map(part => [part.expression, part.damageType]), [[{type: "dice", number: 2, faces: 4}, "piercing"]]);
  assert.equal(action.save, undefined);
  // Other wording ("for every 5 feet traveled" as it is shunted out of an object) is no area's distance damage.
  const shunted = actions(convertItem(thorns("If it ends its turn inside an object, it is shunted out and takes 1d10 Force damage for every 5 feet traveled.")))[0];
  assert.deepEqual(shunted.system.definition.area.persistence.triggers, [], "it stays as before");
});

// A utility cast whose area repeats two passive activities, each on its own turn boundary (Hunger of Hadar's shape).
const gateway = ({text, end=null, scaling={mode: "whole", number: 1}}={}) => doc("spell", "Test Gateway", "test-gateway", {level: 3,
  preparation: {mode: "prepared"}, properties: ["concentration"], duration: {value: "1", units: "minute"}, range: {value: "150", units: "ft"},
  target: {template: {type: "sphere", size: "20"}, affects: {}},
  description: {value: text ?? "<p>The Sphere is Difficult Terrain, and its noises can be heard 30 feet away. Any creature that starts its turn in "
    + "the area takes 2d6 Cold damage. Any creature that ends its turn there must succeed on a Dexterity saving throw or take 2d6 Acid damage. "
    + "The Cold or Acid damage (your choice) increases by 1d6 for each spell slot level above 3.</p>"},
  activities: {a: activity("utility", {name: "Open Gateway"}),
    b: passive("damage", {_id: "actstart", name: "Start of Turn Damage", consumption: {targets: [], spellSlot: false},
      damage: {parts: [{number: 2, denomination: 6, types: ["cold"], scaling}]}}),
    c: end ?? passive("save", {_id: "actend", name: "End of Turn Save", consumption: {targets: [], spellSlot: false},
      save: {ability: "dex", dc: {calculation: "spellcasting"}}, damage: {onSave: "none", parts: [{number: 2, denomination: 6, types: ["acid"], scaling}]}})}});

test("a lasting area repeats each of several passive activities on its own turn boundary, and a higher slot scales the one chosen", async () => {
  const {resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const converted = convertItem(gateway());
  const [cast] = actions(converted);
  valid(cast);
  const {targeting, area, configuration} = cast.system.definition;
  assert.deepEqual([targeting, area.shape, area.size.value], [{type: "area"}, "radial", 20], "the utility is placed by its template");
  const {persistence} = area;
  // Each boundary comes once a turn; sharing once per turn would let the start of a turn spend the end's.
  assert.deepEqual([persistence.oncePerTurn, persistence.difficultTerrain, persistence.triggers.map(trigger => trigger.on)],
    [false, {types: []}, [["turn.started"], ["turn.ended"]]], "a \"can\" after Difficult Terrain doesn't refuse it");
  const [cold, acid] = persistence.triggers.map(trigger => trigger.action);
  assert.deepEqual([cold.damage[0].damageType, cold.save, acid.damage[0].damageType, acid.save.ability], ["cold", undefined, "acid", "agility"]);
  assert.notEqual(cold.id, acid.id);
  assert.deepEqual(converted.notes, ["area: what else its description says is by hand"]);
  assert.equal(noteReason(converted.notes[0]), "area: what else its text says (by hand)", "not filed as an inert utility");
  const upcast = configuration.find(choice => choice.id === "upcast-damage");
  assert.deepEqual(upcast.options.map(option => [option.id, option.label]), [["cold", "WILDPATH.DAMAGE.Cold"], ["acid", "WILDPATH.DAMAGE.Acid"]]);
  assert.equal(upcast.defaultValue, "cold", "preselected, so a cast at its own level needs no pick");
  const resolved = resolveActionConfiguration({definition: cast.system.definition, actorSystem: {resources: {action: {value: 1, max: 1}},
    pools: [{id: "spell-slot.5", value: 1, max: 1}]}, choices: {"spell-slot": {resourceId: "spell-slot.5"}, "upcast-damage": {optionId: "acid"}}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const scaled = resolved.configuration.effectiveDefinition.area.persistence.triggers.map(trigger => trigger.action.damage[0].expression.number);
  assert.deepEqual(scaled, [2, 4], "a 5th-level slot: only the Acid gains 2d6");

  // With no choice in its text, a higher slot scales every repeat.
  const both = actions(convertItem(gateway({text: "<p>Any creature that starts its turn in the area takes 2d6 Cold damage. Any creature that "
    + "ends its turn there must succeed on a Dexterity saving throw or take 2d6 Acid damage.</p>"})))[0].system.definition;
  assert.equal(both.configuration.some(choice => choice.id === "upcast-damage"), false);
  assert.deepEqual(both.configuration[0].effects.map(effect => effect.componentIds[0]), ["lasting-1-damage-1", "lasting-2-damage-1"]);

  // Two passive saves one sentence names, with no turn boundary (Symbol's options): no lasting area.
  const glyphs = actions(convertItem(gateway({text: "<p>Each creature in the area makes a Dexterity saving throw or takes 2d6 Cold damage.</p>",
    end: passive("save", {_id: "actend", name: "Other Glyph", save: {ability: "dex", dc: {calculation: "spellcasting"}},
      damage: {parts: [{number: 2, denomination: 6, types: ["cold"]}]}})})))[0].system.definition;
  assert.equal(glyphs.area, undefined);

  assert.equal(persistence.triggers.some(trigger => "once" in trigger), false, "boundaries alone need no record of their own");

  // One that answers entering keeps its own once a turn, so it neither repeats nor cancels the turn end's save.
  const [entering] = actions(convertItem(gateway({text: "<p>Any creature that enters the area for the first time on a turn or starts its turn "
    + "there takes 2d6 Cold damage. Any creature that ends its turn there must succeed on a Dexterity saving throw or take 2d6 Acid damage.</p>"})));
  valid(entering);
  const lasting = entering.system.definition.area.persistence;
  assert.deepEqual([lasting.oncePerTurn, lasting.triggers.map(trigger => [trigger.on, trigger.once])],
    [false, [[["turn.started", "area.entered"], "turn"], [["turn.ended"], undefined]]]);
});

test("a creature casting a spell whose repeats it chooses to scale keeps the slot level the choice reads", async () => {
  const {resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const spell = {...gateway(), _id: "testGateway00001"};
  const casting = doc("feat", "Test Gateway", "test-gateway-cast", {activities: {a: activity("cast", {consumption: {targets: [], spellSlot: true},
    spell: {uuid: "Compendium.dnd5e.spells24.Item.testGateway00001", level: 5, ability: "cha"}})}});
  const [cast] = actions(convertItem(casting, {spells: {testGateway00001: spell}, creature: {}}));
  valid(cast);
  const slot = cast.system.definition.configuration.find(choice => choice.id === "spell-slot");
  assert.deepEqual([slot.fromCast, slot.options.map(option => option.value)], [true, [5]]);
  const resolved = resolveActionConfiguration({definition: cast.system.definition, actorSystem: {resources: {action: {value: 1, max: 1}}},
    choices: {"spell-slot": {optionId: "level-5"}, "upcast-damage": {optionId: "cold"}}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.configuration.effectiveDefinition.area.persistence.triggers.map(trigger => trigger.action.damage[0].expression.number),
    [4, 2], "its level 5 version: the Cold gains 2d6");
});

test("an activation-less hazard is set by the GM as a lasting area: its template, its reach, its tiers, and only with a sentence naming it", () => {
  const save = (id, name, ability, dc, number, type) => passive("save", {_id: id, name, save: {ability: [ability], dc: {calculation: "", formula: dc}},
    damage: {onSave: "half", parts: [{number, denomination: 10, types: [type]}]}});
  const square = passive("utility", {_id: "actsquare", name: "10-Foot Square", target: {template: {type: "square", size: "10"}, affects: {}}});
  const mold = convertItem(doc("feat", "Test Mold", "test-mold", {description: {value: "<p>One patch covers a 10-foot square. When a creature "
    + "enters a space within 5 feet of the mold for the first time on a turn or starts its turn there, the creature makes a DC 12 Constitution "
    + "saving throw, taking 22 (4d10) Cold damage on a failed save.</p>"}, activities: {a: save("actsave", "", "con", "12", 4, "cold"), b: square}}));
  const [patch] = actions(mold);
  valid(patch);
  const {area, costs, range} = patch.system.definition;
  assert.deepEqual([costs, range, area.shape, area.size.value, area.persistence.duration, area.persistence.triggers[0].on],
    [{allOf: []}, {type: "special"}, "cube", 20, null, ["area.entered", "turn.started"]], "its 10-foot square and 5 feet around it");
  assert.equal(area.persistence.triggers[0].action.damage[0].damageType, "cold");
  assert.deepEqual(mold.notes, ["hazard: what else its description says is by hand"], "its placing utility is the area, not a passive note");
  assert.equal(noteReason(mold.notes[0]), "hazard: what else its text says (by hand)");
  // A Hazard Actor's copy is an item named "Description/Effects": its Action and area take the Actor's name.
  const held = actions(convertItem(doc("feat", "Description/Effects", "description-effects", {description: {value: "<p>When a creature enters "
    + "a space within 5 feet of the mold for the first time on a turn, the creature makes a DC 12 Constitution saving throw, taking 22 (4d10) "
    + "Cold damage on a failed save.</p>"}, activities: {a: save("actsave", "", "con", "12", 4, "cold"), b: square}}),
  {creature: {name: "Test Mold", itemNames: {}}}))[0];
  assert.deepEqual([held.name, held.system.definition.label, held.system.definition.area.persistence.triggers[0].action.label],
    ["Test Mold (save)", "Test Mold (save)", "Test Mold"]);
  // A radius widens once by its reach, not on both sides.
  const ring = actions(convertItem(doc("feat", "Test Ring", "test-ring", {description: {value: "<p>When a creature enters a space within 5 feet "
    + "of the ring for the first time on a turn, it makes a DC 12 Constitution saving throw, taking 22 (4d10) Cold damage.</p>"}, activities: {
    a: save("actsave", "", "con", "12", 4, "cold"), b: passive("utility", {_id: "actcircle", name: "Circle", target: {template: {type: "sphere",
      size: "10"}, affects: {}}})}})))[0].system.definition.area;
  assert.deepEqual([ring.shape, ring.size.value], ["radial", 15]);

  const gas = convertItem(doc("feat", "Test Gas", "test-gas", {description: {value: "<p>Any creature that enters the gas for the first time on "
    + "a turn or starts its turn there makes a DC 12 Constitution saving throw, taking 5 (1d10) Poison damage.</p>"}, activities: {
    a: passive("utility", {_id: "actplace", name: "Place Gas", target: {template: {type: "cube", size: "10"}, affects: {}}}),
    b: save("acttier1", "Level 1-4 Save", "con", "12", 1, "poison"), c: save("acttier2", "Level 5-10 Save", "con", "14", 2, "poison")}}));
  assert.deepEqual(actions(gas).map(tier => [tier.name, tier.system.definition.area.size.value,
    tier.system.definition.area.persistence.triggers[0].action.save.dc.value]), [["Test Gas (Level 1-4 Save)", 10, 12], ["Test Gas (Level 5-10 Save)", 10, 14]]);

  const webs = convertItem(doc("feat", "Test Webs", "test-webs", {description: {value: "<p>These areas are Difficult Terrain. A creature that "
    + "enters the webs for the first time on a turn or starts its turn there must succeed on a DC 12 Dexterity saving throw. Each 10-foot Cube "
    + "of webs has AC 10.</p>"}, activities: {a: passive("save", {_id: "actweb", save: {ability: ["dex"], dc: {formula: "12"}}, damage: {parts: []}})}}));
  const web = actions(webs)[0].system.definition.area;
  assert.deepEqual([web.size.value, web.persistence.difficultTerrain], [10, {types: []}], "the Cube its text names");

  // One whose sentence names neither its save nor its damage (a Vicious Vine's coiling) stays by hand.
  const vine = convertItem(doc("feat", "Test Vine", "test-vine", {description: {value: "<p>When a creature enters a space within 5 feet of the "
    + "vine for the first time on a turn, the vine tries to coil around it. The target must succeed on a DC 12 Dexterity saving throw.</p>"},
  activities: {a: save("actvine", "Save Level 1-4", "dex", "12", 1, "necrotic")}}));
  assert.deepEqual([actions(vine).length, vine.notes], [0, ["\"Save Level 1-4\" is passive or triggered: not automated"]]);
  // Nor is one with any activation (Fireball Fungus).
  const fungus = convertItem(doc("feat", "Test Fungus", "test-fungus", {description: {value: "<p>A creature that enters it for the first time on "
    + "a turn makes a DC 12 Dexterity saving throw, taking Fire damage.</p>"}, activities: {a: activity("save", {activation: {type: "special"},
    save: {ability: ["dex"], dc: {formula: "12"}}, damage: {parts: [{number: 1, denomination: 10, types: ["fire"]}]}})}}));
  assert.equal(actions(fungus)[0]?.system.definition.area?.persistence, undefined);
});

test("a golem made over days is still summoned, spending the manual's one use (its long activation is informational)", () => {
  const golem = name => activity("summon", {_id: `act${name.toLowerCase()}`, name: `Create ${name} Golem`, activation: {type: "special"},
    profiles: [{count: "", uuid: `Compendium.dnd5e.actors24.Actor.${name.toLowerCase()}`}]});
  const manual = convertItem(doc("equipment", "Manual of Golems", "manual-of-golems", {type: {value: "wondrous"}, description: {value: "<p>Once "
    + "you finish creating the golem, the book is consumed in eldritch flames.</p>"}, activities: {a: golem("Clay"), b: golem("Iron")}}),
  {creatures: {clay: "Compendium.wildpath.srd-creatures.Actor.clay", iron: "Compendium.wildpath.srd-creatures.Actor.iron"}});
  assert.equal(actions(manual)[0].system.definition.summon.actorRef, "Compendium.wildpath.srd-creatures.Actor.clay");
  // One golem in all: each of its summons spends the same single use, which nothing refills.
  for ( const made of actions(manual) ) {
    assert.deepEqual(made.system.definition.costs, {allOf: [{capability: "manual-of-golems", amount: 1}]});
    assert.deepEqual(made.system.ruleElements.find(rule => rule.type === "GrantResource").data,
      {resourceId: "manual-of-golems", label: "Manual of Golems", maximum: {type: "constant", value: 1}, recovery: "none"});
  }
  assert.deepEqual(realGapNotes(manual.notes), []);
});

test("Summon Dragon: its caster chooses a Shared Resistance; the spirit's own activities are that choice; Dragon Companion casts it free", () => {
  const spell = convertItem(doc("spell", "Summon Dragon", "summon-dragon", {level: 5, preparation: {mode: "prepared"}, properties: ["concentration"],
    duration: {value: "1", units: "hour"}, range: {value: "60", units: "ft"}, activities: {a: activity("summon", {profiles: [{count: "",
      uuid: "Compendium.dnd5e.actors24.Actor.spirit"}]})}}), {creatures: {spirit: "Compendium.wildpath.srd-creatures.Actor.spirit"}});
  const definition = actions(spell)[0].system.definition;
  const choice = definition.configuration.find(entry => entry.id === "summoner-gains");
  assert.deepEqual(choice.options.map(option => option.id), ["acid", "cold", "fire", "lightning", "poison"]);
  assert.deepEqual(choice.effects, [{type: "keepEffect", effectIds: ["acid", "cold", "fire", "lightning", "poison"]}]);
  assert.deepEqual(definition.effects.map(effect => [effect.appliesTo, effect.concentration, effect.ruleElements[0].data.damageTypes]),
    ["acid", "cold", "fire", "lightning", "poison"].map(type => ["source", true, [type]]));
  valid({name: "Summon Dragon", system: {definition: {...definition, label: "Summon Dragon"}}});

  const shared = convertItem(doc("feat", "Shared Resistances", "shared-resistances", {description: {value: "<p>You have Resistance.</p>"},
    activities: {a: passive("utility", {name: "Share Acid Resistance"})}}));
  assert.deepEqual(shared.notes, []);

  const companion = convertItem(doc("feat", "Dragon Companion", "dragon-companion", {uses: {max: "1", recovery: [{period: "lr", type: "recoverAll"}]},
    activities: {a: passive("utility", {name: "Expend Use"})}}));
  const [feature] = companion.items;
  assert.deepEqual(feature.flags.wildpath.freeCast, {spells: ["summon-dragon"], resourceId: "free-cast.dragon-companion"});
  assert.deepEqual(feature.system.ruleElements.map(rule => rule.data.resourceId), ["free-cast.dragon-companion"], "its dnd5e uses are this pool");
  assert.deepEqual(companion.notes, ["free cast: Summon Dragon without Concentration (1 minute) is by hand"]);
  assert.equal(noteReason(companion.notes[0]), "free cast: an option of its cast (by hand)");
});

test("Robe of Scintillating Colors: its light and Disadvantage on its wearer, the others' Stun save, its save activity folded in", () => {
  const robe = convertItem(doc("equipment", "Robe of Scintillating Colors", "robe-of-scintillating-colors", {type: {value: "wondrous"},
    uses: {max: "3", recovery: []}, activities: {
      a: passive("save", {save: {ability: "wis", dc: {formula: "15"}}, effects: [{_id: "stun", onSave: false}]}),
      b: activity("utility", {_id: "acthues", name: "Display Dazzling Hues", consumption: {targets: [{type: "itemUses", value: "1"}]},
        target: {template: {type: "radius", size: "30"}, affects: {type: "self"}}})}}, [{_id: "stun", name: "Stunned", statuses: ["stunned"]}]));
  const hues = actions(robe).find(item => item.name.endsWith("(Display Dazzling Hues)"));
  const {save, area, effects} = hues.system.definition;
  assert.deepEqual([save, area.shape, area.size.value], [{ability: "wits", dc: {value: 15}}, "emanation", 30]);
  assert.deepEqual(effects.map(effect => [effect.conditionId ?? effect.appliesTo, effect.duration]),
    [["stunned", {value: 1, units: "rounds", expiry: "sourceTurnEnd"}], ["source", {value: 1, units: "rounds", expiry: "sourceTurnEnd"}]]);
  assert.deepEqual(effects[1].ruleElements.map(rule => rule.type), ["GrantLight", "RollMode"]);
  valid(hues);
  assert.deepEqual(robe.notes, []);
});

test("a save whose failure only tells or sends its creature off the Scene is narrative: by document (Heart Sight) or activity (Violet)", () => {
  const save = {save: {ability: "cha", dc: {formula: "12"}}, damage: {parts: []}};
  const sight = convertItem(doc("feat", "Heart Sight", "heart-sight", {activities: {a: activity("save", save)}}));
  assert.deepEqual(sight.notes, ["rolled (save, narrative): who failed is all there is; its description says the rest"]);
  assert.equal(noteReason(sight.notes[0]), "narrative save (it tells or hides; nothing to automate)");
  assert.deepEqual(realGapNotes(sight.notes), []);
  const spray = convertItem(doc("spell", "Test Spray", "test-spray", {level: 7, preparation: {mode: "prepared"},
    activities: {a: activity("save", {...save, name: "Violet Save (Wis)"}), b: activity("save", {...save, _id: "actother", name: "Other Save"})}}));
  assert.deepEqual(realGapNotes(spray.notes), ["rolled (save); what it does is by hand"], "only the violet ray is narrative");
  // A concentration save's marker on those that fail (Dispel Evil and Good's Dismissal).
  const dismissal = convertItem(doc("spell", "Dispel Evil and Good", "dispel-evil-and-good", {level: 5, preparation: {mode: "prepared"},
    properties: ["concentration"], activities: {a: activity("save", {...save, name: "Dismissal"})}}));
  assert.ok(dismissal.notes.includes("save: a failure marks its creature (narrative)"));
});

test("a failed save's conditions from its text: 'or the target has', its size limit, escape DC, duration, a second condition, Exhaustion", () => {
  const save = (ability, dc) => activity("save", {save: {ability, dc: {formula: dc}}, damage: {parts: []}});
  const hand = convertItem(doc("feat", "Grasping Hand", "grasping-hand", {description: {value: "<p>The hand attempts to grapple a Huge or smaller "
    + "creature within 5 feet of it. The target must succeed on a Dexterity saving throw, or the target has the &amp;Reference[Grappled] condition, "
    + "with an escape DC equal to your spell save DC.</p>"}, activities: {a: save("dex", "15")}}));
  assert.deepEqual(actions(hand)[0].system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "grappled",
    saveOutcomePolicy: "failure", maxSize: "huge", metadata: {escapeDC: 15}}]);
  assert.deepEqual(hand.notes, []);
  const net = convertItem(doc("weapon", "Net", "net", {description: {value: "<p>The target must succeed on a Dexterity saving throw or have the "
    + "&amp;Reference[Restrained] condition until it escapes. The target succeeds automatically if it is Huge or larger. To escape, the target "
    + "must take an action to make a [[/skill ath 10]] check, freeing the Restrained creature on a success.</p>"}, activities: {a: save("dex", "12")}}));
  assert.deepEqual(actions(net)[0].system.definition.effects[0], {id: "effect-1", type: "condition", conditionId: "restrained",
    saveOutcomePolicy: "failure", maxSize: "large", metadata: {escapeDC: 10, escapeSkills: ["athletics"]}}, "its check is Athletics only");
  // Its own AC and Hit Points (destroying it frees its creature) are by hand.
  assert.deepEqual(net.notes, ["save: a failure gives restrained (its text); the rest is by hand"]);
  const mucus = convertItem(doc("consumable", "Crawler Mucus", "crawler-mucus", {type: {value: "poison"}, description: {value: "<p>A creature must "
    + "succeed on a DC 13 Constitution saving throw or have the &amp;Reference[Poisoned apply=false] condition for 1 minute. The creature also has "
    + "the &amp;Reference[Paralyzed apply=false] condition while Poisoned in this way. The creature repeats the save at the end of each of its "
    + "turns, ending the effect on itself on a success.</p>"}, activities: {a: save("con", "13")}}));
  const lasting = {saveOutcomePolicy: "failure", duration: {value: 1, units: "minutes"}, repeatSave: "turnEnd"};
  assert.deepEqual(actions(mucus)[0].system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "poisoned", ...lasting},
    {id: "effect-2", type: "condition", conditionId: "paralyzed", ...lasting}]);
  assert.deepEqual(mucus.notes, []);
  const ring = convertItem(doc("equipment", "Ring of X-ray Vision", "ring-of-x-ray-vision", {description: {value: "<p>Whenever you use the ring "
    + "again before taking a Long Rest, you must succeed on a DC 15 Constitution saving throw or gain 1 &amp;Reference[Exhaustion] level.</p>"},
  activities: {a: save("con", "15")}}));
  const tired = actions(ring).find(item => item.system.definition.save);
  assert.deepEqual(tired.system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "exhaustion", saveOutcomePolicy: "failure",
    levels: 1}]);
  valid(tired);
});

test("a summon's forms: those outside the SRD left out, one stat block for split forms, a higher slot's creatures from that slot", () => {
  const summon = (profiles, data={}) => activity("summon", {profiles, summon: {mode: ""}, ...data});
  const uuid = id => `Compendium.dnd5e.actors24.Actor.${id}`;
  const creatures = {mmImp: "Compendium.wildpath.srd-creatures.Actor.mmImp", mmSprite: "Compendium.wildpath.srd-creatures.Actor.mmSprite",
    phbmobGiantInsec: "Compendium.wildpath.srd-creatures.Actor.phbmobGiantInsec",
    mmGhoul: "Compendium.wildpath.srd-creatures.Actor.mmGhoul", mmGhast: "Compendium.wildpath.srd-creatures.Actor.mmGhast"};
  const chain = convertItem(doc("feat", "Pact of the Chain", "pact-of-the-chain", {activities: {a: summon([{uuid: uuid("mmImp")},
    {uuid: uuid("mmSprite")}, {uuid: uuid("mmSlaadTadpole00")}])}}), {creatures, names: {mmSlaadTadpole00: "Slaad Tadpole"}});
  assert.deepEqual(actions(chain)[0].system.definition.configuration.at(-1).options.map(option => option.id), [creatures.mmImp, creatures.mmSprite]);
  assert.deepEqual(chain.notes, ["summon: not in the SRD, so not offered: Slaad Tadpole"]);
  assert.deepEqual(realGapNotes(chain.notes), []);
  // A form no data names at all is still a gap.
  assert.ok(convertItem(doc("feat", "Pact of the Chain", "pact-of-the-chain", {activities: {a: summon([{uuid: uuid("mmImp")},
    {uuid: "Compendium.dnd5e.monsters.Actor.unknown"}])}}), {creatures}).notes.includes("summon: its creature is not among the converted creatures"));
  const insect = convertItem(doc("spell", "Giant Insect", "giant-insect", {level: 4, preparation: {mode: "prepared"}, description: {value:
    "<p>It uses the <strong>@UUID[Compendium.dnd5e.actors24.Actor.phbmobGiantInsec]{Giant Insect}</strong> stat block.</p>"},
  activities: {a: summon([{uuid: uuid("phbginGiantCenti")}, {uuid: uuid("phbginGiantSpide")}])}}), {creatures});
  assert.equal(actions(insect)[0].system.definition.summon.actorRef, creatures.phbmobGiantInsec);
  const undead = convertItem(doc("spell", "Create Undead", "create-undead", {level: 6, preparation: {mode: "prepared"},
    activities: {a: summon([{count: "@item.level - 3", uuid: uuid("mmGhoul")}, {count: "@item.level - 6", level: {min: 8}, uuid: uuid("mmGhast")}])}}),
  {creatures});
  const castLevel = {type: "context", path: "castLevel"};
  assert.deepEqual(actions(undead)[0].system.definition.summon.counts, [
    {actorRef: creatures.mmGhoul, count: {type: "subtract", terms: [castLevel, {type: "constant", value: 3}]}},
    {actorRef: creatures.mmGhast, count: {type: "table", key: castLevel, rows: {8: {type: "subtract", terms: [castLevel, {type: "constant", value: 6}]}},
      default: {type: "constant", value: 0}}}]);
  assert.deepEqual(realGapNotes(undead.notes), []);
});

test("a utility that only teleports: 'you teleport up to 30 feet', 'teleports itself or a willing demon ... up to 60 feet'; not one that attacks", () => {
  const teleport = (identifier, text, range) => convertItem(doc("feat", identifier, identifier, {description: {value: `<p>${text}</p>`},
    activities: {a: activity("utility", {activation: {type: "bonus"}, range: {value: range, units: "ft"}})}}));
  assert.deepEqual(actions(teleport("clouds-jaunt", "As a Bonus Action, you magically teleport up to 30 feet to an unoccupied space you can see.", "30"))[0]
    .system.definition.teleport, {distance: 30});
  assert.deepEqual(actions(teleport("teleport", "The balor teleports itself or a willing demon within 10 feet of itself up to 60 feet to an "
    + "unoccupied space the balor can see.", "60"))[0].system.definition.teleport, {distance: 60});
  const prowl = teleport("arcane-prowl", "The sphinx can teleport up to 30 feet to an unoccupied space it can see, and it makes one Claw attack.", "30");
  assert.equal(actions(prowl)[0].system.definition.teleport, undefined);
});

test("Break Enchantment ends Charmed and Frightened; Feather Fall takes a fall's damage off, cast from a ring with its Reaction", () => {
  const dispel = convertItem(doc("spell", "Dispel Evil and Good", "dispel-evil-and-good", {level: 5, preparation: {mode: "prepared"},
    activities: {a: activity("utility", {name: "Break Enchantment", range: {override: true, units: "touch"},
      target: {override: true, template: {}, affects: {count: "1", type: "creature"}}, consumption: {spellSlot: false, targets: []}})}}));
  assert.deepEqual(actions(dispel)[0].system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "charmed", levels: -1},
    {id: "effect-2", type: "condition", conditionId: "frightened", levels: -1}]);
  const feather = doc("spell", "Feather Fall", "feather-fall", {level: 1, preparation: {mode: "prepared"}, activation: {type: "reaction"},
    range: {value: "60", units: "ft"}, activities: {a: activity("utility", {activation: {type: "action", override: false}})}});
  feather._id = "phbsplFeatherFal";
  const spell = actions(convertItem(feather))[0];
  const trigger = spell.system.ruleElements.find(rule => rule.type === "Trigger").data;
  assert.deepEqual([trigger.event, trigger.match], ["damage.applied", {phase: "before", tagsAll: ["fall"]}]);
  assert.deepEqual(spell.system.definition.rider, {reduceDamage: {dice: {type: "constant", value: 120}}, protects: "target"});
  const ring = convertItem(doc("equipment", "Air Ring", "air-ring", {type: {value: "ring"}, activities: {
    a: activity("cast", {spell: {uuid: "Compendium.dnd5e.spells24.Item.phbsplFeatherFal", level: "1"}})}}), {spells: {phbsplFeatherFal: feather}});
  const cast = actions(ring).find(item => item.name === "Air Ring: Feather Fall");
  assert.deepEqual(cast.system.definition.costs, {allOf: [{capability: "reaction", amount: 1}]});
  assert.ok(cast.system.ruleElements.some(rule => rule.type === "Trigger"));
});

test("a summoned creature's move its summoner pays for (an Arcane Eye's Move); a creature's own Darkness Aura; an infernal wound", () => {
  const creature = (name, item) => ({_id: name.replace(/\W/g, "").padEnd(16, "0").slice(0, 16), name, type: "npc", items: [item],
    system: {source: SRD, details: {cr: 1}, abilities: {}, attributes: {hp: {max: 10}, movement: {walk: "30"}, ac: {calc: "natural", flat: 12}},
      traits: {size: "med"}}});
  const move = doc("feat", "Move", "move", {description: {value: "<p>As a Bonus Action, you can move the eye up to 30 feet in any direction.</p>"},
    activities: {a: activity("utility", {activation: {type: "bonus", condition: "Bonus Action used by summoner"}})}});
  const eye = convertActor(creature("Arcane Eye", move)).actor.items.find(item => item.name === "Move").system.definition;
  assert.deepEqual([eye.costs, eye.controllerCosts], [{allOf: []}, {allOf: [{capability: "bonus-action", amount: 1}]}]);
  assert.deepEqual(eye.effects[0].ruleElements[0].data, {domains: ["speed.dash"], modifierType: "untyped", value: 1}, "its Speed's worth: a Dash");
  const aura = doc("feat", "Darkness Aura", "darkness-aura", {activities: {a: activity("utility", {range: {units: "self"},
    target: {template: {type: "radius", size: "15", units: "ft"}, affects: {}}, duration: {units: "minute", value: "10", concentration: true}})}});
  const dark = convertActor(creature("Darkmantle", aura)).actor.items.find(item => item.name === "Darkness Aura").system.definition;
  assert.deepEqual(dark.area.persistence, {duration: {unit: "round", value: 100}, concentration: true,
    light: {bright: 15, darkness: true, spellLevel: 0}});
  const glaive = doc("feat", "Infernal Glaive", "infernal-glaive", {description: {value: "<p>Failure: The target receives an infernal wound. "
    + "While wounded, the target loses 5 (1d10) Hit Points at the start of each of its turns.</p>"}, activities: {
    a: activity("save", {save: {ability: "con", dc: {formula: "12"}}, damage: {parts: []}, duration: {units: "minute", value: "1"}}),
    b: passive("damage", {_id: "actwound", name: "Damage: Infernal Wound", damage: {parts: [{number: 1, denomination: 10, types: []}]}})}});
  const {actor, notes} = convertActor(creature("Bearded Devil", glaive));
  const wound = actor.items.filter(item => item.type === "action");
  assert.equal(wound.length, 1, "its later damage is no Action");
  const marker = wound[0].system.definition.effects[0];
  assert.deepEqual([marker.duration, marker.ruleElements[0].data.event, marker.ruleElements[0].data.predicate,
    marker.ruleElements[0].data.action.damage[0].damageType], [{value: 1, units: "minutes"}, "turn.started", undefined, "untyped"]);
  // Healing or a Medicine check ending the wound early is by hand.
  assert.deepEqual(realGapNotes(notes), ["Infernal Glaive: save: what ends its wound early (its text) is by hand"]);
});

test("a spell's damage at the start of each turn grows with a higher slot, as a table its slot choice binds (Ensnaring Strike)", () => {
  const strike = convertItem(doc("spell", "Ensnaring Strike", "ensnaring-strike", {level: 1, preparation: {mode: "prepared"},
    description: {value: "<p>The target has the &amp;Reference[Restrained] condition until the spell ends. While Restrained, the target takes "
      + "1d6 Piercing damage at the start of each of its turns.</p>"}, activities: {
      a: activity("save", {save: {ability: "str", dc: {calculation: "spellcasting"}}, damage: {parts: []}, effects: [{_id: "held"}]}),
      b: passive("damage", {_id: "actturn", name: "Start of Turn Damage", damage: {parts: [{number: 1, denomination: 6, types: ["piercing"],
        scaling: {mode: "whole", number: 1}}]}})}}, [{_id: "held", name: "Restrained", statuses: ["restrained"]}]));
  const turn = actions(strike)[0].system.definition.effects.find(effect => effect.ruleElements?.[0]?.type === "Trigger");
  const {key, rows} = turn.ruleElements[0].data.action.damage[0].expression;
  assert.deepEqual([key, rows[1], rows[2]], [{type: "constant", value: "{{spell-slot}}"}, {type: "dice", number: 1, faces: 6},
    {type: "dice", number: 2, faces: 6}]);
  assert.deepEqual(actions(strike)[0].system.definition.configuration.find(choice => choice.id === "spell-slot").effects.at(-1),
    {type: "bindChoice"});
  assert.deepEqual(realGapNotes(strike.notes), []);
});

test("an item's summon adds its wielder's ability (a Dancing Sword's Strength) to its attacks' damage", () => {
  const sword = convertItem(doc("weapon", "Dancing Sword", "dancing-sword", {activities: {a: activity("summon", {name: "Activate Sword: Stength",
    profiles: [{uuid: "Compendium.dnd5e.actors24.Actor.dmgDancingSword0"}], summon: {mode: ""}, bonuses: {attackDamage: "@mod"}})}}),
  {creatures: {dmgDancingSword0: "Compendium.wildpath.srd-creatures.Actor.dmgDancingSword0"}});
  assert.deepEqual(actions(sword)[0].system.definition.summon.bonuses, {attackDamage: {type: "ability-modifier", ability: "might"}});
  assert.deepEqual(realGapNotes(sword.notes), []);
});

test("Fire Opal Flames enchant a weapon and leave the helm's other uses; a Dagger of Venom's coating; an Oathbow's sworn enemy", () => {
  const helm = convertItem(doc("equipment", "Helm of Brilliance", "helm-of-brilliance", {activities: {
    a: activity("enchant", {name: "Fire Opal Flames", effects: [{_id: "flames"}]}),
    b: activity("save", {_id: "actblast", name: "Explosive Emanation", save: {ability: "dex", dc: {formula: "17"}},
      damage: {onSave: "half", parts: [{number: 4, denomination: 6, types: ["fire"]}]}})}}, [{_id: "flames", name: "Burst Into Flames", type: "enchantment"}]));
  const flames = actions(helm).find(item => item.name.includes("Fire Opal")).system.definition;
  assert.deepEqual(flames.effects[0].ruleElements.map(rule => [rule.type, rule.predicate ?? null]),
    [["ExtraDamage", {tagsAny: ["weapon:{{weapon}}"]}], ["GrantLight", null]]);
  assert.ok(actions(helm).some(item => item.name.includes("Explosive Emanation")), "its other uses stay");
  const dagger = convertItem(doc("weapon", "Dagger of Venom", "dagger-of-venom", {description: {value: "<p>You can take a Bonus Action to "
    + "magically coat the blade with poison.</p>"}, activities: {
    a: activity("enchant", {name: "Coat Blade with Poison", activation: {type: "bonus"}, effects: [{_id: "coat"}]}),
    b: activity("save", {_id: "actpoison", name: "Poison Save", save: {ability: "con", dc: {formula: "15"}},
      damage: {onSave: "none", parts: [{number: 2, denomination: 10, types: ["poison"]}]}})}}, [{_id: "coat", name: "Poison Coat", type: "enchantment"}]));
  assert.deepEqual(actions(dagger).map(item => item.name), ["Dagger of Venom (Coat Blade with Poison)"]);
  const coat = actions(dagger)[0].system.definition;
  assert.deepEqual(coat.costs, {allOf: [{capability: "bonus-action", amount: 1}]});
  const strike = coat.effects[0].ruleElements[0].data;
  assert.deepEqual([coat.effects[0].endsWhen, strike.event, strike.action.save.dc, strike.action.damage[0].damageType],
    ["hits", "attack.hit", {value: 15}, "poison"]);
  const bow = convertItem(doc("weapon", "Oathbow", "oathbow", {activities: {
    a: activity("attack", {name: "Attack Sworn Enemy", damage: {includeBase: true, parts: [{number: 3, denomination: 6, types: ["piercing"]}]}}),
    b: activity("enchant", {name: "Oathbow", effects: [{_id: "oath"}]}),
    c: activity("utility", {_id: "actswear", name: "Swear Oath", activation: {type: "special", condition: "when you make a ranged attack"},
      effects: [{_id: "sworn"}]})}}, [{_id: "oath", name: "Oathbow", type: "enchantment"}, {_id: "sworn", name: "Sworn Enemy", statuses: ["marked"]}]));
  assert.deepEqual(actions(bow).map(item => item.name), ["Oathbow (Oathbow)", "Oathbow (Swear Oath)"]);
  const [enchant, swear] = actions(bow).map(item => item.system.definition);
  // Only against its sworn enemy: the mark its wielder gave.
  const rules = enchant.enchant.effects[0].ruleElements;
  assert.deepEqual(rules.map(rule => rule.type), ["RollMode", "ExtraDamage"]);
  for ( const rule of rules ) {
    assert.equal(evaluatePredicate(rule.predicate, {tags: ["weapon:{{host}}"], attack: {fromAttacker: {"sworn-enemy": true}}}).ok, true);
    assert.equal(evaluatePredicate(rule.predicate, {tags: ["weapon:{{host}}"], attack: {fromAttacker: {}}}).ok, false);
  }
  // Sworn once until dawn (its own use), marking its enemy for 7 days; one at a time and other weapons' Disadvantage stay noted.
  assert.deepEqual([swear.costs, swear.targeting.type, swear.effects[0].slug, swear.effects[0].ruleElements, swear.effects[0].duration],
    [{allOf: [{capability: "oathbow-swear-oath", amount: 1}]}, "single", "sworn-enemy", [], {value: 7, units: "days"}]);
  assert.deepEqual(actions(bow)[1].system.ruleElements.find(rule => rule.type === "GrantResource").data,
    {resourceId: "oathbow-swear-oath", label: "Oathbow (Swear Oath)", maximum: {type: "constant", value: 1}, recovery: "longRest"});
  assert.equal(realGapNotes(bow.notes).length, 1);
});

test("a use that sheds Bright and Dim Light is that light on its user: a spell's for its duration and concentration; not an arrow that emits it", () => {
  const blade = convertItem(doc("spell", "Flame Blade", "flame-blade", {level: 2, preparation: {mode: "prepared"}, properties: ["concentration"],
    duration: {value: "10", units: "minute"}, description: {value: "<p>The flaming blade sheds Bright Light in a 10-foot radius and Dim Light for an additional 10 feet.</p>"},
    activities: {a: activity("utility", {name: "Evoke Blade", activation: {type: "bonus"}})}}));
  const [evoke] = actions(blade);
  assert.deepEqual(evoke.system.definition.effects[0].ruleElements, [{schemaVersion: 1, id: "light", type: "GrantLight", data: {bright: 10, dim: 20}}]);
  assert.deepEqual([evoke.system.definition.effects[0].duration, evoke.system.definition.effects[0].concentration], [{value: 10, units: "minutes"}, true]);
  assert.deepEqual(realGapNotes(blade.notes), []);
  valid(evoke);
  const lantern = convertItem(doc("equipment", "Lantern of Revealing", "lantern-of-revealing", {description: {value: "<p>While lit, this hooded lantern "
    + "burns for 6 hours on 1 pint of oil, shedding Bright Light in a 30-foot radius and Dim Light for an additional 30 feet. Invisible creatures "
    + "and objects are visible as long as they are in the lantern's Bright Light.</p>"}, activities: {a: activity("utility", {name: "Consume Oil"})}}));
  const lit = actions(lantern)[0].system.definition.effects[0];
  assert.deepEqual([lit.duration, lit.ruleElements[1].data], [{value: 6, units: "hours"}, {sense: "seeInvisibility", range: 30}]);
  const bow = convertItem(doc("weapon", "Test Bow", "test-bow", {description: {value: "<p>The arrow emits Bright Light in a 20-foot radius and Dim Light "
    + "for an additional 20 feet.</p>"}, activities: {a: activity("utility", {name: "Arrow"})}}));
  assert.equal(actions(bow)[0].system.definition.effects, undefined);
});

test("a creature's move written as a use: a Dash of its Speed or half, Disengaged without provoking, Hide after; not one ending in an attack", () => {
  const move = text => actions(convertItem(doc("feat", "Bubble Dash", "bubble-dash", {description: {value: `<p>${text}</p>`},
    activities: {a: activity("utility", {activation: {type: "bonus"}})}})))[0].system.definition;
  const dash = move("While underwater, the seahorse moves up to half its Swim Speed without provoking &amp;Reference[Opportunity Attacks].");
  assert.deepEqual(dash.effects.map(effect => effect.slug), ["dashing", "disengaged"]);
  assert.equal(dash.effects[0].ruleElements[0].data.value, 0.5);
  assert.deepEqual(dash.costs, {allOf: [{capability: "bonus-action", amount: 1}]});
  valid({name: "Bubble Dash", system: {definition: {...dash, label: "Bubble Dash"}}});
  const prowl = move("The weretiger moves up to its Speed without provoking OpportunityAttacks. At the end of this movement, the weretiger can take the "
    + "&amp;Reference[Hide apply=false] action.");
  assert.deepEqual([prowl.effects[0].ruleElements[0].data.value, prowl.check?.skill], [1, "stealth"]);
  assert.equal(move("The hyena moves up to half its Speed, and it makes one [[/item .mmBite0000000000]] attack.").effects, undefined,
    "moveThenAttack's");
});

test("Tree Stride teleports as far as both of its distances; Fey Step takes its rider; the Ethereal Plane is the Ethereal condition", () => {
  const tree = convertItem(doc("feat", "Tree Stride", "tree-stride", {description: {value: "<p>The dryad teleports to an unoccupied space within "
    + "[[lookup @range.value activity=x]] feet of a second [[lookup @target.affects.special activity=x]] that is within 60 feet of the previous tree.</p>"},
    activities: {a: activity("utility", {activation: {type: "bonus"}, range: {value: "5", units: "ft"}})}}));
  assert.deepEqual(actions(tree)[0].system.definition.teleport, {distance: 65});
  const step = convertItem(doc("feat", "Fey Step", "fey-step", {description: {value: "<p>The steed teleports, along with its rider, to an unoccupied space "
    + "of your choice up to 60 feet away from itself.</p>"}, activities: {a: activity("utility", {activation: {type: "bonus"}, range: {value: "60", units: "ft"}})}}));
  const stepDefinition = actions(step)[0].system.definition;
  assert.deepEqual([stepDefinition.teleport, stepDefinition.targeting, stepDefinition.range, step.notes], [{distance: 60, withTargets: true},
    {type: "single", required: false, count: 1, notHostile: true, notSelf: true}, {type: "ranged", normal: {value: 5, unit: "ft"}}, []],
    "its rider, the willing creature beside it, goes too; unridden it goes alone");
  const stride = convertItem(doc("feat", "Ethereal Stride", "ethereal-stride", {description: {value: "<p>The nightmare and up to three willing creatures "
    + "within 5 feet of it teleport to the Ethereal Plane from the Material Plane or vice versa.</p>"}, activities: {a: activity("utility", {
      range: {value: "5", units: "ft"}, target: {override: false, template: {}, affects: {type: "willing", count: "3"}}})}}));
  const definition = actions(stride)[0].system.definition;
  assert.deepEqual(definition.effects, [{id: "effect-1", type: "condition", conditionId: "ethereal"},
    {id: "effect-2", type: "condition", conditionId: "ethereal", appliesTo: "source"}]);
  assert.deepEqual(definition.targeting, {type: "multiple", required: false, count: 3}, "it may go alone");
  assert.deepEqual(stride.notes, []);
});

test("a form that loses a Speed, a toggled form effect, a swallow with no save, and Elixir of Health's conditions and contagions", () => {
  const self = {override: false, template: {}, affects: {type: "self"}};
  const succubus = convertItem(doc("feat", "Shape-Shift", "shape-shift", {description: {value: "<p>Its game statistics are the same in each form, except "
    + "its Fly Speed is available only in its true form.</p>"}, activities: {a: activity("utility", {activation: {type: "bonus"}, target: self})}}));
  assert.deepEqual(actions(succubus)[0].system.definition.effects[0].ruleElements[0].data,
    {domains: ["speed.fly.multiplier"], modifierType: "untyped", value: 0});
  const bear = convertItem(doc("feat", "Shape-Shift", "shape-shift", {description: {value: "<p>Its game statistics are the same in each form.</p>"},
    activities: {a: activity("utility", {activation: {type: "bonus"}, target: self})}},
  [{_id: "bearform00000000", name: "Speed: Bear Form", transfer: true, disabled: true, statuses: [], changes: [
    {key: "system.attributes.movement.climb", mode: 4, value: "30"}]}]));
  assert.deepEqual(actions(bear)[0].system.definition.effects.map(effect => effect.name), ["Speed: Bear Form"]);
  const toad = convertItem(doc("feat", "Swallow", "swallow", {description: {value: "<p>The toad swallows a Medium or smaller target it is grappling. "
    + "While swallowed, the target has the Blinded and Restrained conditions, and it has Total Cover.</p>"}, activities: {a: activity("utility")}}));
  assert.deepEqual(actions(toad)[0].system.definition.effects.map(effect => [effect.conditionId, effect.maxSize]),
    [["coverTotal", "medium"], ["blinded", "medium"], ["restrained", "medium"]]);
  const elixir = convertItem(doc("consumable", "Elixir of Health", "elixir-of-health", {activities: {a: activity("utility", {target: self})}}));
  const drunk = actions(elixir)[0].system.definition;
  assert.deepEqual([drunk.effects.map(effect => effect.conditionId), drunk.ends], [["blinded", "deafened", "paralyzed", "poisoned"], {contagions: true}]);
});

test("Expeditious Retreat: its cast is a Dash and its marker; the Bonus Action Dash requires the marker and spends no slot", () => {
  const retreat = convertItem(doc("spell", "Expeditious Retreat", "expeditious-retreat", {level: 1, preparation: {mode: "prepared"},
    properties: ["concentration"], duration: {value: "10", units: "minute"}, activation: {type: "bonus"},
    description: {value: "<p>You take the Dash action, and until the spell ends, you can take that action again as a Bonus Action.</p>"},
    activities: {a: activity("utility", {activation: {type: "bonus"}})}}));
  const [cast, again] = actions(retreat);
  assert.deepEqual(cast.system.definition.effects.map(effect => effect.slug), ["dashing", "expeditious-retreat"]);
  assert.equal(cast.system.definition.effects[1].concentration, true);
  assert.deepEqual([again.name, again.system.definition.costs, again.system.definition.requires], ["Expeditious Retreat (Dash)",
    {allOf: [{capability: "bonus-action", amount: 1}]}, {hasCondition: "expeditious-retreat"}]);
  assert.equal(again.system.definition.configuration, undefined, "no slot");
  assert.deepEqual(realGapNotes(retreat.notes), []);
  valid(cast);
  valid(again);
  assert.equal(evaluatePredicate(again.system.definition.requires, {conditions: ["expeditious-retreat"]}).ok, true);
  assert.equal(evaluatePredicate(again.system.definition.requires, {conditions: []}).ok, false);
});

test("Gloves of Missile Snaring take 1d10 + Dexterity off a ranged weapon's hit; Attack Deflection's +5 AC is read from its text", () => {
  const gloves = convertItem(doc("equipment", "Gloves of Missile Snaring", "gloves-of-missile-snaring", {activities: {a: activity("utility", {
    activation: {type: "reaction"}})}}));
  const snare = actions(gloves)[0];
  assert.deepEqual(snare.system.ruleElements.find(rule => rule.type === "Trigger").data.match, {phase: "before", targetTokenId: "{self}",
    tagsAll: ["hit", "ranged", "weapon"]});
  assert.equal(snare.system.definition.rider.reduceDamage.bonus.ability, "agility");
  const staff = convertItem(doc("weapon", "Quarterstaff of the Acrobat", "quarterstaff-of-the-acrobat", {description: {value: "<p>When you are hit by "
    + "an attack while holding the weapon, you can take a Reaction to twirl the weapon around you, gaining a +5 bonus to your Armor Class against "
    + "the triggering attack.</p>"}, activities: {a: activity("utility", {name: "Attack Deflection", activation: {type: "reaction"}})}}));
  const deflect = actions(staff)[0].system.definition;
  assert.equal(deflect.effects[0].ruleElements[0].data.value, 5);
});

test("where a creature stands: damage ending its turn in running water, an aura only underwater, a curse's damage outside water", () => {
  // A standalone Running Water trait: its damage is its activity's, its text an inline roll.
  const water = convertItem(doc("feat", "Running Water", "running-water", {description: {value: "<p>The [[lookup @name]] takes "
    + "[[/damage average activity=actdamage]] damage if it ends its turn in running water.</p>"},
    activities: {a: passive("damage", {name: "Damage", damage: {parts: [{bonus: "20", types: ["acid"]}]}})}}));
  const [river] = water.items[0].system.ruleElements;
  assert.deepEqual([river.type, river.data.event, river.data.predicate, river.data.action.damage[0].damageType, river.data.action.costs],
    ["Trigger", "turn.ended", {equals: {path: "environment.runningWater", value: true}}, "acid", {allOf: []}]);
  assert.deepEqual(water.notes, []);

  // Mucus Cloud: an end-of-turn Emanation save only while underwater; its curse's damage every 10 minutes out of water.
  const mucus = text => convertItem(doc("feat", "Mucus Cloud", "mucus-cloud", {description: {value: text}, activities: {
    a: passive("save", {target: {override: false, template: {type: "radius", size: "5"}, affects: {type: "creature"}},
      range: {units: "self", override: false}, save: {ability: ["con"], dc: {calculation: "", formula: "14"}}, damage: {parts: []},
      effects: [{_id: "cursedEffect0001", onSave: false}]}),
    b: passive("damage", {_id: "actoutside", name: "Damage: Outside Water", damage: {parts: [{number: 1, denomination: 12, types: ["acid"]}]}})}},
  [{_id: "cursedEffect0001", name: "Cursed", statuses: ["cursed"], changes: [], duration: {}}]));
  const said = "<p>While underwater, the [[lookup @name lowercase]]{monster} is surrounded by mucus.</p><p><em>Constitution Saving "
    + "Throw:</em> DC 14, each creature in a 5-ft Emanation originating from the [[lookup @name lowercase]]{monster} at the end of the "
    + "[[lookup @name lowercase]]{monster}'s turn. <em>Failure:</em> The target is cursed. Until the curse ends, the target's skin "
    + "becomes slimy, the target can breathe air and water, and it can't regain Hit Points unless it is underwater.</p><p>While the cursed "
    + "creature is outside a body of water, the creature takes [[/damage average activity=actoutside]] damage at the end of every 10 "
    + "minutes unless moisture is applied to its skin before those minutes have passed.</p>";
  const cloud = mucus(said);
  const [aura] = cloud.items[0].system.ruleElements;
  assert.deepEqual([aura.data.event, aura.data.around, aura.data.predicate], ["turn.ended", {radius: 5, affects: "others"},
    {equals: {path: "environment.water", value: true}}]);
  const [cursed, curse] = aura.data.action.effects;
  assert.deepEqual([cursed.conditionId, curse.type, curse.saveOutcomePolicy], ["cursed", "effect", "failure"]);
  const [interval] = curse.ruleElements;
  assert.deepEqual([interval.type, interval.data.event, interval.data.every, interval.data.predicate], ["Trigger", "time.elapsed",
    {value: 10, units: "minutes"}, {all: [{hasCondition: "cursed"}, {not: {equals: {path: "environment.water", value: true}}}]}]);
  assert.deepEqual(interval.data.action.damage.map(part => [part.damageType, part.expression]), [["acid", {type: "dice", number: 1, faces: 12}]]);
  assert.deepEqual(cloud.notes, ["interval: what else its description says is by hand (\"unless moisture is applied to its skin before those minutes have passed\")",
    "save: \"can't regain Hit Points unless it is underwater\" is by hand"], "no passive note left; what it can't do is by hand");
  assert.ok(evaluatePredicate(interval.data.predicate, {conditions: ["cursed"]}).ok, "cursed on dry land");
  assert.equal(evaluatePredicate(interval.data.predicate, {conditions: ["cursed"], environment: {water: true}}).ok, false, "in water");

  // Underwater and not Incapacitated: both.
  const both = mucus(said.replace("turn. ", "turn, unless the aboleth has the Incapacitated condition. "));
  assert.deepEqual(both.items[0].system.ruleElements[0].data.predicate, {all: [{missingCondition: "incapacitated"},
    {equals: {path: "environment.water", value: true}}]});
  // Any other "While" is not where it stands: still refused.
  const bloodied = mucus(said.replace("While underwater,", "While Bloodied,"));
  assert.equal(bloodied.items[0].system.ruleElements.some(rule => rule.data?.around), false);
  assert.ok(bloodied.notes.some(note => /"save" is passive or triggered/.test(note)));
  assert.ok(bloodied.notes.includes("\"Damage: Outside Water\" is passive or triggered: not automated"),
    "the interval damage its save did not carry keeps its note");
  // A save giving only how long it lasts (no condition to carry the damage): the damage keeps its note too.
  const unconditioned = convertItem(doc("feat", "Mucus Cloud", "mucus-cloud", {description: {value: said}, activities: {
    a: passive("save", {target: {override: false, template: {type: "radius", size: "5"}, affects: {type: "creature"}},
      range: {units: "self", override: false}, save: {ability: ["con"], dc: {calculation: "", formula: "14"}}, damage: {parts: []},
      effects: [], duration: {value: "1", units: "hour"}}),
    b: passive("damage", {_id: "actoutside", name: "Damage: Outside Water", damage: {parts: [{number: 1, denomination: 12, types: ["acid"]}]}})}}));
  assert.equal(JSON.stringify(unconditioned.items).includes("interval-damage"), false);
  assert.ok(unconditioned.notes.includes("\"Damage: Outside Water\" is passive or triggered: not automated"));
});

test("a check that only tells an illusion for what it is is narrative; one whose success also ends the spell is not", () => {
  const study = text => convertItem(doc("spell", "Silent Image", "silent-image", {level: 1, description: {value: `<p>${text}</p>`},
    activities: {a: passive("check", {name: "Study"})}})).notes;
  assert.deepEqual(study("A creature that takes a Study action to examine the image can determine that it is an illusion with a successful check against your spell save DC."),
    ["\"Study\" is passive or triggered (narrative): not automated"]);
  assert.deepEqual(study("A creature that hears it can tell they are imitations with a successful DC 14 Wisdom (Insight) check."),
    ["\"Study\" is passive or triggered (narrative): not automated"]);
  assert.deepEqual(study("The target can make a check against your spell save DC. If it succeeds, it can determine that the phantasm is an illusion, and the spell ends."),
    ["\"Study\" is passive or triggered: not automated"], "its success ends the spell: a real gap");
});

test("an enchantment that only makes its base item into the document it is on leaves nothing by hand", () => {
  const plate = (changes, riders={activity: ["actutility"], effect: [], item: []}) => convertItem(doc("equipment", "Dwarven Plate", "dwarven-plate",
    {type: {value: "heavy"}, armor: {value: 18, magicalBonus: 2}, rarity: "veryRare", properties: ["mgc"],
      description: {value: "<p>While wearing this armor, you gain a +2 bonus to Armor Class.</p>"},
      activities: {a: activity("utility", {name: "Reduce Unwilling Movement", activation: {type: "reaction"}}),
        b: passive("enchant", {name: "Dwarven Plate", effects: [{_id: "dwarvenench00000", riders}]})}},
    [{_id: "dwarvenench00000", name: "Dwarven Plate", type: "enchantment", disabled: true, transfer: true, system: {changes: changes.map(([key, value]) =>
      ({key, value, type: "override"}))}}])).notes;
  const restated = [["name", "Dwarven {}"], ["system.rarity", "veryRare"], ["system.armor.magicalBonus", 2], ["system.properties", "mgc"]];
  const noted = "\"Dwarven Plate\" is passive or triggered: not automated";
  assert.equal(plate(restated).includes(noted), false);
  assert.ok(plate([...restated.slice(0, 2), ["system.armor.magicalBonus", 3]]).includes(noted), "a value the document lacks");
  assert.ok(plate(restated, {activity: [], effect: ["other"], item: []}).includes(noted), "an effect it brings along");

  // A weapon's bonus is read only by its own attacks (Giant Slayer's +1 beside its Attack vs Giant), and an enchantment
  // that is all there is leaves its text by hand (Moon-Touched Sword's light).
  const sword = (name, magicalBonus, changes, others={}) => convertItem(doc("weapon", name, "magic-sword", {magicalBonus, properties: ["mgc"],
    rarity: "rare", description: {value: "<p>You gain a +1 bonus to attack rolls and damage rolls made with this magic weapon. In Darkness, it sheds Bright Light in a 15-foot radius.</p>"},
    activities: {...others, b: passive("enchant", {name, effects: [{_id: "swordenchant0000", riders: {activity: [], effect: [], item: []}}]})}},
  [{_id: "swordenchant0000", name, type: "enchantment", disabled: true, transfer: true, system: {changes: changes.map(([key, value]) =>
    ({key, value, type: "override"}))}}])).notes;
  const giant = sword("Giant Slayer", 1, [["name", "Giant Slayer {}"], ["system.properties", "mgc"], ["system.magicalBonus", 1]],
    {a: activity("attack", {name: "Attack vs Giant", attack: {type: {value: "melee", classification: "weapon"}}})});
  assert.ok(giant.includes("\"Giant Slayer\" is passive or triggered: not automated"), "no attack of its own gives the +1");
  assert.ok(sword("Moon-Touched Sword", null, [["name", "Moon-Touched {}"], ["system.rarity", "rare"], ["system.properties", "mgc"]])
    .includes("\"Moon-Touched Sword\" is passive or triggered: not automated"), "nothing else carries its light");
});

test("a use that only refills the uses its other activity spends is narrative (gathering up Ball Bearings)", () => {
  const bearings = spill => convertItem(doc("consumable", "Ball Bearings", "ball-bearings", {uses: {max: "1", recovery: []},
    description: {value: "<p>Each creature there must succeed on a DC 10 Dexterity saving throw or have the Prone condition.</p>"},
    activities: {a: activity("utility", {_id: "actrecover", name: "Recover Ball Bearings", consumption: {targets: [{type: "itemUses", value: "-1", target: ""}]}}),
      b: activity("save", {name: "Spill Ball Bearings", save: {ability: ["dex"], dc: {calculation: "", formula: "10"}},
        consumption: {targets: [{type: "itemUses", value: spill, target: ""}]}})}}));
  const gathered = bearings("1");
  const recover = actions(gathered).find(item => item.name.includes("Recover"));
  assert.deepEqual(recover.system.definition.restores.map(entry => entry.resourceId), ["ball-bearings"]);
  assert.equal(recover.flags.wildpath.conversion.notes[0], "not automated (utility, narrative): using it spends its cost; its description says the rest");
  assert.equal(realGapNotes(gathered.notes).some(note => note.startsWith("not automated (utility)")), false);
  // Uses nothing spends (a Staff of the Adder's snake head's Hit Points): the refill is not all there is, a real gap.
  assert.ok(realGapNotes(bearings("0").notes).some(note => note.startsWith("not automated (utility)")));
});

test("a passive save one of its effects asks with a Trigger is that effect's (Sanctuary's Save on Target)", () => {
  const sanctuary = ability => convertItem(doc("spell", "Sanctuary", "sanctuary", {level: 1, duration: {value: "1", units: "minute"},
    activities: {a: activity("utility", {name: "Cast", effects: [{_id: "wardedeffect0000"}]}),
      b: passive("save", {name: "Save on Target", activation: {type: "", override: true}, save: {ability, dc: {calculation: "spellcasting", formula: ""}}})}},
    [{_id: "wardedeffect0000", name: "Warded", type: "base", changes: [], statuses: [], transfer: false}]));
  const warded = sanctuary("wis");
  assert.ok(JSON.stringify(actions(warded)[0].system.definition.effects).includes("\"type\":\"Trigger\""), "the ward is its effect's Trigger");
  assert.equal(warded.notes.some(note => note.includes("Save on Target")), false);
  assert.ok(sanctuary("cha").notes.some(note => note.startsWith("\"Save on Target\" is passive or triggered")), "a save no Trigger asks stays noted");
});

test("Polymorph's passive transformation is its save's; an item casting it repeats the spell's notes for the census to count once", () => {
  const polymorph = {_id: "testPolymorph002", name: "Polymorph", type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: "polymorph", level: 4, preparation: {mode: "prepared"}, properties: ["vocal", "concentration"],
      activation: {type: "action"}, range: {value: "60", units: "ft"}, target: {affects: {type: "creature", count: 1}, template: {}},
      duration: {value: "1", units: "hour"}, activities: {a: activity("save", {save: {ability: ["wis"], dc: {calculation: "spellcasting", formula: ""}}}),
        b: passive("transform", {_id: "acttransform", activation: {type: "", override: true}})}}};
  const beasts = [{uuid: "Compendium.wildpath.srd-creatures.Actor.bear", name: "Brown Bear", cr: 1}];
  const spell = convertItem(polymorph, {beasts});
  assert.deepEqual(spell.notes, ["transform: a Beast the caster chooses; what the creature may do in its form is by hand"]);
  assert.deepEqual(realGapNotes(spell.notes), [], "its form's anatomy is the GM's call");
  assert.ok(convertItem(polymorph).notes.some(note => note.startsWith("\"transform\" is passive or triggered")), "no Beasts: nothing carries it");

  const hat = convertItem({_id: "testHatOfSpells1", name: "Hat of Spells", type: "equipment", img: "icons/svg/item-bag.svg", effects: [],
    system: {source: SRD, identifier: "hat-of-spells", description: {value: "<p>Make a DC 10 Intelligence (Arcana) check.</p>"},
      activities: {a: activity("cast", {spell: {uuid: "Compendium.x.testPolymorph002"}}), b: passive("check", {name: "Unknown Spell Check"})}}},
  {beasts, spells: {testPolymorph002: polymorph}});
  assert.ok(hat.notes.includes(spell.notes[0]), "its own notes still show the spell's");
  assert.deepEqual(hat.castNotes, spell.notes);
  assert.deepEqual(censusNotes(hat), ["\"Unknown Spell Check\" is passive or triggered: not automated"], "the census counts its own only");
});

test("a summon's second roll its creature does to those near it is the area its creature carries (summon.area), not a second cast", () => {
  const creatures = {orb: "Compendium.wildpath.srd-creatures.Actor.orb"};
  const summoning = (identifier, text, roll, {match={saves: true}, level=2}={}) => convertItem(doc("spell", identifier, identifier, {level,
    preparation: {mode: "prepared"}, properties: ["concentration"], duration: {value: "1", units: "minute"}, range: {value: "60", units: "ft"},
    description: {value: `<p>${text}</p>`}, activities: {a: activity("summon", {profiles: [{count: "", uuid: "Compendium.dnd5e.actors24.Actor.orb"}],
      match}), b: activity("save", {_id: "actsave", sort: 1, ...roll})}}), {creatures});
  const fire = {save: {ability: ["dex"], dc: {calculation: "spellcasting"}}, damage: {onSave: "half", parts: [{number: 2, denomination: 6,
    types: ["fire"], scaling: {mode: "whole", number: 1}}]}};
  const orb = summoning("test-orb", "A test orb appears. Any creature that ends its turn within 5 feet of the orb makes a Dexterity saving "
    + "throw, taking 2d6 Fire damage on a failed save or half as much damage on a successful one. The orb sheds Bright Light in a 20-foot "
    + "radius and Dim Light for an additional 20 feet. The damage increases by 1d6 for each spell slot level above 2.", fire);
  assert.deepEqual(actions(orb).map(item => [item._id, item.name]), [["testorb000000000", "test-orb"]], "one Action, its own id, no second cast");
  const definition = actions(orb)[0].system.definition;
  valid(actions(orb)[0]);
  const {area, match} = definition.summon;
  assert.deepEqual(match, {saves: true});
  assert.deepEqual([area.shape, area.size, area.persistence.light, area.persistence.affects, area.persistence.budget],
    ["emanation", {value: 5, unit: "ft"}, {bright: 20, dim: 40}, undefined, undefined]);
  const [trigger] = area.persistence.triggers;
  assert.deepEqual(trigger.on, ["turn.ended"]);
  assert.equal(trigger.action.save.ability, "agility");
  assert.ok(trigger.action.tags.includes("spell:test-orb"), "its spell, for what is immune to it");
  assert.deepEqual(trigger.action.damage[0].saveOutcomePolicy, {success: "half", failure: "full"});
  assert.deepEqual(definition.configuration.find(choice => choice.id === "spell-slot").effects.map(effect => [effect.type, effect.componentIds]),
    [["scaleDamage", ["damage-1"]]], "the slot's dice reach the carried damage");
  assert.deepEqual(orb.notes, []);

  // "Any enemy that moves to a space within 10 feet ... or starts its turn there"; "vanishes when it has dealt a total of 60 damage".
  const warden = summoning("test-warden", "A test warden appears. Any enemy that moves to a space within 10 feet of the warden for the first "
    + "time on a turn or starts its turn there makes a Dexterity saving throw, taking 20 Radiant damage on a failed save or half as much damage "
    + "on a successful one. The warden vanishes when it has dealt a total of 60 damage.", {save: {ability: ["dex"], dc: {calculation: "spellcasting"}},
    damage: {onSave: "half", parts: [{custom: {enabled: true, formula: "20"}, types: ["radiant"]}]}}, {level: 4});
  const kept = actions(warden)[0].system.definition.summon.area;
  assert.deepEqual([kept.size.value, kept.persistence.affects, kept.persistence.budget], [10, "enemies", {damage: 60}]);
  // No "only once per turn": entering "for the first time on a turn" is once a turn on its own record, as a placed area's
  // (lastingArea, Web), so one hit as its turn starts saves again when it steps out and back in.
  assert.deepEqual([kept.persistence.oncePerTurn, kept.persistence.triggers.map(({on, once}) => [on, once])],
    [false, [[["turn.started"], undefined], [["area.entered"], "turn"]]]);

  // "you can force that creature": its caster's enemies, noted; no "half as much" in it or the next sentence: none on a success.
  const pack = summoning("test-pack", "A test pack appears. Whenever a creature you can see enters a space within 10 feet of the pack or ends "
    + "its turn there, you can force that creature to make a Dexterity saving throw. On a failed save, the creature takes 3d10 Slashing damage. "
    + "A creature makes this save only once per turn.",
  {save: {ability: ["dex"], dc: {calculation: "spellcasting"}}, damage: {onSave: "half", parts: [{number: 3, denomination: 10, types: ["slashing"]}]}},
  {level: 3});
  const packed = actions(pack)[0].system.definition.summon.area;
  assert.equal(packed.persistence.affects, "enemies");
  assert.deepEqual([packed.persistence.oncePerTurn, packed.persistence.triggers.map(({on}) => on)], [undefined, [["turn.ended", "area.entered"]]],
    "\"only once per turn\": one trigger on the area's shared record");
  assert.deepEqual(packed.persistence.triggers[0].action.damage[0].saveOutcomePolicy, {success: "none", failure: "full"});
  assert.ok(pack.notes.some(note => note.startsWith("area: its caster's choice")));

  // Without that wording the save stays an Action of its own, and a summon without match.saves keeps its creature's DCs.
  const plain = summoning("test-plain", "A test spirit appears. You can make it attack.", fire, {match: {attacks: true}});
  assert.deepEqual(actions(plain).map(item => item.name), ["test-plain (summon)", "test-plain (save)"]);
  assert.equal(actions(plain)[0].system.definition.summon.area, undefined);
  assert.deepEqual(actions(plain)[0].system.definition.summon.match, {attacks: true});
});

test("a spell-made creature: its feature its spell's area carries is its spell's; a Bonus Action its caster should pay is noted", () => {
  const text = "A test warden appears. Any enemy that moves to a space within 10 feet of the warden for the first time on a turn or starts "
    + "its turn there makes a Dexterity saving throw, taking 20 Radiant damage on a failed save or half as much damage on a successful one. "
    + "The warden vanishes when it has dealt a total of 60 damage. As a Bonus Action on your later turns, you can move the warden.";
  const roll = {save: {ability: ["dex"], dc: {calculation: "spellcasting"}}, damage: {onSave: "half", parts: [{custom: {enabled: true,
    formula: "20"}, types: ["radiant"]}]}};
  const spell = doc("spell", "Test Warden", "test-warden", {level: 4, description: {value: `<p>${text}</p>`}, activities: {
    a: activity("summon", {profiles: []}), b: activity("save", {_id: "actsave", sort: 1, ...roll})}});
  spell._id = "testWardenSpell0";
  const guarded = {...doc("feat", "Guarded Area", "guarded-area", {description: {value: `<p>${text}</p>`}, uses: {max: "60", spent: 0},
    activities: {a: passive("save", roll), b: passive("utility", {_id: "actpool", name: "Consume Damage Pool",
      consumption: {targets: [{type: "itemUses", value: "5"}]}})}}), _id: "guardedArea00001"};
  const strike = {...doc("feat", "Strike", "strike", {description: {value: "<p>It strikes.</p>"}, activities: {
    a: activity("attack", {activation: {type: "bonus"}, attack: {type: {value: "melee"}}})}}), _id: "wardenStrike0001"};
  const warden = (biography, items) => convertActor({_id: "testwarden000001", name: "Test Warden", type: "npc", items, system: {source: SRD,
    details: {cr: 0, biography: {value: biography}}, abilities: {}, attributes: {hp: {max: 1}, movement: {walk: "0"}, ac: {flat: 10}},
    traits: {size: "lg"}}}, {spells: {[spell._id]: spell}});
  const made = warden(`<p>@Embed[Compendium.dnd5e.spells24.Item.${spell._id} caption=false]</p>`, [guarded, strike]);
  const feature = made.actor.items.find(item => item.name === "Guarded Area");
  assert.deepEqual([feature.system.ruleElements, feature.flags.wildpath.conversion.notes], [[], []],
    "its save and its damage pool are the spell's area and budget");
  assert.ok(made.notes.includes("Strike: summon: its Bonus Action should be its summoner's; today it acts on its own turn at no cost to its "
    + "caster (by hand)"));
  assert.equal(made.notes.some(note => note.startsWith("Guarded Area")), false);
  const own = warden("<p>A warden of its own.</p>", [guarded, strike]);
  assert.ok(own.notes.some(note => note.includes("is passive or triggered")), "not made by the spell: its own, by hand as before");
  assert.equal(own.notes.some(note => note.includes("summoner's")), false);
});

test("match.saves: a class feature's summon matches its summoner's save DC too (Investment of the Chain Master)", () => {
  const feat = convertItem(doc("feat", "Test Chain", "test-chain", {activities: {a: activity("summon", {profiles: [{count: "",
    uuid: "Compendium.dnd5e.actors24.Actor.orb"}], match: {attacks: true, saves: true}})}}),
  {creatures: {orb: "Compendium.wildpath.srd-creatures.Actor.orb"}});
  assert.deepEqual(actions(feat)[0].system.definition.summon.match, {attacks: true, saves: true});
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {convertActor, convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
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
    description: {value: "<p>The first time a creature enters a space in the wall on a turn or ends its turn there, it makes a Dexterity saving throw.</p>"},
    activities: {a: activity("save", {name: "Create Wall", target: {template: {type: "wall", size: "60", width: "5", height: "10"}, affects: {}},
      save: {ability: "dex", dc: {calculation: "spellcasting"}}, damage: {onSave: "half", parts: [{number: 7, denomination: 8, types: ["piercing"]}]}}),
    b: passive("save", {_id: "acttraverse", name: "Traversal Save", save: {ability: "dex", dc: {calculation: "spellcasting"}},
      damage: {onSave: "half", parts: [{number: 7, denomination: 8, types: ["slashing"]}]}})}}));
  const [wall] = actions(thorns);
  const [trigger] = wall.system.definition.area.persistence.triggers;
  assert.deepEqual(trigger.on, ["area.entered", "turn.ended"]);
  assert.equal(wall.system.definition.damage[0].damageType, "piercing", "its creation is Piercing");
  assert.equal(trigger.action.damage[0].damageType, "slashing", "its repeat is its Traversal Save's");
  assert.equal(thorns.notes.some(note => note.includes("Traversal Save")), false);

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
    saveOutcomePolicy: "failure", maxSize: "large", metadata: {escapeDC: 10}});
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

test("a spell's damage at the start of each turn notes that a higher slot doesn't grow it (Ensnaring Strike)", () => {
  const strike = convertItem(doc("spell", "Ensnaring Strike", "ensnaring-strike", {level: 1, preparation: {mode: "prepared"},
    description: {value: "<p>The target has the &amp;Reference[Restrained] condition until the spell ends. While Restrained, the target takes "
      + "1d6 Piercing damage at the start of each of its turns.</p>"}, activities: {
      a: activity("save", {save: {ability: "str", dc: {calculation: "spellcasting"}}, damage: {parts: []}, effects: [{_id: "held"}]}),
      b: passive("damage", {_id: "actturn", name: "Start of Turn Damage", damage: {parts: [{number: 1, denomination: 6, types: ["piercing"],
        scaling: {mode: "whole", number: 1}}]}})}}, [{_id: "held", name: "Restrained", statuses: ["restrained"]}]));
  const turn = actions(strike)[0].system.definition.effects.find(effect => effect.ruleElements?.[0]?.type === "Trigger");
  assert.equal(turn.ruleElements[0].data.action.damage[0].expression.faces, 6);
  assert.deepEqual(realGapNotes(strike.notes), ["\"Start of Turn Damage\": its damage at the start of each turn doesn't grow with a higher spell slot (by hand)"]);
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

test("Tree Stride teleports as far as both of its distances; Fey Step's rider is noted; the Ethereal Plane is the Ethereal condition", () => {
  const tree = convertItem(doc("feat", "Tree Stride", "tree-stride", {description: {value: "<p>The dryad teleports to an unoccupied space within "
    + "[[lookup @range.value activity=x]] feet of a second [[lookup @target.affects.special activity=x]] that is within 60 feet of the previous tree.</p>"},
    activities: {a: activity("utility", {activation: {type: "bonus"}, range: {value: "5", units: "ft"}})}}));
  assert.deepEqual(actions(tree)[0].system.definition.teleport, {distance: 65});
  const step = convertItem(doc("feat", "Fey Step", "fey-step", {description: {value: "<p>The steed teleports, along with its rider, to an unoccupied space "
    + "of your choice up to 60 feet away from itself.</p>"}, activities: {a: activity("utility", {activation: {type: "bonus"}, range: {value: "60", units: "ft"}})}}));
  assert.deepEqual([actions(step)[0].system.definition.teleport, step.notes], [{distance: 60}, ["teleport: a creature it brings along is moved by hand"]]);
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

import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {resolveActionConfiguration} from "../module/helpers/action-configuration.mjs";
import {applyActionTransformation} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
import {tokenFormCreatures} from "../module/helpers/transformations.mjs";

const WILD_SHAPE = {schemaVersion: 1, id: "action:wild-shape", label: "Wild Shape", costs: {allOf: []},
  transform: {choiceId: "form", status: "wild-shape"},
  configuration: [{id: "form", type: "select-one", label: "Form", required: true,
    options: [{id: "Actor.bear", label: "Bear"}, {id: "Actor.wolf", label: "Wolf"}]}]};

test("a transform names exactly one of a fixed form, a configuration choice, or revert", () => {
  const definition = transform => ({schemaVersion: 1, id: "action:t", label: "T", costs: {allOf: []}, transform});
  assert.equal(validateActionDefinition(WILD_SHAPE).ok, true);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear"})).ok, true);
  assert.equal(validateActionDefinition(definition({revert: true})).ok, true);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear", revert: true})).ok, false);
  assert.equal(validateActionDefinition(definition({})).ok, false);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear", status: ""})).ok, false, "a status is a status id");
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear", status: ["wild-shape"]})).ok, false);
});

/** A creature that records what it is turned into. */
function shifter() {
  return {calls: [], async transform(form, policy) { this.calls.push(["transform", form.name, policy]); },
    async revertTransformation() { this.calls.push(["revert"]); }};
}
const forms = {"Actor.bear": {name: "Bear"}, "Actor.wolf": {name: "Wolf"}};

test("Wild Shape turns its creature into the form the Player chose, after the Action completes", async () => {
  const actor = shifter();
  const {configuration} = resolveActionConfiguration({actionDefinition: WILD_SHAPE, responses: {form: "Actor.wolf"}});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: WILD_SHAPE, configuration}},
    {fromUuid: async uuid => forms[uuid] ?? null});
  assert.deepEqual(actor.calls, [["transform", "Wolf", {status: "wild-shape"}]], "its status is the creature's while the form lasts");
});

test("a fixed form keeps its policy, a revert Action returns the creature, and an unknown form changes nothing", async () => {
  const actor = shifter();
  const fixed = {transform: {formRef: "Actor.bear", keepItemTypes: ["feature"]}};
  await applyActionTransformation({options: {actor}, state: {actionDefinition: fixed}}, {fromUuid: async uuid => forms[uuid] ?? null});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: {transform: {revert: true}}}});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: {transform: {formRef: "Actor.none"}}}},
    {fromUuid: async () => null, logger: {warn() {}}});
  assert.deepEqual(actor.calls, [["transform", "Bear", {keepItemTypes: ["feature"]}], ["revert"]]);
});

test("Polymorph turns each creature that failed its save into the Beast chosen, with the Beast's Hit Points as Temporary", async () => {
  const definition = {...WILD_SHAPE, transform: {choiceId: "form", targets: true, keepItemTypes: [], temporaryHealth: "form", concentration: true}};
  const {configuration} = resolveActionConfiguration({actionDefinition: definition, responses: {form: "Actor.bear"}});
  const creature = (level, threat) => ({...shifter(), system: {details: {level, threat}}});
  const [failed, saved, mightier] = [creature(5), creature(5), creature(undefined, 0)];
  const tokens = new Map([["failed", {actor: failed}], ["saved", {actor: saved}], ["weak", {actor: mightier}]]);
  const caster = {id: "caster", parent: {tokens}};
  const bear = {name: "Bear", system: {details: {threat: 1}, resources: {health: {max: 34}}}};
  const results = [{ok: true, success: false, target: {tokenId: "failed"}}, {ok: true, success: true, target: {tokenId: "saved"}},
    {ok: true, success: false, target: {tokenId: "weak"}}];
  await applyActionTransformation({options: {actor: shifter()}, state: {actionDefinition: definition, configuration,
    source: {tokenRef: "Scene.s.Token.caster"}, results: {saveResolution: {results}}}},
  {fromUuid: async uuid => (uuid === "Actor.bear" ? bear : (uuid === "Scene.s.Token.caster" ? caster : null)), logger: {warn() {}}});
  assert.deepEqual(failed.calls, [["transform", "Bear", {keepItemTypes: [], temporaryHealth: 34, untilTemporaryHealthLost: true,
    concentrationRef: "token:caster"}]]);
  assert.deepEqual(saved.calls, [], "a save keeps its shape");
  assert.deepEqual(mightier.calls, [], "a Bear (CR 1) is beyond a CR 0 creature");
});

test("Shapechange: its user takes the form with Temporary Hit Points that don't end it, its spellcasting, its hour and its concentration", async () => {
  const definition = {...WILD_SHAPE, transform: {choiceId: "form", temporaryHealth: "form", untilTemporaryHealthLost: false, concentration: true,
    keepsSpellcasting: true, limits: {challenge: "self"}, duration: {value: 1, units: "hours"}}};
  const {configuration} = resolveActionConfiguration({actionDefinition: definition, responses: {form: "Actor.bear"}});
  const actor = shifter();
  const bear = {name: "Bear", system: {details: {threat: 1}, resources: {health: {max: 34}}}};
  await applyActionTransformation({options: {actor}, state: {actionDefinition: definition, configuration, source: {tokenId: "druid-token"}}},
    {fromUuid: async uuid => (uuid === "Actor.bear" ? bear : null)});
  assert.deepEqual(actor.calls, [["transform", "Bear", {keepsSpellcasting: true, temporaryHealth: 34, untilTemporaryHealthLost: false,
    duration: {value: 1, units: "hours"}, concentrationRef: "token:druid-token"}]]);
});

test("a countered spell wastes the Action that cast it, never its slot, and says what stopped it", async () => {
  const {afterCountered} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const updates = [];
  const actor = {name: "Caster", system: {resources: {action: {max: 1, spent: 0}, bonus: {max: 1, spent: 0}}},
    update: async data => updates.push(data)};
  const posted = [];
  globalThis.ChatMessage = {create: async data => posted.push(data)};
  const state = {warnings: [{code: "COUNTERED", reason: "Counterspell stopped it."}],
    actionDefinition: {label: "Fireball", costs: {allOf: [{capability: "action", amount: 1}, {capability: "spell-slot.3", amount: 1}]}}};
  assert.deepEqual(await afterCountered({options: {actor, action: {name: "Fireball"}}, state}, {game: {}}), {"system.resources.action.spent": 1});
  assert.deepEqual(updates, [{"system.resources.action.spent": 1}], "the Action, not the slot");
  assert.match(posted[0].content, /Fireball: Counterspell stopped it\./);
  assert.equal(await afterCountered({options: {actor}, state: {warnings: [{code: "CANCELLED"}]}}, {game: {}}), null, "only a counter");
  delete globalThis.ChatMessage;
});

test("a counter that wastes (an Ioun Stone of Absorption) spends the whole cost of what it cancelled: its slot, or a monster's per-day use", async () => {
  const {afterCountered} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  globalThis.ChatMessage = {create: async () => null};
  const caster = pool => {
    const system = {resources: {action: {value: 1, max: 1, spent: 0}}, pools: [pool]};
    const updates = [];
    return {updates, actor: {name: "Caster", system, toObject: () => ({system: structuredClone(system)}), update: async data => updates.push(data)}};
  };
  // The directive's data, as the reaction resolver keeps it on the cancelled Action's warning.
  const wasted = costs => ({warnings: [{code: "COUNTERED", reason: "Ioun Stone stopped it.", data: {directive: {data: {wastes: true}}}}],
    actionDefinition: {label: "Fireball", tags: ["spell"], costs: {allOf: [{capability: "action", amount: 1}, ...costs]}}});
  const wizard = caster({id: "spell-slot.3", value: 2, max: 3});
  await afterCountered({options: {actor: wizard.actor}, state: wasted([{capability: "spell-slot.3", amount: 1}])}, {game: {}});
  assert.deepEqual(wizard.updates, [{"system.resources.action.spent": 1, "system.pools": [{id: "spell-slot.3", value: 1, max: 3}]}],
    "its Action and its slot, the pools written whole as V14 keeps them");
  // Boon of Spell Recall rolls no d4 for a wasted slot (Q129 default): its level-1 slot is simply spent.
  const boon = caster({id: "spell-slot.1", value: 1, max: 1});
  boon.actor.items = [{system: {active: true}, flags: {wildpath: {slotRecall: {dice: "1d4", maxLevel: 4}}}}];
  await afterCountered({options: {actor: boon.actor}, state: wasted([{capability: "spell-slot.1", amount: 1}])}, {game: {}});
  assert.deepEqual(boon.updates, [{"system.resources.action.spent": 1, "system.pools": [{id: "spell-slot.1", value: 0, max: 1}]}]);
  const mage = caster({id: "spellcasting-fireball", value: 1, max: 1});
  await afterCountered({options: {actor: mage.actor}, state: wasted([{capability: "spellcasting-fireball", amount: 1}])}, {game: {}});
  assert.deepEqual(mage.updates, [{"system.resources.action.spent": 1,
    "system.pools": [{id: "spellcasting-fireball", value: 0, max: 1}]}], "a monster's 1/Day too");
  const spent = caster({id: "spell-slot.3", value: 0, max: 3});
  await afterCountered({options: {actor: spent.actor}, state: wasted([{capability: "spell-slot.3", amount: 1}])}, {game: {}});
  assert.deepEqual(spent.updates, [{"system.resources.action.spent": 1}], "nothing left to pay it all with: its Action still is");
  delete globalThis.ChatMessage;
});

test("a countered cast's afterCancelled reports action.cast with the slot a wasting counter then spends, and its Metamagic (Q24, Q97 (b), (d))", async () => {
  const {afterActionCancelled} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  globalThis.ChatMessage = {create: async () => null};
  // A caster whose updates land, so a slot spent before the event is worked out would be missing from it.
  const system = {resources: {action: {value: 1, max: 1, spent: 0}}, pools: [{id: "spell-slot.3", value: 1, max: 3}]};
  const actor = {id: "caster", name: "Caster", system, toObject: () => ({system: structuredClone(system)}),
    update: async data => { if ( data["system.pools"] ) system.pools = data["system.pools"]; }};
  const dispatched = [];
  const automation = {dispatch: async (type, event) => { dispatched.push([type, event.key, event.tags]); return []; }};
  const event = used => ({resolutionId: "fireball:1", used, initiatorUserId: "player-a", options: {actor}, state: {id: "fireball:1",
    warnings: [{code: "COUNTERED", reason: "Ioun Stone stopped it.", data: {directive: {data: {wastes: true}}}}],
    configuration: {choices: [{id: "metamagic", value: "quickened"}]},
    actionDefinition: {id: "action:fireball", label: "Fireball", tags: ["spell"],
      costs: {allOf: [{capability: "action", amount: 1}, {capability: "spell-slot.3", amount: 1}]}}}});
  const {reported} = await afterActionCancelled(event(true), {game: {}, automation, fromUuid: async () => null});
  await reported;
  assert.deepEqual(system.pools, [{id: "spell-slot.3", value: 0, max: 3}], "the wasting counter spent its slot");
  assert.deepEqual(dispatched, [["action.cast", "fireball:1", ["spell", "id:action:fireball", "cost:action", "cost:spell-slot.3", "cast",
    "metamagic", "metamagic:quickened", "slot", "countered"]]]);
  system.pools = [{id: "spell-slot.3", value: 1, max: 3}];
  assert.equal((await afterActionCancelled(event(false), {game: {}, automation, fromUuid: async () => null})).reported, null,
    "only for an Action a user used");
  assert.equal(dispatched.length, 1);
  delete globalThis.ChatMessage;
});

test("an Action the GM cancelled leaves one line in chat, for the GMs and its user", async () => {
  const {noteCancelledByGM} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const posted = [];
  globalThis.ChatMessage = {create: async data => { posted.push(data); return data; }};
  const game = {users: [{id: "gm", isGM: true}, {id: "p1", isGM: false}, {id: "p2", isGM: false}]};
  const state = {warnings: [{code: "RESOLUTION_CANCELLED_BY_GM"}], actionDefinition: {label: "Longsword"}};
  await noteCancelledByGM({options: {actor: {name: "Fighter"}}, state, initiatorUserId: "p1"}, {game});
  assert.deepEqual(posted.map(data => [data.whisper, data.content]), [[["gm", "p1"], "<p>Longsword: cancelled by the GM.</p>"]]);
  assert.equal(await noteCancelledByGM({state: {warnings: [{code: "PROMPT_CANCELLED"}]}}, {game}), null, "only a GM's cancel");
  delete globalThis.ChatMessage;
});

test("an Action that ends effects (Dispel Magic, Remove Curse) ends them on its targets once it completes", async () => {
  const {endEffectsOnTargets} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const effect = (id, metadata) => ({id, name: id, flags: {wildpath: {conditionEffect: {metadata}}}});
  const deleted = [];
  const actor = {uuid: "Actor.orc", effects: [effect("bless", {spellLevel: 1}), effect("haste", {spellLevel: 3}), effect("fly", {spellLevel: 4}),
    effect("curse", {spellLevel: 3, tags: ["curse"]}), effect("prone", {})], deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids)};
  const scene = {tokens: {get: id => (id === "orc" ? {actor, name: "Orc"} : null)}};
  const posted = [];
  globalThis.ChatMessage = {create: async data => posted.push(data)};
  const state = (ends, castingLevel=3) => ({actionDefinition: {ends}, configuration: {castingLevel}, source: {tokenRef: "Scene.s.Token.caster"},
    targets: [{tokenId: "orc"}]});
  const source = {parent: scene};
  const fromUuid = async () => source;
  // Above the slot's level (Fly, 4): the caster's spellcasting check against DC 14.
  const checks = [];
  const caster = total => ({system: {spellcasting: {ability: "intellect"}}, rollTest: async options => {
    checks.push(options);
    return {total: options.ability === "intellect" ? total : 0};
  }});
  await endEffectsOnTargets({options: {actor: caster(15)}, state: state({spells: "slot"})}, {fromUuid, game: {}});
  assert.equal(checks[0].token, source, "the check speaks as the caster's own Token, not a linked one on the GM's Scene");
  assert.equal(checks[0].judged, true, "judged at once: its card offers nothing that could change it (Actor#rollTest)");
  assert.deepEqual(deleted, ["bless", "haste", "curse", "fly"], "spells up to the slot's level, a spell's curse too, and Fly on a 15");
  assert.match(posted[0].content, /bless \(Orc\), haste \(Orc\), fly \(Orc\), curse \(Orc\)/u, "everyone sees what it ended");
  assert.equal(posted[0].whisper, undefined, "a public line");
  assert.match(posted[1].content, /fly/, "the GM is told of the check");
  deleted.length = 0;
  await endEffectsOnTargets({options: {actor: caster(13)}, state: state({spells: "slot"})}, {fromUuid, game: {}});
  assert.equal(deleted.includes("fly"), false, "a 13 leaves it");
  deleted.length = 0;
  await endEffectsOnTargets({state: state({tags: ["curse"]})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["curse"], "Remove Curse: only curses");
  deleted.length = 0;
  actor.effects.push(effect("sight-rot", {contagion: "sight-rot"}));
  await endEffectsOnTargets({state: state({contagions: true})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["sight-rot"], "an Elixir of Health: only magical contagions");
  actor.effects.pop();
  // `statuses` (Guarded Mind, Q68): each whole effect giving one, with what else the same use gave from the same source
  // (Hypnotic Pattern's Incapacitated and its marker); another source's effects and a status toggled by hand alone.
  const given = (id, status, actionDefinitionId, sourceRef) => ({id, name: id, statuses: new Set([status]),
    flags: {wildpath: {conditionEffect: {sourceRef, metadata: {actionDefinitionId}}}}});
  const saved = actor.effects.splice(0);
  actor.effects.push(given("pattern-charmed", "charmed", "hypnotic-pattern", "Actor.wizard"),
    given("pattern-incapacitated", "incapacitated", "hypnotic-pattern", "Actor.wizard"),
    given("pattern-hypnotized", "hypnotized", "hypnotic-pattern", "Actor.wizard"),
    given("other-pattern-incapacitated", "incapacitated", "hypnotic-pattern", "Actor.sorcerer"),
    given("blinded", "blinded", "blindness", "Actor.wizard"), {id: "frightened", name: "frightened", statuses: new Set(["frightened"])},
    {id: "prone", name: "prone", statuses: new Set(["prone"])});
  deleted.length = 0;
  await endEffectsOnTargets({state: state({statuses: ["charmed", "frightened"]})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["pattern-charmed", "pattern-incapacitated", "pattern-hypnotized", "frightened"]);
  actor.effects.splice(0, Infinity, ...saved);

  // `on` (Earthquake): only on the targets whose save had that outcome; a save it does not gate without `on`.
  const saving = (success, ends) => ({...state(ends), actionDefinition: {ends, save: {ability: "dexterity"}},
    results: {saveResolution: {results: [{ok: true, success, target: {tokenId: "orc"}}]}}});
  deleted.length = 0;
  await endEffectsOnTargets({state: saving(true, {tags: ["curse"], on: "failure"})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, [], "a made save: nothing ends");
  await endEffectsOnTargets({state: saving(false, {tags: ["curse"], on: "failure"})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["curse"], "a failed save");
  deleted.length = 0;
  await endEffectsOnTargets({state: saving(true, {tags: ["curse"]})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["curse"], "without on, every target");

  // `enchantments` (Magic Jar's spell over): the bindings with that key its target made, on any creature's Item, end.
  const unbound = [];
  const binding = (id, key, creatorRef) => ({id, flags: {wildpath: {enchantment: {key, creatorRef}}}, async delete() { unbound.push(id); }});
  const holder = {items: [{id: "gem", effects: [binding("jar", "magic-jar", "Actor.orc"), binding("other-jar", "magic-jar", "Actor.wizard"),
    binding("infusion", "infusion", "Actor.orc")]}]};
  await endEffectsOnTargets({state: state({enchantments: ["magic-jar"]})}, {fromUuid, game: {actors: [holder], scenes: []}});
  assert.deepEqual(unbound, ["jar"], "only its own, with that key");
  assert.deepEqual(validateActionDefinition({schemaVersion: 1, id: "x", label: "X", costs: {allOf: []}, ends: {enchantments: "magic-jar"}})
    .errors.map(entry => entry.path), ["ends.enchantments"]);

  // A lasting spell area chosen in place of a creature: at or below the slot's level it ends; above it, on the check.
  const regions = new Map();
  const area = (id, castLevel) => regions.set(id, {id, uuid: `Scene.s.Region.${id}`, flags: {wildpath: {area: {label: id, castLevel}}},
    async delete() { regions.delete(id); }});
  const game = {scenes: {get: id => (id === "s" ? {regions} : null)}};
  const dispelling = (regionId, total) => endEffectsOnTargets({options: {actor: caster(total), dispelArea: {sceneId: "s", regionId}},
    state: {...state({spells: "slot", areas: true}), targets: []}}, {fromUuid, game});
  area("web", 2);
  await dispelling("web", 1);
  assert.equal(regions.has("web"), false, "Web at level 2: ended, no check");
  area("wall", 4);
  await dispelling("wall", 13);
  assert.equal(regions.has("wall"), true, "Wall of Fire at level 4 stays on a 13");
  await dispelling("wall", 14);
  assert.equal(regions.has("wall"), false, "and ends on a 14");
  // No cast level (dispellable: false, or no spell): a dispelArea naming it ends nothing, not read as level 0.
  area("ward", null);
  await dispelling("ward", 30);
  assert.equal(regions.has("ward"), true, "an area with no cast level stays");
  // Through endArea when given: a summon carrying the area is dismissed with its spell (Q31), its Region going with it.
  const ending = [];
  area("sphere-flames", 3);
  await endEffectsOnTargets({options: {actor: caster(1), dispelArea: {sceneId: "s", regionId: "sphere-flames"}},
    state: {...state({spells: "slot", areas: true}), targets: []}}, {fromUuid, game, endArea: async region => ending.push(region.id)});
  assert.deepEqual([ending, regions.has("sphere-flames")], [["sphere-flames"], true]);
  // What an opened section left (Frigid Air) chosen: its wall is ended, and named on the line everyone sees.
  ending.length = 0;
  posted.length = 0;
  area("ice", 6);
  regions.set("frigid", {id: "frigid", uuid: "Scene.s.Region.frigid", flags: {wildpath: {area: {label: "Frigid Air", castLevel: 6,
    parentRegionId: "ice"}}}});
  const iceEnded = await endEffectsOnTargets({options: {actor: caster(1), dispelArea: {sceneId: "s", regionId: "frigid"}},
    state: {...state({spells: "slot", areas: true}, 6), targets: []}}, {fromUuid, game, endArea: async region => ending.push(region.id)});
  assert.deepEqual([ending, Object.keys(iceEnded), posted.at(-1)?.content.includes("ice"), posted.at(-1)?.content.includes("Frigid")],
    [["ice"], ["Scene.s.Region.ice"], true, false]);

  // A creature a lasting spell summoned, targeted itself, is that spell (Q99 (f)): its cast dismissed by the level it was
  // cast at; an instantaneous spell's (no castLevel) and a creature's own effects are judged as before.
  const dismissed = [];
  const summoned = {orc: null};
  const summonScene = {tokens: {get: id => summoned[id] ?? null}};
  const summonSource = async () => ({parent: summonScene});
  const summon = (castLevel, effects=[]) => (summoned.orc = {id: "orc", uuid: "Scene.s.Token.orc", name: "Flaming Sphere",
    flags: {wildpath: {summon: {casterUuid: "Actor.druid", ...(castLevel ? {castLevel} : {})}}},
    actor: {uuid: "Actor.sphere", effects, deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids)}});
  const dispelSummon = (total, ends={spells: "slot"}, deps={}) => endEffectsOnTargets({options: {actor: caster(total)}, state: state(ends)},
    {fromUuid: summonSource, game: {}, endSummon: async (scene, ids) => dismissed.push(...ids), ...deps});
  summon(3);
  await dispelSummon(1);
  assert.deepEqual(dismissed, ["orc"], "cast at level 3: dismissed, no check");
  dismissed.length = 0;
  summon(4);
  await dispelSummon(13);
  assert.deepEqual(dismissed, [], "cast at level 4: stays on a 13");
  await dispelSummon(14);
  assert.deepEqual(dismissed, ["orc"], "and goes on a 14");
  dismissed.length = 0;
  deleted.length = 0;
  summon(null, [effect("bless", {spellLevel: 1})]);
  await dispelSummon(1);
  assert.deepEqual([dismissed, deleted], [[], ["bless"]], "an instantaneous spell's creature stays; its spells end");
  summon(3);
  await dispelSummon(1, {tags: ["curse"]});
  assert.deepEqual(dismissed, [], "Remove Curse never ends a summon");
  await dispelSummon(1, {spells: "slot"}, {endSummon: null});
  assert.deepEqual(dismissed, [], "nothing to dismiss it with: left as it was");

  // A spell on an object (2024 RAW): Magic Weapon (level 2) ends at once; one cast at level 4 on the check.
  const enchantments = new Map();
  const enchant = (id, spellLevel) => enchantments.set(`Actor.a.Item.sword.ActiveEffect.${id}`, {id, uuid: `Actor.a.Item.sword.ActiveEffect.${id}`,
    name: "Magic Weapon", parent: {name: "Longsword"}, flags: {wildpath: {enchantment: {spellLevel}}},
    async delete() { enchantments.delete(this.uuid); }});
  const objectFromUuid = async uuid => enchantments.get(uuid) ?? ({parent: scene});
  const object = (id, total) => endEffectsOnTargets({options: {actor: caster(total), dispelObject: {effectUuid: `Actor.a.Item.sword.ActiveEffect.${id}`}},
    state: {...state({spells: "slot", areas: true}), targets: []}}, {fromUuid: objectFromUuid, game: {}});
  enchant("low", 2);
  await object("low", 1);
  assert.equal(enchantments.size, 0, "Magic Weapon at level 2: ended, no check");
  enchant("high", 4);
  await object("high", 13);
  assert.equal(enchantments.size, 1, "level 4 stays on a 13");
  await object("high", 14);
  assert.equal(enchantments.size, 0, "and ends on a 14");
  delete globalThis.ChatMessage;
});

test("Indomitable (a test offer): a failed save may be rerolled with a bonus of its value expression, from its pool", async () => {
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const indomitable = {id: "ind", name: "Indomitable", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["save"], reroll: true,
    pool: "indomitable", bonus: {type: "class-level", class: "fighter"}}}}};
  const fighter = {uuid: "Actor.fighter", name: "Fighter", items: [indomitable]};
  const system = uses => ({resources: {}, pools: [{id: "indomitable", value: uses, max: 1}], classes: [{id: "fighter", level: 9}]});
  const alone = withTestOffers(null, fighter, system(1), {}, "save", {chooser: "target-controller"});
  assert.deepEqual([alone.own, alone.options.map(option => [option.value, option.bonus, !!option.plan])], [true, [["test-offer:ind", 9, true]]]);
  const inspired = {own: true, chooser: "target-controller", label: "x", options: [{value: "spend:Actor.fighter"}]};
  assert.deepEqual(withTestOffers(inspired, fighter, system(1), {}, "save").options.map(option => option.value),
    ["spend:Actor.fighter", "test-offer:ind"], "beside Heroic Inspiration");
  assert.equal(withTestOffers(null, fighter, system(0), {}, "save"), null, "none left");
  assert.equal(withTestOffers(null, fighter, system(1), {}, "check"), null, "a save's only");
  // Beside a monster offer (the players' Heroic Inspiration), its own joins only when the save failed (owner, Q3).
  const monster = {own: false, options: [{value: "spend:Actor.player"}]};
  assert.deepEqual(withTestOffers(monster, fighter, system(1), {}, "save").options.map(option => [option.value, option.failedOnly ?? false]),
    [["spend:Actor.player", false], ["test-offer:ind", true]]);
});

test("a die an effect lets its creature add (Bardic Inspiration) is offered at its giver's size", async () => {
  const {withAddedDice} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const bard = {documentName: "Actor", system: {classes: [{id: "bard", level: 5}]}};
  globalThis.fromUuidSync = uuid => (uuid === "Actor.bard.Item.inspire" ? {documentName: "Item", parent: bard, actor: bard} : null);
  const inspired = {id: "inspired", name: "Inspired", flags: {wildpath: {conditionEffect: {conditionId: "custom:action:bardic:effect-1",
    sourceRef: "uuid:Actor.bard.Item.inspire", metadata: {addDie: {faces: {type: "table", key: {type: "class-level", class: "bard"},
      rows: {1: 6, 5: 8, 10: 10, 15: 12}}}}}}}};
  const offer = withAddedDice(null, {name: "Fighter", effects: [inspired]}, {}, {chooser: "target-controller", target: {id: "fighter"}});
  assert.deepEqual(offer.options.map(option => [option.value, option.addDice.faces, option.payment.conditionId]),
    [["add:inspired", 8, "custom:action:bardic:effect-1"]], "a 5th-level bard's d8");
  assert.equal(withAddedDice(null, {name: "Fighter", effects: []}, {}, {}), null);
  delete globalThis.fromUuidSync;
});

test("an added die's giver named by a WildPath Token or Actor ref (live: Bardic Inspiration from a bard's Token) is found", async () => {
  const {withAddedDice} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {effectGiverActor} = await import("../module/helpers/effect-sources.mjs");
  const bard = {documentName: "Actor", id: "bard", system: {classes: [{id: "bard", level: 5}]}};
  // An unlinked Token's own (synthetic) Actor, on the second Scene.
  const unlinked = {documentName: "Actor", id: "bard", system: {classes: [{id: "bard", level: 10}]}};
  const previous = globalThis.game;
  globalThis.game = {actors: [bard], scenes: [{id: "s1", tokens: [{id: "other", actor: null}]},
    {id: "s2", tokens: [{id: "tok", actorLink: false, actor: unlinked}]}]};
  const inspired = sourceRef => ({id: "inspired", name: "Inspired", flags: {wildpath: {conditionEffect: {conditionId: "custom:action:bardic:effect-1",
    sourceRef, metadata: {addDie: {faces: {type: "table", key: {type: "class-level", class: "bard"}, rows: {1: 6, 5: 8, 10: 10, 15: 12}}}}}}}});
  const faces = sourceRef => withAddedDice(null, {name: "Fighter", effects: [inspired(sourceRef)]}, {}, {chooser: "target-controller",
    target: {id: "fighter"}, test: "attack"})?.options[0].addDice.faces ?? null;
  try {
    assert.equal(faces("token:tok"), 10, "the unlinked Token's own bard level");
    assert.equal(faces("token:s2.tok"), 10, "scoped to its Scene");
    assert.equal(faces("token:s1.tok"), null, "not on that Scene: no giver, no die");
    assert.equal(faces("actor:bard"), 8, "the world Actor's");
    assert.equal(effectGiverActor(inspired("token:missing")), null);
  } finally {
    globalThis.game = previous;
  }
});

test("a die for one kind of roll (Inspiring Help's) is offered only on it, as many dice as its giver's level gives", async () => {
  const {withAddedDice} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const sidekick = level => ({documentName: "Actor", system: {classes: [{id: "expert", level}]}});
  const givers = {"Actor.veteran": sidekick(20), "Actor.novice": sidekick(11)};
  globalThis.fromUuidSync = uuid => givers[uuid] ?? null;
  const helped = sourceRef => ({id: "helped", name: "Inspiring Help", flags: {wildpath: {conditionEffect: {conditionId: "custom:action:help:effect-1",
    sourceRef, metadata: {addDie: {faces: 6, number: {type: "table", key: {type: "class-level", class: "expert"}, rows: {1: 1, 20: 2}, default: 1},
      tests: ["attack"]}}}}}});
  const game = {i18n: {format: (key, data) => `${key}:${data.number ?? 1}d${data.faces}`}};
  const offer = (sourceRef, test) => withAddedDice(null, {name: "Fighter", effects: [helped(sourceRef)]}, game, {chooser: "source-controller",
    target: {id: "fighter"}, test});
  const veteran = offer("uuid:Actor.veteran", "attack").options[0];
  assert.deepEqual([veteran.addDice, veteran.label, veteran.payment.existingEffectId], [{number: 2, faces: 6}, "WILDPATH.INSPIRATION.AddDice:2d6", "helped"]);
  assert.deepEqual(offer("uuid:Actor.novice", "attack").options[0].addDice, {number: 1, faces: 6});
  assert.equal(offer("uuid:Actor.veteran", "save"), null, "not on a save");
  assert.equal(offer("uuid:Actor.veteran", "check"), null, "nor on a check");
  delete globalThis.fromUuidSync;
});

test("an added die for a check (Assist's) is offered on a check; one with a predicate only on a roll it fits", async () => {
  const {withAddedDice} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {effectAddedDice} = await import("../module/helpers/effect-sources.mjs");
  const helped = addDie => ({id: "helped", name: "Inspiring Help", flags: {wildpath: {conditionEffect: {conditionId: "custom:action:assist:effect-1",
    metadata: {addDie}}}}});
  const offer = (effect, test, context) => withAddedDice(null, {name: "Fighter", effects: [effect]}, {}, {chooser: "source-controller",
    target: {id: "fighter"}, test, context});
  assert.deepEqual(offer(helped({faces: 6, tests: ["check"]}), "check").options[0].addDice, {number: 1, faces: 6});
  assert.equal(offer(helped({faces: 6, tests: ["check"]}), "attack"), null, "not on an attack");
  const beside = helped({faces: 6, tests: ["attack"], predicate: {equals: {path: "attack.allyNearTarget", value: true}}});
  assert.deepEqual(offer(beside, "attack", {attack: {allyNearTarget: true}}).options[0].addDice, {number: 1, faces: 6});
  assert.equal(offer(beside, "attack", {attack: {allyNearTarget: false}}), null, "no ally beside the target: no die");
  assert.equal(effectAddedDice({...beside, disabled: true}, {}, {test: "attack", context: {attack: {allyNearTarget: true}}}), null, "disabled");
});

test("Wild Shape's limits (2014): CR, Fly and Swim Speed by druid level", async () => {
  const {formBeyondLimits} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const limits = {class: "druid", rows: {2: {cr: 0.25, fly: false, swim: false}, 4: {cr: 0.5, fly: false, swim: true}, 8: {cr: 1, fly: true, swim: true}}};
  const druid = level => ({system: {classes: [{id: "druid", level}]}});
  const beast = (name, challenge, mode=null) => ({name, flags: {wildpath: {source: {challenge}}},
    items: mode ? [{system: {ruleElements: [{type: "GrantMovement", data: {mode, distance: 40}}]}}] : []});
  assert.equal(formBeyondLimits(limits, druid(2), beast("Wolf", 0.25)), null);
  assert.match(formBeyondLimits(limits, druid(2), beast("Brown Bear", 1)), /beyond CR 0.25/);
  assert.match(formBeyondLimits(limits, druid(3), beast("Constrictor Snake", 0.25, "swim")), /Swim Speed/);
  assert.equal(formBeyondLimits(limits, druid(4), beast("Constrictor Snake", 0.25, "swim")), null, "swimming from level 4");
  assert.match(formBeyondLimits(limits, druid(5), beast("Giant Owl", 0.25, "fly")), /Fly Speed/);
  assert.equal(formBeyondLimits(limits, druid(8), beast("Giant Owl", 0.25, "fly")), null, "flying from level 8");
  assert.equal(formBeyondLimits(null, druid(1), beast("Mammoth", 6)), null, "no limits, no refusal");
});

test("Shapechange's limit: no form above its user's level or Challenge Rating", async () => {
  const {formBeyondLimits} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const limits = {challenge: "self"};
  const beast = (name, challenge) => ({name, flags: {wildpath: {source: {challenge}}}});
  const caster = {name: "Wizard", system: {details: {level: 5}}};
  assert.match(formBeyondLimits(limits, caster, beast("Mammoth", 6)), /BeyondChallenge|beyond level or CR 5/);
  assert.equal(formBeyondLimits(limits, caster, beast("Giant Crocodile", 5)), null, "its own level is allowed");
  assert.equal(formBeyondLimits(limits, {system: {details: {threat: 13}}}, beast("Mammoth", 6)), null, "a dragon's Challenge Rating");
});

test("a spell cast with a slot in combat is recorded for its turn; a smite, a cantrip, or no combat is not", async () => {
  const {recordSlotSpell} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const game = {combat: {id: "c", round: 1, turn: 2, started: true}};
  const cast = (tags, resourceId="spell-slot.2") => {
    const actor = {flags: {}, async setFlag(scope, key, value) { this.flags[scope] = {...this.flags[scope], [key]: value}; }};
    return {actor, event: {options: {actor}, state: {actionDefinition: {tags},
      results: {paymentResolution: {paymentPlan: {resources: [{resourceId}]}}}}}};
  };
  const fireball = cast(["spell"]);
  await recordSlotSpell(fireball.event, {game});
  assert.equal(fireball.actor.flags.wildpath.slotSpellTurn, "c:1:2");
  for ( const other of [cast(["spell", "smite"]), cast(["spell"], "economy.action")] ) {
    await recordSlotSpell(other.event, {game});
    assert.equal(other.actor.flags.wildpath, undefined);
  }
  const calm = cast(["spell"]);
  await recordSlotSpell(calm.event, {game: {combat: null}});
  assert.equal(calm.actor.flags.wildpath, undefined, "outside combat");
});

test("Immutable Form: a creature that can't shape-shift is not Polymorphed, though it failed its save", async () => {
  const definition = {...WILD_SHAPE, transform: {choiceId: "form", targets: true, keepItemTypes: [], temporaryHealth: "form"}};
  const {configuration} = resolveActionConfiguration({actionDefinition: definition, responses: {form: "Actor.bear"}});
  const golem = {...shifter(), name: "Clay Golem", system: {details: {threat: 9}}, getConditionImmunities: () => ["transformed"]};
  const ogre = {...shifter(), system: {details: {threat: 2}}};
  const caster = {id: "caster", parent: {tokens: new Map([["golem", {actor: golem}], ["ogre", {actor: ogre}]])}};
  const bear = {name: "Bear", system: {details: {threat: 1}, resources: {health: {max: 34}}}};
  await applyActionTransformation({options: {actor: shifter()}, state: {actionDefinition: definition, configuration,
    source: {tokenRef: "Scene.s.Token.caster"}, results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "golem"}},
      {ok: true, success: false, target: {tokenId: "ogre"}}]}}}},
  {fromUuid: async uuid => (uuid === "Actor.bear" ? bear : (uuid === "Scene.s.Token.caster" ? caster : null)), logger: {warn() {}}});
  assert.deepEqual(golem.calls, [], "its shape stays");
  assert.equal(ogre.calls.length, 1, "the other creature that failed is transformed");
});

// A possession (Magic Jar's Possess, a Ghost's Possession): its user takes the body of the one target that failed its save.
const POSSESS = {schemaVersion: 1, id: "action:possess", label: "Possess", costs: {allOf: []}, targeting: {type: "single"},
  save: {ability: "presence", dc: {value: 15}}, transform: {formFrom: "target", copies: [], keepsSpellcasting: true, status: "possessing"}};

test("a transform's formFrom takes its target's body: one form source, a single-target Action, no targets or limits; copies is a list of Item types", () => {
  const definition = (transform, extra={}) => ({...POSSESS, transform: {...POSSESS.transform, ...transform}, ...extra});
  assert.equal(validateActionDefinition(POSSESS).ok, true);
  assert.equal(validateActionDefinition(definition({}, {save: undefined})).ok, true, "with no save, its target is taken");
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear"})).ok, false, "one form source");
  assert.equal(validateActionDefinition(definition({formFrom: "self"})).ok, false);
  assert.equal(validateActionDefinition(definition({}, {targeting: {type: "area"}})).ok, false, "a single target");
  assert.equal(validateActionDefinition(definition({}, {targeting: undefined})).ok, false);
  assert.equal(validateActionDefinition(definition({}, {targeting: {type: "single", count: 1}})).ok, true);
  assert.equal(validateActionDefinition(definition({}, {targeting: {type: "single", count: 3}})).ok, false, "one target");
  assert.equal(validateActionDefinition(definition({}, {save: undefined, attack: {type: "melee", statistic: "spell"}})).ok, false,
    "a miss would not stop it");
  assert.equal(validateActionDefinition(definition({targets: true})).ok, false, "not a Polymorph of its targets");
  assert.equal(validateActionDefinition(definition({limits: {challenge: "self"}})).ok, false, "limits read a fixed or chosen form");
  assert.equal(validateActionDefinition({...WILD_SHAPE, transform: {...WILD_SHAPE.transform, copies: ["action"]}}).ok, true, "copies on any form");
  assert.equal(validateActionDefinition(definition({copies: "feature"})).ok, false);
  assert.equal(validateActionDefinition(definition({copies: [""]})).ok, false);
});

test("a possession turns its user into the first target that failed its save, the Token's own Actor; a save or no target changes nothing", async () => {
  const host = {name: "Mage", uuid: "Scene.s.Token.host.Actor.mage"};
  const caster = {id: "caster", parent: {tokens: new Map([["saved", {actor: {name: "Guard"}}], ["host", {actor: host}]])}};
  const fromUuid = async uuid => (uuid === "Scene.s.Token.caster" ? caster : null);
  const source = {tokenRef: "Scene.s.Token.caster", tokenId: "caster"};
  const results = [{ok: true, success: true, target: {tokenId: "saved"}}, {ok: true, success: false, target: {tokenId: "host"}}];
  const actor = shifter();
  await applyActionTransformation({options: {actor}, state: {actionDefinition: POSSESS, source, results: {saveResolution: {results}}}}, {fromUuid});
  assert.deepEqual(actor.calls, [["transform", "Mage", {keepsSpellcasting: true, status: "possessing", copies: []}]]);
  const resisted = shifter();
  assert.equal(await applyActionTransformation({options: {actor: resisted}, state: {actionDefinition: POSSESS, source,
    results: {saveResolution: {results: [results[0]]}}}}, {fromUuid}), null);
  assert.deepEqual(resisted.calls, [], "every target made its save");
  // A target the save skipped (Unaffected) rolled nothing, so it is not possessed.
  await applyActionTransformation({options: {actor: resisted}, state: {actionDefinition: POSSESS, source,
    results: {saveResolution: {results: [{ok: true, code: "TARGET_SKIPPED", success: false, target: {tokenId: "host"}}]}}}}, {fromUuid});
  assert.deepEqual(resisted.calls, []);
  // A target that failed but whose body is gone (its Token deleted) is the GM's to hear about, not silently dropped.
  const warnings = [];
  const gone = [{ok: true, success: false, target: {tokenId: "deleted"}}];
  assert.equal(await applyActionTransformation({options: {actor: resisted}, state: {actionDefinition: POSSESS, source,
    results: {saveResolution: {results: gone}}}}, {fromUuid, logger: {warn: (...args) => warnings.push(args)}}), null);
  assert.deepEqual(resisted.calls, []);
  assert.deepEqual(warnings, [["Wild Path | WILDPATH.NOTICE.FormMissing", {tokenId: "deleted"}]]);
});

test("a no-save formFrom never takes the body of a target its rules left Unaffected", async () => {
  const definition = {...POSSESS, save: undefined, transform: {formFrom: "target"}};
  const caster = {id: "caster", parent: {tokens: new Map([["host", {actor: {name: "Guard"}}]])}};
  const actor = shifter();
  // The Unaffected target leaves the targets and stays only as an excluded context (withoutUnaffected).
  assert.equal(await applyActionTransformation({options: {actor}, state: {actionDefinition: definition, targets: [],
    results: {targetResolution: {targetContexts: [{target: {tokenId: "host"}, excluded: true, unaffected: true}]}},
    source: {tokenRef: "Scene.s.Token.caster", tokenId: "caster"}}}, {fromUuid: async uuid => (uuid === "Scene.s.Token.caster" ? caster : null)}), null);
  assert.deepEqual(actor.calls, []);
});

test("a formFrom with no save takes its first target's body, composing with the self form's concentration and default copies", async () => {
  const definition = {...POSSESS, save: undefined, transform: {formFrom: "target", concentration: true}};
  const caster = {id: "caster", parent: {tokens: new Map([["host", {actor: {name: "Guard", uuid: "Actor.guard"}}]])}};
  const actor = shifter();
  await applyActionTransformation({options: {actor}, state: {actionDefinition: definition, targets: [{tokenId: "host"}],
    source: {tokenRef: "Scene.s.Token.caster", tokenId: "caster"}}}, {fromUuid: async uuid => (uuid === "Scene.s.Token.caster" ? caster : null)});
  assert.deepEqual(actor.calls, [["transform", "Guard", {concentrationRef: "token:caster"}]]);
});

test("transform copies: the form's Item types its creature gets copies of (features and Actions by default, none with [])", async () => {
  globalThis.Actor ??= class {};
  globalThis.foundry ??= {data: {fields: {}, ActiveEffectTypeDataModel: class {}}, documents: {}, utils: {}};
  globalThis.foundry.utils.setProperty ??= (object, path, value) => {
    const keys = path.split(".");
    const last = keys.pop();
    keys.reduce((node, key) => (node[key] ??= {}), object)[last] = value;
  };
  globalThis.game = {i18n: {format: (key, data) => `${key} ${data.form}`}};
  const {default: WildPathActor} = await import("../module/documents/actor.mjs");
  const item = (type, name) => ({type, toObject: () => ({_id: name, name, type})});
  const form = {name: "Mage", uuid: "Scene.s.Token.host.Actor.mage", prototypeToken: {width: 1, height: 1},
    items: [item("feature", "Magic Resistance"), item("action", "Arcane Burst"), item("gear", "Staff")]};
  const creature = () => ({transformation: null, isToken: true, token: null, system: {resources: {health: {temp: 0}}}, created: [],
    async createEmbeddedDocuments(type, data) { this.created.push([type, data]); return data.map((entry, index) => ({id: `e${index}`, ...entry})); }});
  const copied = actor => actor.created.filter(([type]) => type === "Item").flatMap(([, data]) => data.map(entry => entry.name));
  const wildShaped = creature();
  await WildPathActor.prototype.transform.call(wildShaped, form, {});
  assert.deepEqual(copied(wildShaped), ["Magic Resistance", "Arcane Burst"], "its features and Actions, as before");
  const possessing = creature();
  await WildPathActor.prototype.transform.call(possessing, form, {copies: []});
  assert.deepEqual(copied(possessing), [], "it keeps its own game statistics");
  assert.equal(possessing.created[0][1][0].flags.wildpath.transformation.formRef, "Scene.s.Token.host.Actor.mage");
  const gear = creature();
  await WildPathActor.prototype.transform.call(gear, form, {copies: ["gear"]});
  assert.deepEqual(copied(gear), ["Staff"]);
});

test("once the world is ready, a creature whose form is a Token's Actor is prepared again; others are left alone", () => {
  const formed = ref => ({transformation: ref ? {policy: {formRef: ref}} : null});
  const [possessing, wildShaped, plain] = [formed("Scene.s.Token.host.Actor.mage"), formed("Actor.bear"), formed(null)];
  assert.deepEqual(tokenFormCreatures([possessing, wildShaped, plain]), [possessing]);
  // Foundry prepares world documents before a lazy Token delta's Actor can be read, so the form was missed at load.
  assert.match(readFileSync(new URL("../wildpath.mjs", import.meta.url), "utf8"),
    /Hooks\.once\("ready"[^]*?for \( const actor of tokenFormCreatures\(game\.actors \?\? \[\]\) \) actor\.reset\(\);/u);
});

test("ends.fromSource: a holder letting go ends only the effects it gave, each whole group, never another source's (wave E B16)", async () => {
  const {endEffectsOnTargets} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const given = (id, status, actionDefinitionId, sourceRef) => ({id, name: id, statuses: new Set([status]),
    flags: {wildpath: {conditionEffect: {sourceRef, metadata: {actionDefinitionId, tags: ["curse"]}}}}});
  const deleted = [];
  const held = {uuid: "Actor.hero", effects: [given("cloak-blinded", "blinded", "darkmantle-crush", "Actor.darkmantle"),
    given("cloak-smothered", "suffocating", "darkmantle-crush", "Actor.darkmantle"),
    given("other-blinded", "blinded", "darkmantle-crush", "Actor.other-darkmantle"),
    given("darkness-blinded", "blinded", "darkness", "Actor.mage")], deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids)};
  const darkmantle = {uuid: "Actor.darkmantle", id: "darkmantle"};
  const scene = {tokens: {get: id => (id === "hero" ? {actor: held, name: "Hero"} : null)}};
  globalThis.ChatMessage = {create: async () => null};
  const run = ends => endEffectsOnTargets({state: {actionDefinition: {ends}, source: {tokenRef: "Scene.s.Token.darkmantle"},
    targets: [{tokenId: "hero"}]}}, {fromUuid: async () => ({parent: scene, actor: darkmantle}), game: {scenes: []}});
  await run({statuses: ["blinded"], fromSource: true});
  assert.deepEqual(deleted, ["cloak-blinded", "cloak-smothered"], "its own Blinded and the rest of that use; another's kept");
  deleted.length = 0;
  await run({tags: ["curse"], fromSource: true});
  assert.deepEqual(deleted, ["cloak-blinded", "cloak-smothered"], "tags too");
  deleted.length = 0;
  await run({statuses: ["blinded"]});
  assert.deepEqual(deleted, ["cloak-blinded", "cloak-smothered", "other-blinded", "darkness-blinded"], "without it, every source's");
  deleted.length = 0;
  await endEffectsOnTargets({state: {actionDefinition: {ends: {statuses: ["blinded"], fromSource: true}}, source: {tokenRef: "x"},
    targets: [{tokenId: "hero"}]}}, {fromUuid: async () => ({parent: scene}), game: {scenes: []}});
  assert.deepEqual(deleted, [], "no user found: nothing ends");
  delete globalThis.ChatMessage;
});

test("ends.fromSource reaches the user's own disabled effects and dismisses only a summon its user summoned (wave E B16 review)", async () => {
  const {endEffectsOnTargets} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const deleted = [];
  const dismissed = [];
  const held = {uuid: "Actor.hero", deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids),
    effects: [{id: "cloak-off", name: "Blinded", statuses: new Set(["blinded"]), disabled: true,
      flags: {wildpath: {conditionEffect: {sourceRef: "Actor.darkmantle", metadata: {actionDefinitionId: "crush"}}}}}]};
  const summon = casterUuid => ({id: "wolf", uuid: "Scene.s.Token.wolf", name: "Wolf", actor: {uuid: "Actor.wolf", effects: []},
    flags: {wildpath: {summon: {castLevel: 2, casterUuid}}}});
  const tokens = {hero: {actor: held, name: "Hero"}};
  const scene = {tokens: {get: id => tokens[id] ?? null}};
  globalThis.ChatMessage = {create: async () => null};
  const run = (ends, tokenId) => endEffectsOnTargets({state: {actionDefinition: {ends}, source: {tokenRef: "Scene.s.Token.darkmantle"},
    targets: [{tokenId}]}}, {fromUuid: async () => ({parent: scene, actor: {uuid: "Actor.darkmantle", id: "darkmantle"}}),
    game: {scenes: []}, endSummon: async (_scene, ids) => dismissed.push(...ids)});
  await run({statuses: ["blinded"], fromSource: true}, "hero");
  assert.deepEqual(deleted, ["cloak-off"], "its own Blinded, toggled off, ends too");
  tokens.wolf = summon("Actor.druid");
  await run({spells: 9, fromSource: true}, "wolf");
  assert.deepEqual(dismissed, [], "another caster's summon stays");
  await run({spells: 9}, "wolf");
  assert.deepEqual(dismissed, ["wolf"], "without fromSource it is dismissed");
  dismissed.length = 0;
  tokens.wolf = summon("Actor.darkmantle");
  await run({spells: 9, fromSource: true}, "wolf");
  assert.deepEqual(dismissed, ["wolf"], "its own user's summon is dismissed");
  delete globalThis.ChatMessage;
});

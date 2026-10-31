import assert from "node:assert/strict";
import test from "node:test";

import {creatureTypeFix, featureShapeFix, fillFeatureShapes, fortitudeFix, runMigrations, stalePoolIds, threatFix}
  from "../module/helpers/migrations.mjs";

test("a pool is stale only when nothing names it and it has no base of its own", () => {
  const pools = [
    {id: "spell-slot.1", base: 0}, {id: "hit-die.d8", base: 0}, {id: "heroic-inspiration", base: 0},
    {id: "focus", base: 0}, {id: "wand-charges", base: 0}, {id: "rage", base: 0}, {id: "hand-made", base: 3}, {id: "gone", base: 0}
  ];
  const documents = [
    {system: {active: false, ruleElements: [{type: "GrantResource", data: {id: "wand-charges", maximum: 7}}]}},
    {system: {definition: {costs: [{resourceId: "focus", amount: 1}]}}},
    {effects: [{system: {ruleElements: [{type: "Modifier", data: {domains: ["pools.rage.max"]}}]}}]}
  ];
  assert.deepEqual(stalePoolIds(pools, documents), ["gone"]);
});

test("a per-Item pool ({item} in its grant: Magic Initiate taken twice) stays while its Item is there", () => {
  const feat = id => ({_id: id, system: {ruleElements: [{type: "GrantResource", data: {resourceId: "free-cast.magic-initiate.{item}"}}]}});
  const pools = [{id: "free-cast.magic-initiate.a"}, {id: "free-cast.magic-initiate.b"}];
  assert.deepEqual(stalePoolIds(pools, [feat("a")]), ["free-cast.magic-initiate.b"], "b's feat is gone");
});

test("an NPC converted before fractional Challenge Ratings gets its fraction back", () => {
  const npc = (threat, challenge) => ({type: "npc", system: {details: {threat}}, flags: {wildpath: {source: {challenge}}}});
  assert.equal(threatFix(npc(0, 0.25)), 0.25);
  assert.equal(threatFix(npc(0.25, 0.25)), null);
  assert.equal(threatFix(npc(3, 0.25)), null, "a GM-raised Challenge Rating is kept");
  assert.equal(threatFix(npc(9, 5)), null, "a whole rating lost no fraction");
  assert.equal(threatFix({type: "npc", system: {details: {threat: 3}}}), null, "no converted rating: left as it is");
  assert.equal(threatFix({type: "character", flags: {wildpath: {source: {challenge: 2}}}}), null);
});

test("a character built by level-up records the Fortitude modifier its Hit Points count for each level", () => {
  const character = (fortitude, extra={}) => ({type: "character", system: {classes: [{id: "fighter", level: 3}],
    abilities: {fortitude: {value: fortitude}}, resources: {health: {base: 28, ...extra}}}});
  assert.equal(fortitudeFix(character(14)), 2);
  assert.equal(fortitudeFix(character(9)), -1);
  assert.equal(fortitudeFix(character(14, {perLevelFortitude: 1})), null, "already recorded");
  assert.equal(fortitudeFix({type: "character", system: {classes: [], abilities: {fortitude: {value: 14}}}}), null,
    "Hit Points typed by hand: nothing to count");
  assert.equal(fortitudeFix({type: "npc", system: {classes: [{}]}}), null);
});

test("an NPC converted before creatures carried a type takes it from its compendium creature", () => {
  const types = new Map([["mmZombie00000000", {type: "undead", subtype: ""}]]);
  const zombie = {type: "npc", _id: "worldCopy", system: {details: {type: ""}}, flags: {wildpath: {source: {id: "mmZombie00000000"}}}};
  assert.deepEqual(creatureTypeFix(zombie, types), {"system.details.type": "undead", "system.details.subtype": ""});
  assert.equal(creatureTypeFix({...zombie, system: {details: {type: "fiend"}}}, types), null, "it has one: left as it is");
  assert.equal(creatureTypeFix({...zombie, flags: {}}, types), null, "no compendium creature");
  assert.equal(creatureTypeFix({type: "character"}, types), null);
  const named = new Map([["name:Owl", {type: "beast"}], ["name:Guard", null]]);
  assert.deepEqual(creatureTypeFix({type: "npc", name: "Owl", system: {details: {}}}, named), {"system.details.type": "beast",
    "system.details.subtype": ""}, "no source: one compendium creature of its name");
  assert.equal(creatureTypeFix({type: "npc", name: "Guard", system: {details: {}}}, named), null, "a name several types share");
});

function world({version=0, isGM=true, active=true, contentStamp="", system="", modules=[]}={}) {
  const settings = {version, contentStamp};
  const user = {isGM};
  const told = [];
  return {
    told,
    settings,
    game: {
      user, users: {activeGM: active ? user : {}},
      system: {flags: {wildpath: {contentStamp: system}}}, modules,
      settings: {get: (_scope, key) => ((key === "contentStamp") ? settings.contentStamp : settings.version),
        set: async (_scope, key, value) => { settings[(key === "contentStamp") ? "contentStamp" : "version"] = value; }},
      i18n: {localize: key => key, format: key => key}
    },
    ui: {notifications: {info: text => told.push(["info", text]), warn: text => told.push(["warn", text])}}
  };
}

test("a re-runnable migration runs again when the converted content changes, once; a failure keeps the old stamp", async () => {
  const {contentStampOf} = await import("../module/helpers/migrations.mjs");
  const ran = [];
  const migrations = [{version: 1, name: "one", run: async () => { ran.push(1); }},
    {version: 2, name: "shapes", rerun: true, run: async () => { ran.push(2); }}];
  const book = stamp => ({id: "wildpath-dnd-players-handbook", active: true, flags: {wildpath: {contentStamp: stamp}}});
  const current = world({version: 2, system: "s1", modules: [book("b1"), {id: "other-module", active: true, flags: {}}]});
  current.settings.contentStamp = contentStampOf(current.game);
  assert.equal(contentStampOf(current.game), "system:s1|wildpath-dnd-players-handbook:b1", "the system's and the converted books'");
  await runMigrations({...current, migrations});
  assert.deepEqual(ran, [], "same content: nothing runs");
  current.game.modules[0].flags.wildpath.contentStamp = "b2";
  await runMigrations({...current, migrations});
  assert.deepEqual(ran, [2], "a book reconverted: the re-runnable one runs again, the others don't");
  assert.equal(current.settings.contentStamp, "system:s1|wildpath-dnd-players-handbook:b2");
  await runMigrations({...current, migrations});
  assert.deepEqual(ran, [2], "and only once");
  // A world on version 1: migration 2 runs as new, once, not again as a re-run.
  const behind = world({version: 1, system: "s1"});
  await runMigrations({...behind, migrations});
  assert.deepEqual(ran, [2, 2]);
  // A failing re-run keeps the old stamp, so it runs again next start.
  const failing = world({version: 2, system: "s2", contentStamp: "system:s1"});
  const logger = console.warn;
  console.warn = () => {};
  try {
    await runMigrations({...failing, migrations: [{version: 2, name: "shapes", rerun: true, run: async () => { throw new Error("pack gone"); }}]});
  } finally { console.warn = logger; }
  assert.equal(failing.settings.contentStamp, "system:s1");
});

test("migrations run once, in order, on the active GM only, and stop at a failure", async () => {
  const ran = [];
  const migrations = [
    {version: 2, name: "two", run: async () => { ran.push(2); }},
    {version: 1, name: "one", run: async () => { ran.push(1); }}
  ];
  const fresh = world();
  assert.equal(await runMigrations({...fresh, migrations}), 2);
  assert.deepEqual(ran, [1, 2]);
  assert.equal(fresh.settings.version, 2);
  assert.equal(await runMigrations({...fresh, migrations}), 2, "nothing left to run");
  assert.deepEqual(ran, [1, 2]);

  assert.equal(await runMigrations({...world({active: false}), migrations}), 0, "another GM is the active one");
  assert.equal(await runMigrations({...world({isGM: false}), migrations}), 0, "a Player never migrates");

  const failing = world({version: 1});
  const logger = console.warn;
  console.warn = () => {};
  try {
    const result = await runMigrations({...failing, migrations: [...migrations,
      {version: 3, name: "three", run: async () => { throw new Error("broken"); }},
      {version: 4, name: "four", run: async () => { ran.push(4); }}]});
    assert.equal(result, 2, "stops at the failure, with what came before recorded");
  } finally {
    console.warn = logger;
  }
  assert.equal(failing.settings.version, 2);
  assert.ok(!ran.includes(4));
  assert.ok(failing.told.some(([kind, text]) => (kind === "warn") && (text === "WILDPATH.MIGRATION.Failed")));
});

test("feature shapes (migration 5): an Item takes its compendium copy's generalized rules and spellChoice, additively", () => {
  const bond = {schemaVersion: 1, id: "life-bond", type: "Trigger", data: {kind: "shared-healing", event: "healing.applied", from: "summoner"}};
  const other = {schemaVersion: 1, id: "new-modifier", type: "Modifier", data: {domains: ["ac"], value: 1}};
  const pack = {type: "feature", system: {ruleElements: [bond, other]}, flags: {wildpath: {spellChoice: {flag: "mastered", levels: [1, 2]}}}};
  const stored = {type: "feature", system: {ruleElements: [{id: "own", type: "Modifier", data: {}}]}, flags: {wildpath: {}}};
  assert.deepEqual(featureShapeFix(stored, pack), {"system.ruleElements": [{id: "own", type: "Modifier", data: {}}, bond],
    "flags.wildpath.spellChoice": {flag: "mastered", levels: [1, 2]}}, "the shapes it lacks; an unrelated new pack rule is left out");
  const done = {type: "feature", system: {ruleElements: [bond]}, flags: {wildpath: {spellChoice: {flag: "own", levels: [3]}}}};
  assert.equal(featureShapeFix(done, pack), null, "it has them: nothing");
  const edited = {type: "feature", system: {ruleElements: [{...bond, data: {...bond.data, range: 30}}]}, flags: {wildpath: {}}};
  assert.deepEqual(Object.keys(featureShapeFix(edited, pack)), ["flags.wildpath.spellChoice"], "a rule with that id is never replaced");
  const adept = {type: "feature", system: {ruleElements: [{id: "dice", type: "DamageDieMinimum", data: {damageTypes: ["{training:adept}"]}},
    {id: "potent", type: "RollOutcome", data: {outcome: "half-on-success", domains: ["imposed.save"]}}]}};
  assert.equal(featureShapeFix({type: "feature", system: {}}, adept)["system.ruleElements"].length, 2, "a recorded choice's rule; half-on-success");
  assert.equal(featureShapeFix(stored, null), null, "no copy");
  assert.equal(featureShapeFix({...stored, type: "action"}, pack), null, "another type");
});

test("feature shapes (migration 5): a summoned steed's Items are found through its summonSource, a feat through its own copy", async () => {
  const bond = {schemaVersion: 1, id: "life-bond", type: "Trigger", data: {kind: "shared-healing", event: "healing.applied", from: "summoner"}};
  const potent = {schemaVersion: 1, id: "potent-cantrip", type: "RollOutcome", data: {outcome: "half-on-success", domains: ["imposed.save"]}};
  const source = id => ({wildpath: {source: {id}}});
  const packs = {
    "Compendium.wildpath.srd-creatures.Actor.steed": {toObject: () => ({items: [{type: "feature", flags: source("bond"),
      system: {ruleElements: [bond]}}]})},
    "Compendium.wildpath.srd-items.Item.potent": {toObject: () => ({type: "feature", flags: source("potent"), system: {ruleElements: [potent]}})}
  };
  const item = (id, data) => ({id, ...data, toObject: () => structuredClone({_id: id, ...data})});
  const updates = [];
  const actor = (id, flags, items) => ({id, flags, items,
    updateEmbeddedDocuments: async (name, changes) => updates.push([id, name, changes])});
  const steed = actor("steed", {wildpath: {summonSource: "Compendium.wildpath.srd-creatures.Actor.steed"}},
    [item("b", {type: "feature", flags: source("bond"), system: {ruleElements: []}})]);
  const wizard = actor("wizard", {}, [item("p", {type: "feature", flags: source("potent"), system: {ruleElements: []},
    _stats: {compendiumSource: "Compendium.wildpath.srd-items.Item.potent"}}), item("h", {type: "feature", flags: source("homebrew"),
    system: {ruleElements: []}})]);
  const game = {items: [], actors: [steed, wizard], scenes: []};
  await fillFeatureShapes(game, async uuid => packs[uuid] ?? null);
  assert.deepEqual(updates, [["steed", "Item", [{_id: "b", "system.ruleElements": [bond]}]],
    ["wizard", "Item", [{_id: "p", "system.ruleElements": [potent]}]]], "the homebrew feature, with no copy, is left as it is");
});

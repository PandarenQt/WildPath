import {test} from "node:test";
import assert from "node:assert/strict";
import {hitPointsForLevel, improvementUpdates, levelSteps, multiclassShortfalls, pointBuySpent, poolOptions, traitUpdates, usesPool} from "../module/helpers/level-up.mjs";

test("a level's steps: its entries, the original class's or a multiclass's", () => {
  const advancement = [{level: 1, type: "grant", title: "Class Features"}, {level: 1, type: "trait", title: "Saves", classRestriction: "primary"},
    {level: 1, type: "trait", title: "Armor", classRestriction: "secondary"}, {level: 3, type: "subclass"}, {level: 0, type: "size"}];
  assert.deepEqual(levelSteps(advancement, 1).map(step => step.title), ["Class Features", "Saves"]);
  assert.deepEqual(levelSteps(advancement, 1, {original: false}).map(step => step.title), ["Class Features", "Armor"]);
  assert.deepEqual(levelSteps(advancement, 3).map(step => step.kind), ["subclass"]);
  assert.deepEqual(levelSteps(advancement, 0).map(step => step.kind), ["size"], "a species or background at creation");
});

test("2024 hit points: the Hit Die's maximum at first level, its average rounded up after, plus Fortitude", () => {
  assert.equal(hitPointsForLevel({hitDie: 10, first: true, fortitude: 2}), 12);
  assert.equal(hitPointsForLevel({hitDie: 10, first: false, fortitude: 2}), 8);
  assert.equal(hitPointsForLevel({hitDie: 6, first: false, fortitude: -5}), 1, "at least 1");
});

test("choices and what they change: skills, saves, training and ability increases", () => {
  assert.deepEqual(poolOptions(["skills:*"], {skills: ["athletics", "stealth"]}), ["skills:athletics", "skills:stealth"]);
  assert.equal(poolOptions(["masteries:martial:*"], {skills: []}).includes("masteries:longsword"), true);
  const system = {skills: {stealth: {proficiency: 2}}, training: {armor: ["light"]}, abilities: {might: {value: 15}, agility: {value: 19}}};
  assert.deepEqual(traitUpdates(["skills:athletics", "skills:stealth", "saves:might", "armor:light", "armor:heavy", "weapons:martial",
    "masteries:longsword", "skills:*"], system), {"system.skills.athletics.proficiency": 1, "system.skills.stealth.proficiency": 2,
    "system.abilities.might.saveProficient": true, "system.training.armor": ["light", "heavy"], "system.training.weapons": ["martial"],
    "system.training.masteries": ["longsword"]});
  assert.deepEqual(improvementUpdates({might: 2, agility: 1}, system), {"system.abilities.might.value": 17},
    "two points: Might takes both");
  assert.deepEqual(improvementUpdates({agility: 1, might: 1}, system), {"system.abilities.agility.value": 20, "system.abilities.might.value": 16});
  assert.deepEqual(improvementUpdates({might: 3}, system, {cap: 2, points: 3}), {"system.abilities.might.value": 17}, "at most 2 to one");
});

test("multiclassing wants 13 in a class's primary abilities: all of them, or one", () => {
  const classes = [{name: "Fighter", primaryAbility: {abilities: ["might", "agility"], all: false}},
    {name: "Paladin", primaryAbility: {abilities: ["might", "presence"], all: true}}, {name: "Homebrew"}];
  assert.deepEqual(multiclassShortfalls(classes, {might: 13, presence: 12}), ["Paladin"]);
  assert.deepEqual(multiclassShortfalls(classes, {agility: 14, might: 15, presence: 13}), []);
  assert.deepEqual(multiclassShortfalls(classes, {}), ["Fighter", "Paladin"], "a missing score is 10");
});

test("ability score generation: point buy costs 27 for 15/15/15/8/8/8, and an array is used once each", () => {
  assert.equal(pointBuySpent([15, 15, 15, 8, 8, 8]), 27);
  assert.equal(pointBuySpent([15, 14, 13, 12, 10, 8]), 27);
  assert.equal(pointBuySpent([16, 8, 8, 8, 8, 8]), null, "16 cannot be bought");
  assert.equal(usesPool([8, 10, 12, 13, 14, 15], [15, 14, 13, 12, 10, 8]), true);
  assert.equal(usesPool([15, 15, 13, 12, 10, 8], [15, 14, 13, 12, 10, 8]), false);
});

test("training from its Items merges over its own: a union, proficiency at least 1, Expertise 2; nothing is written", async () => {
  const {mergeTraining, poolOptions} = await import("../module/helpers/level-up.mjs");
  const system = {skills: {stealth: {proficiency: 0}, arcana: {proficiency: 1}, history: {proficiency: 2}},
    abilities: {agility: {saveProficient: false}}, training: {armor: ["light"], weapons: []}};
  mergeTraining(system, ["skills:stealth", "expertise:arcana", "skills:history", "saves:agility", "armor:light", "armor:medium",
    "weapons:hand-crossbow", "skills:*", "skills:unknown"]);
  assert.deepEqual([system.skills.stealth.proficiency, system.skills.arcana.proficiency, system.skills.history.proficiency], [1, 2, 2]);
  assert.equal(system.abilities.agility.saveProficient, true);
  assert.deepEqual([system.training.armor, system.training.weapons], [["light", "medium"], ["hand-crossbow"]]);
  assert.deepEqual(poolOptions(["expertise:*"], {skills: ["arcana", "stealth"]}), ["expertise:arcana", "expertise:stealth"]);
  assert.ok(poolOptions(["masteries:*"], {skills: []}).includes("masteries:longsword"), "every weapon");
});

test("SRD classes: an Expertise step offers Expertise, and one weapon's training is its base name", async () => {
  const fs = await import("node:fs");
  const rogue = JSON.parse(fs.readFileSync("packs/_source/srd-classes/rogue-phbrgeRogue00000.json", "utf8")).system.advancement;
  const pools = rogue.filter(entry => entry.type === "trait").flatMap(entry => (entry.choices ?? []).flatMap(choice => choice.pool));
  assert.ok(pools.includes("expertise:*"), JSON.stringify(pools));
  const grants = rogue.filter(entry => entry.type === "trait").flatMap(entry => entry.grants ?? []);
  assert.ok(grants.includes("weapons:hand-crossbow") || grants.includes("weapons:rapier"), JSON.stringify(grants));
});

test("languages: a choice of any, standard or rare languages, merged as training while their source lasts", async () => {
  const {LANGUAGES, mergeTraining, poolOptions} = await import("../module/helpers/level-up.mjs");
  assert.deepEqual(poolOptions(["languages:standard:*"], {skills: []}), LANGUAGES.standard.map(language => `languages:${language}`));
  assert.equal(poolOptions(["languages:*"], {skills: []}).length, LANGUAGES.standard.length + LANGUAGES.rare.length);
  assert.ok(poolOptions(["languages:rare:*"], {skills: []}).includes("languages:cant"));
  const system = {skills: {}, abilities: {}, training: {languages: ["common"]}};
  mergeTraining(system, ["languages:elvish", "languages:common"]);
  assert.deepEqual(system.training.languages, ["common", "elvish"]);
});

test("source gates: the core books by their rules, other local books as supplements, UA by name, the rest third-party", async () => {
  const {sourceGate} = await import("../module/helpers/level-up.mjs");
  const source = (extra={}) => ({system: "dnd5e", book: "Player's Handbook", rules: "2024", ...extra});
  assert.equal(sourceGate(source(), "wildpath"), "core2024", "the SRD");
  assert.equal(sourceGate(source({rules: "2014"}), "wildpath-dnd-players-handbook"), "core2014");
  assert.equal(sourceGate(source({book: "Tasha's Cauldron of Everything"}), "wildpath-dnd-tashas-cauldron"), "supplement");
  assert.equal(sourceGate(source({book: "Unearthed Arcana: Mages of Strixhaven"}), "wildpath-ua"), "ua");
  assert.equal(sourceGate(source({thirdParty: true}), "wildpath-humblewood"), "thirdParty");
  assert.equal(sourceGate(undefined, "world"), "thirdParty", "homebrew WildPath did not convert");
  assert.equal(sourceGate(source(), "some-module"), "thirdParty");
});

test("a choice's options: what its creature lacks, and what it has that it may replace", async () => {
  const {choiceOptions} = await import("../module/helpers/level-up.mjs");
  const pool = ["Compendium.x.Item.archery", "Compendium.x.Item.defense", "Compendium.x.Item.dueling"];
  const items = [{id: "a", name: "Archery", system: {active: true}, _stats: {compendiumSource: "Compendium.x.Item.archery"}},
    {id: "d", name: "Defense", system: {active: false}, _stats: {compendiumSource: "Compendium.x.Item.defense"}},
    {id: "r", name: "Rope", system: {active: true}, _stats: {compendiumSource: null}}];
  assert.deepEqual(choiceOptions(pool, items), {options: ["Compendium.x.Item.defense", "Compendium.x.Item.dueling"],
    owned: [{id: "a", name: "Archery"}]}, "a replaced (inactive) Defense may be picked again");
});

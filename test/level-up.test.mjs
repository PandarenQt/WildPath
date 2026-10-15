import {test} from "node:test";
import assert from "node:assert/strict";
import {hitPointsForLevel, improvementUpdates, levelSteps, multiclassShortfalls, poolOptions, traitUpdates} from "../module/helpers/level-up.mjs";

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

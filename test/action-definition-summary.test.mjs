import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {summarizeActionDefinition} from "../module/helpers/action-definition-summary.mjs";

const lang = JSON.parse(readFileSync("lang/en.json", "utf8"));
const localize = key => key.split(".").reduce((node, part) => node?.[part], lang) ?? key;
const source = name => JSON.parse(readFileSync(`packs/_source/actions/${name}.json`, "utf8")).system.definition;

test("the item sheet summarizes what a definition does, one line per part", () => {
  assert.deepEqual(summarizeActionDefinition(source("venom-burst"), localize), [
    ["Cost", "1 action"], ["Targets", "single (1)"], ["Range", "ranged 30 ft"], ["Save", "fortitude DC 13"],
    ["Damage", "2d6 poison"], ["Effects", "poisoned"]]);
  assert.deepEqual(summarizeActionDefinition(source("burning-ground"), localize).map(([label]) => label),
    ["Cost", "Targets", "Range", "Area", "Damage"]);
  assert.deepEqual(summarizeActionDefinition({costs: {anyOf: [[{capability: "spell-slot.1", amount: 1}],
    [{capability: "spell-slot.2", amount: 1}]]}, summon: {actorRef: "Actor.wolf", count: 2, concentration: true}}, localize), [
    ["Cost", "1 spell-slot.1 or 1 spell-slot.2"], ["Summon", "Actor.wolf ×2, concentration"]]);
  assert.deepEqual(summarizeActionDefinition(null), []);
  // A count that grows (Eldritch Blast's beams by level, a table) is named as damage's expressions are, not "[object Object]".
  const blast = JSON.parse(readFileSync("packs/_source/srd-items/eldritch-blast-phbsplEldritchBl.json", "utf8")).system.definition;
  assert.equal(new Map(summarizeActionDefinition(blast, localize)).get("Targets"), "multiple (table)");
});

test("the summary's labels and a free cost are lang keys the sheet localizes", () => {
  // The Builder's own section heading and free-cost hint, so the summary and the sections cannot drift apart.
  assert.deepEqual(summarizeActionDefinition({}), [["WILDPATH.BUILDER.Section.costs", "WILDPATH.BUILDER.Costs.Free"]]);
  assert.deepEqual(summarizeActionDefinition({}, key => `<${key}>`), [["<WILDPATH.BUILDER.Section.costs>", "<WILDPATH.BUILDER.Costs.Free>"]]);
  assert.deepEqual(summarizeActionDefinition({}, localize), [["Cost", "Free"]]);
});

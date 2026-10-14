import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {summarizeActionDefinition} from "../module/helpers/action-definition-summary.mjs";

const source = name => JSON.parse(readFileSync(`packs/_source/actions/${name}.json`, "utf8")).system.definition;

test("the item sheet summarizes what a definition does, one line per part", () => {
  assert.deepEqual(summarizeActionDefinition(source("venom-burst")), [
    ["Cost", "1 action"], ["Targets", "single (1)"], ["Range", "ranged 30 ft"], ["Save", "fortitude DC 13"],
    ["Damage", "2d6 poison"], ["Effects", "poisoned"]]);
  assert.deepEqual(summarizeActionDefinition(source("burning-ground")).map(([label]) => label),
    ["Cost", "Targets", "Range", "Area", "Damage"]);
  assert.deepEqual(summarizeActionDefinition({costs: {anyOf: [[{capability: "spell-slot.1", amount: 1}],
    [{capability: "spell-slot.2", amount: 1}]]}, summon: {actorRef: "Actor.wolf", count: 2, concentration: true}}), [
    ["Cost", "1 spell-slot.1 or 1 spell-slot.2"], ["Summon", "Actor.wolf ×2, concentration"]]);
  assert.deepEqual(summarizeActionDefinition(null), []);
});

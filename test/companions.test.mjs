import {test} from "node:test";
import assert from "node:assert/strict";
import {companionOwnershipChanges} from "../module/adapters/foundry-v14-companions.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const users = [{id: "gm", isGM: true}, {id: "ana"}, {id: "bo"}, {id: "cy"}];
// Ana owns the summoner, Bo the fighter, Cy nothing.
const owners = {"Actor.summoner": ["ana"], "Actor.fighter": ["bo"]};
const owns = (userId, ref) => (owners[ref] ?? []).includes(userId);

test("every Player who owns a controller controls the companion; GMs and others are left alone", () => {
  assert.deepEqual(companionOwnershipChanges({controllers: ["Actor.summoner"], users, owns}), {ana: 3});
  assert.deepEqual(companionOwnershipChanges({ownership: {ana: 3}, previous: ["Actor.summoner"],
    controllers: ["Actor.summoner", "Actor.fighter"], users, owns}), {bo: 3}, "sharing control adds the fighter's Player");
});

test("a Player who controlled a companion only through a removed controller returns to the default", () => {
  assert.deepEqual(companionOwnershipChanges({ownership: {ana: 3, bo: 3}, previous: ["Actor.summoner", "Actor.fighter"],
    controllers: ["Actor.fighter"], users, owns}), {ana: -1});
  assert.deepEqual(companionOwnershipChanges({ownership: {cy: 3}, previous: ["Actor.summoner"], controllers: [], users, owns}),
    {}, "an owner the GM set by hand is not touched");
});

test("controller costs are validated like the Action's own costs", () => {
  const definition = controllerCosts => ({schemaVersion: 1, id: "action:bite", label: "Bite", costs: {allOf: []}, controllerCosts});
  assert.equal(validateActionDefinition(definition({allOf: [{capability: "bonus-action", amount: 1},
    {capability: "movement", amount: 10}]})).ok, true);
  assert.deepEqual(validateActionDefinition(definition({allOf: [{capability: "bonus-action", amount: -1}]})).errors
    .map(error => error.path), ["controllerCosts.allOf.0.amount"]);
});

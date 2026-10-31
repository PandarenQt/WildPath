import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {recordMagicTurn} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
import {requiresContext} from "../module/helpers/combat.mjs";
import {evaluatePredicate} from "../module/helpers/predicates.mjs";

const game = {combat: {id: "combat-1", started: true, round: 2, turn: 0}};
const creature = () => {
  const actor = {flags: {wildpath: {}}, system: {}};
  actor.setFlag = async (scope, key, value) => { actor.flags[scope][key] = value; };
  return actor;
};
const cast = (capability, tags=["spell"]) => ({state: {configuration: {effectiveDefinition: {tags, costs: {allOf: [{capability, amount: 1}]}}}}});

test("a spell cast with the Action is this turn's Magic action; Boon of Dimensional Travel's Blink Steps needs it or an attack roll", async () => {
  const actor = creature();
  await recordMagicTurn({options: {actor}, ...cast("bonus-action")}, {game});
  assert.equal(requiresContext(actor, {game}).magicActionThisTurn, false, "a Bonus Action spell (or a Quickened one) is not");
  await recordMagicTurn({options: {actor}, ...cast("action", ["weapon"])}, {game});
  assert.equal(requiresContext(actor, {game}).magicActionThisTurn, false, "an Action that is no spell is not");
  await recordMagicTurn({options: {actor}, ...cast("action")}, {game});
  assert.equal(requiresContext(actor, {game}).magicActionThisTurn, true);
  assert.equal(requiresContext(actor, {game: {combat: {...game.combat, turn: 1}}}).magicActionThisTurn, false, "another turn");
  const boon = JSON.parse(fs.readFileSync("packs/_source/srd-items/boon-of-dimensional-travel-5nr432zyvqpw0000.json", "utf8")).system;
  assert.deepEqual([boon.definition.teleport, boon.ruleElements[0].data.recovery], [{distance: 30}, "turn"]);
  const allowed = context => evaluatePredicate(boon.definition.requires, context).ok;
  assert.deepEqual([allowed({attackedThisTurn: false, magicActionThisTurn: true}), allowed({attackedThisTurn: true, magicActionThisTurn: false}),
    allowed({attackedThisTurn: false, magicActionThisTurn: false})], [true, true, false]);
});

test("Perfect Focus: rolling Initiative brings Focus back up to 4, never down", async () => {
  const {withResourceRestores, resolveActorResourcePayment} = await import("../module/resolvers/resource-resolver.mjs");
  const [trigger] = JSON.parse(fs.readFileSync("packs/_source/srd-items/perfect-focus-phbmnkPerfectFoc.json", "utf8")).system.ruleElements;
  assert.deepEqual([trigger.data.event, trigger.data.predicate], ["initiative.rolled", {all: [{poolBelowMax: "monk-s-focus"}]}]);
  const after = value => {
    const actorSystem = {resources: {}, pools: [{id: "monk-s-focus", value, max: 15}]};
    const paid = resolveActorResourcePayment({actorSystem, cost: {allOf: []}});
    const plan = withResourceRestores(actorSystem, paid.mutationPlan, trigger.data.action.restores);
    return plan.updates?.["system.pools.0.value"] ?? value;
  };
  assert.deepEqual([after(1), after(4), after(9)], [4, 4, 9]);
});

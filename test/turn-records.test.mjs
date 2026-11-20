import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {drawnThisTurn, recordDrawnTurn, recordMagicTurn} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
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
  // Its statuses, for `hasCondition` (Expeditious Retreat's Bonus Action Dash).
  assert.equal(evaluatePredicate({hasCondition: "expeditious-retreat"}, requiresContext({...actor, statuses: new Set(["expeditious-retreat"])}, {game})).ok, true);
  assert.equal(evaluatePredicate({hasCondition: "expeditious-retreat"}, requiresContext(actor, {game})).ok, false);
  const boon = JSON.parse(fs.readFileSync("packs/_source/srd-items/boon-of-dimensional-travel-5nr432zyvqpw0000.json", "utf8")).system;
  assert.deepEqual([boon.definition.teleport, boon.ruleElements[0].data.recovery], [{distance: 30}, "turn"]);
  const allowed = context => evaluatePredicate(boon.definition.requires, context).ok;
  assert.deepEqual([allowed({attackedThisTurn: false, magicActionThisTurn: true}), allowed({attackedThisTurn: true, magicActionThisTurn: false}),
    allowed({attackedThisTurn: false, magicActionThisTurn: false})], [true, true, false]);
});

test("a noRepeat draw's options are its creature's record for the turn, by Action, merged in a turn and replaced on the next (Q25)", async () => {
  const actor = creature();
  const drew = (id, byTarget, draw={choiceId: "drawn", formula: "1d10", noRepeat: "turn"}) => ({options: {actor},
    state: {actionDefinition: {id, draw}, results: {drawResolution: {byTarget}}}});
  await recordDrawnTurn(drew("action:eye-rays", {all: ["charm-ray"]}), {game});
  await recordDrawnTurn(drew("action:eye-rays", {all: ["sleep-ray", "charm-ray"]}), {game});
  await recordDrawnTurn(drew("action:other", {"token-a": ["fear-ray"]}), {game});
  assert.deepEqual(drawnThisTurn(actor, "action:eye-rays", game), ["charm-ray", "sleep-ray"], "merged, once each");
  assert.deepEqual(drawnThisTurn(actor, "action:other", game), ["fear-ray"], "each Action its own");
  await recordDrawnTurn(drew("action:plain", {all: ["red"]}, {choiceId: "drawn", formula: "1d8"}), {game});
  assert.deepEqual(drawnThisTurn(actor, "action:plain", game), [], "a draw without noRepeat is not recorded");
  const next = {combat: {...game.combat, turn: 1}};
  assert.deepEqual(drawnThisTurn(actor, "action:eye-rays", next), [], "another turn reads nothing");
  await recordDrawnTurn(drew("action:eye-rays", {all: ["death-ray"]}), {game: next});
  assert.deepEqual(actor.flags.wildpath.drawnTurn, {turn: "combat-1:2:1", drawn: [["action:eye-rays", "death-ray"]]}, "replaced");
  const outside = creature();
  await recordDrawnTurn({...drew("action:eye-rays", {all: ["charm-ray"]}), options: {actor: outside}}, {game: {combat: null}});
  assert.deepEqual(outside.flags.wildpath, {}, "outside combat nothing is recorded (Q98 default)");
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

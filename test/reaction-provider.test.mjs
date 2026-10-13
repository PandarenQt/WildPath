import assert from "node:assert/strict";
import test from "node:test";

import {bindSelf, createFoundryReactionProvider} from "../module/adapters/foundry-v14-reaction-provider.mjs";

const opportunityTrigger = {schemaVersion: 1, id: "opportunity", type: "Trigger", data: {
  kind: "reaction", event: "movement.transition-proposed", match: {phase: "interrupt"},
  triggerPredicate: {all: [
    {equals: {path: "event.data.relations.{self}.leavesReach", value: true}},
    {equals: {path: "event.data.relations.{self}.context.hostile", value: true}}
  ]}}};
const strike = (reach=5) => ({id: "strike", type: "action", system: {active: true, ruleElements: [opportunityTrigger], definition: {
  schemaVersion: 1, id: "action:opportunity", label: "Opportunity", costs: {allOf: [{capability: "reaction", amount: 1}]},
  targeting: {type: "single", required: true, count: 1}, range: {type: "reach", distance: {value: reach, unit: "ft"}},
  attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
  damage: [{id: "blade", expression: {type: "constant", value: 4}, damageType: "slashing"}]}}});
const token = (id, disposition, items=[]) => ({id, uuid: `Scene.s.Token.${id}`, disposition,
  actor: {id: `actor-${id}`, uuid: `Scene.s.Token.${id}.Actor.actor-${id}`, items}});

function world() {
  const mover = token("mover", 1);
  const guard = token("guard", -1, [strike(10)]);
  const bystander = token("bystander", 0, [strike()]);
  const sleeper = token("sleeper", -1, [{...strike(), system: {...strike().system, active: false}}]);
  const scene = {grid: {distance: 5}, tokens: [mover, guard, bystander, sleeper]};
  const refs = {"Scene.s": scene, [mover.uuid]: mover};
  return createFoundryReactionProvider({resolve: uuid => refs[uuid] ?? null});
}

test("the production reaction provider derives movement reactors from the world's Trigger RuleElements", () => {
  const services = world()({resolutionKind: "movement", intent: {sceneRef: "Scene.s", tokenRef: "Scene.s.Token.mover"}});
  assert.deepEqual(services.reactions.triggers.map(trigger => trigger.owner.tokenId), ["guard", "bystander"],
    "inactive Items and the mover itself never react");
  const [guardTrigger] = services.reactions.triggers;
  assert.equal(guardTrigger.kind, "reaction");
  assert.equal(guardTrigger.reaction.actionId, "action:opportunity");
  assert.equal(guardTrigger.owner.actorId, "Scene.s.Token.guard.Actor.actor-guard");
  assert.equal(guardTrigger.predicate.all[0].equals.path, "event.data.relations.guard.leavesReach", "{self} is bound per reactor");
  assert.deepEqual(services.movement.observers.map(({id, reachFields, context}) => ({id, reachFields, hostile: context.hostile})), [
    {id: "guard", reachFields: 2, hostile: true},
    {id: "bystander", reachFields: 1, hostile: false}
  ], "reach comes from the reaction's range; hostility from opposed dispositions");
});

test("the provider serves native drags from resolved documents and supplies nothing without a mover", () => {
  const provider = createFoundryReactionProvider({resolve: () => null});
  const mover = token("mover", 1);
  const scene = {grid: {distance: 5}, tokens: [mover, token("guard", -1, [strike()])]};
  // Native intents carry entity refs ("token:<scene>.<id>"), not UUIDs: the authority passes the documents.
  const native = provider({intent: {sceneRef: "uuid:Scene.s", tokenRef: "token:s.mover"}, scene, token: mover});
  assert.deepEqual(native.movement.observers.map(observer => observer.id), ["guard"]);
  assert.deepEqual(provider({intent: {sceneRef: "uuid:Scene.s", tokenRef: "token:s.mover"}}), {});
  assert.deepEqual(world()({resolutionKind: "movement", intent: {sceneRef: "Scene.s"}}), {});
  assert.deepEqual(bindSelf({not: {equals: {path: "a.{self}.b", value: "{self}"}}}, "x"),
    {not: {equals: {path: "a.x.b", value: "{self}"}}}, "only paths are bound");
});

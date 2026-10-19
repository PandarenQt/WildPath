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

test("a reaction set to Never is not offered, and one set to Always says so on its trigger", () => {
  const set = policy => ({...strike(), flags: {wildpath: {reactionPolicy: policy}}});
  const mover = token("mover", 1);
  const scene = {grid: {distance: 5}, tokens: [mover, token("eager", -1, [set("always")]), token("calm", -1, [set("never")]),
    token("asks", -1, [strike()])]};
  const services = createFoundryReactionProvider({resolve: () => null})({scene, token: mover});
  assert.deepEqual(services.reactions.triggers.map(trigger => [trigger.owner.tokenId, trigger.metadata.reactionPolicy ?? "ask"]),
    [["eager", "always"], ["asks", "ask"]]);
  assert.deepEqual(services.movement.observers.map(observer => observer.id), ["eager", "asks"], "a Never reactor does not even watch");
});

test("every creature makes Opportunity Attacks, unless its own content does, it is set to Never, or the mover Disengaged", () => {
  const mover = {...token("mover", 1), actor: {id: "actor-mover", uuid: "Actor.mover", items: [], statuses: new Set()}};
  const ogre = token("ogre", -1, []);
  const quiet = {...token("quiet", -1, []), actor: {...token("quiet", -1, []).actor, flags: {wildpath: {commonPolicies: {opportunity: "never"}}}}};
  const scene = {grid: {distance: 5}, tokens: [mover, ogre, quiet, token("guard", -1, [strike()])]};
  const provider = createFoundryReactionProvider({resolve: () => null});
  const services = provider({scene, token: mover});
  assert.deepEqual(services.reactions.triggers.map(trigger => trigger.id),
    ["reaction:ogre:common-opportunity", "reaction:guard:strike:opportunity"], "the guard's own reaction replaces the common one");
  const [common] = services.reactions.triggers;
  assert.equal(common.reaction.action.id, "common:unarmed", "with no weapon, an Unarmed Strike");
  assert.equal(common.predicate.all[0].equals.path, "event.data.relations.ogre.leavesReach");
  assert.deepEqual(services.movement.observers.map(observer => observer.id), ["ogre", "guard"]);
  mover.actor.statuses.add("disengaged");
  assert.deepEqual(provider({scene, token: mover}).reactions.triggers.map(trigger => trigger.id), ["reaction:guard:strike:opportunity"],
    "Disengage stops the common Opportunity Attack");
});

test("Flyby: a creature that avoids Opportunity Attacks while flying provokes none when it flies out of reach", async () => {
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const {opportunityAttackAvoidanceFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const owners = rules => [{ruleElements: rules}];
  const flyby = {schemaVersion: 1, id: "flyby", type: "AvoidOpportunityAttacks", data: {movementModes: ["fly"]}};
  assert.deepEqual(opportunityAttackAvoidanceFromRuleElements(owners([flyby])), {always: false, movementModes: ["fly"]});
  assert.deepEqual(opportunityAttackAvoidanceFromRuleElements(owners([{...flyby, data: {}}])), {always: true, movementModes: []},
    "naming no mode is every movement");

  const avoidance = {always: false, movementModes: ["fly"]};
  const mover = {...token("bat", 1), actor: {id: "actor-bat", uuid: "Actor.bat", items: [], statuses: new Set(),
    getOpportunityAttackAvoidance: () => avoidance}};
  const scene = {grid: {distance: 5}, tokens: [mover, token("ogre", -1, [])]};
  const [trigger] = createFoundryReactionProvider({resolve: () => null})({scene, token: mover}).reactions.triggers;
  const leaving = movementMode => ({event: {data: {movementMode, relations: {ogre: {leavesReach: true, context: {hostile: true}}}}}});
  assert.equal(evaluatePredicate(trigger.predicate, leaving("fly")).ok, false, "flying out of reach");
  assert.equal(evaluatePredicate(trigger.predicate, leaving("walk")).ok, true, "walking out still provokes");
  avoidance.always = true;
  assert.equal(createFoundryReactionProvider({resolve: () => null})({scene, token: mover}).reactions, undefined, "like Disengage");
});

test("2024: being pushed or teleported out of reach provokes no Opportunity Attack", async () => {
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const mover = {...token("mover", 1), actor: {id: "actor-mover", uuid: "Actor.mover", items: [], statuses: new Set()}};
  const scene = {grid: {distance: 5}, tokens: [mover, token("ogre", -1, [])]};
  const [trigger] = createFoundryReactionProvider({resolve: () => null})({scene, token: mover}).reactions.triggers;
  const leaving = movementKind => ({event: {data: {movementKind, movementMode: "walk",
    relations: {ogre: {leavesReach: true, context: {hostile: true}}}}}});
  assert.equal(evaluatePredicate(trigger.predicate, leaving("voluntary")).ok, true, "walking out provokes");
  assert.equal(evaluatePredicate(trigger.predicate, leaving("forced")).ok, false, "pushed out");
  assert.equal(evaluatePredicate(trigger.predicate, leaving("teleport")).ok, false, "teleported out");
});

test("its own hit: Paladin's Smite's 2014 smite while no other slot spell was cast this turn, else the 2024 spell", t => {
  const smite = (id, free) => ({id, type: "action", system: {active: true, definition: {schemaVersion: 1, id: `action:${id}`, label: id,
    tags: ["spell", "smite"], costs: {allOf: free ? [] : [{capability: "bonus-action", amount: 1}]}, range: {type: "special"},
    targeting: {type: "single", required: true, count: 1}, damage: [{id: "d", expression: {type: "constant", value: 1}, damageType: "radiant"}]},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}, ...(free ? {onlyWithoutOtherSlotSpell: true} : {})}}]}});
  const paladin = token("paladin", 1, [smite("paladins-smite", true), smite("divine-smite", false)]);
  const scene = {grid: {distance: 5}, tokens: [paladin, token("foe", -1)]};
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 2, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const offered = () => createFoundryReactionProvider()({scene, token: paladin}).reactions.triggers
    .filter(trigger => trigger.owner.tokenId === "paladin").map(trigger => trigger.reaction.actionId);
  assert.deepEqual(offered(), ["action:paladins-smite"], "no other slot spell this turn: the free one only");
  paladin.actor.flags = {wildpath: {slotSpellTurn: "c:2:0"}};
  assert.deepEqual(offered(), ["action:divine-smite"], "after another slot spell: the 2024 spell");
  globalThis.game.combat.round = 3;
  assert.deepEqual(offered(), ["action:paladins-smite"], "a new turn");
});

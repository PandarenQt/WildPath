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

test("its own hit: Paladin's Smite's 2014 smite beside the 2024 spell while no other slot spell was cast this turn", t => {
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
  assert.deepEqual(offered(), ["action:paladins-smite", "action:divine-smite"], "no other slot spell this turn: both, as options");
  paladin.actor.flags = {wildpath: {slotSpellTurn: "c:2:0"}};
  assert.deepEqual(offered(), ["action:divine-smite"], "after another slot spell: the 2024 spell");
  globalThis.game.combat.round = 3;
  assert.deepEqual(offered(), ["action:paladins-smite", "action:divine-smite"], "a new turn");
});

test("a once-a-turn reaction carries its record key and turn, and is not offered once used this turn", t => {
  const strikeOnce = {...strike(), system: {...strike().system, ruleElements: [{...opportunityTrigger, data: {...opportunityTrigger.data, once: "turn"}}]}};
  const guard = token("guard", -1, [strikeOnce]);
  const scene = {grid: {distance: 5}, tokens: [token("mover", 1), guard]};
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 4, turn: 1, started: true}};
  t.after(() => { globalThis.game = previous; });
  const offered = () => createFoundryReactionProvider()({scene, token: scene.tokens[0]}).reactions?.triggers ?? [];
  assert.deepEqual(offered()[0].payload.once, {key: "strike-opportunity", turn: "c:4:1", uses: 1});
  guard.actor.flags = {wildpath: {onceUsed: {"strike-opportunity": "c:4:1"}}};
  assert.equal(offered().some(trigger => trigger.owner.tokenId === "guard"), false, "used this turn");
  globalThis.game.combat.turn = 2;
  assert.equal(offered().some(trigger => trigger.owner.tokenId === "guard"), true, "a new turn");
});

test("a reaction is offered only while its creature has its status (whileStatus: Brutal Strike needs Reckless Attack)", () => {
  const gated = {...strike(), system: {...strike().system, ruleElements: [{...opportunityTrigger, data: {...opportunityTrigger.data, whileStatus: "reckless"}}]}};
  const guard = token("guard", -1, [gated]);
  const scene = {grid: {distance: 5}, tokens: [token("mover", 1), guard]};
  const offered = () => (createFoundryReactionProvider()({scene, token: scene.tokens[0]}).reactions?.triggers ?? [])
    .some(trigger => trigger.owner.tokenId === "guard");
  assert.equal(offered(), false, "not reckless");
  guard.actor.statuses = new Set(["reckless"]);
  assert.equal(offered(), true);
});

test("options sharing a onceKey (Cunning Strike's three) are one use a turn between them", t => {
  const option = id => ({...strike(), id, system: {...strike().system, ruleElements: [{...opportunityTrigger, id,
    data: {...opportunityTrigger.data, once: "turn", onceKey: "cunning-strike"}}]}});
  const rogue = token("rogue", -1, [option("poison"), option("trip")]);
  const scene = {grid: {distance: 5}, tokens: [token("mover", 1), rogue]};
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 2, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const offered = () => (createFoundryReactionProvider()({scene, token: scene.tokens[0]}).reactions?.triggers ?? [])
    .filter(trigger => trigger.owner.tokenId === "rogue").map(trigger => trigger.payload.once.key);
  assert.deepEqual(offered(), ["cunning-strike", "cunning-strike"]);
  rogue.actor.flags = {wildpath: {onceUsed: {"cunning-strike": "c:2:0"}}};
  assert.deepEqual(offered(), [], "one used: neither again this turn");
});

test("a creature that can't make Opportunity Attacks (Staggering Blow) reacts to no movement", () => {
  const guard = token("guard", -1, [strike(10)]);
  const scene = {grid: {distance: 5}, tokens: [token("mover", 1), guard]};
  const reactors = () => (createFoundryReactionProvider()({resolutionKind: "movement", scene, token: scene.tokens[0]}).reactions?.triggers ?? [])
    .map(trigger => trigger.owner.tokenId);
  assert.deepEqual(reactors(), ["guard"]);
  guard.actor.statuses = new Set(["no-opportunity-attacks"]);
  assert.deepEqual(reactors(), []);
});

test("outside a started encounter, movement provokes nothing: no Opportunity Attack, no movement reaction", (t) => {
  const previous = globalThis.game;
  t.after(() => { globalThis.game = previous; });
  const mover = {...token("mover", 1), actor: {id: "actor-mover", uuid: "Actor.mover", items: [], statuses: new Set()}};
  const scene = {grid: {distance: 5}, tokens: [mover, token("ogre", -1, []), token("guard", -1, [strike()])]};
  const provider = createFoundryReactionProvider({resolve: () => null});
  globalThis.game = {combats: []};
  assert.deepEqual(provider({scene, token: mover}), {}, "no encounter");
  globalThis.game = {combats: [{started: false, combatants: [{actor: mover.actor}]}]};
  assert.deepEqual(provider({scene, token: mover}), {}, "an encounter not yet started");
  globalThis.game = {combats: [{started: true, combatants: [{actor: mover.actor}]}]};
  assert.deepEqual(provider({scene, token: mover}).reactions.triggers.map(trigger => trigger.id),
    ["reaction:ogre:common-opportunity", "reaction:guard:strike:opportunity"]);
});

test("a Trigger naming a common Action (Retaliation) reacts with that Action, at its Item's setting", () => {
  const retaliation = (policy) => ({id: "retaliation", name: "Retaliation", type: "action", ...(policy ? {flags: {wildpath: {reactionPolicy: policy}}} : {}),
    system: {active: true, definition: {schemaVersion: 1, id: "action:retaliation", label: "Retaliation",
      costs: {allOf: [{capability: "reaction", amount: 1}]}},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
      match: {phase: "interrupt", targetTokenId: "{self}", notSourceTokenId: "{self}"}, commonAction: "opportunity"}}]}});
  const mover = token("mover", 1);
  const provider = createFoundryReactionProvider({resolve: () => null});
  const triggers = provider({scene: {grid: {distance: 5}, tokens: [mover, token("barbarian", -1, [retaliation()])]}, token: mover})
    .reactions.triggers.filter(trigger => trigger.event?.type === "damage.applied" || trigger.id.includes("retaliation"));
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].reaction.action.id, "common:unarmed", "with no weapon, an Unarmed Strike");
  assert.equal(triggers[0].reaction.action.label, "Retaliation", "offered under its Item's name");
  assert.deepEqual(triggers[0].reaction.action.costs.allOf.map(cost => cost.capability), ["reaction"]);
  const never = provider({scene: {grid: {distance: 5}, tokens: [mover, token("barbarian", -1, [retaliation("never")])]}, token: mover});
  assert.equal((never.reactions?.triggers ?? []).some(trigger => trigger.id.includes("retaliation")), false, "its Item set to Never");
});

test("its own Action's damage to itself (a fall, its Bleeding) offers its own reactions on itself (Stone's Endurance)", () => {
  const stone = {id: "stone", name: "Stone's Endurance", type: "action", system: {active: true, definition: {schemaVersion: 1,
    id: "action:stone", label: "Stone's Endurance", costs: {allOf: [{capability: "reaction", amount: 1}]}, range: {type: "self"},
    targeting: {type: "self"}}, ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction",
      event: "damage.applied", match: {phase: "before", targetTokenId: "{self}"}}}]}};
  const mover = token("goliath", 1, [stone]);
  const services = createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [mover]}, token: mover});
  assert.deepEqual(services.reactions.triggers.map(trigger => trigger.id), ["reaction:goliath:stone:reaction"]);
});

test("each reactor's relation to an event's source: hostile, how far, and whether it sees it", async () => {
  const {relationsToSource} = await import("../module/adapters/foundry-v14-reaction-provider.mjs");
  const at = (id, disposition, x, statuses=[]) => ({...token(id, disposition), x, y: 0, width: 1, height: 1, elevation: 0,
    actor: {...token(id, disposition).actor, statuses: new Set(statuses), system: {senses: {}}}});
  const scene = {tokenVision: false, grid: {type: 1, size: 100, distance: 5}, dimensions: {size: 100, distance: 5}, tokens: [at("caster", -1, 0),
    at("wizard", 1, 1000), at("imp", -1, 200)]};
  for ( const entry of scene.tokens ) entry.parent = scene;
  const relations = relationsToSource(scene, {source: {tokenId: "caster"}});
  assert.deepEqual(Object.keys(relations), ["wizard", "imp"], "everyone but the source");
  assert.deepEqual([relations.wizard.hostile, relations.wizard.sees, relations.imp.hostile], [true, true, false]);
  assert.equal(relations.wizard.distance, 50, "ten squares away");
  scene.tokens[0].actor.statuses.add("invisible");
  assert.equal(relationsToSource(scene, {source: {tokenId: "caster"}}).wizard.sees, false, "an Invisible caster is not seen");
  assert.deepEqual(relationsToSource(scene, {source: {}}), {}, "no source on the Scene: nothing to read");
  const services = createFoundryReactionProvider({resolve: () => null})({scene, token: scene.tokens[0]});
  assert.equal(typeof services.reactions?.context, "function", "each event's predicates see them (toSource)");
});

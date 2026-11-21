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
  // A reaction its creature's rules forbid (`Forbid`: Gaseous Form's attacks) is not offered.
  guard.actor.forbiddingRule = definition => (definition?.attack ? {id: "gaseous"} : null);
  assert.equal(offered(), false, "forbidden");
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
  assert.equal((triggers[0].reaction.action.tags ?? []).includes("opportunity"), false, "its melee attack is no Opportunity Attack (Sentinel's Halt)");
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

test("a magic item's reaction is offered only while its item is equipped and, when it needs attunement, attuned (Cube of Force)", () => {
  const shield = {id: "cube-shield", name: "Cube of Force: Shield", type: "action", flags: {wildpath: {grantedBy: "cube"}},
    system: {active: true, definition: {schemaVersion: 1, id: "action:cube-shield", label: "Cube of Force: Shield",
      costs: {allOf: [{capability: "reaction", amount: 1}]}, targeting: {type: "self"}},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", targetTokenId: "{self}"}}}]}};
  const offered = gear => {
    const holder = token("holder", 1, [{id: "cube", name: "Cube of Force", type: "gear", system: gear}, shield]);
    return (createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [holder]}, token: holder})
      .reactions?.triggers ?? []).some(trigger => trigger.id.includes("cube-shield"));
  };
  assert.equal(offered({active: true, attunement: "required"}), false, "not attuned");
  assert.equal(offered({active: false, attunement: "attuned"}), false, "not equipped");
  assert.equal(offered({active: true, attunement: "attuned"}), true);
  assert.equal(offered({active: true, attunement: ""}), true, "no attunement needed");
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
  // Mirror Image's duplicates fool the source unless it is Blinded or its Blindsight or Truesight reaches (2024).
  assert.equal(relations.wizard.undeceived, false, "an ordinary attacker is fooled");
  scene.tokens[0].actor.system.senses = {truesight: 60};
  assert.equal(relationsToSource(scene, {source: {tokenId: "caster"}}).wizard.undeceived, true, "Truesight 60 ft reaches 50 ft");
  scene.tokens[0].actor.system.senses = {blindsight: 30};
  assert.equal(relationsToSource(scene, {source: {tokenId: "caster"}}).wizard.undeceived, false, "Blindsight 30 ft does not reach");
  scene.tokens[0].actor.system.senses = {};
  scene.tokens[0].actor.statuses.add("blinded");
  assert.equal(relationsToSource(scene, {source: {tokenId: "caster"}}).wizard.undeceived, true, "a Blinded attacker");
  scene.tokens[0].actor.statuses.delete("blinded");
  scene.tokens[0].actor.statuses.add("invisible");
  assert.equal(relationsToSource(scene, {source: {tokenId: "caster"}}).wizard.sees, false, "an Invisible caster is not seen");
  assert.deepEqual(relationsToSource(scene, {source: {}}), {}, "no source on the Scene: nothing to read");
  const services = createFoundryReactionProvider({resolve: () => null})({scene, token: scene.tokens[0]});
  assert.equal(typeof services.reactions?.context, "function", "each event's predicates see them (toSource)");
});

test("Grappler's Punch and Grab: its own Unarmed Strike's hit offers the common Grapple, free, once a turn", () => {
  const grappler = {id: "grappler", name: "Grappler", type: "feature", system: {active: true, ruleElements: [{schemaVersion: 1, id: "punch-and-grab",
    type: "Trigger", data: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["unarmed"]},
      commonAction: "grapple", free: true, once: "turn", onceKey: "punch-and-grab"}}]}};
  const wrestler = token("wrestler", 1, [grappler]);
  const services = createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [wrestler]}, token: wrestler});
  const [trigger] = services.reactions.triggers.filter(entry => entry.id.includes("punch-and-grab"));
  assert.equal(trigger.reaction.action.id, "common:grapple");
  assert.deepEqual(trigger.reaction.action.costs.allOf, [], "it costs no Action: it comes with the hit");
  assert.match(JSON.stringify(trigger), /"tagsAll":\["unarmed"\]/u, "only on an Unarmed Strike's hit");
});

test("a feature's Trigger carrying its own Action (data.action) reacts with it, at its own setting: no Action Item to use by hand", () => {
  const refill = {schemaVersion: 1, id: "action:refill", label: "Refill", costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
    restores: [{resourceId: "focus", amount: 1}]};
  const feature = {id: "focus", name: "Focus", type: "feature", system: {active: true, ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger",
    data: {kind: "reaction", event: "action.declared", match: {phase: "interrupt", sourceTokenId: "{self}"}, action: refill, policy: "always"}}]}};
  const barbarian = token("barbarian", 1, [feature]);
  const services = createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [barbarian]}, token: barbarian});
  const [trigger] = services.reactions.triggers.filter(entry => entry.id === "reaction:barbarian:focus:reaction");
  assert.deepEqual([trigger.reaction.action.restores, trigger.reaction.actionId, trigger.metadata.reactionPolicy],
    [[{resourceId: "focus", amount: 1}], "action:refill", "always"]);
});

test("each reactor's own effects on the first creature an event names (targetFrom): Superior Hunter's Prey's own Hunter's Mark", () => {
  const prey = {id: "prey", type: "action", system: {active: true, definition: {schemaVersion: 1, id: "action:prey", label: "Prey",
    costs: {allOf: []}, range: {type: "special"}, targeting: {type: "single", required: true, count: 1}},
  ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
    match: {phase: "interrupt", sourceTokenId: "{self}"}}}]}};
  const ranger = token("ranger", 1, [prey]);
  const caster = token("caster", 1);
  const marked = token("marked", -1);
  const mark = {name: "Hunter's Mark", statuses: new Set(["hunters-mark"]), flags: {wildpath: {conditionEffect: {sourceRef: ranger.actor.uuid}}}};
  marked.actor.effects = [mark];
  const services = createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [ranger, caster, marked]}, token: ranger});
  const {targetFrom} = services.reactions.context({event: {targets: [{tokenId: "marked"}]}});
  assert.deepEqual([targetFrom.ranger, targetFrom.caster], [{"hunters-mark": true}, {}], "only its caster's mark is its own");
  assert.deepEqual(services.reactions.context({event: {targets: []}}).targetFrom.ranger, {}, "no creature named: nothing from anyone");
});

test("the creature type of an event's source (sourceType): Holy Aura's ward answers a Fiend's or an Undead's hit", () => {
  const ward = {id: "ward", type: "action", system: {active: true, definition: {schemaVersion: 1, id: "action:ward", label: "Ward",
    costs: {allOf: []}, range: {type: "special"}, targeting: {type: "single", required: true, count: 1}},
  ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
    match: {phase: "interrupt", targetTokenId: "{self}"}, triggerPredicate: {oneOf: {path: "sourceType", values: ["fiend", "undead"]}}}}]}};
  const cleric = token("cleric", 1, [ward]);
  const fiend = token("fiend", -1);
  fiend.actor.system = {details: {type: "fiend"}};
  const services = createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [cleric, fiend]}, token: cleric});
  assert.equal(services.reactions.context({event: {source: {tokenId: "fiend"}, targets: [{tokenId: "cleric"}]}}).sourceType, "fiend");
  assert.equal(services.reactions.context({event: {source: {tokenId: "cleric"}, targets: [{tokenId: "fiend"}]}}).sourceType, null,
    "a creature of no type");
  assert.equal(services.reactions.context({event: {targets: []}}).sourceType, null, "no source");
});

test("a redirect to a creature it picks is offered only while one qualifies, with its limits on side and size (Q47)", async () => {
  const at = (id, disposition, x, {size="medium", statuses=[], hidden=false, items=[]}={}) => ({...token(id, disposition, items), x, y: 0,
    width: 1, height: 1, elevation: 0, hidden, actor: {...token(id, disposition, items).actor, statuses: new Set(statuses),
      system: {senses: {}, traits: {size}}}});
  const redirect = (spec, id="redirect") => ({id, type: "action", system: {active: true, definition: {schemaVersion: 1, id: `action:${id}`,
    label: id, costs: {allOf: [{capability: "reaction", amount: 1}]}, range: {type: "self"}, targeting: {type: "self"},
    rider: {redirectDamage: spec, protects: "target"}},
  ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
    match: {phase: "before", tagsAll: ["hit"], targetTokenId: "{self}"}, triggerPredicate: {equals: {path: "toSource.{self}.sees", value: true}}}}]}});
  const smallOrMedium = {oneOf: {path: "size", values: ["small", "medium"]}};
  const boss = at("boss", -1, 100, {items: [redirect({to: "chosen", range: 5, notHostile: true, eligible: smallOrMedium}),
    redirect({to: "self"}, "own")]});
  const knight = at("knight", 1, 0);
  const scene = {tokenVision: false, grid: {type: 1, size: 100, distance: 5}, dimensions: {size: 100, distance: 5}, tokens: [knight, boss]};
  const gate = others => {
    scene.tokens = [knight, boss, ...others];
    for ( const entry of scene.tokens ) entry.parent = scene;
    const services = createFoundryReactionProvider({resolve: () => null})({scene, token: knight});
    const trigger = services.reactions.triggers.find(entry => entry.id === "reaction:boss:redirect:reaction");
    const context = services.reactions.context({event: {source: {tokenId: "knight"}, targets: [{tokenId: "boss"}]}});
    return {trigger, value: context.redirectable["boss-redirect-reaction"]};
  };
  const {trigger} = gate([]);
  assert.deepEqual(trigger.predicate, {all: [{equals: {path: "toSource.boss.sees", value: true}},
    {equals: {path: "redirectable.boss-redirect-reaction", value: true}}]}, "its own predicate, and a qualifying creature");
  assert.equal(gate([]).value, false, "nobody near: not offered");
  assert.equal(gate([at("goblin", -1, 200)]).value, true, "a Medium ally 5 ft away");
  assert.equal(gate([at("goblin", -1, 300)]).value, false, "10 ft away");
  assert.equal(gate([at("squire", 1, 200)]).value, false, "a creature hostile to it");
  assert.equal(gate([at("ogre", -1, 200, {size: "large"})]).value, false, "a Large ally");
  assert.equal(gate([at("rat", -1, 200, {size: "tiny"})]).value, false, "a Tiny ally: Small or Medium excludes it too");
  assert.equal(gate([at("goblin", -1, 200, {size: "small"})]).value, true, "a Small ally");
  assert.equal(gate([at("goblin", -1, 200, {hidden: true})]).value, false, "one the GM hides");
  assert.equal(gate([at("goblin", -1, 200, {statuses: ["dead"]})]).value, false, "a dead one");
  assert.equal(gate([at("peddler", 0, 200)]).value, true, "a neutral creature counts as friendly");
  // Its own creature taking it (`to: "self"`) needs nobody else: no gate.
  const own = createFoundryReactionProvider({resolve: () => null})({scene, token: knight}).reactions.triggers
    .find(entry => entry.id === "reaction:boss:own:reaction");
  assert.deepEqual(own.predicate, {equals: {path: "toSource.boss.sees", value: true}});
  // An Action's own turns to hostility (`turned`, before they are recorded): the neutral creature attacking the knight is
  // hostile to the knight's side from that attack on.
  scene.tokens = [knight, boss, at("peddler", 0, 200)];
  for ( const entry of scene.tokens ) entry.parent = scene;
  const turned = createFoundryReactionProvider({resolve: () => null})({scene, token: knight,
    turned: [{id: "peddler", side: 1, combat: {}}]}).reactions.context({event: {source: {tokenId: "peddler"}, targets: [{tokenId: "knight"}]}});
  assert.equal(turned.toSource.knight.hostile, true, "the knight answers the neutral attacker as a hostile creature");
});

test("a retarget's and a reaction target's pick are gated like a redirect's, its `eligible` judged from the reactor (Q47)", async () => {
  const at = (id, disposition, x, {statuses=[], items=[], type="humanoid"}={}) => ({...token(id, disposition, items), x, y: 0,
    width: 1, height: 1, elevation: 0, actor: {...token(id, disposition, items).actor, statuses: new Set(statuses),
      system: {senses: {}, traits: {size: "medium"}, details: {type}}}});
  const prey = (retarget, id="prey") => ({id, type: "feature", system: {active: true, ruleElements: [{schemaVersion: 1, id: "reaction",
    type: "Trigger", data: {kind: "reaction", event: "damage.applied", match: {phase: "interrupt", sourceTokenId: "{self}"},
      action: {schemaVersion: 1, id: `action:${id}`, label: id, costs: {allOf: []}, range: {type: "special"},
        targeting: {type: "single", required: true, count: 1}, retarget}}}]}});
  const choice = (targetChoice, id) => ({...prey(null, id), system: {active: true, ruleElements: [{...prey(null, id).system.ruleElements[0],
    data: {...prey(null, id).system.ruleElements[0].data, action: {...prey(null, id).system.ruleElements[0].data.action, retarget: undefined,
      targetChoice}}}]}});
  const scene = {tokenVision: false, grid: {type: 1, size: 100, distance: 5}, dimensions: {size: 100, distance: 5}, tokens: []};
  // The ranger (x 0) hits the orc (x 100); `others` stand beyond the orc.
  const gate = (others, {statuses=[], items=[prey({range: 30})]}={}) => {
    const ranger = at("ranger", 1, 0, {statuses, items});
    scene.tokens = [ranger, at("orc", -1, 100), ...others];
    for ( const entry of scene.tokens ) entry.parent = scene;
    const services = createFoundryReactionProvider({resolve: () => null})({scene, token: ranger});
    const context = services.reactions.context({event: {source: {tokenId: "ranger"}, targets: [{tokenId: "orc"}]}});
    return Object.fromEntries(services.reactions.triggers.map(trigger => [trigger.id, trigger.predicate?.all?.at(-1)?.equals?.path
      ? context.redirectable[trigger.predicate.all.at(-1).equals.path.slice("redirectable.".length)] : null]));
  };
  const key = "reaction:ranger:prey:reaction";
  assert.equal(gate([])[key], false, "nobody near the orc but the ranger");
  assert.equal(gate([at("goblin", -1, 700)])[key], true, "30 ft from the orc, 35 ft from the ranger: around the creature it hit");
  assert.equal(gate([at("goblin", -1, 800)])[key], false, "35 ft from the orc");
  // "That you can see" is the ranger's sight, not the orc's: a Blinded ranger sees nobody.
  const seen = [prey({range: 30, eligible: {equals: {path: "seenBySource", value: true}}})];
  assert.equal(gate([at("goblin", -1, 300)], {items: seen})[key], true);
  assert.equal(gate([at("goblin", -1, 300)], {items: seen, statuses: ["blinded"]})[key], false);
  // A reaction's target among creatures in range: gated unless it may pick itself.
  const picks = [choice({from: "creatures", range: 10}, "pick"), choice({from: "creatures", range: 10, includeSelf: true}, "own")];
  const far = gate([], {items: picks});
  assert.deepEqual([far["reaction:ranger:pick:reaction"], far["reaction:ranger:own:reaction"]], [true, null], "the orc 5 ft away; no gate with itself");
  assert.equal(gate([], {items: [choice({from: "creatures", range: 10, eligible: {equals: {path: "actor.system.details.type", value: "undead"}}},
    "pick")]})["reaction:ranger:pick:reaction"], false, "nobody its `eligible` admits");
});

test("a neutral creature turns hostile to a side once it attacks one of it or is attacked by one, kept on the Combat (Q47)", async () => {
  const {recordTurnedHostile, tokensHostile} = await import("../module/adapters/foundry-v14-hostility.mjs");
  const scene = {id: "s"};
  const placed = (id, disposition) => ({id, disposition, parent: scene});
  const [hero, orc, peddler, hermit] = [placed("hero", 1), placed("orc", -1), placed("peddler", 0), placed("hermit", 0)];
  const combat = {started: true, combatants: [hero, orc, peddler].map(entry => ({tokenId: entry.id, sceneId: "s"})), flags: {},
    writes: 0, async setFlag(scope, key, value) { this.writes += 1; this.flags = {[scope]: {...this.flags[scope], [key]: value}}; }};
  const game = {combats: [combat], user: {isGM: true}};
  assert.deepEqual([tokensHostile(hero, orc, game), tokensHostile(hero, hero, game), tokensHostile(hero, peddler, game),
    tokensHostile(peddler, hermit, game)], [true, false, false, false], "neutral is hostile to no one yet");
  // The peddler attacks the hero: hostile to the hero's side, both ways, and not to the orcs'.
  assert.equal(await recordTurnedHostile(peddler, [hero], game), true);
  assert.deepEqual(combat.flags.wildpath.turnedHostile, {peddler: [1]});
  assert.deepEqual([tokensHostile(peddler, hero, game), tokensHostile(hero, peddler, game), tokensHostile(orc, peddler, game)], [true, true, false]);
  // The orc attacks it: now hostile to both sides; attacking again writes nothing.
  await recordTurnedHostile(orc, [peddler], game);
  assert.deepEqual(combat.flags.wildpath.turnedHostile, {peddler: [1, -1]});
  assert.equal(await recordTurnedHostile(peddler, [hero, orc], game), false, "already recorded");
  assert.equal(combat.writes, 2);
  // A secret Token is on the hostile side; two sides or two neutrals record nothing; nor does a player, nor anyone out of combat.
  assert.equal(tokensHostile({...orc, disposition: -2}, peddler, game), true);
  assert.equal(await recordTurnedHostile(hero, [orc, hero], game), false, "two sides, or itself");
  assert.equal(await recordTurnedHostile(peddler, [hermit], game), false, "two neutral creatures");
  assert.equal(await recordTurnedHostile(hermit, [hero], {...game, user: {isGM: false}}), false, "a player writes nothing");
  assert.equal(await recordTurnedHostile(hermit, [{...hero, id: "stranger"}], game), false, "out of combat: nowhere to keep it");
  assert.equal(tokensHostile(hero, peddler, {combats: []}), false, "the record goes with its Combat");
  // One not in the combat is kept on its attacker's or target's Combat.
  await recordTurnedHostile(hero, [hermit], game);
  assert.deepEqual([combat.flags.wildpath.turnedHostile.hermit, tokensHostile(hermit, hero, game)], [[1], true]);
});

/** War Caster's reactive spell: its converted Trigger, and the one-action spells its creature might cast with it. */
const WAR_CASTER_TRIGGER = {schemaVersion: 1, id: "war-caster-reactive-spell", type: "Trigger", data: {kind: "reaction",
  event: "movement.transition-proposed", match: {phase: "interrupt"}, asOpportunity: true,
  eachAction: {all: [{tagsAll: ["spell", "cost:action"]}, {equals: {path: "action.targeting.count", value: 1}}]},
  replaceCost: {from: "action", to: "reaction"}}};
const spell = (id, {cost = "action", targeting = {type: "single", required: true, count: 1}, extra = {}, flags, prepared,
  range = {type: "ranged", normal: {value: 60, unit: "ft"}}} = {}) => ({id, name: id, type: "action", ...(flags ? {flags} : {}),
  system: {active: true, ...(prepared === false ? {prepared} : {}), definition: {schemaVersion: 1, id: `action:${id}`, label: id,
    tags: ["spell", "component:verbal"], costs: {allOf: [{capability: cost, amount: 1}]}, range, targeting, ...extra}}});
// Eldritch Blast's beams: one below 5th level, two from it.
const eldritch = spell("eldritch-blast", {targeting: {type: "multiple", required: true, repeatable: true,
  count: {type: "table", key: {type: "character-level"}, rows: {1: 1, 5: 2, 11: 3, 17: 4}}}});
function warCasterWorld({policy, moverStatuses = [], forbids = false, avoidance, level = 4} = {}) {
  const feat = {id: "war-caster", name: "War Caster", type: "feature", ...(policy ? {flags: {wildpath: {reactionPolicy: policy}}} : {}),
    system: {active: true, ruleElements: [WAR_CASTER_TRIGGER]}};
  const glaive = {id: "glaive", name: "Glaive", type: "action", system: {active: true, definition: {schemaVersion: 1, id: "action:glaive",
    label: "Glaive", costs: {allOf: [{capability: "action", amount: 1}]}, range: {type: "reach", distance: {value: 10, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "constant", value: 4}, damageType: "slashing"}]}}};
  const slot = {configuration: [{id: "spell-slot", type: "resource", label: "Spell slot", required: true,
    cost: {anyOf: [[{capability: "spell-slot.2", amount: 1}], [{capability: "spell-slot.3", amount: 1}]]},
    levelByResourceId: {"spell-slot.2": 2, "spell-slot.3": 3}, effects: [{type: "scaleTargets", levelChoiceId: "spell-slot", baseLevel: 2, perLevel: 1}]}]};
  const caster = token("caster", -1, [feat, glaive, spell("fire-bolt"), spell("hold-person", {extra: slot}),
    spell("healing-word", {cost: "bonus-action"}), spell("magic-missile", {targeting: {type: "multiple", required: true, count: 3}}),
    spell("fireball", {targeting: {type: "area", required: true}}), spell("shield", {cost: "reaction"}),
    {...spell("inactive"), system: {...spell("inactive").system, active: false}}, spell("unprepared", {extra: slot, prepared: false}),
    eldritch, spell("shocking-grasp", {range: {type: "touch", distance: {value: 5, unit: "ft"}}})]);
  caster.actor.system = {details: {level}};
  if ( forbids ) caster.actor.forbiddingRule = definition => (definition.tags.includes("component:verbal") ? {id: "silenced"} : null);
  const mover = {...token("mover", 1), actor: {id: "actor-mover", uuid: "Actor.mover", items: [], statuses: new Set(moverStatuses),
    ...(avoidance ? {getOpportunityAttackAvoidance: () => avoidance} : {})}};
  return createFoundryReactionProvider({resolve: () => null})({scene: {grid: {distance: 5}, tokens: [mover, caster]}, token: mover});
}

test("War Caster: each one-action spell at one creature is a Reaction option beside the Opportunity Attack, gated as it is", async () => {
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const services = warCasterWorld();
  const triggers = services.reactions.triggers;
  const option = id => `reaction:caster:war-caster:war-caster-reactive-spell:${id}`;
  assert.deepEqual(triggers.map(trigger => trigger.id), [option("fire-bolt"), option("hold-person"), option("eldritch-blast"),
    option("shocking-grasp"), "reaction:caster:common-opportunity"],
  "not a Bonus Action, a Reaction, a several-target, an area, an inactive or an unprepared spell, nor its glaive; Eldritch Blast's "
    + "one beam at 4th level; and its Opportunity Attack stays");
  assert.equal(warCasterWorld({level: 5}).reactions.triggers.some(trigger => trigger.id === option("eldritch-blast")), false,
    "two beams from 5th level");
  const [bolt, hold, , grasp] = triggers;
  assert.deepEqual([bolt.reaction.action.label, hold.reaction.action.label], ["War Caster (fire-bolt)", "War Caster (hold-person)"]);
  assert.deepEqual([bolt, hold].map(trigger => trigger.reaction.action.costs.allOf.map(cost => cost.capability)), [["reaction"], ["reaction"]],
    "cast with the Reaction, so one Reaction between them and the Opportunity Attack");
  assert.equal(hold.reaction.action.configuration[0].id, "spell-slot", "its slot is still asked");
  assert.equal(services.movement.observers[0].reachFields, 2, "it watches its Opportunity Attack's 10-ft reach, not a spell's range");
  const leaving = (extra = {}) => ({event: {data: {movementKind: "voluntary", movementMode: "walk",
    relations: {caster: {leavesReach: true, before: 2, context: {hostile: true}}}, ...extra}}});
  assert.equal(evaluatePredicate(bolt.predicate, leaving()).ok, true, "a hostile creature leaving its reach");
  assert.equal(evaluatePredicate(bolt.predicate, leaving({movementKind: "forced"})).ok, false, "not when pushed out");
  assert.equal(evaluatePredicate(bolt.predicate, {event: {data: {movementKind: "voluntary",
    relations: {caster: {leavesReach: false, before: 1, context: {hostile: true}}}}}}).ok, false, "not while it stays in reach");
  assert.equal(evaluatePredicate(grasp.predicate, leaving()).ok, false, "a touch spell not at a mover leaving from 10 ft");
  assert.equal(evaluatePredicate(grasp.predicate, {event: {data: {movementKind: "voluntary", movementMode: "walk",
    relations: {caster: {leavesReach: true, before: 1, context: {hostile: true}}}}}}).ok, true, "... but from 5 ft");
  const flyby = warCasterWorld({avoidance: {always: false, movementModes: ["fly"]}}).reactions.triggers[0];
  assert.equal(evaluatePredicate(flyby.predicate, leaving({movementMode: "fly"})).ok, false, "not against Flyby's flight");
  assert.equal(evaluatePredicate(flyby.predicate, leaving()).ok, true);
});

test("War Caster offers nothing under Disengage, when set to Never, or for a spell its rules forbid", () => {
  const ids = options => (warCasterWorld(options).reactions?.triggers ?? []).map(trigger => trigger.id);
  assert.deepEqual(ids({moverStatuses: ["disengaged"]}), [], "Disengage stops it as the Opportunity Attack");
  assert.deepEqual(ids({policy: "never"}), ["reaction:caster:common-opportunity"], "its feature set to Never");
  assert.deepEqual(ids({forbids: true}), ["reaction:caster:common-opportunity"], "a Silenced caster's verbal spells");
});

test("a Trigger's asOpportunity, eachAction and replaceCost are validated", async () => {
  const {evaluateRuleElement} = await import("../module/helpers/rule-elements.mjs");
  const check = data => evaluateRuleElement({...WAR_CASTER_TRIGGER, data: {...WAR_CASTER_TRIGGER.data, ...data}}, {}).ok;
  assert.equal(check({}), true);
  assert.equal(check({event: "attack.hit"}), false, "asOpportunity answers movement only");
  assert.equal(check({eachAction: {unknown: 1}}), false, "eachAction is a predicate");
  assert.equal(check({replaceCost: {from: "action"}}), false, "replaceCost names both capabilities");
});

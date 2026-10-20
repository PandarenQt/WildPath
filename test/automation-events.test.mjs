import {test} from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATION_CODES,
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  collectReactionWindows,
  collectTriggeredAutomations,
  createAutomationEvent,
  createReactionTrigger,
  createTriggerDefinition,
  dispatchAutomationEvents,
  matchAutomationEvent
} from "../module/helpers/automation-events.mjs";
import {createBuiltinEconomyResource} from "../module/helpers/action-economy.mjs";

test("automation events normalize source, targets, tags, and payload without mutating inputs", () => {
  const data = {attack: {total: 18}};
  const event = createAutomationEvent({
    id: "hit-1",
    type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "attacker", tokenId: "token-a"},
    targets: [{actorId: "defender", tokenId: "token-d", tags: ["hostile"]}],
    tags: ["melee", "melee"],
    data
  });

  data.attack.total = 1;
  assert.equal(event.actorId, "attacker");
  assert.equal(event.source.ref, "token:token-a");
  assert.equal(event.source.tokenId, "token-a");
  assert.equal(event.targets[0].ref, "token:token-d");
  assert.deepEqual(event.targets.map(target => target.actorId), ["defender"]);
  assert.deepEqual(event.tags, ["melee"]);
  assert.equal(event.data.attack.total, 18);
});

test("automation events accept opaque string references", () => {
  const event = createAutomationEvent({
    type: AUTOMATION_EVENT_TYPES.TURN_STARTED,
    source: "actor:actor-a",
    targets: ["token:scene-a.token-b"]
  });

  assert.equal(event.actorId, "actor-a");
  assert.equal(event.source.ref, "actor:actor-a");
  assert.equal(event.targets[0].ref, "token:scene-a.token-b");
  assert.equal(event.targets[0].tokenId, "token-b");
});

test("trigger collection matches event type, phase, target, tags, and predicate", () => {
  const event = createAutomationEvent({
    id: "damage-1",
    type: AUTOMATION_EVENT_TYPES.DAMAGE_APPLIED,
    phase: AUTOMATION_EVENT_PHASES.AFTER,
    source: {actorId: "attacker"},
    targets: [{actorId: "defender"}],
    tags: ["fire", "spell"],
    data: {damage: {type: "fire", amount: 12}}
  });
  const triggers = [
    createTriggerDefinition({
      id: "fire-shield",
      event: AUTOMATION_EVENT_TYPES.DAMAGE_APPLIED,
      match: {phase: AUTOMATION_EVENT_PHASES.AFTER, targetActorId: "defender", tagsAny: ["fire"]},
      predicate: {equals: {path: "event.data.damage.type", value: "fire"}},
      priority: 20,
      payload: {effect: "retaliate"}
    }),
    createTriggerDefinition({
      id: "cold-shield",
      event: AUTOMATION_EVENT_TYPES.DAMAGE_APPLIED,
      match: {tagsAny: ["cold"]},
      priority: 10
    })
  ];
  const result = collectTriggeredAutomations({triggers, event});

  assert.deepEqual(result.matches.map(match => match.triggerId), ["fire-shield"]);
  assert.equal(result.matches[0].payload.effect, "retaliate");
  assert.equal(result.rejected[0].code, AUTOMATION_CODES.TAG_MISMATCH);
});

test("trigger dispatch ordering is deterministic and one-shot triggers are remembered", () => {
  const event = createAutomationEvent({id: "turn-start", type: AUTOMATION_EVENT_TYPES.TURN_STARTED});
  const triggers = [
    createTriggerDefinition({id: "later", event: AUTOMATION_EVENT_TYPES.TURN_STARTED, priority: 50}),
    createTriggerDefinition({id: "once", event: AUTOMATION_EVENT_TYPES.TURN_STARTED, priority: 10, once: true})
  ];
  const result = dispatchAutomationEvents({events: [event, event], triggers});

  assert.deepEqual(result.dispatches.map(dispatch => dispatch.triggerId), ["once", "later", "later"]);
  assert.deepEqual(result.usedTriggerIds, ["once"]);
  assert.equal(result.rejected.find(rejection => rejection.triggerId === "once").code, AUTOMATION_CODES.ALREADY_USED);
});

test("event matcher reports specific mismatch codes", () => {
  const event = createAutomationEvent({
    type: AUTOMATION_EVENT_TYPES.ATTACK_MISS,
    phase: AUTOMATION_EVENT_PHASES.AFTER,
    source: {actorId: "attacker"},
    targets: [{actorId: "defender"}],
    tags: ["ranged"]
  });

  assert.equal(matchAutomationEvent({type: AUTOMATION_EVENT_TYPES.ATTACK_HIT}, event).code, AUTOMATION_CODES.TYPE_MISMATCH);
  assert.equal(matchAutomationEvent({phase: AUTOMATION_EVENT_PHASES.BEFORE}, event).code, AUTOMATION_CODES.PHASE_MISMATCH);
  assert.equal(matchAutomationEvent({sourceActorId: "other"}, event).code, AUTOMATION_CODES.SOURCE_MISMATCH);
  assert.equal(matchAutomationEvent({targetActorIdsAll: ["defender", "other"]}, event).code, AUTOMATION_CODES.TARGET_MISMATCH);
  assert.equal(matchAutomationEvent({notTagsAny: ["ranged"]}, event).code, AUTOMATION_CODES.TAG_MISMATCH);
  const own = createAutomationEvent({type: AUTOMATION_EVENT_TYPES.ACTION_DECLARED, phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "mage", tokenId: "mage-token"}, tags: ["spell"]});
  assert.equal(matchAutomationEvent({notSourceTokenId: "mage-token"}, own).code, AUTOMATION_CODES.SOURCE_MISMATCH, "not its own spell");
  assert.equal(matchAutomationEvent({notSourceTokenId: "other-token", tagsAny: ["spell"]}, own).ok, true);
});

test("reaction windows use reaction resources without committing payment", () => {
  const event = createAutomationEvent({
    id: "incoming-hit",
    type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "attacker"},
    targets: [{actorId: "defender"}],
    tags: ["weapon-attack"]
  });
  const resources = [createBuiltinEconomyResource("economy.reaction", {current: 1, maximum: 1})];
  const trigger = createReactionTrigger({
    id: "shield",
    event: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    match: {phase: AUTOMATION_EVENT_PHASES.INTERRUPT, targetActorId: "defender"},
    actorId: "defender",
    actionId: "spell.shield",
    priority: 5
  });
  const result = collectReactionWindows({
    triggers: [trigger],
    event,
    resourcesByActor: {defender: resources}
  });

  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].actorId, "defender");
  assert.equal(result.windows[0].actionId, "spell.shield");
  assert.equal(result.windows[0].selectedPaymentOption.resources[0].resourceId, "economy.reaction");
  assert.equal(resources[0].current, 1);
});

test("spent reactions are rejected as unavailable reaction windows", () => {
  const event = createAutomationEvent({
    type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    targets: [{actorId: "defender"}]
  });
  const trigger = createReactionTrigger({
    id: "shield",
    event: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    match: {phase: AUTOMATION_EVENT_PHASES.INTERRUPT, targetActorId: "defender"},
    actorId: "defender"
  });
  const result = collectReactionWindows({
    triggers: [trigger],
    event,
    resourcesByActor: {
      defender: [createBuiltinEconomyResource("economy.reaction", {current: 0, maximum: 1})]
    }
  });

  assert.equal(result.windows.length, 0);
  assert.equal(result.rejected.find(rejection => rejection.triggerId === "shield").code, AUTOMATION_CODES.REACTION_UNAVAILABLE);
});

test("Persistent Rage: its Trigger answers initiative while Rage is spent and its own use is left", async () => {
  const fs = await import("node:fs");
  const {automationTriggers} = await import("../module/adapters/foundry-v14-automation-dispatcher.mjs");
  const feature = JSON.parse(fs.readFileSync("packs/_source/srd-items/persistent-rage-phbbrbPersistent.json", "utf8"));
  const actorWith = (rage, own) => ({id: "barb", items: [{id: feature._id, type: "feature", name: feature.name, system: feature.system}],
    effects: [], system: {pools: [{id: "rage", value: rage, max: 5}, {id: "persistent-rage", value: own, max: 1}]}});
  const event = {type: "initiative.rolled"};
  const [trigger] = automationTriggers(actorWith(0, 1), event);
  assert.ok(trigger, "offered with Rage spent");
  assert.deepEqual(trigger.definition.restores.map(entry => entry.resourceId), ["rage"]);
  assert.equal(automationTriggers(actorWith(5, 1), event).length, 0, "Rage full");
  assert.equal(automationTriggers(actorWith(0, 0), event).length, 0, "already used this Long Rest");
});

test("Survivor's Heroic Rally answers its turn's start while Bloodied and above 0 Hit Points", async () => {
  const fs = await import("node:fs");
  const {automationTriggers} = await import("../module/adapters/foundry-v14-automation-dispatcher.mjs");
  const feature = JSON.parse(fs.readFileSync("packs/_source/srd-items/survivor-phbftrSurvivor00.json", "utf8"));
  const actorAt = value => ({id: "f", items: [{id: feature._id, type: "feature", name: feature.name, system: feature.system}], effects: [],
    system: {resources: {health: {value, max: 40}}, pools: []}});
  const event = {type: "turn.started"};
  assert.equal(automationTriggers(actorAt(15), event).length, 1);
  assert.equal(automationTriggers(actorAt(30), event).length, 0, "not Bloodied");
  assert.equal(automationTriggers(actorAt(0), event).length, 0, "at 0 Hit Points");
});

test("Tireless: a Short Rest's rest.completed takes one Exhaustion level off; a Long Rest's does not", async () => {
  const fs = await import("node:fs");
  const {automationTriggers} = await import("../module/adapters/foundry-v14-automation-dispatcher.mjs");
  const item = JSON.parse(fs.readFileSync("packs/_source/srd-items/tireless-temporary-hit-points-phbrgrTireless00.json", "utf8"));
  const actor = {id: "ranger", items: [{id: item._id, type: "action", name: item.name, system: item.system}], effects: [], system: {pools: []}};
  const [trigger] = automationTriggers(actor, {type: "rest.completed", data: {restType: "shortRest"}});
  assert.deepEqual(trigger?.definition.effects, [{id: "effect-1", type: "condition", conditionId: "exhaustion", levels: -1}]);
  assert.equal(automationTriggers(actor, {type: "rest.completed", data: {restType: "longRest"}}).length, 0);
});

test("a reaction whose required resource choice it can't pay (Eldritch Smite with no Pact Magic slot) is not offered", async () => {
  const fs = await import("node:fs");
  const {economyResourcesFromActorResources} = await import("../module/helpers/action-economy.mjs");
  const smite = JSON.parse(fs.readFileSync("packs/_source/srd-items/eldritch-smite-phbinvEldritchSm.json", "utf8")).system.definition;
  const event = createAutomationEvent({type: AUTOMATION_EVENT_TYPES.ATTACK_HIT, phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "warlock"}, targets: [{actorId: "orc"}]});
  const trigger = createReactionTrigger({id: "smite", event: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    match: {phase: AUTOMATION_EVENT_PHASES.INTERRUPT}, actorId: "warlock", action: smite, cost: smite.costs});
  const offered = slots => collectReactionWindows({triggers: [trigger], event, resourcesByActor: {warlock: economyResourcesFromActorResources({
    resources: {reaction: {value: 1, max: 1}}, classes: [{id: "warlock", level: 5, spellcasting: {progression: "pact"}}],
    pools: [{id: "spell-slot.pact", value: slots, max: 2}]})}});
  assert.equal(offered(1).windows.length, 1, "a slot left");
  const none = offered(0);
  assert.deepEqual([none.windows.length, none.rejected[0].code], [0, AUTOMATION_CODES.REACTION_UNAVAILABLE], "none left");
});

test("atMost: the number at a path is at most a value; missing is not", async () => {
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const near = {atMost: {path: "event.data.relations.me.distance", value: 5}};
  assert.equal(evaluatePredicate(near, {event: {data: {relations: {me: {distance: 5}}}}}).ok, true);
  assert.equal(evaluatePredicate(near, {event: {data: {relations: {me: {distance: 10}}}}}).ok, false);
  assert.equal(evaluatePredicate(near, {event: {data: {}}}).ok, false);
  assert.equal(evaluatePredicate({atMost: {path: "x"}}, {}).code, "INVALID_PREDICATE");
});

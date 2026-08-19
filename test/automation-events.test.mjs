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
  assert.equal(event.source.tokenId, "token-a");
  assert.deepEqual(event.targets.map(target => target.actorId), ["defender"]);
  assert.deepEqual(event.tags, ["melee"]);
  assert.equal(event.data.attack.total, 18);
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

import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_BAR_ENTRY_STATES,
  createActionBarViewModel,
  createCombatCarouselViewModel,
  UI_COMMAND_TYPES
} from "../module/helpers/ui-view-models.mjs";

function actorSystem({action=1, bonus=1, reaction=1}={}) {
  return {
    resources: {
      action: {value: action, max: 1},
      bonus: {value: bonus, max: 1},
      reaction: {value: reaction, max: 1},
      movement: {value: 30, max: 30}
    },
    pools: []
  };
}

test("action bar view model exposes resolver-driven action button state", () => {
  const model = createActionBarViewModel({
    actor: {id: "actor-a", name: "Rook"},
    actorSystem: actorSystem(),
    actions: [
      {id: "strike", name: "Strike", activationCost: {allOf: [{capability: "action", amount: 1}]}},
      {id: "free-step", name: "Free Step", activationCost: {allOf: []}}
    ],
    selectedActionId: "strike"
  });

  const strike = model.actions.find(action => action.id === "strike");
  const free = model.actions.find(action => action.id === "free-step");

  assert.equal(model.actorRef, "actor:actor-a");
  assert.equal(strike.ref, "item:strike");
  assert.equal(strike.enabled, true);
  assert.equal(strike.selected, true);
  assert.equal(strike.state, ACTION_BAR_ENTRY_STATES.SELECTED);
  assert.equal(strike.command.type, UI_COMMAND_TYPES.USE_ACTION);
  assert.equal(strike.command.actorRef, "actor:actor-a");
  assert.equal(strike.payment.defaultOptionId, "payment-1");
  assert.equal(free.group, "free");
  assert.equal(model.summary.readyCount, 2);
});

test("action bar keeps bonus-action fallback visible as payment metadata", () => {
  const model = createActionBarViewModel({
    actorRef: "actor:actor-a",
    actorSystem: actorSystem({action: 1, bonus: 0}),
    actions: [
      {id: "shove", name: "Shove", activationCost: {allOf: [{capability: "bonus-action", amount: 1}]}}
    ]
  });
  const shove = model.actions[0];
  const payment = shove.payment.options[0].resources[0];

  assert.equal(shove.enabled, true);
  assert.equal(payment.resourceId, "economy.action");
  assert.equal(payment.mode, "alternative");
  assert.equal(payment.alternativeFor, "bonus-action");
  assert.equal(payment.policy, "action-for-spent-bonus-action");
});

test("action bar reports unavailable actions without creating a use command", () => {
  const model = createActionBarViewModel({
    actorRef: "actor:actor-a",
    actorSystem: actorSystem({action: 0}),
    actions: [
      {id: "strike", name: "Strike", activationCost: {allOf: [{capability: "action", amount: 1}]}}
    ]
  });

  assert.equal(model.actions[0].enabled, false);
  assert.equal(model.actions[0].state, ACTION_BAR_ENTRY_STATES.UNAVAILABLE);
  assert.equal(model.actions[0].command, null);
  assert.equal(model.summary.unavailableCount, 1);
});

test("action bar can derive action entries from actor item collections", () => {
  const model = createActionBarViewModel({
    actor: {
      id: "actor-a",
      system: actorSystem(),
      items: {
        contents: [
          {id: "strike", type: "action", name: "Strike", activationCost: {allOf: []}},
          {id: "rope", type: "gear", name: "Rope"}
        ]
      }
    }
  });

  assert.deepEqual(model.actions.map(action => action.id), ["strike"]);
});

test("combat carousel view model exposes turn order through opaque refs", () => {
  const model = createCombatCarouselViewModel({
    timeline: {
      id: "combat-a",
      round: 2,
      turn: 1,
      combatants: [
        {id: "c1", actorId: "actor-a", tokenId: "token-a", initiative: 18, metadata: {label: "Rook"}},
        {id: "c2", actorId: "actor-b", tokenId: "token-b", initiative: 12, metadata: {label: "Mire"}},
        {id: "c3", actorId: "actor-c", tokenId: "token-c", initiative: 8, metadata: {label: "Sable"}}
      ]
    },
    resourcesByActorRef: {
      "actor:actor-b": [{id: "economy.action", category: "action", current: 0, maximum: 1}]
    },
    statusesByActorRef: {
      "actor:actor-b": ["poisoned"]
    }
  });

  assert.equal(model.combatRef, "combat:combat-a");
  assert.equal(model.activeRef, "combatant:combat-a.c2");
  assert.equal(model.activeActorRef, "actor:actor-b");
  assert.equal(model.previous.ref, "combatant:combat-a.c1");
  assert.equal(model.next.ref, "combatant:combat-a.c3");
  assert.equal(model.turns[1].active, true);
  assert.equal(model.turns[0].distanceFromActive, -1);
  assert.equal(model.turns[2].distanceFromActive, 1);
  assert.equal(model.turns[1].resources[0].depleted, true);
  assert.deepEqual(model.turns[1].statuses, ["poisoned"]);
  assert.equal(model.commands.startActiveTurn.type, UI_COMMAND_TYPES.START_ACTOR_TURN);
});

test("combat carousel can hide hidden combatants for player-facing views", () => {
  const model = createCombatCarouselViewModel({
    timeline: {
      id: "combat-a",
      combatants: [
        {id: "visible", actorId: "actor-a"},
        {id: "hidden", actorId: "actor-b", hidden: true}
      ]
    },
    includeHidden: false
  });

  assert.deepEqual(model.turns.map(turn => turn.id), ["visible"]);
  assert.equal(model.summary.hiddenCount, 1);
});

test("combat carousel accepts Foundry-shaped combat turns", () => {
  const model = createCombatCarouselViewModel({
    combat: {
      id: "combat-a",
      round: 1,
      turn: 0,
      scene: {id: "scene-a"},
      turns: [
        {
          id: "turn-a",
          tokenId: "token-a",
          actor: {id: "actor-a", name: "Rook"},
          token: {name: "Rook Token"},
          initiative: 20
        }
      ]
    }
  });

  assert.equal(model.turns[0].label, "Rook");
  assert.equal(model.turns[0].actorRef, "actor:actor-a");
  assert.equal(model.turns[0].tokenRef, "token:scene-a.token-a");
});

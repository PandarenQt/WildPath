import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  TURN_RECOVERY_CODES,
  getCombatLifecycleEvents
} from "../module/helpers/combat.mjs";

class FakeField {
  constructor(config={}) {
    this.config = config;
  }
}

globalThis.Actor = class {};
globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class {
      static defineSchema() {
        return {};
      }
    },
    fields: {
      SchemaField: FakeField,
      NumberField: FakeField,
      StringField: FakeField,
      ArrayField: FakeField,
      SetField: FakeField,
      BooleanField: FakeField,
      ObjectField: FakeField
    }
  },
  utils: {
    isEmpty(value) {
      return !value || Object.keys(value).length === 0;
    }
  }
};

const {default: WildPathActor} = await import("../module/documents/actor.mjs");

const GM_AUTHORITY = {
  isGM: true,
  canCommit: true,
  userId: "gm-a",
  activeGMId: "gm-a"
};

const PLAYER_AUTHORITY = {
  isGM: false,
  canCommit: false,
  userId: "player-a",
  activeGMId: "gm-a"
};

test("Actor sheet no longer exposes or handles manual Start Turn", () => {
  const template = readFileSync(new URL("../templates/actor/actor-sheet.hbs", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("../module/applications/actor-sheet.mjs", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles/wildpath.css", import.meta.url), "utf8");
  const uiModels = readFileSync(new URL("../module/helpers/ui-view-models.mjs", import.meta.url), "utf8");

  assert.equal(template.includes('data-action="startTurn"'), false);
  assert.equal(template.includes("Start Turn"), false);
  assert.equal(sheet.includes("startTurn:"), false);
  assert.equal(sheet.includes("#onStartTurn"), false);
  assert.equal(sheet.includes("this.actor.startTurn"), false);
  assert.equal(css.includes("turn-button"), false);
  assert.equal(uiModels.includes("actor.startTurn"), false);
});

test("manual or non-authoritative startTurn cannot refresh during active combat", async () => {
  const actor = fakeActor("actor-a");
  const {combat, combatant, events} = combatStartContext(actor);

  const noContext = await actor.startTurn();
  const playerContext = await actor.startTurn({
    combat,
    combatant,
    events,
    authority: PLAYER_AUTHORITY,
    hook: "combatStart"
  });

  assert.equal(noContext.ok, false);
  assert.equal(noContext.code, TURN_RECOVERY_CODES.MISSING_COMBAT);
  assert.equal(playerContext.ok, false);
  assert.equal(playerContext.code, TURN_RECOVERY_CODES.COMMIT_NOT_AUTHORIZED);
  assert.equal(actor.system.resources.action.value, 0);
  assert.equal(actor.system.resources.movement.value, 10);
  assert.equal(actor.triggerCalls.length, 0);
  assert.equal(actor.updateCalls.length, 0);
});

test("combatTurn recovery refreshes only the incoming combatant and preserves generic turn pools", async () => {
  const actorA = fakeActor("actor-a");
  const actorB = fakeActor("actor-b");
  const {combat, combatantB, events} = combatTurnContext({actorA, actorB});

  const result = await actorB.startTurn({
    combat,
    combatant: combatantB,
    events,
    authority: GM_AUTHORITY,
    hook: "combatTurn"
  });

  assert.equal(result.ok, true);
  assert.equal(actorB.system.resources.action.value, 1);
  assert.equal(actorB.system.resources.movement.value, 30);
  assert.equal(actorB.system.resources.reaction.value, 1);
  assert.equal(actorB.system.pools.find(pool => pool.id === "focus").value, 3);
  assert.equal(actorB.system.resources.shortRest.value, 0);
  assert.equal(actorB.system.resources.longRest.value, 0);
  assert.equal(actorB.system.pools.find(pool => pool.id === "short-pool").value, 0);
  assert.equal(actorB.system.pools.find(pool => pool.id === "long-pool").value, 0);
  assert.equal(actorB.triggerCalls.length, 1);
  assert.equal(actorB.triggerCalls[0].some(event => event.type === "turnStart" && event.actorId === "actor-b"), true);
  assert.equal(actorA.system.resources.action.value, 0);
  assert.equal(actorA.system.resources.movement.value, 10);
  assert.equal(actorA.triggerCalls.length, 0);
});

test("combatStart recovery refreshes the first combatant once", async () => {
  const actor = fakeActor("actor-a");
  const {combat, combatant, events} = combatStartContext(actor);

  const result = await actor.startTurn({
    combat,
    combatant,
    events,
    authority: GM_AUTHORITY,
    hook: "combatStart"
  });

  assert.equal(result.ok, true);
  assert.equal(actor.system.resources.action.value, 1);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(actor.triggerCalls.length, 1);
});

test("wrong actor cannot recover from another combatant turn", async () => {
  const actorA = fakeActor("actor-a");
  const actorB = fakeActor("actor-b");
  const {combat, combatantB, events} = combatTurnContext({actorA, actorB});

  const result = await actorA.startTurn({
    combat,
    combatant: combatantB,
    events,
    authority: GM_AUTHORITY,
    hook: "combatTurn"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, TURN_RECOVERY_CODES.ACTOR_NOT_INCOMING_COMBATANT);
  assert.equal(actorA.system.resources.action.value, 0);
  assert.equal(actorA.system.resources.movement.value, 10);
  assert.equal(actorA.triggerCalls.length, 0);
});

test("duplicate combat turn recovery does not manufacture another turn start", async () => {
  const actor = fakeActor("actor-a");
  const {combat, combatant, events} = combatStartContext(actor);
  const context = {
    combat,
    combatant,
    events,
    authority: GM_AUTHORITY,
    hook: "combatStart"
  };

  const first = await actor.startTurn(context);
  actor.system.resources.action.value = 0;
  actor.system.resources.movement.value = 10;
  actor.system.pools.find(pool => pool.id === "focus").value = 0;
  const duplicate = await actor.startTurn(context);

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.code, TURN_RECOVERY_CODES.ALREADY_PROCESSED);
  assert.equal(duplicate.duplicate, true);
  assert.equal(actor.system.resources.action.value, 0);
  assert.equal(actor.system.resources.movement.value, 10);
  assert.equal(actor.system.pools.find(pool => pool.id === "focus").value, 0);
  assert.equal(actor.triggerCalls.length, 1);
  assert.equal(actor.updateCalls.length, 1);
});

function fakeActor(id) {
  const actor = Object.assign(Object.create(WildPathActor.prototype), {
    id,
    uuid: `Actor.${id}`,
    name: id,
    system: {
      resources: {
        action: {value: 0, max: 1, recovery: "turn"},
        bonus: {value: 0, max: 1, recovery: "turn"},
        reaction: {value: 0, max: 1, recovery: "turn"},
        movement: {value: 10, max: 30, recovery: "turn"},
        shortRest: {value: 0, max: 2, recovery: "shortRest"},
        longRest: {value: 0, max: 2, recovery: "longRest"}
      },
      pools: [
        {id: "focus", label: "Focus", value: 0, max: 3, recovery: "turn"},
        {id: "short-pool", label: "Short Pool", value: 0, max: 4, recovery: "shortRest"},
        {id: "long-pool", label: "Long Pool", value: 0, max: 5, recovery: "longRest"}
      ]
    },
    effects: [],
    updateCalls: [],
    triggerCalls: [],
    async update(updates) {
      this.updateCalls.push(JSON.parse(JSON.stringify(updates)));
      for ( const [path, value] of Object.entries(updates) ) setPath(this, path, value);
    },
    async applyConditionTriggers({events=[]}={}) {
      this.triggerCalls.push(JSON.parse(JSON.stringify(events)));
      return {ok: true, events};
    }
  });
  return actor;
}

function combatStartContext(actor) {
  const combatant = {id: "combatant-a", actor, actorId: actor.id, tokenId: "token-a"};
  const combat = {
    id: "combat-a",
    round: 1,
    turn: 0,
    turns: [combatant],
    combatant
  };
  return {
    combat,
    combatant,
    events: getCombatLifecycleEvents(combat, {round: 1, turn: 0}, {hook: "combatStart"})
  };
}

function combatTurnContext({actorA, actorB}) {
  const combatantA = {id: "combatant-a", actor: actorA, actorId: actorA.id, tokenId: "token-a"};
  const combatantB = {id: "combatant-b", actor: actorB, actorId: actorB.id, tokenId: "token-b"};
  const combat = {
    id: "combat-a",
    round: 1,
    turn: 0,
    turns: [combatantA, combatantB],
    combatant: combatantA
  };
  return {
    combat,
    combatantA,
    combatantB,
    events: getCombatLifecycleEvents(combat, {round: 1, turn: 1}, {hook: "combatTurn"})
  };
}

function setPath(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for ( const part of parts.slice(0, -1) ) {
    cursor = /^\d+$/u.test(part) ? cursor[Number(part)] : cursor[part];
  }
  const final = parts.at(-1);
  if ( /^\d+$/u.test(final) ) cursor[Number(final)] = value;
  else cursor[final] = value;
}

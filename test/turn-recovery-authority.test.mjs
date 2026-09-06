import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  TURN_RECOVERY_CODES,
  getCombatTurnStartLifecycleEvents
} from "../module/helpers/combat.mjs";

class FakeField {
  constructor(config={}) {
    this.config = config;
  }
}

class FakeFoundryCombat {
  async _onStartTurn(combatant, context) {
    this.superStartTurnCalls.push({combatant, context});
  }
}

globalThis.Actor = class {};
globalThis.foundry = {
  documents: {
    Combat: FakeFoundryCombat
  },
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
const {default: WildPathCombat} = await import("../module/documents/combat.mjs");

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

test("WildPath startup registers the Combat document subclass", () => {
  const source = readFileSync(new URL("../wildpath.mjs", import.meta.url), "utf8");

  assert.match(source, /import WildPathCombat from "\.\/module\/documents\/combat\.mjs";/u);
  assert.match(source, /CONFIG\.Combat\.documentClass\s*=\s*WildPathCombat/u);
});

test("pre-update combat hooks no longer perform turn recovery", () => {
  const source = readFileSync(new URL("../wildpath.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Hooks\.on\("combatTurn"/u);
  assert.doesNotMatch(source, /Hooks\.on\("combatStart"/u);
  assert.doesNotMatch(source, /onCombatTurnChange/u);
});

test("manual startTurn cannot refresh or fire turn-start triggers", async () => {
  const actor = fakeActor("actor-a");
  const result = await actor.startTurn();

  assert.equal(result.ok, false);
  assert.equal(result.code, TURN_RECOVERY_CODES.MISSING_COMBAT);
  assert.equal(actor.system.resources.action.value, 0);
  assert.equal(actor.system.resources.movement.value, 10);
  assert.equal(actor.triggerCalls.length, 0);
  assert.equal(actor.updateCalls.length, 0);
});

test("player-initiated turn advance recovers through Foundry managed GM start-turn lifecycle", async () => {
  const actorA = fakeActor("actor-a");
  const actorB = fakeActor("actor-b");
  const {combat, combatantB} = managedTurnContext({actorA, actorB, turn: 1});

  await combat._onStartTurn(combatantB, {round: 1, turn: 1, skipped: false});

  assert.equal(actorB.system.resources.action.value, 1);
  assert.equal(actorB.system.resources.movement.value, 30);
  assert.equal(actorB.system.resources.reaction.value, 1);
  assert.equal(actorB.system.pools.find(pool => pool.id === "focus").value, 3);
  assert.equal(actorA.system.resources.action.value, 0);
  assert.equal(actorA.system.resources.movement.value, 10);
  assert.equal(actorB.updateCalls.length, 1);
  assert.equal(combat.superStartTurnCalls.length, 1);
});

test("GM-initiated turn advance recovers only the incoming combatant exactly once", async () => {
  const actorA = fakeActor("actor-a");
  const actorB = fakeActor("actor-b");
  const {combat, combatantB} = managedTurnContext({actorA, actorB, turn: 1});

  const result = await combat._onStartTurn(combatantB, {round: 1, turn: 1, skipped: false});

  assert.equal(result.ok, true);
  assert.equal(actorB.system.resources.action.value, 1);
  assert.equal(actorB.system.resources.movement.value, 30);
  assert.equal(actorB.system.resources.reaction.value, 1);
  assert.equal(actorA.system.resources.action.value, 0);
  assert.equal(actorA.system.resources.movement.value, 10);
  assert.equal(actorB.updateCalls.length, 1);
  assert.equal(actorA.updateCalls.length, 0);
});

test("combat start recovers the first combatant through managed start-turn lifecycle", async () => {
  const actor = fakeActor("actor-a");
  const {combat, combatantA} = managedTurnContext({actorA: actor, turn: 0});

  await combat._onStartTurn(combatantA, {round: 1, turn: 0, skipped: false});

  assert.equal(actor.system.resources.action.value, 1);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(actor.system.resources.reaction.value, 1);
  assert.equal(actor.updateCalls.length, 1);
});

test("managed start turn mutates synthetic combatant actor rather than base actor", async () => {
  const baseActor = fakeActor("base-actor");
  const tokenActor = fakeActor("synthetic-actor", {uuid: "Scene.scene-a.Token.token-a.Actor.synthetic-actor"});
  const {combat, combatantA} = managedTurnContext({
    actorA: tokenActor,
    combatantAData: {actorId: baseActor.id, tokenId: "token-a"},
    turn: 0
  });

  await combat._onStartTurn(combatantA, {round: 1, turn: 0, skipped: false});

  assert.equal(tokenActor.system.resources.movement.value, 30);
  assert.equal(tokenActor.system.resources.action.value, 1);
  assert.equal(baseActor.system.resources.movement.value, 10);
  assert.equal(baseActor.system.resources.action.value, 0);
  assert.equal(tokenActor.updateCalls.length, 1);
  assert.equal(baseActor.updateCalls.length, 0);
});

test("managed start turn preserves generic recovery and rest-resource isolation", async () => {
  const actor = fakeActor("actor-a");
  const {combat, combatantA} = managedTurnContext({actorA: actor, turn: 0});

  await combat._onStartTurn(combatantA, {round: 1, turn: 0, skipped: false});

  assert.equal(actor.system.pools.find(pool => pool.id === "focus").value, 3);
  assert.equal(actor.system.resources.shortRest.value, 0);
  assert.equal(actor.system.resources.longRest.value, 0);
  assert.equal(actor.system.pools.find(pool => pool.id === "short-pool").value, 0);
  assert.equal(actor.system.pools.find(pool => pool.id === "long-pool").value, 0);
});

test("managed start turn emits semantic turnStart for condition triggers exactly once", async () => {
  const actor = fakeActor("actor-a");
  const {combat, combatantA} = managedTurnContext({actorA: actor, turn: 0});

  await combat._onStartTurn(combatantA, {round: 1, turn: 0, skipped: false});

  assert.equal(actor.triggerCalls.length, 1);
  assert.deepEqual(actor.triggerCalls[0], [{
    type: "turnStart",
    combatId: "combat-a",
    round: 1,
    turn: 0,
    combatantId: "combatant-a",
    actorId: "actor-a",
    tokenId: "token-a"
  }]);
});

test("Actor startTurn rejects stale or wrong managed Combat context", async () => {
  const actorA = fakeActor("actor-a");
  const actorB = fakeActor("actor-b");
  const {combat, combatantB} = managedTurnContext({actorA, actorB, turn: 1});
  const events = getCombatTurnStartLifecycleEvents(combat, combatantB, {round: 1, turn: 1, skipped: false});

  const wrongActor = await actorA.startTurn({combat, combatant: combatantB, context: {round: 1, turn: 1}, events});
  const staleTurn = await actorB.startTurn({combat, combatant: combatantB, context: {round: 1, turn: 0}, events});

  assert.equal(wrongActor.ok, false);
  assert.equal(wrongActor.code, TURN_RECOVERY_CODES.ACTOR_NOT_INCOMING_COMBATANT);
  assert.equal(staleTurn.ok, false);
  assert.equal(staleTurn.code, TURN_RECOVERY_CODES.INVALID_LIFECYCLE);
  assert.equal(actorA.system.resources.action.value, 0);
  assert.equal(actorB.system.resources.action.value, 0);
});

function fakeActor(id, {uuid=`Actor.${id}`}={}) {
  const actor = Object.assign(Object.create(WildPathActor.prototype), {
    id,
    uuid,
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

function managedTurnContext({
  actorA,
  actorB=null,
  combatantAData={},
  combatantBData={},
  turn=0
}) {
  const combat = new WildPathCombat();
  combat.id = "combat-a";
  combat.round = 1;
  combat.turn = turn;
  combat.superStartTurnCalls = [];

  const combatantA = createCombatant({
    id: "combatant-a",
    actor: actorA,
    actorId: actorA.id,
    tokenId: "token-a",
    parent: combat,
    ...combatantAData
  });
  const turns = [combatantA];
  let combatantB = null;
  if ( actorB ) {
    combatantB = createCombatant({
      id: "combatant-b",
      actor: actorB,
      actorId: actorB.id,
      tokenId: "token-b",
      parent: combat,
      ...combatantBData
    });
    turns.push(combatantB);
  }

  combat.turns = turns;
  combat.combatants = new Map(turns.map(combatant => [combatant.id, combatant]));
  combat.combatant = turns[turn] ?? combatantA;

  return {
    combat,
    combatantA,
    combatantB
  };
}

function createCombatant(data) {
  return {
    _id: data.id,
    ...data
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

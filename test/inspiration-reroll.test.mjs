import {test} from "node:test";
import assert from "node:assert/strict";
import {INSPIRATION_QUERY, registerInspirationRerolls} from "../module/applications/inspiration-reroll.mjs";

// Heroic Inspiration's reroll on a sheet roll's card: no point is spent unless the card can be marked used and rerolled.
const handlers = [];
globalThis.Hooks = {on: (name, fn) => handlers.push(fn)};
globalThis.CONFIG = {queries: {}};
globalThis.document = {createElement: () => ({listeners: [], addEventListener(type, fn) { this.listeners.push(fn); }})};
registerInspirationRerolls();

const player = {id: "player"};
const gm = {id: "gm", isGM: true};

/** A card of Ana's might check; `author`: the clicking player wrote it, else the GM rolled it for her. */
function table({author=true, cardFails=false, owner=true, gmOnline=true}={}) {
  const log = [];
  const pools = () => [{id: "heroic-inspiration", value: 1, max: 1}];
  const actor = {uuid: "Actor.ana", name: "Ana", type: "character", hasPlayerOwner: true, isOwner: owner,
    system: {pools: pools()}, toObject: () => ({system: {pools: pools()}}),
    testUserPermission: (user, level) => (level === "OWNER") && (user.isGM || owner),
    async update(data) { log.push(["spend", data["system.pools"][0].value]); },
    async rollTest(options) { log.push(["roll", options.ability, options.rerolled]); }};
  const message = {id: "card", timestamp: Date.now(), flags: {wildpath: {rollTest: {actorUuid: actor.uuid, ability: "might", rerolled: false}}},
    canUserModify: (user, action) => (action === "update") && (user.isGM || author),
    async update(data) {
      if ( cardFails ) throw new Error("User lacks permission to update ChatMessage");
      log.push(["card", data["flags.wildpath.rollTest.rerolled"]]);
      message.flags.wildpath.rollTest.rerolled = data["flags.wildpath.rollTest.rerolled"];
    }};
  // The active GM answers a query on its own client: there it is the GM, and the card is its to mark.
  const activeGM = !gmOnline ? null : {async query(name, data) {
    log.push(["query", name]);
    const previous = globalThis.game.user;
    globalThis.game.user = gm;
    try { return await CONFIG.queries[name](data, {user: player}); }
    finally { globalThis.game.user = previous; }
  }};
  globalThis.game = {user: player, messages: {get: id => (id === message.id ? message : undefined)}, users: {activeGM},
    i18n: {localize: key => key, format: key => key}};
  globalThis.fromUuidSync = () => actor;
  globalThis.ui = {notifications: {warn() {}}};
  const shown = [];
  handlers[0](message, {querySelector: () => ({append: button => shown.push(button)})});
  return {log, button: shown[0] ?? null, message};
}

test("Heroic Inspiration: the card is marked used before the point is spent, then the test is rolled again", async () => {
  const {log, button} = table();
  await button.listeners[0]();
  assert.deepEqual(log, [["card", true], ["spend", 0], ["roll", "might", true]]);
});

test("Heroic Inspiration: on a card the GM rolled for her character, the owner's reroll is claimed and paid by the active GM", async () => {
  const {log, button} = table({author: false});
  await button.listeners[0]();
  assert.deepEqual(log, [["query", INSPIRATION_QUERY], ["card", true], ["spend", 0], ["roll", "might", true]]);
});

test("Heroic Inspiration: the active GM refuses a claim from a user who does not own the character, or for a used card", async () => {
  const {log, message} = table({author: false, owner: false});
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: player}), {ok: false},
    "a player cannot spend another's point");
  globalThis.game.user = gm;
  message.flags.wildpath.rollTest.rerolled = true;
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: {isGM: true}}), {ok: false},
    "a card already rerolled is not claimed twice");
  assert.deepEqual(log, []);
});

test("Heroic Inspiration: with no GM to claim another's card, nothing is spent or rolled", async () => {
  const {log, button} = table({author: false, gmOnline: false});
  assert.equal(await button.listeners[0](), undefined);
  assert.deepEqual(log, []);
});

test("Heroic Inspiration: a card that cannot be marked used spends no point and rolls nothing", async () => {
  const {log, button} = table({cardFails: true});
  await assert.rejects(button.listeners[0](), /permission/);
  assert.deepEqual(log, [], "no point lost for no reroll");
});

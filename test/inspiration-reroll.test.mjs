import {test} from "node:test";
import assert from "node:assert/strict";
import {INSPIRATION_QUERY, registerInspirationRerolls} from "../module/applications/inspiration-reroll.mjs";
import {PORTENT_QUERY, registerPortent} from "../module/adapters/foundry-v14-portent.mjs";

// Heroic Inspiration's reroll on a sheet roll's card: no point is spent unless the card can be marked used and rerolled.
const handlers = [];
globalThis.Hooks = {on: (name, fn) => handlers.push(fn)};
globalThis.CONFIG = {queries: {}};
globalThis.document = {createElement: () => ({listeners: [], addEventListener(type, fn) { this.listeners.push(fn); }})};
registerInspirationRerolls();
registerPortent();

const player = {id: "player"};
const gm = {id: "gm", isGM: true};

/** A card of Ana's might check; `author`: the clicking player wrote it, else the GM rolled it for her. */
function table({author=true, cardFails=false, owner=true, gmOnline=true, points=1}={}) {
  const log = [];
  const character = (uuid, name) => {
    let value = points;
    const pools = () => [{id: "heroic-inspiration", value, max: 4}];
    return {uuid, name, type: "character", hasPlayerOwner: true, isOwner: owner,
      get system() { return {pools: pools()}; }, toObject: () => ({system: {pools: pools()}}),
      testUserPermission: (user, level) => (level === "OWNER") && (user.isGM || owner),
      async update(data) {
        log.push(["spend", name, data["system.pools"][0].value]);
        await Promise.resolve();
        value = data["system.pools"][0].value;
      },
      async rollTest(options) { log.push(["roll", options.ability, options.rerolled]); }};
  };
  const actor = character("Actor.ana", "Ana");
  const bo = character("Actor.bo", "Bo");
  const card = id => {
    const message = {id, timestamp: Date.now(), flags: {wildpath: {rollTest: {actorUuid: actor.uuid, ability: "might", rerolled: false}}},
      canUserModify: (user, action) => (action === "update") && (user.isGM || author),
      async update(data) {
        if ( cardFails ) throw new Error("User lacks permission to update ChatMessage");
        log.push(["card", ...(id === "card" ? [] : [id]), data["flags.wildpath.rollTest.rerolled"]]);
        // As in Foundry, the card's own flag changes only once the server has answered.
        await Promise.resolve();
        message.flags.wildpath.rollTest.rerolled = data["flags.wildpath.rollTest.rerolled"];
      }};
    return message;
  };
  const message = card("card");
  const other = card("other");
  // The active GM answers a query on its own client: there it is the GM, and the card is its to mark.
  const queryOptions = [];
  const activeGM = !gmOnline ? null : {id: gm.id, async query(name, data, options) {
    log.push(["query", name]);
    queryOptions.push(options);
    const previous = globalThis.game.user;
    globalThis.game.user = gm;
    try { return await CONFIG.queries[name](data, {user: player}); }
    finally { globalThis.game.user = previous; }
  }};
  globalThis.game = {user: player, messages: {get: id => [message, other].find(entry => entry.id === id)}, users: {activeGM},
    i18n: {localize: key => key, format: key => key}};
  globalThis.fromUuidSync = uuid => (uuid === bo.uuid ? bo : actor);
  globalThis.ui = {notifications: {warn() {}}};
  const shown = [];
  handlers[0](message, {querySelector: () => ({append: button => shown.push(button)})});
  return {log, button: shown[0] ?? null, message, other, actor, bo, queryOptions};
}

test("Heroic Inspiration: the active GM marks the card used before the point is spent, then the test is rolled again", async () => {
  const {log, button, queryOptions} = table();
  await button.listeners[0]();
  assert.deepEqual(log, [["query", INSPIRATION_QUERY], ["card", true], ["spend", "Ana", 0], ["roll", "might", true]],
    "even its author asks the active GM, the one client that claims");
  assert.equal(queryOptions[0]?.timeout, undefined, "no timeout: a late answer may follow a point already spent, and only it rolls");
});

test("Heroic Inspiration: the active GM's own click claims on its own client", async () => {
  const {log, button} = table();
  globalThis.game.user = gm;
  await button.listeners[0]();
  assert.deepEqual(log, [["card", true], ["spend", "Ana", 0], ["roll", "might", true]]);
});

test("Heroic Inspiration: with no GM connected, the card's author claims it on its own client", async () => {
  const {log, button} = table({gmOnline: false});
  await button.listeners[0]();
  assert.deepEqual(log, [["card", true], ["spend", "Ana", 0], ["roll", "might", true]]);
});

test("Heroic Inspiration: the player and the GM clicking at once reroll once and spend one point", async () => {
  // Live 2026-11-13: both clicks rerolled, and 2 points went to 1 (both wrote the same planned value).
  const {log, button, actor} = table({points: 2});
  const playerClick = button.listeners[0]();
  globalThis.game.user = gm;
  const gmClick = button.listeners[0]();
  await Promise.all([playerClick, gmClick]);
  assert.deepEqual(log, [["query", INSPIRATION_QUERY], ["card", true], ["spend", "Ana", 1], ["roll", "might", true]]);
  assert.equal(actor.system.pools[0].value, 1);
});

test("Heroic Inspiration: two claims for one card reach the active GM at once, and only the first is granted", async () => {
  const {log, message, actor} = table({points: 2});
  globalThis.game.user = gm;
  const answers = await Promise.all([CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: player}),
    CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: gm})]);
  assert.deepEqual(answers, [{ok: true}, {ok: false}]);
  assert.deepEqual(log, [["card", true], ["spend", "Ana", 1]]);
  assert.equal(actor.system.pools[0].value, 1);
});

test("Heroic Inspiration: two cards claimed at once with one point between them: the second is refused and given back", async () => {
  const {log, message, other, actor} = table();
  globalThis.game.user = gm;
  const answers = await Promise.allSettled([CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: player}),
    CONFIG.queries[INSPIRATION_QUERY]({messageId: other.id}, {user: player})]);
  assert.deepEqual(answers[0], {status: "fulfilled", value: {ok: true}});
  assert.equal(answers[1].status, "rejected", "its spend is planned again from the point left once the first has written");
  assert.deepEqual(log, [["card", true], ["card", "other", true], ["spend", "Ana", 0], ["card", "other", false]]);
  assert.equal(actor.system.pools[0].value, 0);
  assert.equal(other.flags.wildpath.rollTest.rerolled, false, "the refused card is offered again");
});

test("Heroic Inspiration and Portent claiming one card at once on the active GM's client: only one goes through", async () => {
  const {log, message} = table();
  globalThis.game.user = gm;
  let looked = 0;
  globalThis.fromUuid = async () => { looked++; return null; };
  const reroll = CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: player});
  assert.deepEqual(await CONFIG.queries[PORTENT_QUERY]({messageId: message.id, holderUuid: "Actor.diviner", slot: "1"}, {user: gm}),
    {ok: false});
  assert.equal(looked, 0, "Portent is refused while the reroll's claim is under way");
  assert.deepEqual(await reroll, {ok: true});
  const second = table();
  globalThis.game.user = gm;
  let release;
  globalThis.fromUuid = () => new Promise(resolve => { release = resolve; });
  const portent = CONFIG.queries[PORTENT_QUERY]({messageId: second.message.id, holderUuid: "Actor.diviner", slot: "1"}, {user: gm});
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: second.message.id}, {user: player}), {ok: false},
    "nor the reroll while Portent's claim is under way");
  release(null);
  assert.deepEqual(await portent, {ok: false});
  assert.deepEqual(second.log, []);
  delete globalThis.fromUuid;
});

test("Heroic Inspiration: a GM's claim pays with the character it picked; a player's always with the roller", async () => {
  const {log, message} = table();
  globalThis.game.user = gm;
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id, payerUuid: "Actor.bo"}, {user: player}), {ok: true});
  assert.deepEqual(log, [["card", true], ["spend", "Ana", 0]], "a player cannot name another payer");
  const second = table();
  globalThis.game.user = gm;
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: second.message.id, payerUuid: "Actor.bo"}, {user: gm}), {ok: true});
  assert.deepEqual(second.log, [["card", true], ["spend", "Bo", 0]]);
});

test("Heroic Inspiration: the active GM refuses a claim from a user who does not own the character, or for a used card", async () => {
  const {log, message} = table({author: false, owner: false});
  globalThis.game.user = gm;
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: player}), {ok: false},
    "a player cannot spend another's point");
  message.flags.wildpath.rollTest.rerolled = true;
  assert.deepEqual(await CONFIG.queries[INSPIRATION_QUERY]({messageId: message.id}, {user: {isGM: true}}), {ok: false},
    "a card already rerolled is not claimed twice");
  assert.deepEqual(log, []);
});

test("Heroic Inspiration: on a card the GM rolled for her character, the owner's reroll is claimed and paid by the active GM", async () => {
  const {log, button} = table({author: false});
  await button.listeners[0]();
  assert.deepEqual(log, [["query", INSPIRATION_QUERY], ["card", true], ["spend", "Ana", 0], ["roll", "might", true]]);
});

test("Heroic Inspiration: with no GM to claim another's card, nothing is spent or rolled", async () => {
  const {log, button} = table({author: false, gmOnline: false});
  assert.equal(await button.listeners[0](), undefined);
  assert.deepEqual(log, []);
});

test("Heroic Inspiration: a card that cannot be marked used spends no point and rolls nothing", async () => {
  const {log, button} = table({cardFails: true});
  await button.listeners[0]();
  assert.deepEqual(log, [["query", INSPIRATION_QUERY]], "no point lost for no reroll");
  assert.equal(button.disabled, false, "the button is offered again");
  const alone = table({cardFails: true, gmOnline: false});
  await assert.rejects(alone.button.listeners[0](), /permission/);
  assert.deepEqual(alone.log, [], "nor with no GM connected");
});

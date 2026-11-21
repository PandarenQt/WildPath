import {test} from "node:test";
import assert from "node:assert/strict";
import {TEST_OFFER_QUERY, registerTestOfferCards} from "../module/applications/test-offer-card.mjs";

// Test offers on a sheet roll's or an initiative roll's card (Q35; Q101 defaults).
const handlers = [];
globalThis.Hooks = {on: (name, fn) => handlers.push(fn)};
globalThis.CONFIG = {queries: {}, WILDPATH: {SKILLS: {stealth: {ability: "agility"}, athletics: {ability: "might"}}}};
globalThis.document = {createElement: () => ({listeners: [], addEventListener(type, fn) { this.listeners.push(fn); }})};
registerTestOfferCards();

const player = {id: "player"};
const gm = {id: "gm", isGM: true};
const setPath = (object, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((node, key) => (node[key] ??= {}), object)[last] = value;
};
const offerItem = (id, name, testOffer) => ({id, name, system: {active: true}, flags: {wildpath: {testOffer}}});
// A bard's 2024 Peerless Skill (a failure's die, kept if it still fails), and a Battle Master's Ambush-like die on a Stealth
// check or an initiative roll, on any result.
const PEERLESS = offerItem("peerless", "Peerless Skill", {tests: ["check", "attack"], refundOnFail: true, pool: "bardic-inspiration",
  faces: {type: "constant", value: 10}});
const AMBUSH = offerItem("ambush", "Ambush", {tests: ["check"], anyResult: true, pool: "bardic-inspiration", faces: {type: "constant", value: 8},
  unlessStatus: ["incapacitated", "stunned", "paralyzed", "petrified", "unconscious"], predicate: {any: [{equals: {path: "check.skill", value: "stealth"}}, {equals: {path: "check.initiative", value: true}}]}});

/** A table: Ana (her player owns her) rolled a card; `answers` are the dialogs' answers in turn, `dice` the dice rolled. */
function table({items=[PEERLESS], effects=[], owner=true, uses=3, flags={rollTest: {actorUuid: "Actor.ana", ability: null, skill: "stealth",
  save: null, rerolled: false}}, rolls=[{total: 12, dice: [{faces: 20, total: 9}]}], answers=[], dice=[], gmOnline=true, statuses=[], failSpend=false}={}) {
  const log = [];
  let value = uses;
  const system = () => ({pools: [{id: "bardic-inspiration", value, max: 3}], resources: {}, skills: {stealth: {proficiency: 1}}});
  const effectList = Object.assign([...effects], {get: id => effectList.find(effect => effect.id === id)});
  const actor = {uuid: "Actor.ana", id: "ana", name: "Ana", type: "character", hasPlayerOwner: true, isOwner: owner, statuses: new Set(statuses),
    items, effects: effectList, get system() { return system(); }, toObject: () => ({system: system()}),
    testUserPermission: (user, level) => (level === "OWNER") && (user.isGM || owner),
    async update(data) {
      const pools = data["system.pools"];
      log.push(["spend", pools?.find(pool => pool.id === "bardic-inspiration")?.value]);
      if ( failSpend ) throw new Error("the write failed");
      await Promise.resolve();
      if ( pools ) value = pools.find(pool => pool.id === "bardic-inspiration").value;
    },
    async rollTest(options) { log.push(["reroll", options]); }};
  const combatant = {tokenId: "token-ana", sceneId: "scene", async update(data) { log.push(["initiative", data.initiative]); }};
  const scene = {id: "scene", tokens: null};
  const token = {id: "token-ana", name: "Ana", parent: scene, actor, hidden: false};
  scene.tokens = Object.assign([token], {get: id => (id === token.id ? token : null)});
  const message = {id: "card", timestamp: Date.now(), speaker: {scene: "scene", token: "token-ana", actor: "ana"}, rolls,
    flags: structuredClone(flags.core ? flags : {wildpath: flags}),
    async update(data) {
      log.push(["card", Object.keys(data)]);
      await Promise.resolve();
      for ( const [path, entry] of Object.entries(data) ) setPath(message, path, entry);
    }};
  const activeGM = !gmOnline ? null : {id: gm.id, async query(name, data) {
    log.push(["query", name]);
    const previous = globalThis.game.user;
    globalThis.game.user = gm;
    try { return await CONFIG.queries[name](data, {user: previous}); }
    finally { globalThis.game.user = previous; }
  }};
  const asked = [];
  globalThis.game = {user: player, users: {activeGM}, messages: {get: id => (id === message.id ? message : null)},
    scenes: {get: id => (id === scene.id ? scene : null)}, actors: {get: () => actor}, combats: [{started: true, combatants: [combatant]}],
    i18n: {localize: key => key, format: (key, data) => `${key} ${JSON.stringify(data)}`},
    wildpath: {requestRoll: async request => { log.push(["die", request.formula]); return {total: dice.shift()}; }}};
  globalThis.fromUuidSync = uuid => (uuid === actor.uuid ? actor : null);
  globalThis.foundry = {utils: {randomID: () => "r"}, dice: {Roll: class { constructor(total) { this.total = Number(total); } async evaluate() { return this; } }},
    applications: {api: {DialogV2: {confirm: async ({content}) => { asked.push(content.replace(/<\/?p>/g, "")); return answers.shift() ?? null; }}}}};
  globalThis.ChatMessage = {create: async data => { log.push(["posted", data.content, data.flags]); }};
  const buttons = () => {
    const shown = [];
    handlers[0](message, {querySelector: () => ({append: button => shown.push(button)})});
    return shown;
  };
  return {log, message, actor, buttons, asked, uses: () => value};
}

test("a sheet check's card offers Peerless Skill to its owner only, asks whether it failed, and spends nothing on a no", async () => {
  assert.equal(table({owner: false}).buttons().length, 0, "another player sees none");
  const watching = table();
  globalThis.game.user = gm;
  assert.equal(watching.buttons().length, 0, "nor the GM, for a creature a player owns");
  const {log, buttons, asked} = table({answers: [false]});
  const [button, ...others] = buttons();
  assert.equal(others.length, 0);
  assert.match(button.textContent, /AddDieKept/);
  await button.listeners[0]();
  assert.deepEqual([asked, log], [["WILDPATH.TESTOFFER.DidFail"], []], "a no rolls, claims and spends nothing");
  assert.equal(button.disabled, false, "and the button is offered again");
});

test("a failed sheet check adds the rolled die: the card is marked, the use spent, the new total posted", async () => {
  const {log, buttons, asked, uses, message} = table({answers: [true, true], dice: [7]});
  await buttons()[0].listeners[0]();
  assert.deepEqual(asked, ["WILDPATH.TESTOFFER.DidFail", 'WILDPATH.TESTOFFER.NowSucceeds {"value":7,"total":19}']);
  assert.deepEqual(log.slice(0, 4), [["die", "1d10"], ["query", TEST_OFFER_QUERY],
    ["card", ["flags.wildpath.testOfferUsed", "flags.wildpath.rollTest.rerolled"]], ["spend", 2]]);
  assert.equal(log[4][0], "posted");
  assert.match(log[4][1], /TESTOFFER\.Added .*"value":7,"total":19/);
  assert.equal(log[4][2].wildpath.rollTest.rerolled, true, "the new card is offered nothing more");
  assert.equal(uses(), 2);
  assert.equal(buttons().length, 0, "a used card offers no more");
  assert.equal(message.flags.wildpath.rollTest.rerolled, true, "nor Portent or Heroic Inspiration");
});

test("a die kept if the roll still fails (refundOnFail): a 'still fails' posts the total and spends nothing", async () => {
  const {log, buttons, uses} = table({answers: [true, false], dice: [2]});
  await buttons()[0].listeners[0]();
  assert.equal(uses(), 3);
  assert.equal(log.some(entry => entry[0] === "spend"), false);
  assert.match(log.find(entry => entry[0] === "posted")[1], /AddedKept .*"total":14/);
});

test("two claims for one card at once spend one use; a die its dice cannot show is refused", async () => {
  const {log, message, uses} = table({uses: 3});
  globalThis.game.user = gm;
  const data = {messageId: message.id, value: "test-offer:peerless", rolled: 5, pay: true};
  const answers = await Promise.all([CONFIG.queries[TEST_OFFER_QUERY](data, {user: player}), CONFIG.queries[TEST_OFFER_QUERY](data, {user: player})]);
  assert.deepEqual(answers.map(answer => answer.ok), [true, false]);
  assert.equal(uses(), 2);
  assert.equal(log.filter(entry => entry[0] === "spend").length, 1);
  const cheat = table();
  globalThis.game.user = gm;
  assert.deepEqual(await CONFIG.queries[TEST_OFFER_QUERY]({messageId: cheat.message.id, value: "test-offer:peerless", rolled: 11}, {user: player}),
    {ok: false}, "a d10 never shows 11");
  assert.deepEqual(cheat.log, []);
  const stranger = table({owner: false});
  globalThis.game.user = gm;
  assert.deepEqual(await CONFIG.queries[TEST_OFFER_QUERY]({messageId: stranger.message.id, value: "test-offer:peerless", rolled: 5}, {user: player}),
    {ok: false}, "a player who does not decide it");
});

test("an any-result offer (Ambush) asks nothing; a check it does not fit offers it not", async () => {
  const {log, buttons, asked, uses} = table({items: [AMBUSH], dice: [6]});
  const [button] = buttons();
  assert.match(button.textContent, /INSPIRATION\.AddDie /);
  await button.listeners[0]();
  assert.deepEqual(asked, [], "no 'did it fail?'");
  assert.equal(uses(), 2);
  assert.match(log.find(entry => entry[0] === "posted")[1], /"total":18/);
  const athletics = table({items: [AMBUSH], flags: {rollTest: {actorUuid: "Actor.ana", ability: null, skill: "athletics", save: null, rerolled: false}}});
  assert.equal(athletics.buttons().length, 0);
});

test("an initiative card: only an any-result offer, its total set on the Combatant", async () => {
  const flags = {core: {initiativeRoll: true}};
  assert.equal(table({flags}).buttons().length, 0, "Peerless Skill needs a failure, which initiative never has (Q101 (b))");
  const {log, buttons, asked} = table({items: [PEERLESS, AMBUSH], flags, rolls: [{total: 15, dice: [{faces: 20, total: 13}]}], dice: [4]});
  const shown = buttons();
  assert.equal(shown.length, 1);
  await shown[0].listeners[0]();
  assert.deepEqual(asked, []);
  assert.deepEqual(log.filter(entry => ["card", "initiative"].includes(entry[0])), [["card", ["flags.wildpath.testOfferUsed"]], ["initiative", 19]]);
  assert.equal(buttons().length, 0);
});

test("a sheet save's reroll (Indomitable): claimed, then the save rolled again with its bonus and named", async () => {
  const indomitable = offerItem("indomitable", "Indomitable", {tests: ["save"], reroll: true, pool: "bardic-inspiration", bonus: 9});
  const {log, buttons} = table({items: [indomitable, PEERLESS], answers: [true],
    flags: {rollTest: {actorUuid: "Actor.ana", ability: null, skill: null, save: "wits", rerolled: false}}});
  const shown = buttons();
  assert.equal(shown.length, 1, "a check's offer is not on a save");
  await shown[0].listeners[0]();
  assert.equal(log.some(entry => entry[0] === "posted"), false, "the reroll posts its own card");
  assert.deepEqual(log.at(-1), ["reroll", {ability: null, skill: null, save: "wits", rerolled: true, rerolledWith: "Indomitable", bonus: 9,
    rollMode: null, token: log.at(-1)[1].token}]);
  assert.equal(log.filter(entry => entry[0] === "spend").length, 1);
});

test("not offered on a card: help the check already rolled in, a natural the d20 does not show", () => {
  const assist = {id: "assist", name: "Assist", flags: {wildpath: {conditionEffect: {conditionId: "custom:assist",
    metadata: {addDie: {tests: ["check"], faces: {type: "constant", value: 4}}}}}}};
  assert.equal(table({items: [], effects: [assist]}).buttons().length, 1, "an effect's die is offered");
  assert.equal(table({items: [], effects: [assist], flags: {rollTest: {actorUuid: "Actor.ana", skill: "stealth", rerolled: false,
    folded: ["assist"]}}}).buttons().length, 0, "not once Actor#rollTest rolled it in");
  const luck = offerItem("luck", "Luck", {tests: ["check", "save", "attack"], reroll: true, natural: 1});
  assert.equal(table({items: [luck]}).buttons().length, 0, "a 9 is no 1");
  assert.equal(table({items: [luck], rolls: [{total: 4, dice: [{faces: 20, total: 1}]}]}).buttons().length, 1);
});

test("a sheet save's 'succeed instead' (Ring of Evasion) on the save its predicate names, posted as a success", async () => {
  const ring = offerItem("ring", "Ring of Evasion", {tests: ["save"], succeed: true, pool: "bardic-inspiration", unlessStatus: "unconscious",
    predicate: {oneOf: {path: "save.ability", values: ["agility"]}}});
  const save = ability => ({rollTest: {actorUuid: "Actor.ana", ability: null, skill: null, save: ability, rerolled: false}});
  assert.equal(table({items: [ring], flags: save("wits")}).buttons().length, 0, "not a Wits save");
  const {log, buttons, uses} = table({items: [ring], flags: save("agility"), answers: [true]});
  await buttons()[0].listeners[0]();
  assert.equal(uses(), 2);
  assert.match(log.find(entry => entry[0] === "posted")[1], /TESTOFFER\.Succeeded .*"roller":"Ana"/);
});

test("a payment that fails gives the card back: both marks written false, so it is offered again", async () => {
  for ( const flags of [undefined, {core: {initiativeRoll: true}}] ) {
    const {message, buttons, uses} = table({items: [AMBUSH], failSpend: true, ...(flags ? {flags} : {})});
    globalThis.game.user = gm;
    await assert.rejects(CONFIG.queries[TEST_OFFER_QUERY]({messageId: message.id, value: "test-offer:ambush", rolled: 5}, {user: player}),
      /the write failed/);
    assert.equal(uses(), 3);
    assert.equal(message.flags.wildpath.testOfferUsed, false, "not left blocking Portent and every other offer");
    if ( !flags ) assert.equal(message.flags.wildpath.rollTest.rerolled, false);
    globalThis.game.user = player;
    assert.equal(buttons().length, 1);
  }
});

test("Ambush is not offered while its creature is Incapacitated by any condition that includes it", () => {
  assert.equal(table({items: [AMBUSH]}).buttons().length, 1);
  for ( const status of ["incapacitated", "unconscious", "stunned"] ) {
    assert.equal(table({items: [AMBUSH], statuses: [status]}).buttons().length, 0, status);
  }
});

test("an effect's die marked anyResult asks no 'did it fail?' and is offered on initiative too", async () => {
  const deleted = [];
  const die = anyResult => ({id: "omen", name: "Omen", async delete() { deleted.push(this.id); }, flags: {wildpath: {conditionEffect: {conditionId: "custom:omen",
    metadata: {addDie: {tests: ["check"], faces: {type: "constant", value: 6}, ...(anyResult ? {anyResult: true} : {})}}}}}});
  const initiative = {core: {initiativeRoll: true}};
  assert.equal(table({items: [], effects: [die(false)], flags: initiative}).buttons().length, 0, "a failure's die: never on initiative");
  assert.equal(table({items: [], effects: [die(true)], flags: initiative}).buttons().length, 1);
  const {buttons, asked, log} = table({items: [], effects: [die(true)], dice: [3]});
  await buttons()[0].listeners[0]();
  assert.deepEqual(asked, []);
  assert.match(log.find(entry => entry[0] === "posted")[1], /"total":15/);
  assert.deepEqual(deleted, ["omen"], "paid by ending the effect");
});

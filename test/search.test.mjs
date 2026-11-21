import {test} from "node:test";
import assert from "node:assert/strict";
import {SEARCH_QUERY, findHidden, perceivedRoll, perceivedTotal, registerSearch, searchCard, searchCheckOf} from "../module/adapters/foundry-v14-search.mjs";

test("a hidden creature's own `perceived` modes count against it alone: the dice its d20 needs, and the total they make", () => {
  assert.deepEqual([perceivedRoll("normal", "normal"), perceivedRoll("advantage", "advantage"), perceivedRoll("normal", "disadvantage"),
    perceivedRoll("advantage", "normal"), perceivedRoll("advantage", "disadvantage"), perceivedRoll("disadvantage", "advantage")],
  [null, null, "1d20", "1d20", "2d20kl", "2d20kh"]);
  const check = {total: 17, natural: 12, rollMode: "normal", rollModes: []};
  assert.equal(perceivedTotal(check, "normal", null), 17);
  assert.equal(perceivedTotal(check, "disadvantage", 3), 8, "the lower of its 12 and the fresh 3, plus its +5");
  assert.equal(perceivedTotal(check, "disadvantage", 19), 17, "the 12 stays the lower");
  assert.equal(perceivedTotal(check, "advantage", 19), 24);
  assert.equal(perceivedTotal({...check, rollMode: "advantage"}, "normal", 6), 11, "a roll that kept its higher die: the fresh die alone");
  assert.equal(perceivedTotal({...check, naturalMinimum: 10}, "disadvantage", 3), 15, "Reliable Talent counts the 3 as 10");
  assert.equal(perceivedTotal({...check, totalMinimum: 16}, "disadvantage", 3), 16, "a floor on the total still holds");
});

/** A Search check's card as Actor#rollTest posts it: its roll (a kept d20 of `natural`) and its rollTest flags. */
const card = ({total=17, natural=12, discarded=null, flags={}, searched=false, timestamp=Date.now()}={}) => ({id: "card", timestamp,
  speaker: {scene: "s", token: "searcher"}, rolls: [{total, dice: [{faces: 20, results: [{result: natural, active: true},
    ...(discarded ? [{result: discarded, active: false, discarded: true}] : [])]}]}],
  flags: {wildpath: {searched, rollTest: {actorUuid: "Actor.searcher", skill: "perception", search: true, ...flags}}},
  async update(data) { if ( data["flags.wildpath.searched"] ) this.flags.wildpath.searched = true; }});

test("a Search check, read from its card: the roll's total and kept d20, the modes and floors its flags name", () => {
  assert.deepEqual(searchCheckOf(card({natural: 12, discarded: 4, flags: {rollModes: ["advantage", "bogus"], naturalMinimum: 10}})),
    {total: 17, natural: 12, rollMode: "advantage", rollModes: ["advantage"], naturalMinimum: 10, totalMinimum: null});
  assert.equal(searchCheckOf(card({flags: {rollModes: ["advantage", "disadvantage"]}})).rollMode, "normal", "its sources cancel");
  assert.equal(searchCheckOf(card({flags: {search: false}})), null, "a check not rolled to search (a sheet roll) finds no one");
  assert.equal(searchCheckOf({...card(), rolls: []}), null, "a card without a roll (a Portent's note)");
  assert.equal(searchCheckOf(card({natural: 40})).natural, null, "no d20 shows 40");
});

/** A square grid of 100 px with no Token vision (all Bright Light); a wall document blocks sight between columns 3 and 4. */
function world({walls=[]}={}) {
  const scene = {id: "s", grid: {size: 100, distance: 5, getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: j * 100 + 100, y: i * 100},
    {x: j * 100 + 100, y: i * 100 + 100}, {x: j * 100, y: i * 100 + 100}]}, tokenVision: false, walls, tokens: []};
  const deleted = [];
  const place = (id, i, j, disposition, {effects=[], perceived=[], statuses=["invisible"], hidden=false}={}) => {
    const actor = {statuses: new Set(statuses), system: {senses: {}}, effects, getRollModes: domains => (domains.includes("perceived")
      ? perceived.map(mode => ({mode})) : []), deleteEmbeddedDocuments: async (type, ids) => deleted.push([id, ...ids])};
    const token = {id, name: id, parent: scene, x: j * 100, y: i * 100, width: 1, height: 1, disposition, hidden, actor,
      getOccupiedGridSpaceOffsets: () => [{i, j}]};
    scene.tokens.push(token);
    return token;
  };
  return {scene, place, deleted};
}
const hiding = (id, foundDC) => ({id, disabled: false, flags: {wildpath: {conditionEffect: {metadata: {foundDC}}}}});

test("a Perception check finds each hidden foe whose space its searcher sees and whose found DC it meets, ending only those instances", async () => {
  const {place, deleted} = world({walls: [{c: [350, -500, 350, 900], sight: 20}]});
  const searcher = place("searcher", 0, 0, 1, {statuses: []});
  place("rogue", 2, 2, -1, {effects: [hiding("hide", 16), hiding("spell", "check")]});
  place("lucky", 1, 1, -1, {effects: [hiding("hide", 18)]});
  place("walled", 0, 6, -1, {effects: [hiding("hide", 5)]});
  place("ally", 1, 0, 1, {effects: [hiding("hide", 5)]});
  place("gm-hidden", 2, 0, -1, {effects: [hiding("hide", 5)], hidden: true});
  place("spellbound", 2, 1, -1, {effects: [{id: "invisibility", flags: {wildpath: {conditionEffect: {metadata: {}}}}}]});
  place("neutral", 1, 2, 0, {effects: [hiding("hide", 15)]});
  const rolled = [];
  const check = {total: 17, natural: 12, rollMode: "normal", rollModes: []};
  const found = await findHidden(searcher, check, {roll: async formula => { rolled.push(formula); return 1; }});
  assert.deepEqual(found.map(token => token.id), ["rogue", "neutral"], "17 meets 16, not 18; a neutral creature is found too");
  assert.deepEqual(deleted, [["rogue", "hide"], ["neutral", "hide"]], "only its numeric found DC's instance: a spell's Invisible stays");
  assert.deepEqual(rolled, [], "no creature's modes differ from the roll's");
  // A neutral searcher finds a hidden foe and a hidden friendly creature alike (only allies are left out).
  const {place: put, deleted: ended} = world();
  const guard = put("guard", 0, 0, 0, {statuses: []});
  put("thief", 0, 1, 1, {effects: [hiding("hide", 10)]});
  put("cutpurse", 0, 2, -1, {effects: [hiding("hide", 10)]});
  assert.deepEqual([(await findHidden(guard, check)).map(token => token.id), ended], [["thief", "cutpurse"], [["thief", "hide"], ["cutpurse", "hide"]]]);
});

test("the Cloak of Elvenkind's `perceived` Disadvantage is that creature's alone: an extra d20 for it, the lower counting", async () => {
  const {place, deleted} = world();
  const searcher = place("searcher", 0, 0, 1, {statuses: []});
  place("cloaked", 0, 2, -1, {effects: [hiding("hide", 14)], perceived: ["disadvantage"]});
  place("plain", 0, 3, -1, {effects: [hiding("hide", 14)]});
  const rolled = [];
  const check = {total: 17, natural: 12, rollMode: "normal", rollModes: []};
  const found = await findHidden(searcher, check, {roll: async (formula, name) => { rolled.push([formula, name]); return 3; }});
  assert.deepEqual([found.map(token => token.id), rolled, deleted], [["plain"], [["1d20", "cloaked"]], [["plain", "hide"]]],
    "the cloaked creature is checked at 3 + 5 = 8");
  // The searcher's own Advantage and the cloak cancel out for that creature alone: as its roll kept the higher of two dice,
  // one fresh d20 is its normal roll (9 + 5); the plain one keeps the Advantage roll's 17.
  const fresh = [];
  const helped = await findHidden(searcher, {...check, rollMode: "advantage", rollModes: ["advantage"]},
    {roll: async (formula, name) => { fresh.push([formula, name]); return 9; }});
  assert.deepEqual([helped.map(token => token.id), fresh], [["cloaked", "plain"], [["1d20", "cloaked"]]]);
  const twice = await findHidden(searcher, {...check, rollMode: "advantage", rollModes: ["advantage"]}, {roll: async () => 8});
  assert.deepEqual(twice.map(token => token.id), ["plain"], "8 + 5 misses its 14");
  // A fresh die closed unrolled leaves that creature unjudged.
  const {place: put, deleted: none} = world();
  const seeker = put("searcher", 0, 0, 1, {statuses: []});
  put("cloaked", 0, 2, -1, {effects: [hiding("hide", 1)], perceived: ["disadvantage"]});
  assert.deepEqual([(await findHidden(seeker, check, {roll: async () => null})).length, none], [0, []]);
});

test("the GM's search query: from a recent Search card its sender's creature rolled, once; never from a check the client names", async t => {
  const keys = ["CONFIG", "game", "ChatMessage", "foundry"];
  const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  t.after(() => { for ( const key of keys ) globalThis[key] = saved[key]; });
  const {scene, place, deleted} = world();
  const searcher = place("searcher", 0, 0, 1, {statuses: []});
  searcher.actor.uuid = "Actor.searcher";
  searcher.actor.testUserPermission = user => user === "owner";
  place("rogue", 0, 2, -1, {effects: [hiding("hide", 16)]});
  const cards = {card: card(), plain: {...card(), id: "plain", flags: {wildpath: {rollTest: {actorUuid: "Actor.searcher", skill: "perception"}}}},
    old: {...card({timestamp: Date.now() - 3600000}), id: "old"}, other: {...card({flags: {actorUuid: "Actor.someone"}}), id: "other"}};
  const posted = [];
  globalThis.CONFIG = {queries: {}};
  globalThis.ChatMessage = {create: async data => posted.push(data), getSpeaker: () => ({})};
  globalThis.foundry = {utils: {escapeHTML: text => text}};
  globalThis.game = {user: {id: "gm", isGM: true}, i18n: {format: (key, data) => `${key} ${data.found}`},
    messages: {get: id => cards[id]}, scenes: {get: id => (id === "s" ? {tokens: {get: id => scene.tokens.find(token => token.id === id)}} : undefined)}};
  registerSearch();
  const query = globalThis.CONFIG.queries[SEARCH_QUERY];
  assert.deepEqual(await query({messageId: "card"}, {user: "stranger"}), {ok: false}, "its sender must own the searcher");
  assert.deepEqual(await query({messageId: "card", tokenUuid: "Scene.s.Token.searcher", check: {total: 99, rollMode: "normal"}}, {user: "stranger"}),
    {ok: false}, "a check the client sends counts for nothing");
  for ( const id of ["plain", "old", "other", "missing"] ) assert.deepEqual(await query({messageId: id}, {user: "owner"}), {ok: false}, id);
  assert.deepEqual(deleted, []);
  assert.deepEqual(await query({messageId: "card"}, {user: "owner"}), {ok: true});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([deleted, cards.card.flags.wildpath.searched, posted.length], [[["rogue", "hide"]], true, 1], "17 finds the rogue's 16");
  assert.deepEqual(await query({messageId: "card"}, {user: "owner"}), {ok: false}, "a card searches once");
  assert.equal(await searchCard(cards.card, "owner"), null);
  globalThis.game.user.isGM = false;
  assert.deepEqual(await query({messageId: "card"}, {user: "owner"}), {ok: false}, "a player's client never searches");
});

test("Item#use: a Search checked with a skill it finds with asks the active GM to search; another skill does not", async t => {
  const keys = ["Item", "game", "foundry", "CONFIG"];
  const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  t.after(() => { for ( const key of keys ) globalThis[key] = saved[key]; });
  globalThis.Item = class { constructor(data) { Object.assign(this, data); } };
  const {default: WildPathItem} = await import("../module/documents/item.mjs");
  const {commonAction} = await import("../module/helpers/common-actions.mjs");
  const {WILDPATH} = await import("../module/config.mjs");
  const queries = [];
  globalThis.CONFIG = {WILDPATH, queries: {}};
  globalThis.game = {user: {id: "player"}, users: {activeGM: {id: "gm", query: async (name, data) => { queries.push([name, data]); return {ok: true}; }}},
    wildpath: {executeActionIntent: async () => ({ok: true})}, i18n: {localize: key => key, format: key => key}};
  let picked = "perception";
  globalThis.foundry = {applications: {api: {DialogV2: {input: async () => ({skill: picked})}}}};
  const rolls = [];
  const token = {uuid: "Scene.s.Token.hero"};
  const actor = {uuid: "Actor.hero", name: "Hero", items: [], effects: [], statuses: new Set(), token,
    system: {resources: {action: {value: 1, max: 1}}, pools: []},
    rollTest: async options => { rolls.push(options); return {total: 17, natural: 12, rollMode: "normal", messageId: "card"}; }};
  assert.equal(await WildPathItem.prototype.use.call(commonAction(actor, "search")), true);
  assert.deepEqual([rolls, queries], [[{skill: "perception", search: true, token}], [[SEARCH_QUERY, {messageId: "card"}]]],
    "its card, spoken by its Token, is the search: the GM reads the check from it");
  picked = "insight";
  await WildPathItem.prototype.use.call(commonAction(actor, "search"));
  assert.deepEqual([rolls[1], queries.length], [{skill: "insight"}, 1], "Insight finds no one");
});

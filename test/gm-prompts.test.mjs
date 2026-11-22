import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryGmPrompts, GM_PROMPT_QUERY} from "../module/adapters/foundry-v14-gm-prompts.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

// A hand-written Earthquake-like Action (no converter yet): a save, a fall for each creature that failed it, and a
// structures entry on the GM's own targets.
const fall = {schemaVersion: 1, id: "quake:fall", label: "Falls in", costs: {allOf: [{capability: "action", amount: 1}]}, fall: {feet: 20}};
const shaken = {schemaVersion: 1, id: "quake:structures", label: "Structures shaken", costs: {allOf: []},
  damage: [{id: "structures", expression: {type: "dice", number: 12, faces: 6}, damageType: "bludgeoning"}]};
const quake = {schemaVersion: 1, id: "quake", label: "Quake", costs: {allOf: []}, save: {ability: "agility", dc: {value: 15}},
  gmPrompt: [{for: "failed", action: fall}, {for: "picked", action: shaken}]};

/** A table with the GM at `userId` (the active GM is "gm"), the caster and three creatures on one Scene. */
function table({userId="gm", complete=true, resolves=true, openings=null}={}) {
  const runs = [];
  const posted = [];
  const updates = [];
  let finish = () => {};
  const scene = {id: "scene", tokens: null};
  const token = id => ({id, name: id.toUpperCase(), parent: scene, actor: {uuid: `Actor.${id}`}});
  const list = [token("caster"), token("ana"), token("bo"), token("cy")];
  scene.tokens = {get: id => list.find(entry => entry.id === id)};
  const messages = new Map();
  const coordinator = {resolveAuthorityAction: async ({resolved, onComplete}) => {
    runs.push({definition: resolved.action.system.definition, intent: resolved.intent});
    finish = () => onComplete({state: {status: complete ? "completed" : "cancelled"}});
    return {ok: true, state: {status: "running"}};
  }};
  const game = {user: {id: userId, isGM: true, targets: []}, users: {activeGM: {id: "gm"}},
    i18n: {format: (key, data) => `${key}|${Object.values(data).join("|")}`, localize: key => key},
    messages: {get: id => messages.get(id)}, scenes: {get: id => (id === "scene" ? scene : undefined)}};
  globalThis.foundry = {utils: {escapeHTML: text => text}};
  globalThis.ChatMessage = {getSpeaker: ({token: speaker}) => ({token: speaker.id}), create: async (data, options) => {
    const message = {id: `m${posted.length}`, author: {isGM: true}, ...data,
      async update(change) {
        updates.push(change);
        await Promise.resolve();
        this.flags.wildpath.gmPrompt.entries = change["flags.wildpath.gmPrompt.entries"];
      }};
    posted.push({message, options});
    messages.set(message.id, message);
    return message;
  }};
  const warnings = [];
  const prompts = createFoundryGmPrompts({game, coordinator, logger: {warn: (...args) => warnings.push(args.join(" "))},
    resolveAction: async options => (resolves ? {ok: true, ...options} : {ok: false, reason: "gone"}),
    fromUuid: uuid => (uuid === "Scene.scene.Token.caster" ? list[0] : null), openings});
  const save = (success, tokenId) => ({ok: true, success, target: {tokenId}});
  const state = {source: {tokenRef: "Scene.scene.Token.caster"}, actionDefinition: quake,
    results: {saveResolution: {results: [save(false, "ana"), save(true, "bo"), save(false, "cy"), save(false, "gone")]}}};
  return {prompts, game, state, runs, posted, updates, messages, finish: () => finish(), list, warnings};
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("a gmPrompt entry is failed (with the Action's save) or picked, with a valid inline Action", () => {
  assert.equal(validateActionDefinition(quake).ok, true);
  assert.deepEqual(validateActionDefinition(quake).definition.gmPrompt.map(entry => entry.for), ["failed", "picked"]);
  const refused = definition => validateActionDefinition(definition).errors.map(entry => entry.path);
  assert.deepEqual(refused({...quake, gmPrompt: [{for: "saved", action: shaken}]}), ["gmPrompt.0.for"]);
  assert.deepEqual(refused({...quake, save: null, gmPrompt: [{for: "failed", action: fall}]}), ["gmPrompt.0.for"],
    "no save, so no creature fails it");
  assert.deepEqual(refused({...quake, save: null, gmPrompt: [{for: "picked", action: shaken}]}), []);
  assert.deepEqual(refused({...quake, gmPrompt: [{for: "picked", action: {...shaken, id: ""}}]}), ["gmPrompt.0.action"]);
  assert.equal("gmPrompt" in validateActionDefinition({...quake, gmPrompt: undefined}).definition, false, "absent stays absent");
});

test("once its Action completes, the active GM whispers one card: a button per creature that failed and one for its targets", async () => {
  const {prompts, state, posted, game} = table();
  await prompts.afterResolution({state});
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].options, {messageMode: "gm"}, "whispered to the GMs");
  const card = posted[0].message.flags.wildpath.gmPrompt;
  assert.deepEqual([card.sourceActorRef, card.sourceTokenId, card.sceneId], ["Actor.caster", "caster", "scene"]);
  assert.deepEqual(card.entries.map(entry => [entry.id, entry.for, entry.label, entry.targets, entry.used]), [
    ["0-ana", "failed", "WILDPATH.GMPROMPT.Failed|Falls in|ANA", [{actorRef: "Actor.ana", tokenId: "ana", sceneId: "scene"}], false],
    ["0-cy", "failed", "WILDPATH.GMPROMPT.Failed|Falls in|CY", [{actorRef: "Actor.cy", tokenId: "cy", sceneId: "scene"}], false],
    ["1", "picked", "WILDPATH.GMPROMPT.Picked|Structures shaken", null, false]],
    "Bo saved; a creature whose Token is gone gets none");
  assert.deepEqual(card.entries[0].action.costs, {allOf: []}, "the GM's press costs its source nothing");

  await table({userId: "assistant"}).prompts.afterResolution({state});
  assert.equal(posted.length, 1, "only the active GM posts");
  const nobodyFailed = {...state, actionDefinition: {...quake, gmPrompt: [quake.gmPrompt[0]]},
    results: {saveResolution: {results: [{ok: true, success: true, target: {tokenId: "bo"}}]}}};
  const {prompts: other, posted: none} = table();
  assert.equal(await other.afterResolution({state: nobodyFailed}), null);
  assert.equal(none.length, 0, "no entry, no card");
  assert.equal(await other.afterResolution({state: {...state, actionDefinition: {...quake, gmPrompt: undefined}}}), null);
  assert.ok(game);
});

test("a press claims its entry before running its one authority Action; a second press runs nothing", async () => {
  const {prompts, state, posted, runs, updates, finish, game} = table();
  const message = await prompts.afterResolution({state});
  assert.deepEqual(await prompts.press({messageId: message.id, entryId: "0-ana"}, game.user), {ok: true});
  assert.deepEqual(updates[0]["flags.wildpath.gmPrompt.entries"].map(entry => entry.used), [true, false, false], "claimed first");
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].definition.id, "quake:fall");
  assert.deepEqual(runs[0].definition.costs, {allOf: []});
  assert.deepEqual(runs[0].intent.targetRefs, [{actorRef: "Actor.ana", tokenId: "ana", sceneId: "scene"}]);
  assert.deepEqual([runs[0].intent.actorRef, runs[0].intent.source], ["Actor.caster", {tokenId: "caster", sceneId: "scene"}]);
  assert.deepEqual(await prompts.press({messageId: message.id, entryId: "0-ana"}, game.user), {ok: false}, "during the run");
  finish();
  await settle();
  assert.deepEqual(await prompts.press({messageId: message.id, entryId: "0-ana"}, game.user), {ok: false}, "after it (a reload reads used)");
  assert.equal(runs.length, 1);
  assert.equal(posted[0].message.flags.wildpath.gmPrompt.entries[0].used, true, "a completed entry stays used");
  // Two presses at once: the second finds the card claimed.
  const both = await Promise.all([prompts.press({messageId: message.id, entryId: "0-cy"}, game.user),
    prompts.press({messageId: message.id, entryId: "0-cy"}, game.user)]);
  assert.deepEqual(both.map(result => result.ok), [true, false]);
});

test("an entry whose Action cannot start or does not complete is released", async () => {
  const unresolved = table({resolves: false});
  const message = await unresolved.prompts.afterResolution({state: unresolved.state});
  assert.deepEqual(await unresolved.prompts.press({messageId: message.id, entryId: "0-ana"}, unresolved.game.user), {ok: true});
  await settle();
  assert.equal(message.flags.wildpath.gmPrompt.entries[0].used, false, "its source or target gone: the button works again");
  assert.equal(unresolved.runs.length, 0);

  const cancelled = table({complete: false});
  const card = await cancelled.prompts.afterResolution({state: cancelled.state});
  await cancelled.prompts.press({messageId: card.id, entryId: "0-ana"}, cancelled.game.user);
  await settle();
  cancelled.finish();
  await settle();
  assert.equal(card.flags.wildpath.gmPrompt.entries[0].used, false, "cancelled at a prompt");
});

test("a run's release waits for another entry's claim still on its way, so it neither clears that claim nor is lost", async () => {
  const {prompts, state, game, finish} = table({complete: false});
  const message = await prompts.afterResolution({state});
  await prompts.press({messageId: message.id, entryId: "0-ana"}, game.user);
  await settle();
  // Slow writes: Cy's claim is still on its way when Ana's run is cancelled.
  message.update = async change => {
    await settle();
    await settle();
    message.flags.wildpath.gmPrompt.entries = change["flags.wildpath.gmPrompt.entries"];
  };
  const claim = prompts.press({messageId: message.id, entryId: "0-cy"}, game.user);
  finish();
  assert.deepEqual(await claim, {ok: true});
  for ( let i = 0; i < 8; i++ ) await settle();
  assert.deepEqual(message.flags.wildpath.gmPrompt.entries.map(entry => entry.used), [false, true, false],
    "Ana released, Cy still claimed");
});

test("picked acts on the pressing GM's targets on the card's Scene; none is refused", async () => {
  const {prompts, state, runs, game} = table();
  const message = await prompts.afterResolution({state});
  assert.deepEqual(await prompts.press({messageId: message.id, entryId: "1", targetIds: ["elsewhere"]}, game.user), {ok: false});
  assert.equal(message.flags.wildpath.gmPrompt.entries[2].used, false, "nothing claimed");
  assert.deepEqual(await prompts.press({messageId: message.id, entryId: "1", targetIds: ["bo", "elsewhere"]}, game.user), {ok: true});
  await settle();
  assert.deepEqual(runs[0].intent.targetRefs, [{actorRef: "Actor.bo", tokenId: "bo", sceneId: "scene"}]);
  assert.equal(runs[0].definition.id, "quake:structures");
});

test("only a GM's press on a GM's card runs, and only on the active GM; another GM's client asks it", async () => {
  const {prompts, state, runs, game} = table();
  const message = await prompts.afterResolution({state});
  assert.deepEqual(await prompts.handleQuery({messageId: message.id, entryId: "0-ana"}, {user: {id: "player", isGM: false}}), {ok: false},
    "a player's query");
  message.author = {isGM: false};
  assert.deepEqual(await prompts.handleQuery({messageId: message.id, entryId: "0-ana"}, {user: {id: "assistant", isGM: true}}), {ok: false},
    "a card a player wrote with the same flags");
  message.author = {isGM: true};
  assert.deepEqual(await prompts.handleQuery({messageId: message.id, entryId: "0-ana"}, {user: {id: "assistant", isGM: true}}), {ok: true},
    "an Assistant GM's press");
  await settle();
  assert.equal(runs.length, 1);
  const away = table({userId: "assistant"});
  const card = await table().prompts.afterResolution({state: away.state});
  away.messages.set(card.id, card);
  assert.deepEqual(await away.prompts.press({messageId: card.id, entryId: "0-ana"}, away.game.user), {ok: false},
    "not the active GM: it runs nothing itself");
  assert.equal(GM_PROMPT_QUERY, "wildpath.gmPrompt");
  assert.ok(game);
});

test("a GM sees the card's buttons (a used one disabled); a player, or a player's card, none; picked with no targets warns", async t => {
  const {prompts, state, game} = table({userId: "assistant"});
  const asked = [];
  game.users.activeGM.query = async (name, data) => { asked.push([name, data]); return {ok: true}; };
  const warned = [];
  globalThis.ui = {notifications: {warn: text => warned.push(text)}};
  globalThis.document = {createElement: () => ({listeners: [], addEventListener(type, fn) { this.listeners.push(fn); }})};
  t.after(() => { delete globalThis.document; delete globalThis.ui; });
  const message = await table().prompts.afterResolution({state});
  message.flags.wildpath.gmPrompt.entries[1].used = true;
  const render = (user, author=true) => {
    const appended = [];
    game.user = user;
    prompts.onRender({...message, author: {isGM: author}}, {querySelector: () => null, append: node => appended.push(node)});
    return appended;
  };
  assert.equal(render({id: "player", isGM: false}).length, 0, "a player gets no buttons");
  assert.equal(render({id: "assistant", isGM: true}, false).length, 0, "a player-authored card gets none");
  const buttons = render({id: "assistant", isGM: true, targets: []});
  assert.deepEqual(buttons.map(button => [button.textContent, button.disabled, button.title]), [["WILDPATH.GMPROMPT.Failed|Falls in|ANA", false, undefined],
    ["WILDPATH.GMPROMPT.Failed|Falls in|CY", true, "WILDPATH.GMPROMPT.Used"], ["WILDPATH.GMPROMPT.Picked|Structures shaken", false, undefined]],
    "a used button says why it is disabled");
  await buttons[2].listeners[0]();
  assert.deepEqual([warned, asked], [["WILDPATH.GMPROMPT.NoTargets|WILDPATH.GMPROMPT.Picked|Structures shaken"], []],
    "no targets: a warning naming the button, nothing sent");
  game.user.targets = [{id: "bo"}];
  await buttons[2].listeners[0]();
  await buttons[0].listeners[0]();
  assert.deepEqual(asked, [[GM_PROMPT_QUERY, {messageId: message.id, entryId: "1", targetIds: ["bo"]}],
    [GM_PROMPT_QUERY, {messageId: message.id, entryId: "0-ana", targetIds: []}]], "routed to the active GM");
});

test("the runtime posts an Action's GM card after its deaths settle and routes the query and the buttons", async () => {
  // registerFoundryV14MultiplayerResolution has no harness of its own; its wiring is read from its source.
  const {readFileSync} = await import("node:fs");
  const runtime = readFileSync(new URL("../module/resolvers/foundry-multiplayer-runtime.mjs", import.meta.url), "utf8");
  const card = runtime.indexOf("await gmPrompts.afterResolution(event)");
  assert.ok(card > runtime.indexOf("await dying.settleDeaths(killed)"));
  assert.ok(card < runtime.indexOf("return actionCompletedFollowUps(event"));
  assert.match(runtime, /CONFIG\.queries\[GM_PROMPT_QUERY\] = gmPrompts\.handleQuery/);
  assert.match(runtime, /"renderChatMessageHTML", \(message, html\) => gmPrompts\.onRender\(message, html\)/);
});

// An Earthquake-like trigger's Action (hand-written, no converter yet): openings across the area that ran it, rolled and laid
// out by the areas adapter (stubbed here), and a fall with no feet of its own.
const OPENS = {label: "Fissure", count: {type: "dice", number: 1, faces: 6}, depth: 40, width: {value: 10, unit: "ft"},
  persistence: {walls: "open"}};
const PARENT = {sceneId: "scene", regionId: "quake-area", topology: "square", fields: [{x: 1, y: 1}], castLevel: 8, depth: 30};

test("an Action's opens puts a roll entry on the card, pressed at once; its result adds the Open entry, whose press opens them", async () => {
  const calls = [];
  let laid = {regionIds: ["f1", "f2"], definition: {id: "quake:opens"}, count: 3, depths: [40, 60]};
  const openings = {roll: async (entry, card) => (calls.push(["roll", entry.id, card.sceneId]), laid),
    open: async (entry, card) => (calls.push(["open", entry.regionIds, card.sourceTokenId]), {regionIds: entry.regionIds})};
  const {prompts, state, posted, messages, updates} = table({openings});
  const opener = {schemaVersion: 1, id: "quake:open", label: "Quake", costs: {allOf: []}, tags: ["spell"], targeting: {type: "self"},
    opens: OPENS};
  assert.equal(validateActionDefinition(opener).ok, true);
  await prompts.afterResolution({state: {...state, actionDefinition: opener}, options: {parentArea: PARENT}});
  await settle();
  const card = posted[0].message.flags.wildpath.gmPrompt;
  assert.deepEqual(card.entries.map(entry => [entry.id, entry.for, entry.label, entry.used]), [
    ["opens", "roll", "WILDPATH.OPENS.Roll|Fissure", true],
    ["opens-open", "open", "WILDPATH.OPENS.Open|Fissure|2|3|40, 60", false]], "rolled at once; 2 of 3 placed, and their depths");
  assert.deepEqual([card.entries[0].opens, card.entries[0].parentArea, card.entries[0].actionId, card.entries[0].tags],
    [OPENS, PARENT, "quake:open", ["spell"]], "the roll keeps the openings, the area as it stood and the Action's own");
  assert.deepEqual(card.entries[1].regionIds, ["f1", "f2"]);
  assert.deepEqual(calls, [["roll", "opens", "scene"]]);
  assert.equal((await prompts.press({messageId: posted[0].message.id, entryId: "opens"}, {isGM: true})).ok, false, "a used roll runs no more");
  assert.equal((await prompts.press({messageId: posted[0].message.id, entryId: "opens-open"}, {isGM: true})).ok, true);
  await settle();
  assert.deepEqual(calls.at(-1), ["open", ["f1", "f2"], "caster"]);
  assert.equal(messages.get(posted[0].message.id).flags.wildpath.gmPrompt.entries[1].used, true, "opened once");
  // A die closed unrolled (laid null): released, so the GM presses the roll again.
  laid = null;
  const second = table({openings});
  await second.prompts.afterResolution({state: {...second.state, actionDefinition: opener}, options: {parentArea: PARENT}});
  await settle();
  assert.deepEqual(second.posted[0].message.flags.wildpath.gmPrompt.entries.map(entry => [entry.for, entry.used]), [["roll", false]]);
  assert.ok(updates.length >= 1);
});

test("opens with no area that ran it posts nothing and tells the GM; a fall with no feet falls as deep as that area", async () => {
  const {prompts, state, posted, warnings} = table({openings: {roll: async () => null, open: async () => null}});
  const opener = {schemaVersion: 1, id: "quake:open", label: "Quake", costs: {allOf: []}, opens: OPENS};
  assert.equal(await prompts.afterResolution({state: {...state, actionDefinition: opener}}), null);
  assert.equal(posted.length, 0);
  assert.match(warnings.join(), /WILDPATH\.NOTICE\.OpensNoArea/);
  const fallsIn = {...quake, gmPrompt: [{for: "failed", action: {...fall, fall: {}}}]};
  assert.equal(validateActionDefinition(fallsIn).ok, true);
  await prompts.afterResolution({state: {...state, actionDefinition: fallsIn}, options: {parentArea: PARENT}});
  assert.deepEqual(posted[0].message.flags.wildpath.gmPrompt.entries.map(entry => entry.action.fall), [{feet: 30}, {feet: 30}],
    "the fissure's depth, filled in as the card is posted");
  await prompts.afterResolution({state: {...state, actionDefinition: quake}, options: {parentArea: PARENT}});
  assert.deepEqual(posted[1].message.flags.wildpath.gmPrompt.entries[0].action.fall, {feet: 20}, "its own feet kept");
});

test("opens rides a self-targeted trigger on its caster's turn; an area's depth is a positive number of feet", () => {
  const area = (trigger, persistence={}) => ({schemaVersion: 1, id: "quake", label: "Quake", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape: "radial", size: {value: 100, unit: "ft"}, persistence: {...persistence, triggers: [trigger]}}});
  const opener = (extra={}) => ({schemaVersion: 1, id: "quake:open", costs: {allOf: []}, opens: OPENS, ...extra});
  const errors = definition => validateActionDefinition(definition).errors?.map(entry => entry.path) ?? [];
  assert.deepEqual(errors(area({on: ["turn.ended"], turnOf: "source", once: "area", action: opener({targeting: {type: "self"}})})), []);
  for ( const trigger of [{on: ["area.created"], action: opener()}, {on: ["turn.ended"], turnOf: "source", action: opener()},
    {on: ["turn.ended"], action: opener({targeting: {type: "self"}})},
    {on: ["turn.ended", "area.entered"], turnOf: "source", action: opener({targeting: {type: "self"}})}] ) {
    assert.deepEqual(errors(area(trigger)), ["area.persistence.triggers.0.action.opens"], JSON.stringify(trigger.on));
  }
  const pit = {on: ["area.created"], action: {schemaVersion: 1, id: "pit:fall", costs: {allOf: []}, fall: {}}};
  assert.deepEqual(errors(area(pit, {depth: 10})), []);
  for ( const depth of [0, -5, "deep"] ) assert.deepEqual(errors(area(pit, {depth})), ["area.persistence.depth"], String(depth));
  assert.deepEqual(errors(opener({opens: {...OPENS, width: {value: 0}}})), ["opens"], "a positive width");
});

test("a roll that lays no opening adds no Open entry and stays used", async () => {
  const openings = {roll: async () => ({regionIds: [], definition: {id: "quake:opens"}, count: 0, depths: []}), open: async () => null};
  const {prompts, state, posted} = table({openings});
  const opener = {schemaVersion: 1, id: "quake:open", label: "Quake", costs: {allOf: []}, targeting: {type: "self"}, opens: OPENS};
  await prompts.afterResolution({state: {...state, actionDefinition: opener}, options: {parentArea: PARENT}});
  await settle();
  assert.deepEqual(posted[0].message.flags.wildpath.gmPrompt.entries.map(entry => [entry.for, entry.used]), [["roll", true]]);
});

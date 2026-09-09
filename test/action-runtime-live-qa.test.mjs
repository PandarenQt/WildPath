import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {qaActionData, bounded, summarizeRecord, matchesQAIntent, verifyDigitalRoll,
  combineClientDumps, setupGM, setupPlayer, cleanupGM, QA_FLAG} from "../docs/development/action-runtime-live-qa.mjs";
import {actionDefinitionFromAction, actionDefinitionToResolverInput} from "../module/helpers/action-definitions.mjs";
import {createD20RollRequest} from "../module/helpers/rolls.mjs";
import {resolveAttackAgainstDefense, ATTACK_DEFAULT_POLICY} from "../module/resolvers/attack-resolver.mjs";
import {createFoundryDigitalRollProvider} from "../module/adapters/foundry-digital-roll-provider.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {MULTIPLAYER_MESSAGE_TYPES as MESSAGE} from "../module/helpers/multiplayer-authority.mjs";

const guide = readFileSync(new URL("../docs/development/action-runtime-live-qa.md", import.meta.url), "utf8");

test("every Action live QA console block parses and both case declarations call the embedded Item", () => {
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const blocks = [...guide.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(match => match[1]);
  assert.ok(blocks.length >= 18);
  for (const [index, block] of blocks.entries()) assert.doesNotThrow(() => new AsyncFunction(block), `block ${index + 1}`);
  const declarations = blocks.filter(block => block.includes("await action.use()"));
  assert.equal(declarations.length, 2);
  for (const block of declarations) assert.match(block, /sourceActor\.items\.get\(qa\.fixture\.actionId\)/);
  for (const block of blocks) assert.doesNotMatch(block, /executeActionIntent\(|createTestRollProvider\(|targetRefs\s*:/);
  for (const block of blocks) assert.doesNotMatch(block, /\bprompt\s*\(/);
  assert.ok(guide.startsWith("## STOP CONDITIONS"));
  assert.ok(guide.indexOf("## CONTINUE CONDITIONS") < guide.indexOf("```js"));
});

test("persisted QA Action uses current definition translation and guarantees both outcomes for all natural dice", () => {
  const data = qaActionData("run");
  const parsed = actionDefinitionFromAction(JSON.parse(JSON.stringify(data)));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.migrated, false);
  const input = actionDefinitionToResolverInput(parsed.definition);
  assert.deepEqual(data.system.modifiers[0].domains, ["attack.weapon"]);
  assert.equal(parsed.definition.range.distance.value, 5);
  assert.equal(parsed.definition.costs.allOf[0].capability, "action");
  assert.equal(input.damage.components[0].amount, 6);
  for (let natural = 1; natural <= 20; natural++) for (const [ac, hit] of [[1, true], [100, false]]) {
    const resolved = resolveAttackAgainstDefense({roll: {natural, total: natural + 4},
      defense: {value: ac}, policy: input.attack.policy});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.hit, hit, `d20=${natural}, AC=${ac}`);
    assert.equal(resolved.critical, false);
  }
  assert.equal(ATTACK_DEFAULT_POLICY.naturalCriticalHits, true);
  assert.equal(ATTACK_DEFAULT_POLICY.naturalCriticalMisses, true);
  data.system.definition.damage[0].expression.value = 99;
  assert.equal(qaActionData("another").system.definition.damage[0].expression.value, 6);
});

test("digital proof checks actual provider output and rejects numeric-only, manual and uncorrelated results", async () => {
  // Deterministic Roll class is confined to this Node test. The live helper never installs one.
  class TestFoundryRoll {
    constructor(formula) { this.formula = formula; }
    async evaluate(options) {
      assert.equal(options.allowInteractive, false);
      this.total = 15;
      this.dice = [{number: 1, faces: 20, results: [{result: 11, active: true}]}];
      return this;
    }
    toJSON() { return {formula: this.formula, total: this.total, terms: this.dice}; }
  }
  const request = createD20RollRequest({id: "roll", resolutionId: "resolution", type: "attack", modifierTotal: 4, modifiers: [{value: 4}]});
  const provided = await createFoundryDigitalRollProvider({RollClass: TestFoundryRoll}).execute(request);
  assert.equal(provided.ok, true, JSON.stringify(provided));
  assert.doesNotThrow(() => verifyDigitalRoll(provided.result, "resolution"));
  for (const patch of [{raw: null}, {provider: {id: "test", type: "test"}},
    {provenance: {type: "manual", method: "manual"}}, {natural: null}, {total: 16}, {resolutionId: "other"}]) {
    assert.throws(() => verifyDigitalRoll({...provided.result, ...patch}, "resolution"));
  }
});

test("QA intent correlation requires exact synthetic Actor, embedded Item, Player and authority", () => {
  const fixture = {sourceRef: "Scene.s.Token.t.Actor.a", actionRef: "Scene.s.Token.t.Actor.a.Item.i", playerId: "p", gmId: "g"};
  const envelope = {messageType: MESSAGE.ACTION_INTENT, senderUserId: "p", recipientUserId: "g",
    payload: {actorRef: fixture.sourceRef, actionRef: fixture.actionRef}};
  assert.equal(matchesQAIntent(envelope, fixture), true);
  for (const patch of [{senderUserId: "g"}, {recipientUserId: "p"}, {messageType: MESSAGE.RESOLUTION_RESULT},
    {payload: {...envelope.payload, actorRef: "Actor.a"}}, {payload: {...envelope.payload, actionRef: "Item.i"}}]) {
    assert.equal(matchesQAIntent({...envelope, ...patch}, fixture), false);
  }
});

test("diagnostics keep failure/pending/commit evidence while excluding live document handles and bounding traces", () => {
  const actor = {}; actor.self = actor;
  const record = {resolutionId: "r", authorityUserId: "g", initiatorUserId: "p",
    options: {actor, persistencePort: {id: "foundry-v14-document-persistence"}},
    requestExpectations: new Map([["r:q", {expectedUserId: "p", request: {id: "q"}}]]),
    state: {status: "failed", currentStageId: "action.commit", completedStageIds: ["action.attack-roll"],
      pendingRequests: [{id: "q"}], errors: [{reason: "document update failed"}],
      mutationPlans: [{type: "resourcePayment"}],
      results: {actionResult: {ok: false, steps: [{data: {transaction: {ok: false, rolledBack: true}}}]}},
      trace: Array.from({length: 100}, (_, i) => ({stageId: String(i)}))}};
  const dump = summarizeRecord(record);
  assert.equal(dump.status, "failed");
  assert.equal(dump.routing[0].expectedUserId, "p");
  assert.equal(dump.pendingRequests[0].id, "q");
  assert.equal(dump.errors[0].reason, "document update failed");
  assert.equal(dump.transaction.rolledBack, true);
  assert.equal(dump.traceTail.length, 12);
  assert.equal(dump.traceTail[0].stageId, "88");
  assert.doesNotThrow(() => JSON.stringify(dump));
  assert.equal(summarizeRecord(null).status, null);
  assert.match(bounded("x".repeat(2000)), /truncated/);
  assert.match(bounded(Array(25).fill(1)).at(-1), /5 more/);
});

test("combining client evidence rejects a different run, case, resolution or user", () => {
  const base = {runId: "run", mode: "hit", resolutionId: "r", authorityUserId: "g", playerId: "p"};
  const gm = {...base, role: "gm"}, player = {...base, role: "player"};
  assert.equal(combineClientDumps(gm, player).player, player);
  for (const key of Object.keys(base)) assert.throws(() => combineClientDumps({...gm, [key]: "wrong"}, player), /mismatch/);
  assert.throws(() => combineClientDumps({...gm, resolutionId: null}, {...player, resolutionId: null}));
});

class Values extends Map { [Symbol.iterator]() { return this.values(); } }

async function playerEnvironment(t) {
  const keys = ["game", "canvas", "CONFIG", "Item", "foundry", "wpActionRuntimeQA", "wpActionRuntimeQAArchive", "wpActionRuntimeQASetup"];
  const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  t.after(() => {
    globalThis.wpActionRuntimeQA?.detach();
    for (const key of keys) {
      if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key];
    }
  });
  delete globalThis.wpActionRuntimeQA;
  globalThis.Item = class { constructor(data) { Object.assign(this, data); } };
  const {default: WildPathItem} = await import("../module/documents/item.mjs");
  const f = {runId: "qa-run", role: "source", sceneId: "s", gmId: "g", playerId: "p",
    sourceActorId: "a", targetActorId: "b", sourceTokenId: "src", targetTokenId: "dst", actionId: "i",
    sourceRef: "Scene.s.Token.src.Actor.a", targetRef: "Scene.s.Token.dst.Actor.b", actionRef: "Scene.s.Token.src.Actor.a.Item.i"};
  const snapshot = () => ({system: {resources: {action: {value: 1}, health: {value: 30}}}, effects: [], items: []});
  const actor = (id, uuid) => ({id, uuid, isToken: true, isOwner: true, system: snapshot().system,
    effects: [], toObject: snapshot, getStatistic: () => ({totalModifier: 0}), items: new Values(),
    getFlag: () => ({runId: f.runId})});
  const sourceActor = actor("a", f.sourceRef), targetActor = actor("b", f.targetRef);
  targetActor.system.resources.health.max = 30;
  const source = {id: "src", uuid: "Scene.s.Token.src", actor: sourceActor, getFlag: () => f};
  const target = {id: "dst", uuid: "Scene.s.Token.dst", actor: targetActor, getFlag: () => ({runId: f.runId, role: "target"})};
  sourceActor.token = source;
  const action = new WildPathItem({...qaActionData(f.runId), id: "i", uuid: f.actionRef, actor: sourceActor});
  sourceActor.items.set("i", action);
  const scene = {id: "s", tokens: new Values([["src", source], ["dst", target]])};
  source.parent = target.parent = scene;
  const users = new Values([["g", {id: "g", active: true, isGM: true}], ["p", {id: "p", active: true, isGM: false}]]);
  users.activeGM = users.get("g");
  const incoming = new Set(), outgoing = new Set();
  const socket = {on: (name, fn) => incoming.add(fn), off: (name, fn) => incoming.delete(fn),
    onAnyOutgoing: fn => outgoing.add(fn), offAnyOutgoing: fn => outgoing.delete(fn)};
  const sent = [];
  const transport = {registered: true, namespace: "system.wildpath", async send(envelope) {
    sent.push(envelope); for (const fn of outgoing) fn("system.wildpath", envelope); return {ok: true};
  }};
  const coordinator = createMultiplayerActionCoordinator({userId: "p", users: () => users, activeGMUserId: "g", transport});
  const executeActionIntent = intent => coordinator.declareActionIntent(intent);
  const runtime = {transport, coordinator, executeActionIntent};
  const scenes = new Values([["s", scene]]); scenes.active = scene;
  const actors = new Values([["a", actor("a", "Actor.a")], ["b", actor("b", "Actor.b")]]);
  const game = {release: {generation: 14, build: 367}, system: {id: "wildpath"}, users, user: users.get("p"),
    scenes, actors, modules: new Values(), socket, wildpath: {multiplayer: runtime, executeActionIntent}};
  game.user.targets = new Set([{document: target}]);
  f.prepared = {mode: "hit", before: {action: 1, hp: 30}};
  Object.assign(globalThis, {game, canvas: {ready: true, scene}, CONFIG: {Item: {documentClass: WildPathItem}}});
  return {f, action, game, scene, incoming, outgoing, sent, coordinator, sourceActor, targetActor};
}

test("QA observes the resolution spawned by real WildPathItem.use without changing the method or intent", async t => {
  const env = await playerEnvironment(t);
  const use = env.action.use;
  const qa = setupPlayer();
  assert.equal(qa.begin("hit"), env.action);
  qa.declared = await env.action.use();
  assert.equal(qa.declared, true);
  assert.equal(env.sent.length, 1);
  assert.equal(qa.resolutionId, env.sent[0].resolutionId);
  assert.equal(env.sent[0].payload.actorRef, env.f.sourceRef);
  assert.equal(env.sent[0].payload.actionRef, env.f.actionRef);
  assert.equal(env.sent[0].payload.targetRefs[0].tokenId, "dst");
  assert.equal(env.sent[0].payload.attack, undefined);
  assert.equal(env.action.use, use);
  assert.equal(env.sourceActor.system.resources.action.value, 1);
  qa.detach();
  assert.equal(env.outgoing.size, 0);
  assert.equal(env.incoming.size, 0);
});

test("QA refuses missing native targets before declaring and captures timeout without a resolution ID", async t => {
  const env = await playerEnvironment(t);
  const qa = setupPlayer();
  env.game.user.targets.clear();
  assert.throws(() => qa.begin("hit"), /native targeting/);
  assert.equal(env.sent.length, 0);
  env.game.user.targets.add({document: env.scene.tokens.get("dst")});
  qa.begin("hit");
  qa.startedAt = Date.now() - 21000;
  t.mock.method(console, "error", () => {});
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(qa.failed, true);
  assert.equal(qa.lastDump.resolutionId, null);
  assert.match(qa.lastDump.reason, /timeout/);
  assert.throws(() => qa.begin("hit"), /Previous case failed/);
});

test("QA refuses an incorrect prepared synthetic health maximum before Item declaration", async t => {
  const env = await playerEnvironment(t);
  const qa = setupPlayer();
  env.targetActor.system.resources.health.max = 10;
  assert.throws(() => qa.begin("hit"), /Player Documents have not received GM preparation/);
  assert.equal(qa.mode, null);
  assert.equal(qa.startedAt, null);
  assert.equal(env.sent.length, 0);
});

test("runbook native-target prechecks leave the observer reusable for missing or wrong targets", async t => {
  const env = await playerEnvironment(t);
  const qa = setupPlayer();
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const blocks = [...guide.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(m => m[1]);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const hitPrecheck = blocks.find(b => b.includes("qa.targetReady();"));
  const hitUse = blocks.find(b => b.includes('qa.begin("hit")'));
  for (const targets of [[], [{document: env.scene.tokens.get("src")}]]) {
    env.game.user.targets = new Set(targets);
    await new AsyncFunction(hitPrecheck)();
    await new AsyncFunction(hitUse)();
    assert.equal(qa.failed, false);
    assert.equal(qa.mode, null);
    assert.equal(qa.startedAt, null);
    assert.equal(qa.resolutionId, null);
    assert.equal(env.sent.length, 0);
  }
  assert.ok(console.warn.mock.calls.every(c => c.arguments[0].startsWith("TARGET NOT READY")));
  env.game.user.targets = new Set([{document: env.scene.tokens.get("dst")}]);
  await new AsyncFunction(hitUse)();
  assert.equal(qa.declared, true);
  assert.equal(env.sent.length, 1);
  assert.equal(qa.resolutionId, env.sent[0].resolutionId);
});

test("runbook player selection stops before setup for zero or multiple active Players without browser dialogs", async t => {
  const env = await playerEnvironment(t);
  t.mock.method(console, "table", () => {});
  t.mock.method(console, "warn", () => {});
  const block = [...guide.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(m => m[1])
    .find(b => b.includes("await setupGM("));
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  env.game.users.get("p").active = false;
  await new AsyncFunction(block)();
  env.game.users.get("p").active = true;
  env.game.users.set("p2", {id: "p2", name: "second", active: true, isGM: false});
  await new AsyncFunction(block)();
  assert.equal(console.warn.mock.calls.length, 2);
  assert.equal(globalThis.wpActionRuntimeQA, undefined);
  assert.equal(env.sent.length, 0);
});

test("runbook keeps strict failure handling after begin when Item declaration fails", async t => {
  const env = await playerEnvironment(t);
  const qa = setupPlayer();
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(env.action, "use", async () => false);
  const block = [...guide.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(m => m[1])
    .find(b => b.includes('qa.begin("hit")'));
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  await assert.rejects(new AsyncFunction(block)(), /Item.use\(\) declaration failed/);
  assert.equal(qa.failed, true);
  assert.ok(qa.startedAt);
  assert.equal(qa.lastDump.declarationSuccess, false);
});

test("QA captures a routed provider error and rejects a second declaration in one case", async t => {
  const env = await playerEnvironment(t);
  const qa = setupPlayer(); qa.begin("hit"); await env.action.use();
  t.mock.method(console, "error", () => {});
  const error = {messageId: "error", messageType: MESSAGE.RESOLUTION_ERROR, resolutionId: qa.resolutionId,
    senderUserId: "g", payload: {reason: "Provider failed"}};
  for (const fn of env.incoming) fn(error, "g");
  assert.equal(qa.failed, true);
  assert.equal(qa.lastDump.envelopes.at(-1).envelope.payload.reason, "Provider failed");
  assert.match(qa.lastDump.reason, /Provider failed/);
  qa.detach(); delete globalThis.wpActionRuntimeQA;
  const next = setupPlayer(); next.begin("hit"); await env.action.use();
  await env.action.use(); // Test a user double-click; the live procedure never retries a use.
  assert.equal(next.failed, true);
  assert.match(next.lastDump.reason, /More than one Item use/);
});

test("cleanup refuses an in-flight record and deletes only Documents with the exact run marker", async t => {
  const env = await playerEnvironment(t);
  env.game.user = env.game.users.activeGM;
  const deleted = [];
  for (const [id, a] of env.game.actors.entries()) a.delete = async () => { deleted.push(id); env.game.actors.delete(id); };
  const other = {id: "other", getFlag: () => ({runId: "another"}), delete: () => { throw new Error("Unrelated deletion"); }};
  env.game.actors.set("other", other);
  env.scene.tokens.set("other", other);
  env.scene.tokens.get("dst").getFlag = () => ({runId: env.f.runId});
  env.scene.deleteEmbeddedDocuments = async (type, ids) => { assert.equal(type, "Token"); deleted.push(...ids); };
  const r = {options: {actor: env.sourceActor}, state: {status: "paused"}};
  env.coordinator.records.set("r", r);
  await assert.rejects(cleanupGM(env.f.runId), /Nonterminal QA Action/);
  assert.equal(deleted.length, 0);
  r.state.status = "completed";
  t.mock.method(console, "log", () => {});
  await cleanupGM(env.f.runId);
  assert.deepEqual(deleted, ["src", "dst", "a", "b"]);
  assert.equal(env.game.actors.has("other"), true);
  assert.equal(QA_FLAG, "actionRuntimeLiveQA");
});

test("GM setup persists marked Documents, reads the attack domain, and prepares only synthetic resources", async t => {
  const env = await playerEnvironment(t);
  const {game, scene} = env;
  game.user = game.users.activeGM;
  game.actors.clear(); scene.tokens.clear();
  globalThis.foundry = {utils: {randomID: () => "new-run"}};
  const grid = {isSquare: true, type: 1, distance: 5, units: "ft", size: 100, sizeX: 100, sizeY: 100,
    getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}),
    getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100}),
    getCenterPoint: ({i, j}) => ({x: j * 100 + 50, y: i * 100 + 50}),
    getAdjacentOffsets: ({i, j}) => [{i: i - 1, j: j - 1}, {i: i - 1, j}, {i, j: j + 1}],
    getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: (j + 1) * 100, y: i * 100},
      {x: (j + 1) * 100, y: (i + 1) * 100}, {x: j * 100, y: (i + 1) * 100}]};
  Object.assign(scene, {grid, tokenVision: false, walls: new Values(), regions: new Values(),
    dimensions: {sceneX: 0, sceneY: 0, sceneWidth: 2000, sceneHeight: 2000, size: 100, distance: 5, units: "ft"}});
  Object.assign(canvas, {grid, level: {id: "level"}});
  const writes = [];
  function actor(data, uuid) {
    const a = {...structuredClone(data), uuid, items: new Values(), effects: []};
    // Model normal Actor preparation from authored inputs, without adding max to creation data.
    for (const resource of Object.values(a.system.resources)) resource.max = resource.base + (resource.bonus ?? 0);
    a.getFlag = (scope, key) => a.flags[scope]?.[key];
    a.toObject = () => ({system: structuredClone(a.system), effects: [], items: []});
    a.getStatistic = domain => ({totalModifier: [...a.items.values()].flatMap(i => i.system.modifiers)
      .filter(m => m.domains.includes(domain)).reduce((sum, m) => sum + m.value, 0)});
    a.update = async patch => {
      writes.push({uuid, patch});
      for (const [path, value] of Object.entries(patch)) {
        const keys = path.split(".");
        const parent = keys.slice(0, -1).reduce((o, k) => o[k] ??= {}, a);
        parent[keys.at(-1)] = value;
      }
    };
    a.getTokenDocument = async (data, options) => {
      assert.equal(options.parent, scene);
      return {toObject: () => ({...data, actorId: a.id})};
    };
    a.createEmbeddedDocuments = async (type, data) => {
      assert.equal(type, "Item");
      assert.equal(a.isToken, true);
      return data.map(d => {
        const item = new CONFIG.Item.documentClass({...d, id: "item", uuid: `${uuid}.Item.item`, actor: a});
        item.system.getActionDefinition = () => actionDefinitionFromAction(item);
        a.items.set(item.id, item);
        return item;
      });
    };
    return a;
  }
  CONFIG.Actor = {documentClass: {async create(data) {
    const id = `base-${game.actors.size}`;
    const a = actor({...data, id}, `Actor.${id}`);
    assert.equal(data.system.resources.health.base, 30);
    assert.equal(data.system.resources.health.max, undefined);
    assert.equal(data.flags.wildpath[QA_FLAG].runId, "new-run");
    game.actors.set(id, a); return a;
  }}};
  scene.createEmbeddedDocuments = async (type, entries) => {
    assert.equal(type, "Token");
    return entries.map(data => {
      const id = `token-${scene.tokens.size}`, base = game.actors.get(data.actorId);
      const synthetic = actor({id: base.id, system: base.system, flags: base.flags}, `Scene.s.Token.${id}.Actor.${base.id}`);
      synthetic.isToken = true;
      const token = {...data, id, uuid: `Scene.s.Token.${id}`, parent: scene, actor: synthetic, documentName: "Token",
        getOccupiedGridSpaceOffsets: () => [grid.getOffset(data)]};
      synthetic.token = token;
      token.getFlag = (scope, key) => token.flags[scope]?.[key];
      token.setFlag = async (scope, key, value) => { token.flags[scope][key] = structuredClone(value); };
      scene.tokens.set(id, token); return token;
    });
  };
  t.mock.method(console, "log", () => {});
  const qa = await setupGM("p");
  assert.equal(game.actors.size, 2);
  assert.equal(scene.tokens.size, 2);
  assert.equal(qa.fixture.actionRef, "Scene.s.Token.token-0.Actor.base-0.Item.item");
  assert.equal(game.actors.get("base-0").items.size, 0);
  const target = scene.tokens.get(qa.fixture.targetTokenId).actor;
  target.system.resources.health.max = 10;
  await assert.rejects(qa.prepare("hit"), /Synthetic target effective health must be value 30 \/ max 30/);
  assert.equal(qa.mode, null);
  assert.equal(env.sent.length, 0);
  target.system.resources.health.max = 30;
  const prepared = await qa.prepare("hit");
  assert.equal(prepared.before.action, 1);
  assert.equal(prepared.before.hp, 30);
  assert.equal(prepared.before.ac, 1);
  assert.ok(writes.every(w => w.uuid.startsWith("Scene.s.Token.")));
  const count = writes.length;
  await assert.rejects(qa.prepare("miss"), /Prior case/);
  assert.equal(writes.length, count);
  qa.passed.hit = true;
  await assert.rejects(qa.prepare("hit"), /already completed/);
  assert.equal(writes.length, count);
  const miss = await qa.prepare("miss");
  assert.equal(miss.before.ac, 100);
  qa.startedAt = Date.now();
  await assert.rejects(cleanupGM(qa.fixture.runId), /Unproven or failed/);
});

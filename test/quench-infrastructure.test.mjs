// These tests cover optional registration and fixture deletion safety, not real Foundry behavior.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createQuenchActor,createEmbeddedQuenchItem,createEmbeddedQuenchEffect,cleanupQuenchFixtures,useQuenchFixtures}
  from "../module/tests/quench/fixtures.mjs";

function globals(t,values) {
  for (const [key,value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
    t.after(() => old ? Object.defineProperty(globalThis,key,old) : delete globalThis[key]);
  }
}

function fixtureStore(t,{isGM=true}={}) {
  const actors = new Map(), calls = [];
  let sequence = 0;
  function add(id,flags={},name="Actor") {
    const actor = {id,name,flags,getFlag:(scope,key) => flags[scope]?.[key],
      async createEmbeddedDocuments(kind,data) {calls.push({kind,data}); return data.map(d => ({...d,parent:actor}));}};
    actors.set(id,actor);
    return actor;
  }
  const documentClass = {
    async create(data,options) {
      calls.push({kind:"create",data,options});
      return add(`actor-${++sequence}`,data.flags,data.name);
    },
    async deleteDocuments(ids) {
      calls.push({kind:"delete",ids});
      ids.forEach(id => actors.delete(id));
    }
  };
  globals(t,{game:{ready:true,user:{isGM},actors:{filter:fn => [...actors.values()].filter(fn)}},
    CONFIG:{Actor:{documentClass}},foundry:{utils:{randomID:() => `run-${++sequence}`}}});
  return {actors,calls,add,documentClass};
}

test("Quench entry loads without Quench or Foundry globals and registers the six Q1/Q2 batches on demand", async t => {
  const hooks = [], batches = [];
  globals(t,{Hooks:{on:(...args) => hooks.push(args)},game:undefined,foundry:undefined,quench:undefined});
  await import("../module/tests/quench/index.mjs");
  assert.equal(hooks.length,1);
  assert.equal(hooks[0][0],"quenchReady");
  hooks[0][1]({registerBatch:(key,register,options) => batches.push({key,register,options})});
  assert.deepEqual(batches.map(b => b.key),["wildpath.runtime-smoke","wildpath.documents","wildpath.resources",
    "wildpath.effects","wildpath.conditions","wildpath.rule-elements"]);
  const counts = batches.map(batch => {
    let count = 0;
    batch.register({describe:(_name,fn) => fn.call({timeout() {}}),it:() => count++,beforeEach() {},afterEach() {},assert:{}});
    assert.equal(batch.options.preSelected,false,"Registration must not opt developers into mutation tests");
    return count;
  });
  assert.deepEqual(counts,[3,6,8,4,5,8]);
  const startup = readFileSync(new URL("../wildpath.mjs",import.meta.url),"utf8");
  assert.deepEqual(startup.match(/import\s+"\.\/module\/tests\/[^"\n]+";/g),['import "./module/tests/quench/index.mjs";']);
});

test("Quench fixtures mark real-API creation requests and refuse embedded mutation on unmarked parents", async t => {
  const store = fixtureStore(t);
  const actor = await createQuenchActor({runId:"test-run",type:"npc",system:{details:{threat:2}}});
  assert.deepEqual(store.calls[0].data.flags,{wildpath:{quenchFixture:true,quenchRunId:"test-run"}});
  assert.equal(store.calls[0].data.type,"npc");
  assert.deepEqual(store.calls[0].options,{renderSheet:false});
  const item = await createEmbeddedQuenchItem(actor,{type:"gear"});
  assert.strictEqual(item.parent,actor);
  assert.deepEqual(item.flags,actor.flags);
  const ordinary = store.add("ordinary");
  const count = store.calls.length;
  await assert.rejects(createEmbeddedQuenchItem(ordinary),/explicitly marked fixture Actor/);
  await assert.rejects(createQuenchActor({runId:""}),/nonempty/);
  assert.equal(store.calls.length,count,"Refused fixture operations must not reach document mutation APIs");
});

test("Quench ActiveEffect fixtures require a marked parent and preserve scoped flags and native data", async t => {
  const store = fixtureStore(t), hooks = {};
  const fixtures = useQuenchFixtures({beforeEach:fn => hooks.before = fn,afterEach:fn => hooks.after = fn});
  hooks.before.call({skip() {assert.fail("GM must not skip");}});
  const actor = await fixtures.createActor();
  const system = {ruleElements:[{schemaVersion:1,id:"fixture-rule",type:"Modifier",data:{domains:["all"],value:2}}]};
  const duration = {value:1,units:"seconds",expiry:null,expired:true};
  const effect = await fixtures.createEffect(actor,{system,duration,start:{time:0},disabled:true});
  assert.strictEqual(effect.parent,actor);
  assert.deepEqual(effect.flags,actor.flags);
  assert.equal(effect.type,"effect");
  assert.equal(effect.disabled,true);
  assert.equal(effect.transfer,false);
  assert.deepEqual(effect.system,system);
  assert.deepEqual(effect.duration,duration);
  assert.deepEqual(effect.start,{time:0});
  assert.equal(store.calls.at(-1).kind,"ActiveEffect");
  const ordinary = store.add("ordinary");
  const missingRun = store.add("missing-run",{wildpath:{quenchFixture:true}});
  const count = store.calls.length;
  await assert.rejects(createEmbeddedQuenchEffect(ordinary),/explicitly marked fixture Actor/);
  await assert.rejects(createEmbeddedQuenchEffect(missingRun),/nonempty/);
  assert.equal(store.calls.length,count,"Refused effect creation must not reach embedded mutation APIs");
  await hooks.after();
  assert.deepEqual([...store.actors.keys()],["ordinary","missing-run"]);
});

test("Quench cleanup requires both exact marker and run ID and is safe to repeat", async t => {
  const store = fixtureStore(t);
  store.add("own",{wildpath:{quenchFixture:true,quenchRunId:"own-run"}});
  store.add("other-run",{wildpath:{quenchFixture:true,quenchRunId:"other-run"}});
  store.add("unmarked",{wildpath:{quenchRunId:"own-run"}});
  store.add("name-only",{},"[WildPath Quench] Actor");
  store.add("truthy-marker",{wildpath:{quenchFixture:"true",quenchRunId:"own-run"}});
  assert.deepEqual(await cleanupQuenchFixtures({runId:"own-run"}),["own"]);
  assert.deepEqual(await cleanupQuenchFixtures({runId:"own-run"}),[]);
  assert.deepEqual([...store.actors.keys()],["other-run","unmarked","name-only","truthy-marker"]);
  await assert.rejects(cleanupQuenchFixtures(),/nonempty/);
  assert.equal(store.calls.length,1,"Missing scope must never cause a world-wide delete");
});

test("Quench mutation helpers and skipped non-GM teardown never write Documents", async t => {
  const store = fixtureStore(t,{isGM:false}), hooks = {};
  useQuenchFixtures({beforeEach:fn => hooks.before = fn,afterEach:fn => hooks.after = fn});
  const skipped = new Error("Mocha pending");
  assert.throws(() => hooks.before.call({skip() {throw skipped;}}),error => error === skipped);
  await hooks.after();
  await assert.rejects(createQuenchActor({runId:"test"}),/require a GM/);
  await assert.rejects(createEmbeddedQuenchItem({}),/require a GM/);
  await assert.rejects(createEmbeddedQuenchEffect({}),/require a GM/);
  await assert.rejects(cleanupQuenchFixtures({runId:"test"}),/require a GM/);
  assert.deepEqual(store.calls,[]);
});

test("Quench teardown finds a marked Actor even when creation throws after persistence", async t => {
  const store = fixtureStore(t), hooks = {};
  store.add("unrelated");
  const fixtures = useQuenchFixtures({beforeEach:fn => hooks.before = fn,afterEach:fn => hooks.after = fn});
  hooks.before.call({skip() {assert.fail("GM must not skip");}});
  const create = store.documentClass.create;
  store.documentClass.create = async (...args) => {
    await create(...args);
    throw new Error("creation observer failed after persistence");
  };
  await assert.rejects(fixtures.createActor(),/creation observer failed/);
  assert.equal(store.actors.size,2);
  await hooks.after();
  assert.deepEqual([...store.actors.keys()],["unrelated"]);
});

test("Quench teardown removes its fixture after an assertion failure and preserves other runs", async t => {
  const store = fixtureStore(t), hooks = {};
  store.add("other-run",{wildpath:{quenchFixture:true,quenchRunId:"other-run"}});
  const fixtures = useQuenchFixtures({beforeEach:fn => hooks.before = fn,afterEach:fn => hooks.after = fn});
  hooks.before.call({skip() {assert.fail("GM must not skip");}});
  await assert.rejects(async () => {
    try {
      await fixtures.createActor();
      assert.equal(store.actors.size,2);
      assert.fail("deliberate mid-test assertion failure");
    } finally {
      await hooks.after(); // Exercise the installed teardown hook after the failed body.
    }
  },/deliberate mid-test assertion failure/);
  assert.deepEqual([...store.actors.keys()],["other-run"]);
});

test("Quench cleanup reports a rejected deletion instead of silently leaving fixtures", async t => {
  const store = fixtureStore(t);
  store.add("retained",{wildpath:{quenchFixture:true,quenchRunId:"failed-run"}});
  store.documentClass.deleteDocuments = async () => [];
  await assert.rejects(cleanupQuenchFixtures({runId:"failed-run"}),/cleanup incomplete for run failed-run/);
  assert.equal(store.actors.size,1);
});

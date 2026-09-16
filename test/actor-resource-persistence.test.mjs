import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real Actor class; no Foundry schema emulation.
globalThis.Actor = class {};
globalThis.foundry = {
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");

function fixture({recovery="shortRest", rejectUpdate=false}={}) {
  const source = {system: {
    resources: {action: {base: 1, bonus: 0, max: 1, value: 1, recovery}},
    pools: [
      {id: "first", label: "Reserve", base: 2, bonus: 0, max: 0, value: 2, recovery: "none"},
      {id: "target", label: "Focus", base: 6, bonus: 1, max: 0, value: 6, recovery},
      {id: "second", label: "Resolve", base: 4, bonus: 0, max: 0, value: 3, recovery}
    ]
  }};
  const calls = [];
  const prepared = () => ({...structuredClone(source.system), pools: source.system.pools.map(pool => ({
    ...pool, max: pool.base + pool.bonus + 2, modifierBonus: 2
  })), getResource(id) {return this.resources[id] ?? this.pools.find(pool => pool.id === id) ?? null;}});
  const actor = Object.assign(Object.create(WildPathActor.prototype), {
    id: "resource-fixture", uuid: "Actor.resource-fixture", effects: [], isOwner: true,
    system: prepared(),
    toObject(sourceOnly) {
      assert.equal(sourceOnly, true, "Resource persistence must request detached source data");
      return structuredClone(source);
    },
    async update(updates) {
      // V14 ArrayFields are replaced as complete leaf values. A permissive dot-path setter
      // would hide the defect. Reject that shape instead of pretending to emulate cleaning.
      assert.ok(!Object.keys(updates).some(path => path.startsWith("system.pools.")),
        "ArrayField element paths are not partial persistence updates");
      calls.push(structuredClone(updates));
      if (rejectUpdate) throw new Error("Persistence rejected");
      for (const [path, value] of Object.entries(updates)) {
        if (path === "system.pools") {
          assert.ok(Array.isArray(value));
          source.system.pools = structuredClone(value);
        } else {
          assert.match(path, /^system\.resources\.[^.]+\.value$/u);
          source.system.resources[path.split(".")[2]].value = value;
        }
      }
      this.system = prepared();
      return this;
    }
  });
  return {actor, source, calls};
}

test("spendResource replaces clean source pools at a nonzero index without changing neighbors or order", async () => {
  const {actor, source, calls} = fixture();
  const before = structuredClone(source.system.pools);
  const preparedBefore = structuredClone(actor.system.pools);
  // Match by ID in source, even if prepared enumeration order ever differs.
  actor.system.pools.unshift(actor.system.pools.pop());
  assert.equal(await actor.spendResource("target", 2), true);
  const expected = [before[0], {...before[1], value: 4}, before[2]];
  assert.deepEqual(calls, [{"system.pools": expected}]);
  assert.deepEqual(source.system.pools, expected);
  assert.equal(actor.getResource("target").value, 4);
  assert.equal(actor.getResource("target").max, 9);
  assert.equal(preparedBefore[1].modifierBonus, 2);
  assert.equal("modifierBonus" in source.system.pools[1], false);
  assert.equal(source.system.pools[1].max, 0, "The prepared maximum must not overwrite source");
});

test("spendResources combines built-in and two custom costs into one coherent Actor update", async () => {
  const {actor, source, calls} = fixture();
  const before = structuredClone(source.system.pools);
  assert.equal(await actor.spendResources({target: 2, action: 1, second: 1}), true);
  const pools = [before[0], {...before[1], value: 4}, {...before[2], value: 2}];
  assert.deepEqual(calls, [{"system.resources.action.value": 0, "system.pools": pools}]);
  assert.deepEqual(source.system.pools, pools);
  assert.equal(source.system.resources.action.value, 0);
});

test("spendResource rejects an unaffordable custom spend before any source or prepared mutation", async () => {
  const {actor, source, calls} = fixture();
  const before = structuredClone(source), preparedBefore = structuredClone(actor.system.pools);
  assert.equal(await actor.spendResource("target", 7), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(source, before);
  assert.deepEqual(actor.system.pools, preparedBefore);
});

test("spendResources rejects an unaffordable custom cost without partially spending other resources", async () => {
  const {actor, source, calls} = fixture();
  const before = structuredClone(source), preparedBefore = structuredClone(actor.system.pools);
  assert.equal(await actor.spendResources({action: 1, target: 2, second: 4}), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(source, before);
  assert.deepEqual(actor.system.pools, preparedBefore);
});

test("custom restores and forced spends retain prepared clamping with clean source replacements", async () => {
  for (const method of ["spendResource", "spendResources"]) {
    const {actor, source, calls} = fixture();
    const spend = (amount, options) => method === "spendResource"
      ? actor.spendResource("target", amount, options) : actor.spendResources({target: amount}, options);
    const before = structuredClone(source.system.pools);
    assert.equal(await spend(-100), true);
    assert.deepEqual(calls[0], {"system.pools": [before[0], {...before[1], value: 9}, before[2]]});
    assert.equal(await spend(100, {force: true}), true);
    assert.deepEqual(calls[1], {"system.pools": [before[0], {...before[1], value: 0}, before[2]]});
  }
});

test("rejected custom persistence leaves source and prepared values unchanged", async () => {
  for (const method of ["spendResource", "spendResources"]) {
    const {actor, source, calls} = fixture({rejectUpdate: true});
    const before = structuredClone(source), preparedBefore = structuredClone(actor.system.pools);
    const operation = method === "spendResource"
      ? () => actor.spendResource("target", 2) : () => actor.spendResources({action: 1, target: 2, second: 1});
    await assert.rejects(operation, /Persistence rejected/u);
    assert.equal(calls.length, 1);
    assert.deepEqual(source, before);
    assert.deepEqual(actor.system.pools, preparedBefore);
    assert.equal(actor.getResource("action").value, 1);
  }
});

test("built-in-only spending retains value paths and never replaces pools", async () => {
  for (const method of ["spendResource", "spendResources"]) {
    const {actor, source, calls} = fixture();
    const before = structuredClone(source.system.pools);
    actor.toObject = () => assert.fail("Built-in spending does not require a pool source snapshot");
    const result = method === "spendResource"
      ? await actor.spendResource("action", 1) : await actor.spendResources({action: 1});
    assert.equal(result, true);
    assert.deepEqual(calls, [{"system.resources.action.value": 0}]);
    assert.deepEqual(source.system.pools, before);
  }
});

for (const recovery of ["shortRest", "longRest"]) {
  test(`rest(${recovery}) replaces only matching pool values using prepared maxima and clean source`, async () => {
    const {actor, source, calls} = fixture({recovery});
    const before = structuredClone(source.system.pools);
    await actor.rest(recovery);
    const pools = [before[0], {...before[1], value: 9}, {...before[2], value: 6}];
    assert.deepEqual(calls, [{"system.resources.action.value": 1, "system.pools": pools}]);
    assert.deepEqual(source.system.pools, pools);
  });
}

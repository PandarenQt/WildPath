import assert from "node:assert/strict";
import test from "node:test";

import {runMigrations, stalePoolIds, threatFix} from "../module/helpers/migrations.mjs";

test("a pool is stale only when nothing names it and it has no base of its own", () => {
  const pools = [
    {id: "spell-slot.1", base: 0}, {id: "hit-die.d8", base: 0}, {id: "heroic-inspiration", base: 0},
    {id: "focus", base: 0}, {id: "wand-charges", base: 0}, {id: "rage", base: 0}, {id: "hand-made", base: 3}, {id: "gone", base: 0}
  ];
  const documents = [
    {system: {active: false, ruleElements: [{type: "GrantResource", data: {id: "wand-charges", maximum: 7}}]}},
    {system: {definition: {costs: [{resourceId: "focus", amount: 1}]}}},
    {effects: [{system: {ruleElements: [{type: "Modifier", data: {domains: ["pools.rage.max"]}}]}}]}
  ];
  assert.deepEqual(stalePoolIds(pools, documents), ["gone"]);
});

test("an NPC converted before fractional Challenge Ratings gets its fraction back", () => {
  const npc = (threat, challenge) => ({type: "npc", system: {details: {threat}}, flags: {wildpath: {source: {challenge}}}});
  assert.equal(threatFix(npc(0, 0.25)), 0.25);
  assert.equal(threatFix(npc(0.25, 0.25)), null);
  assert.equal(threatFix({type: "npc", system: {details: {threat: 3}}}), null, "no converted rating: left as it is");
  assert.equal(threatFix({type: "character", flags: {wildpath: {source: {challenge: 2}}}}), null);
});

function world({version=0, isGM=true, active=true}={}) {
  const settings = {version};
  const user = {isGM};
  const told = [];
  return {
    told,
    settings,
    game: {
      user, users: {activeGM: active ? user : {}},
      settings: {get: () => settings.version, set: async (_scope, _key, value) => { settings.version = value; }},
      i18n: {localize: key => key, format: key => key}
    },
    ui: {notifications: {info: text => told.push(["info", text]), warn: text => told.push(["warn", text])}}
  };
}

test("migrations run once, in order, on the active GM only, and stop at a failure", async () => {
  const ran = [];
  const migrations = [
    {version: 2, name: "two", run: async () => { ran.push(2); }},
    {version: 1, name: "one", run: async () => { ran.push(1); }}
  ];
  const fresh = world();
  assert.equal(await runMigrations({...fresh, migrations}), 2);
  assert.deepEqual(ran, [1, 2]);
  assert.equal(fresh.settings.version, 2);
  assert.equal(await runMigrations({...fresh, migrations}), 2, "nothing left to run");
  assert.deepEqual(ran, [1, 2]);

  assert.equal(await runMigrations({...world({active: false}), migrations}), 0, "another GM is the active one");
  assert.equal(await runMigrations({...world({isGM: false}), migrations}), 0, "a Player never migrates");

  const failing = world({version: 1});
  const logger = console.warn;
  console.warn = () => {};
  try {
    const result = await runMigrations({...failing, migrations: [...migrations,
      {version: 3, name: "three", run: async () => { throw new Error("broken"); }},
      {version: 4, name: "four", run: async () => { ran.push(4); }}]});
    assert.equal(result, 2, "stops at the failure, with what came before recorded");
  } finally {
    console.warn = logger;
  }
  assert.equal(failing.settings.version, 2);
  assert.ok(!ran.includes(4));
  assert.ok(failing.told.some(([kind, text]) => (kind === "warn") && (text === "WILDPATH.MIGRATION.Failed")));
});

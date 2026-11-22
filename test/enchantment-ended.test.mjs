import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real runtime.
globalThis.Actor = class {};
globalThis.ActiveEffect = class {};
const {registerFoundryV14MultiplayerResolution} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");

test("an Item deleted passes each of its effects, with the deletion's options, to the effect.ended dispatch (an enchantment's creator)", async () => {
  const handlers = [];
  const looked = [];
  const game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, socket: {on() {}, emit() {}}, i18n: {localize: key => key}};
  const previous = {Hooks: globalThis.Hooks, fromUuid: globalThis.fromUuid};
  globalThis.Hooks = {callAll() { return false; }, on(name, fn) { if ( name === "deleteItem" ) handlers.push(fn); }};
  // The creator looked up is the sign its Triggers would run; none is found, so nothing further runs.
  globalThis.fromUuid = async uuid => { looked.push(uuid); return null; };
  try {
    assert.equal(registerFoundryV14MultiplayerResolution({game}).ok, true);
  } finally {
    globalThis.Hooks = previous.Hooks;
  }
  try {
    const gem = {id: "gem", documentName: "Item", parent: {documentName: "Actor"}};
    const effect = (id, creatorRef) => ({id, parent: gem, flags: {wildpath: creatorRef ? {enchantment: {key: "vessel", creatorRef}} : {}},
      system: {ruleElements: [{type: "Trigger", data: {event: "effect.ended", action: {id: "action:ended"}}}]}});
    gem.effects = [effect("vessel", "Actor.wizard"), effect("own", null), effect("other", "Actor.cleric")];
    const fire = async options => { for ( const handler of handlers ) handler(gem, options, "gm"); await new Promise(setImmediate); };
    await fire({wildpath: {ended: false}});
    assert.deepEqual(looked, [], "a hand-over is no ending");
    await fire({});
    assert.deepEqual(looked, ["Actor.wizard", "Actor.cleric"], "each enchantment's creator; the Item's own effect names none");
  } finally {
    globalThis.fromUuid = previous.fromUuid;
  }
});

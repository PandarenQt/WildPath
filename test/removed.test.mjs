import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryRemoved, removedFromScene} from "../module/adapters/foundry-v14-removed.mjs";
import {WILDPATH} from "../module/config.mjs";
import {resourceCapsFromRuleElements} from "../module/helpers/rule-elements.mjs";

/** A document whose update applies `flags.wildpath.removed` and plain fields, recording each update. */
const document = fields => ({hidden: false, flags: {}, updates: [], ...fields,
  async update(data, operation) {
    this.updates.push({data, operation});
    for ( const [key, value] of Object.entries(data) ) {
      if ( key === "flags.wildpath.removed" ) this.flags = {wildpath: {removed: value}};
      else this[key] = value;
    }
  }});

/** A square grid of 100-pixel, 5-foot fields; Tokens at the given top-left points; walls as `{c}` move walls. */
function scene(positions, walls=[]) {
  const grid = {
    getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
    getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5})
  };
  const result = {id: "scene", grid, walls: walls.map(c => ({c, move: 20, sight: 20, light: 20, dir: 0, door: 0, ds: 0})),
    dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 2000) && (y < 2000)}}};
  result.tokens = positions.map(([id, x, y]) => document({id, x, y, parent: result,
    getCenterPoint(data={}) { return {x: (data.x ?? this.x) + 50, y: (data.y ?? this.y) + 50}; },
    getOccupiedGridSpaceOffsets(data={}) { return [grid.getOffset({x: (data.x ?? this.x) + 1, y: (data.y ?? this.y) + 1})]; }}));
  return result;
}

/** A prisoner, its mirror and a GM's adapter; `effect(metadata)` is a Trapped effect the mirror gave. */
function fixture({positions=[["prisoner", 500, 500], ["mirror", 900, 500]], walls=[], user="gm", combatant=true}={}) {
  const where = scene(positions, walls);
  const tokenOf = id => where.tokens.find(token => token.id === id);
  const prisoner = {statuses: new Set(), getDependentTokens: () => [tokenOf("prisoner")]};
  const mirror = {documentName: "Actor", uuid: "Actor.mirror", statuses: new Set(),
    getDependentTokens: () => (tokenOf("mirror") ? [tokenOf("mirror")] : [])};
  for ( const token of where.tokens ) token.actor = (token.id === "mirror") ? mirror : (token.id === "prisoner") ? prisoner : {statuses: new Set()};
  const entry = document({tokenId: "prisoner", sceneId: "scene"});
  const game = {user: {id: user}, users: {activeGM: {id: "gm"}}, combats: combatant ? [{combatants: [entry]}] : []};
  const removed = createFoundryRemoved({game, fromUuidSync: uuid => ((uuid === "Actor.mirror") ? mirror : null)});
  const effect = (metadata={}) => ({parent: prisoner, flags: {wildpath: {conditionEffect: {sourceRef: "Actor.mirror", metadata}}}});
  return {where, token: tokenOf("prisoner"), prisoner, entry, removed, effect};
}

test("Trapped is on the plane \"removed\", removes its creature from the scene and takes its action, bonus action and reaction", () => {
  const trapped = WILDPATH.CONDITIONS.trapped;
  assert.deepEqual([trapped.plane, trapped.removes], ["removed", true]);
  const caps = resourceCapsFromRuleElements([{ruleElements: trapped.ruleElements}], {});
  assert.deepEqual([caps.action, caps.bonus, caps.reaction, caps.movement], [0, 0, 0, undefined], "not its movement, nor Incapacitated");
  assert.equal(removedFromScene({statuses: new Set(["trapped"])}), true);
  assert.equal(removedFromScene({statuses: new Set(["ethereal"])}), false, "another plane is not removed from the scene");
  WILDPATH.CONDITIONS.jarred = {id: "jarred", removes: true, ruleElements: []};
  try { assert.equal(removedFromScene({statuses: new Set(["jarred"])}), true, "a homebrew status with the key, no code"); }
  finally { delete WILDPATH.CONDITIONS.jarred; }
});

test("the active GM hides a trapped creature's Token and Combatant, keeping their own hidden, and shows them again when it ends", async () => {
  const {token, prisoner, entry, removed, effect} = fixture();
  prisoner.statuses.add("trapped");
  await removed.onEffectChanged(effect());
  assert.deepEqual([token.hidden, token.flags.wildpath.removed, entry.hidden, entry.flags.wildpath.removed],
    [true, {hidden: false}, true, {hidden: false}]);
  // Again (an update hook): already hidden and marked, nothing more.
  await removed.onEffectChanged(effect());
  assert.equal(token.updates.length, 1);
  prisoner.statuses.delete("trapped");
  await removed.onEffectChanged(effect());
  assert.deepEqual([token.hidden, token.flags.wildpath.removed, entry.hidden, entry.flags.wildpath.removed, token.x, token.y],
    [false, null, false, null, 500, 500], "back where it was, with no returns");
  assert.equal(token.updates.length, 2, "no move");
});

test("an unlinked creature's own Token is hidden; a GM-hidden Token stays hidden after release", async () => {
  const {token, prisoner, removed, effect} = fixture({combatant: false});
  const unlinked = {isToken: true, token, statuses: new Set(["trapped"])};
  token.hidden = true;
  await removed.onEffectChanged({...effect(), parent: unlinked});
  assert.deepEqual([token.hidden, token.flags.wildpath.removed], [true, {hidden: true}]);
  unlinked.statuses.clear();
  await removed.onEffectChanged({...effect(), parent: unlinked});
  assert.deepEqual([token.hidden, token.flags.wildpath.removed], [true, null], "the GM's ambusher stays hidden");
  assert.equal(prisoner.statuses.size, 0);
});

test("two statuses that remove it keep it hidden until the last one ends; a non-GM client does nothing", async () => {
  WILDPATH.CONDITIONS.jarred = {id: "jarred", removes: true, ruleElements: []};
  try {
    const {token, prisoner, removed, effect} = fixture();
    prisoner.statuses = new Set(["trapped", "jarred"]);
    await removed.onEffectChanged(effect());
    prisoner.statuses.delete("trapped");
    await removed.onEffectChanged(effect({returns: "source"}));
    assert.deepEqual([token.hidden, Boolean(token.flags.wildpath.removed), token.x], [true, true, 500]);
    prisoner.statuses.delete("jarred");
    await removed.onEffectChanged(effect());
    assert.equal(token.hidden, false);
  } finally { delete WILDPATH.CONDITIONS.jarred; }
  const player = fixture({user: "player"});
  player.prisoner.statuses.add("trapped");
  await player.removed.onEffectChanged(player.effect());
  assert.deepEqual([player.token.hidden, player.token.updates.length, player.entry.updates.length], [false, 0, 0]);
});

test("returns: \"source\" brings it back beside its giver as a Blink, on the giver's side of a wall, while still marked", async () => {
  // The mirror hangs on a wall at x = 1000 (its field 900-1000); the prisoner was caught east of it, where the fields
  // beside the mirror nearest it are behind the wall.
  const {token, prisoner, removed, effect} = fixture({positions: [["prisoner", 1300, 500], ["mirror", 900, 500]],
    walls: [[1000, 0, 1000, 2000]]});
  prisoner.statuses.add("trapped");
  await removed.onEffectChanged(effect());
  prisoner.statuses.delete("trapped");
  await removed.onEffectChanged(effect({returns: "source"}));
  const move = token.updates.find(entry => entry.operation?.movement);
  assert.deepEqual([move.data.x, move.data.y], [900, 400], "the free field beside the mirror nearest it, not behind the wall");
  assert.equal(move.operation.movement.prisoner.waypoints[0].action, "blink");
  assert.equal(token.updates.indexOf(move), 1, "moved before it is shown and unmarked");
  assert.deepEqual([token.hidden, token.flags.wildpath.removed], [false, null]);
  // Every field west of the wall beside the mirror taken: it stays where it was.
  const full = fixture({positions: [["prisoner", 200, 200], ["mirror", 900, 500], ["a", 800, 400], ["b", 800, 500], ["c", 800, 600],
    ["d", 900, 400], ["e", 900, 600]], walls: [[1000, 0, 1000, 2000]]});
  full.prisoner.statuses.add("trapped");
  await full.removed.onEffectChanged(full.effect());
  full.prisoner.statuses.delete("trapped");
  await full.removed.onEffectChanged(full.effect({returns: "source"}));
  assert.deepEqual([full.token.x, full.token.y, full.token.hidden], [200, 200, false]);
});

test("with no giver's Token on its Scene it stays where it was; another creature standing there now puts it beside that spot", async () => {
  const {token, prisoner, removed, effect} = fixture({positions: [["prisoner", 500, 500]]});
  prisoner.statuses.add("trapped");
  await removed.onEffectChanged(effect());
  prisoner.statuses.delete("trapped");
  await removed.onEffectChanged(effect({returns: "source"}));
  assert.deepEqual([token.x, token.y, token.updates.some(entry => entry.operation?.movement)], [500, 500, false]);
  const taken = fixture({positions: [["prisoner", 500, 500], ["ogre", 500, 500]]});
  taken.prisoner.statuses.add("trapped");
  await taken.removed.onEffectChanged(taken.effect());
  taken.prisoner.statuses.delete("trapped");
  await taken.removed.onEffectChanged(taken.effect());
  const move = taken.token.updates.find(entry => entry.operation?.movement);
  assert.ok(move, "moved off the ogre");
  assert.notDeepEqual([move.data.x, move.data.y], [500, 500]);
  assert.ok((Math.abs(move.data.x - 500) <= 100) && (Math.abs(move.data.y - 500) <= 100), "to a field beside its spot");
});

test("effect changes Foundry's hooks start at once settle one after another: a creature freed by two of them is placed once", async () => {
  const {token, prisoner, removed, effect} = fixture({positions: [["prisoner", 500, 500], ["mirror", 900, 500]]});
  prisoner.statuses.add("trapped");
  await removed.onEffectChanged(effect());
  // A server trip before the update lands, as a Token's own update has.
  const update = token.update;
  token.update = async function(...args) { await new Promise(resolve => setTimeout(resolve)); return update.apply(this, args); };
  prisoner.statuses.delete("trapped");
  await Promise.all([removed.onEffectChanged(effect({returns: "source"})), removed.onEffectChanged(effect({returns: "source"}))]);
  assert.equal(token.updates.filter(entry => entry.operation?.movement).length, 1, "one Blink, not one per hook");
  assert.deepEqual([token.hidden, token.flags.wildpath.removed], [false, null]);
});

test("an unrelated effect's change queued as Trapped ends does not release it by its own row: the Trapped hook brings it back beside its source", async () => {
  const {where, token, prisoner, removed, effect} = fixture({positions: [["prisoner", 500, 500], ["mirror", 900, 500]], combatant: false});
  prisoner.statuses.add("trapped");
  await removed.onEffectChanged(effect());
  // Its other effect's hook fires while it is still trapped; its Trapped ends before that settles.
  const other = removed.onEffectChanged({parent: prisoner, flags: {}});
  prisoner.statuses.delete("trapped");
  await Promise.all([other, removed.onEffectChanged(effect({returns: "source"}))]);
  const mirror = where.tokens.find(entry => entry.id === "mirror");
  assert.ok(Math.max(Math.abs(token.x - mirror.x), Math.abs(token.y - mirror.y)) <= 100, `beside the mirror, not at (${token.x}, ${token.y})`);
  assert.deepEqual([token.hidden, token.flags.wildpath.removed], [false, null]);
});

test("one change failing to settle does not stop the next: a rejected update leaves later effect changes working", async () => {
  const {token, prisoner, removed, effect} = fixture({combatant: false});
  const update = token.update;
  token.update = async () => { token.update = update; throw new Error("Token deleted mid-release"); };
  prisoner.statuses.add("trapped");
  await assert.rejects(removed.onEffectChanged(effect()), /Token deleted/);
  await removed.onEffectChanged(effect());
  assert.deepEqual([token.hidden, token.flags.wildpath.removed], [true, {hidden: false}], "hidden on the next change");
});

test("a Combatant added while its Token was hidden as Trapped gets the Token's own hidden back on release", async () => {
  const {token, prisoner, effect} = fixture({combatant: false});
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: []};
  const own = createFoundryRemoved({game, fromUuidSync: () => null});
  prisoner.statuses.add("trapped");
  await own.onEffectChanged(effect());
  // Foundry's createCombatants copies the Token's hidden onto the new Combatant, with no marker.
  const entry = document({tokenId: "prisoner", sceneId: "scene", hidden: token.hidden});
  game.combats.push({combatants: [entry]});
  await own.onEffectChanged(effect());
  prisoner.statuses.delete("trapped");
  await own.onEffectChanged(effect());
  assert.deepEqual([token.hidden, entry.hidden, entry.flags.wildpath?.removed ?? null], [false, false, null]);
});

test("two removed creatures are each on a plane of their own: neither reaches the other, nor the world", async () => {
  const {planeOf} = await import("../module/adapters/foundry-v14-creature-tokens.mjs");
  const a = {uuid: "Actor.a", statuses: new Set(["trapped"])};
  const b = {uuid: "Actor.b", statuses: new Set(["trapped"])};
  assert.notEqual(planeOf(a), planeOf(b));
  assert.notEqual(planeOf(a), planeOf({statuses: new Set()}));
  assert.equal(planeOf(a), planeOf({uuid: "Actor.a", statuses: new Set(["ethereal", "trapped"])}), "removed wins over another plane");
});

test("a Trapped creature is offered no reaction (its cap leaves no Reaction to pay)", async () => {
  const {AUTOMATION_CODES, AUTOMATION_EVENT_TYPES, AUTOMATION_EVENT_PHASES, collectReactionWindows, createAutomationEvent,
    createReactionTrigger} = await import("../module/helpers/automation-events.mjs");
  const {economyResourcesFromActorResources} = await import("../module/helpers/action-economy.mjs");
  const event = createAutomationEvent({type: AUTOMATION_EVENT_TYPES.ATTACK_HIT, phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "orc"}, targets: [{actorId: "fighter"}]});
  const trigger = createReactionTrigger({id: "opportunity", event: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    match: {phase: AUTOMATION_EVENT_PHASES.INTERRUPT}, actorId: "fighter"});
  // As the actor's data preparation applies its caps: the maximum capped, the value clamped to it.
  const offered = statuses => {
    const cap = resourceCapsFromRuleElements(statuses.map(id => ({ruleElements: WILDPATH.CONDITIONS[id].ruleElements})), {}).reaction ?? Infinity;
    const max = Math.min(1, cap);
    return collectReactionWindows({triggers: [trigger], event,
      resourcesByActor: {fighter: economyResourcesFromActorResources({resources: {reaction: {value: Math.min(1, max), max}}})}});
  };
  assert.equal(offered([]).windows.length, 1);
  const trapped = offered(["trapped"]);
  assert.deepEqual([trapped.windows.length, trapped.rejected[0]?.code], [0, AUTOMATION_CODES.REACTION_UNAVAILABLE]);
});

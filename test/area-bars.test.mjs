import {test} from "node:test";
import assert from "node:assert/strict";
import {areaBarPolicy, areaBarsLanding, barredCrossing, createFoundryPersistentAreas, persistentAreaRegionData, pressedAreas}
  from "../module/adapters/foundry-v14-persistent-areas.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {evaluateMovementPath} from "../module/helpers/movement-paths.mjs";
import {movementMessage} from "../module/helpers/refusal-messages.mjs";

const UNDEAD = {oneOf: {path: "actor.system.details.type", values: ["undead"]}};

/**
 * A 100-px, 5-ft square Scene with one lasting area over squares 3 and 4 of row 0 (or an emanation around the caster), a
 * caster at square 8 and a mover at square 0. `bars` and the rest are the area's persistence; `area` its other flag keys.
 */
function world({bars={}, affects=null, area={}, mover={}, caster={}}={}) {
  const tokens = Object.assign([], {get(id) { return this.find(token => token.id === id); }});
  const scene = {id: "scene", grid: {type: 1, size: 100, distance: 5}, dimensions: {size: 100, distance: 5}, tokens, regions: []};
  const token = (id, x, {disposition=1, type="humanoid", statuses=[], elevation=0}={}) => ({id, uuid: `Token.${id}`, x: x * 100, y: 0,
    width: 1, height: 1, depth: 1, elevation, disposition, parent: scene,
    actor: {uuid: `Actor.${id}`, statuses: new Set(statuses), system: {traits: {size: "medium"}, details: {type}}}});
  tokens.push(token("caster", 8, caster), token("mover", 0, {disposition: -1, ...mover}));
  const flag = {schemaVersion: 1, label: "Ward", topology: "square", fields: [{x: 3, y: 0}, {x: 4, y: 0}], shape: "radial", size: 5,
    attached: false, band: {bottom: null, top: null}, sourceTokenId: "caster", sourceActorRef: "Actor.caster",
    persistence: {oncePerTurn: true, concentration: false, duration: null, triggers: [], ...(affects ? {affects} : {}),
      ...(bars ? {bars} : {})}, ...area};
  scene.regions.push({id: "ward", flags: {wildpath: {area: flag}}});
  return {scene, flag, mover: tokens[1], caster: tokens[0]};
}

/** A voluntary walk along row 0 through the squares `xs`, judged by `policy`: whether it is allowed, and its first refusal. */
function walk(policy, xs) {
  const result = evaluateMovementPath({anchors: xs.map(x => ({x, y: 0}))}, {gridDistance: 5, transitionPolicy: policy});
  return {ok: result.valid, code: result.failures[0]?.code ?? null, reason: result.failures[0]?.reason ?? null};
}

test("a lasting area's bars are validated: who a predicate, moves voluntary, forced or teleport, way in, out or both; an emanation may bar", () => {
  const reasons = (bars, shape="radial") => {
    const result = validateActionDefinition({schemaVersion: 1, id: "action:ward", label: "Ward", costs: {allOf: []},
      targeting: {type: "area"}, area: {shape, size: {value: 10, unit: "ft"}, persistence: {bars}}});
    return (result.errors ?? []).map(entry => entry.path);
  };
  assert.deepEqual(reasons({}), [], "every creature, walking in");
  assert.deepEqual(reasons({who: UNDEAD, moves: ["voluntary"], way: "both"}), []);
  assert.deepEqual(reasons({moves: ["voluntary", "forced", "teleport"]}), []);
  assert.deepEqual(reasons({way: "out"}, "emanation"), [], "an emanation may bar, unlike blocks");
  assert.deepEqual(reasons({who: {oneOf: "undead"}}), ["area.persistence.bars.who"], "a malformed predicate");
  assert.deepEqual([reasons({moves: []}), reasons({moves: ["fly"]}), reasons({moves: "voluntary"})],
    [["area.persistence.bars.moves"], ["area.persistence.bars.moves"], ["area.persistence.bars.moves"]]);
  assert.deepEqual(reasons({way: "up"}), ["area.persistence.bars.way"]);
  assert.deepEqual(reasons(["voluntary"]), ["area.persistence.bars"], "an object");
});

test("a lasting area's Region flag keeps its bars; one without has none", () => {
  const sourceToken = {id: "caster", actor: {uuid: "Actor.caster"}, parent: {grid: {size: 100, distance: 5}}};
  const placement = bars => ({footprint: {topology: "square", fields: []}, definition: {id: "action:ward", label: "Ward",
    area: {shape: "radial", size: {value: 10}, persistence: {...(bars ? {bars} : {})}}}});
  const bars = {who: UNDEAD, way: "both"};
  const data = persistentAreaRegionData({placement: placement(bars), sourceToken, combat: null});
  assert.deepEqual(data.flags.wildpath.area.persistence.bars, bars);
  assert.notEqual(data.flags.wildpath.area.persistence.bars, bars, "a copy, not the definition's own object");
  assert.equal("bars" in persistentAreaRegionData({placement: placement(null), sourceToken, combat: null}).flags.wildpath.area.persistence,
    false, "an older or bar-free area bars nothing");
});

test("a barred creature can't willingly step into the area; within it, beside it and unbarred creatures move freely", () => {
  const refused = walk(areaBarPolicy(world().mover), [0, 1, 2, 3]);
  assert.deepEqual([refused.ok, refused.code, refused.reason], [false, "AREA_BARRED", "Ward bars it from entering."]);
  assert.equal(movementMessage(refused, {i18n: {localize: key => `loc:${key}`}}), "loc:WILDPATH.REFUSAL.AreaBarred",
    "the player is told in words");
  assert.equal(walk(areaBarPolicy(world().mover), [0, 1, 2]).ok, true, "up to its edge");
  assert.equal(walk(areaBarPolicy(world().mover), [3, 4]).ok, true, "a step within it (already inside)");
  assert.equal(walk(areaBarPolicy(world().mover), [4, 5]).ok, true, "and out of it, by default");
  assert.equal(walk(areaBarPolicy(world({bars: {who: UNDEAD}}).mover), [0, 1, 2, 3]).ok, true, "who leaves a goblin out");
  assert.equal(walk(areaBarPolicy(world({bars: {who: UNDEAD}, mover: {type: "undead"}}).mover), [2, 3]).ok, false, "and holds a skeleton");
  assert.equal(walk(areaBarPolicy(world({affects: "enemies", mover: {disposition: 1}}).mover), [2, 3]).ok, true,
    "a creature its affects spares (the caster's ally)");
  assert.equal(walk(areaBarPolicy(world({affects: "enemies"}).mover), [2, 3]).ok, false, "but not a foe");
  assert.equal(walk(areaBarPolicy(world({mover: {statuses: ["ethereal"]}}).mover), [2, 3]).ok, true, "one on another plane");
  assert.equal(walk(areaBarPolicy(world({area: {pending: true}}).mover), [2, 3]).ok, true, "an opening not yet confirmed");
  assert.equal(areaBarPolicy(world({bars: null}).mover), null, "no area on the Scene bars");
});

test("a creature its rules leave untouched by the area's Action (Antimagic Field's Unaffected by spells) is not barred", () => {
  const spellProof = actor => { actor.unaffectingRule = definition => (definition.tags.includes("spell") ? {id: "antimagic"} : null); };
  const {mover} = world({area: {tags: ["spell", "spell:leveled"]}});
  spellProof(mover.actor);
  assert.equal(walk(areaBarPolicy(mover), [2, 3]).ok, true, "a spell's ward lets it by");
  const plain = world({area: {tags: ["fortification"]}}).mover;
  spellProof(plain.actor);
  assert.equal(walk(areaBarPolicy(plain), [2, 3]).ok, false, "a ward that is no spell still bars it");
  const {caster} = world({bars: {way: "out"}, area: {tags: ["spell"]}});
  spellProof(caster.actor);
  caster.x = 300;
  assert.equal(walk(areaBarPolicy(caster), [3, 2]).ok, false, "its caster's own rules are excepted, as for its triggers");
  const sourceToken = {id: "caster", actor: {uuid: "Actor.caster"}, parent: {grid: {size: 100, distance: 5}}};
  const flag = bars => persistentAreaRegionData({sourceToken, combat: null, placement: {footprint: {topology: "square", fields: []},
    definition: {id: "action:ward", label: "Ward", tags: ["spell"], metadata: {spellLevel: 2},
      area: {shape: "radial", size: {value: 10}, persistence: {...(bars ? {bars} : {})}}}}}).flags.wildpath.area;
  assert.deepEqual(flag({}).tags, ["spell", "spell:leveled", "id:action:ward"], "the flag keeps the tags Unaffected tests");
  assert.equal("tags" in flag(null), false, "only an area that bars");
});

test("way out keeps a barred creature in, way both either way; forced moves are not voluntary", () => {
  const out = world({bars: {way: "out"}}).mover;
  assert.equal(walk(areaBarPolicy(out), [2, 3]).ok, true, "in");
  assert.deepEqual(walk(areaBarPolicy(out), [4, 5]).reason, "Ward bars it from leaving.");
  assert.equal(movementMessage({reason: "Ward bars it from leaving."}, {i18n: {localize: key => key}}), "WILDPATH.REFUSAL.AreaBarredOut");
  const both = world({bars: {way: "both"}}).mover;
  assert.deepEqual([walk(areaBarPolicy(both), [2, 3]).ok, walk(areaBarPolicy(both), [4, 5]).ok, walk(areaBarPolicy(both), [3, 4]).ok],
    [false, false, true]);
  const {flag, mover} = world();
  const step = {from: [{x: 2, y: 0}], to: [{x: 3, y: 0}], feet: [0, 0]};
  assert.deepEqual([barredCrossing(flag, mover, step, "voluntary"), barredCrossing(flag, mover, step, "forced")], ["in", null]);
});

test("areaBarsLanding: a teleport's landing across the edge of an area barring teleports, judged from where the creature stands", () => {
  const into = {x: 300, y: 0};
  assert.deepEqual(areaBarsLanding(world({bars: {moves: ["teleport"]}}).mover, into, "teleport"), {label: "Ward", way: "in"});
  assert.equal(areaBarsLanding(world().mover, into, "teleport"), null, "an area barring voluntary moves only");
  assert.equal(areaBarsLanding(world({bars: {moves: ["teleport"]}}).mover, into, "forced"), null, "another kind of move");
  const inside = world({bars: {moves: ["teleport"], way: "both"}}).mover;
  inside.x = 300;
  assert.equal(areaBarsLanding(inside, {x: 400, y: 0}, "teleport"), null, "inside to inside");
  assert.deepEqual(areaBarsLanding(inside, {x: 700, y: 0}, "teleport"), {label: "Ward", way: "out"}, "out, with way both");
  assert.equal(areaBarsLanding(inside, {x: 700, y: 0}, "teleport", {from: {x: 600, y: 0}}), null, "from outside it (a step's own start)");
  const banded = world({bars: {moves: ["teleport"]}, area: {band: {bottom: 0, top: 10}}}).mover;
  assert.equal(areaBarsLanding(banded, {...into, elevation: 30}, "teleport"), null, "above its band");
  assert.equal(areaBarsLanding(world({bars: null}).mover, into, "teleport"), null, "no area on the Scene bars");
});

test("an area's band bars only a creature at its height; the destination's elevation counts on the last step", () => {
  const {mover} = world({area: {band: {bottom: 0, top: 10}}});
  assert.equal(walk(areaBarPolicy(mover), [2, 3]).ok, false, "on the ground");
  assert.equal(walk(areaBarPolicy(mover, {elevation: 30}), [2, 3]).ok, true, "flying in above it");
  mover.elevation = 30;
  assert.equal(walk(areaBarPolicy(mover), [2, 3]).ok, true, "a flier over it");
  assert.equal(walk(areaBarPolicy(mover, {elevation: 0}), [1, 2, 3]).ok, false, "landing in it");
});

test("an emanation's bars move with its caster, which never crosses its own edge", () => {
  const {mover, caster} = world({area: {attached: true, fields: [], shape: "emanation", size: 5}});
  caster.x = 300;
  assert.equal(walk(areaBarPolicy(mover), [0, 1, 2]).ok, false, "the square beside the caster is in it");
  assert.equal(walk(areaBarPolicy(caster), [3, 4, 5]).ok, true, "its caster carries it");
});

test("bars pressed is \"ends\", only on an area that surrounds a creature or object", () => {
  const reasons = (bars, shape="emanation", persistence={}) => (validateActionDefinition({schemaVersion: 1, id: "action:shell",
    label: "Shell", costs: {allOf: []}, targeting: {type: "area"}, area: {shape, size: {value: 10, unit: "ft"},
      persistence: {bars, ...persistence}}}).errors ?? []).map(entry => entry.path);
  assert.deepEqual(reasons({way: "both", pressed: "ends"}), [], "an emanation");
  assert.deepEqual(reasons({pressed: "ends"}, "radial", {onObject: "object"}), [], "an area cast on an object");
  assert.deepEqual(reasons({pressed: "breaks"}), ["area.persistence.bars.pressed"]);
  assert.deepEqual(reasons({pressed: "ends"}, "radial"), ["area.persistence.bars.pressed"], "a placed area moves with no one");
});

/** The world's ward as a `size`-ft emanation pressed: "ends" around the caster at square `at`, the goblin (mover) at square 0. */
function shell({bars={}, at=2, size=5, ...rest}={}) {
  const made = world({bars: {pressed: "ends", ...bars}, area: {attached: true, fields: [], shape: "emanation", size}, ...rest});
  made.caster.x = at * 100;
  const step = to => ({previous: {x: made.caster.x, y: 0}, position: {x: to * 100, y: 0}});
  return {...made, pressed: to => pressedAreas(made.caster, step(to)).map(region => region.id)};
}

test("pressedAreas: the caster's step that carries its pressed emanation's edge across a creature it bars", () => {
  assert.deepEqual(shell().pressed(1), ["ward"], "the edge comes over the goblin: it would be inside");
  assert.deepEqual(shell().pressed(3), [], "a step away from it");
  assert.deepEqual(shell({bars: {pressed: null}}).pressed(1), [], "without pressed the edge just passes over");
  assert.deepEqual(shell({bars: {who: UNDEAD}}).pressed(1), [], "a creature who leaves out (a goblin, not undead)");
  assert.deepEqual(shell({bars: {who: UNDEAD}, mover: {type: "undead"}}).pressed(1), ["ward"], "and one it holds");
  assert.deepEqual(shell({affects: "enemies", mover: {disposition: 1}}).pressed(1), [], "an ally its affects spares");
  assert.deepEqual(shell({bars: {moves: ["teleport"]}}).pressed(1), ["ward"], "its moves aside: the creature does not move");
  const removed = shell();
  removed.mover.flags = {wildpath: {removed: {hidden: false}}};
  assert.deepEqual(removed.pressed(1), [], "a creature removed from the scene");
  assert.deepEqual(shell({mover: {statuses: ["dead"]}}).pressed(1), [], "a dead creature is an object");
  const actorless = shell();
  actorless.mover.actor = null;
  assert.deepEqual(actorless.pressed(1), [], "and so is a Token with no actor");
  const other = shell();
  assert.deepEqual(pressedAreas(other.mover, {previous: {x: 0, y: 0}, position: {x: 100, y: 0}}), [],
    "only its anchor's move presses it (the goblin's own walk is barredCrossing's)");
});

test("pressedAreas: a barred creature already inside is pressed out only where the way bars leaving", () => {
  const inside = options => {
    const made = shell({at: 1, ...options});
    return made.pressed(3);
  };
  assert.deepEqual(inside(), [], "way in: the caster may walk away from a creature already inside");
  assert.deepEqual(inside({bars: {way: "out"}}), ["ward"], "way out keeps it in, so leaving it outside presses");
  assert.deepEqual(inside({bars: {way: "both"}}), ["ward"], "and way both (Antilife Shell)");
  assert.deepEqual(shell({at: 2, size: 10, bars: {way: "both"}}).pressed(1), [], "a step that keeps it inside");
});

test("a pressed area checkpoints its Scene's moves, and pressing it ends it with a GM notice", async () => {
  const warned = [];
  const areas = createFoundryPersistentAreas({game: {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}},
    i18n: {format: (key, data) => `${key}:${data.name}`}}, coordinator: {}, resolveAction: async () => ({ok: true}),
  logger: {warn: text => warned.push(text)}});
  assert.equal(areas.hasCrossingAreas(shell().scene), true, "the anchor's drag is stepped");
  assert.equal(areas.hasCrossingAreas(shell({bars: {pressed: null}}).scene), false, "bars alone answer no step");
  assert.equal(areas.hasCrossingAreas(shell({area: {attached: false, fields: [], shape: "radial", size: 5}}).scene), false,
    "an area cast without its object is placed: nothing carries it, so nothing presses");
  const {scene} = shell();
  const [region] = scene.regions;
  let deleted = 0;
  region.delete = async () => { deleted += 1; };
  await areas.press(region);
  assert.equal(deleted, 1, "its Region ends");
  assert.deepEqual(warned, ["Wild Path | WILDPATH.NOTICE.AreaPressed:Ward"]);
});

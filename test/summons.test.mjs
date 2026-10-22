import {test} from "node:test";
import assert from "node:assert/strict";
import {summonBonusesAt, summonExpired, summonPlacements} from "../module/adapters/foundry-v14-summons.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

// A square grid's eight neighbours.
const square = ({i, j}) => [-1, 0, 1].flatMap(di => [-1, 0, 1].map(dj => ({i: i + di, j: j + dj})))
  .filter(offset => (offset.i !== i) || (offset.j !== j));

test("summons go on the nearest free fields around the caster, skipping occupied ones", () => {
  const placed = summonPlacements({start: {i: 5, j: 5}, count: 3, occupied: new Set(["4,4", "4,5", "5,5"]), adjacent: square});
  assert.equal(placed.length, 3);
  for ( const offset of placed ) {
    assert.ok(Math.max(Math.abs(offset.i - 5), Math.abs(offset.j - 5)) === 1, "next to the caster");
    assert.ok(!["4,4", "4,5", "5,5"].includes(`${offset.i},${offset.j}`), "never on a creature");
  }
  const ring = new Set(square({i: 5, j: 5}).map(offset => `${offset.i},${offset.j}`));
  const crowded = summonPlacements({start: {i: 5, j: 5}, count: 2, occupied: new Set([...ring, "5,5"]), adjacent: square});
  assert.ok(crowded.every(offset => Math.max(Math.abs(offset.i - 5), Math.abs(offset.j - 5)) === 2), "the next ring when it is full");
});

test("a summon with rounds leaves at the turn it arrived on, that many rounds later, in its own combat only", () => {
  const flag = {rounds: 2, createdAt: {combatId: "c", round: 1, turn: 3}};
  assert.equal(summonExpired(flag, {id: "c", round: 3, turn: 2}), false);
  assert.equal(summonExpired(flag, {id: "c", round: 3, turn: 3}), true);
  assert.equal(summonExpired(flag, {id: "other", round: 9, turn: 0}), false);
  assert.equal(summonExpired({rounds: null, createdAt: flag.createdAt}, {id: "c", round: 9, turn: 0}), false, "no rounds: it stays");
});

test("a summon names exactly one creature source and a count from 1 to 20", () => {
  const definition = summon => ({schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon});
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", count: 3, rounds: 10, concentration: true})).ok, true);
  assert.equal(validateActionDefinition(definition({choiceId: "beast"})).ok, true);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", choiceId: "beast"})).ok, false);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", count: 0})).ok, false);
});

test("summons join a combat right after their caster, and leave it with their Tokens", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const calls = [];
  const combatants = [{id: "cc", tokenId: "caster", sceneId: "s", initiative: 12}];
  const combat = {id: "c", round: 1, turn: 0, combatants,
    createEmbeddedDocuments: async (type, data) => { calls.push(["create", type, data]); combatants.push(...data.map((entry, i) => ({id: `w${i}`, ...entry}))); },
    deleteEmbeddedDocuments: async (type, ids) => calls.push(["delete", type, ids])};
  const tokens = new Map();
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: () => ({i: 0, j: 0}), getAdjacentOffsets: square, getTopLeftPoint: ({i, j}) => ({x: i * 100, y: j * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `t${i}`, actorId: "wolf", parent: scene}; tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async (type, ids) => { calls.push(["delete", type, ids]); for ( const id of ids ) tokens.delete(id); }};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  const wolf = {uuid: "Actor.wolf", getTokenDocument: async data => ({toObject: () => ({...data})})};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combat, scenes: [scene]},
    companions: {setControllers: async () => {}}, fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.wolf": wolf})[uuid] ?? null});
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 2, rounds: 1}}}});
  const joined = calls.find(call => call[0] === "create")[2];
  assert.deepEqual(joined.map(entry => [entry.tokenId, entry.initiative]), [["t0", 11.999], ["t1", 11.998]]);
  await summons.onTurnStart({id: "c", round: 2, turn: 0});
  assert.deepEqual(calls.filter(call => call[0] === "delete").map(call => call.slice(1)),
    [["Combatant", ["w0", "w1"]], ["Token", ["t0", "t1"]]], "combatants go before their Tokens");
});

test("a Large summon needs its whole footprint free, summons never overlap each other, and an unseen place is skipped", () => {
  const large = ({i, j}) => [{i, j}, {i: i + 1, j}, {i, j: j + 1}, {i: i + 1, j: j + 1}];
  const placed = summonPlacements({start: {i: 5, j: 5}, count: 2, occupied: new Set(["5,5"]), adjacent: square, footprint: large});
  const cells = placed.flatMap(offset => large(offset).map(cell => `${cell.i},${cell.j}`));
  assert.equal(placed.length, 2);
  assert.equal(new Set(cells).size, 8, "the two 2×2 summons share no field");
  assert.equal(cells.includes("5,5"), false, "neither covers the caster");
  const behindWall = summonPlacements({start: {i: 5, j: 5}, count: 3, occupied: new Set(["5,5"]), adjacent: square,
    allowed: ({j}) => j <= 5});
  assert.ok(behindWall.every(({j}) => j <= 5), "the caster cannot see past the wall at column 6");
});

test("a clicked point is where a summon appears; the rest go near the caster; the intent carries at most 20 points", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const {sanitizeActionIntentPayload} = await import("../module/helpers/multiplayer-authority.mjs");
  const tokens = new Map();
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0)}},
    grid: {getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}), getAdjacentOffsets: square,
      getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `t${i}`, parent: scene};
      tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async () => {}};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  const wolf = {uuid: "Actor.wolf", getTokenDocument: async data => ({toObject: () => ({...data})})};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene]},
    companions: {setControllers: async () => {}}, fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.wolf": wolf})[uuid] ?? null});
  const placed = await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}, summonPoints: [{x: 950, y: 350}]},
    state: {source: {tokenRef: "Scene.s.Token.caster"}, actionDefinition: {summon: {actorRef: "Actor.wolf", count: 2}}}});
  assert.deepEqual(placed.map(token => [token.x, token.y]), [[900, 300], [100, 0]],
    "the clicked field, then the first field beside the caster that is on the Scene");

  const points = Array.from({length: 25}, (_, i) => ({x: i, y: i}));
  const sanitized = sanitizeActionIntentPayload({intent: {actorRef: "Actor.a", summon: {points: [...points, {x: "nope"}], extra: 1}}});
  assert.equal(sanitized.summon.points.length, 20);
  assert.deepEqual(Object.keys(sanitized.summon), ["points"]);
});

test("what a summon gains with the spell's level: Hit Points, AC, and its attack and save damage as rules", () => {
  const level = {type: "context", path: "castLevel"};
  const at5 = summonBonusesAt({hp: {type: "multiply", terms: [{type: "constant", value: 10}, {type: "subtract", terms: [level, {type: "constant", value: 4}]}]},
    ac: level, attackDamage: level, saveDamage: {type: "dice", number: {type: "subtract", terms: [level, {type: "constant", value: 3}]}, faces: 10}}, 5);
  assert.deepEqual([at5.hp, at5.ac], [10, 5], "10 * (5 - 4) Hit Points, AC + 5");
  assert.deepEqual(at5.rules.map(rule => [rule.type, rule.predicate, rule.data.value ?? rule.data.expression]), [
    ["Modifier", {tagsAny: ["melee", "ranged"]}, 5],
    ["ExtraDamage", {not: {tagsAny: ["melee", "ranged"]}}, {type: "dice", number: 2, faces: 10}]], "+5 on its attacks, 2d10 on its other damage");
  assert.deepEqual(summonBonusesAt({}, 5), {hp: 0, ac: 0, rules: []});
  // Conjure Fey at 7th: its caster's spellcasting modifier (from the caster, not the spirit) plus 1d12 per level above 6th.
  const caster = {actorSystem: {abilities: {intellect: {value: 18}}, spellcasting: {ability: "intellect"}}};
  const fey = summonBonusesAt({attackDamage: {type: "add", terms: [{type: "constant", value: 4},
    {type: "dice", number: {type: "subtract", left: level, right: {type: "constant", value: 6}}, faces: 12}]}}, 7, caster);
  assert.deepEqual(fey.rules.map(rule => [rule.type, rule.data.value ?? rule.data.expression]),
    [["Modifier", 4], ["ExtraDamage", {type: "dice", number: 1, faces: 12}]]);
});

test("a summon's count from its creature's own formula, at the cast level (Animate Dead), or none below 1", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const tokens = new Map();
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0)}},
    grid: {getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}), getAdjacentOffsets: square,
      getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `t${tokens.size}-${i}`, parent: scene};
      tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async () => {}};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  const skeleton = {uuid: "Actor.skeleton", getTokenDocument: async data => ({toObject: () => ({...data})})};
  const warnings = [];
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene]}, logger: {warn: message => warnings.push(message)},
    companions: {setControllers: async () => {}}, fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.skeleton": skeleton})[uuid] ?? null});
  const animateDead = {type: "add", terms: [{type: "constant", value: 1}, {type: "multiply", terms: [{type: "subtract",
    left: {type: "context", path: "castLevel"}, right: {type: "constant", value: 3}}, {type: "constant", value: 2}]}]};
  const cast = (castLevel, count) => summons.afterResolution({options: {actor: {uuid: "Actor.caster", system: {}}},
    state: {source: {tokenRef: "Scene.s.Token.caster"}, configuration: {castingLevel: castLevel},
      actionDefinition: {label: "Animate Dead", summon: {actorRef: "Actor.skeleton", count: 1, counts: [{actorRef: "Actor.skeleton", count}]}}}});
  assert.equal((await cast(5, animateDead)).length, 5, "1 + 2 per slot level above 3rd");
  assert.equal((await cast(3, {type: "constant", value: 0})).length, 0, "none below 1");
  assert.equal(warnings.length, 1);
  assert.equal((await cast(1, 4)).length, 4, "a plain number (Dancing Lights' four lights)");
});

test("an artificer's summon: its bonuses from its summoner, its attacks its summoner's, its creature by level", async () => {
  const {summonBonusesAt, matchedAttack} = await import("../module/adapters/foundry-v14-summons.mjs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const artificer = level => ({system: {abilities: {intellect: {value: 16}}, classes: [{id: "artificer", name: "artificer", level}],
    details: {level}, spellcasting: {ability: "intellect"}}});
  const hp = {type: "add", terms: [{type: "ability-modifier", ability: "intellect"}, {type: "multiply", terms: [{type: "constant", value: 5},
    {type: "class-level", class: "artificer"}]}]};
  const caster = artificer(5);
  assert.equal(summonBonusesAt({hp}, 0, {actor: caster, actorSystem: caster.system}).hp, 28, "Intelligence +3 and 5 per artificer level");
  const defender = {system: {details: {level: 1}}};
  assert.ok(matchedAttack(caster, defender).length <= 1);
  const definition = {schemaVersion: 1, id: "action:steel", label: "Steel Defender", costs: {allOf: []}, targeting: {type: "self"},
    summon: {choiceId: "summon-creature", count: 1},
    configuration: [{id: "summon-creature", type: "select-one", label: "Creature", required: true, options: [
      {id: "improved", label: "Improved", level: {min: 15, class: "artificer"}}, {id: "steel", label: "Steel", level: {min: 3, max: 14, class: "artificer"}}]}]};
  const options = level => actionDefinitionFromItem({type: "action", actor: artificer(level), system: {definition}}).definition
    .configuration[0].options.map(option => option.id);
  assert.deepEqual([options(2), options(5), options(15)], [[], ["steel"], ["improved"]]);
});

test("a summoned spirit's damage from its summoning's level and its summoner's modifier, written in as it appears", async () => {
  const {formulaExpression} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const {withSummonNumbers} = await import("../module/adapters/foundry-v14-summons.mjs");
  const expression = formulaExpression("(2 * @flags.dnd5e.summon.level - 6)d6 + @flags.dnd5e.summon.mod", {ability: "might"});
  assert.deepEqual(withSummonNumbers(expression, {level: 4, mod: 3}),
    {type: "add", terms: [{type: "dice", number: 2, faces: 6}, {type: "constant", value: 3}]}, "4th level, +3: 2d6 + 3");
  const plain = {type: "dice", number: 1, faces: 8};
  assert.equal(withSummonNumbers(plain, {level: 4, mod: 3}), plain, "nothing to write in: the same object");
});

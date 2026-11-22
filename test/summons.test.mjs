import {test} from "node:test";
import assert from "node:assert/strict";
import {summonBonusesAt, summonExpired, summonInitiative, summonPlacements} from "../module/adapters/foundry-v14-summons.mjs";
import {areaExpired} from "../module/adapters/foundry-v14-persistent-areas.mjs";
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

test("a lasting thing's turn is its Combatant's place now: a summon rolling above it does not end it a turn early (Q32)", () => {
  // Cast on the caster's turn (index 2); a summon then rolled above it, so the caster is fourth (index 3).
  const createdAt = {combatId: "c", round: 1, turn: 2, combatantId: "caster"};
  const turns = [{id: "spirit"}, {id: "a"}, {id: "b"}, {id: "caster"}];
  for ( const [expired, flag] of [[summonExpired, {rounds: 2, createdAt}], [areaExpired, {persistence: {duration: {value: 2}}, createdAt}]] ) {
    assert.equal(expired(flag, {id: "c", round: 3, turn: 2, turns}), false, "the turn before the caster's");
    assert.equal(expired(flag, {id: "c", round: 3, turn: 3, turns}), true, "the caster's turn");
    // Its Combatant gone: the place recorded.
    assert.equal(expired(flag, {id: "c", round: 3, turn: 2, turns: turns.filter(entry => entry.id !== "caster")}), true);
  }
});

test("whose combat turn a summon takes: its Action's say, else its own when its creature acts, none when it never does", () => {
  const action = (controllerCosts={}) => ({type: "action", system: {definition: {costs: {allOf: [{capability: "bonus-action", amount: 1}]},
    controllerCosts}}});
  const trigger = data => ({type: "feature", system: {ruleElements: [{type: "Trigger", data}]}});
  const paid = {allOf: [{capability: "bonus-action", amount: 1}]};
  assert.equal(summonInitiative({}, {items: [action()]}), "own", "Spiritual Weapon's Move and Attack, its own Bonus Action");
  assert.equal(summonInitiative({}, {items: [action(paid)]}), "none", "Arcane Eye's Move, its summoner's");
  assert.equal(summonInitiative({}, {items: [{type: "action", system: {definition: {costs: {allOf: []}, byController: true}}}]}), "none",
    "a spectral pack's free Move, its summoner's to take (Q33)");
  assert.equal(summonInitiative({}, {items: [{type: "gear"}, {type: "feature", system: {ruleElements: []}}]}), "none", "a Floating Disk");
  assert.equal(summonInitiative({}, {items: []}), "none", "Mage Hand, a sensor, an illusion");
  assert.equal(summonInitiative({}, {items: [trigger({event: "turn.started", around: {radius: 5}})]}), "own", "a Faithful Hound's bite");
  assert.equal(summonInitiative({}, {items: [trigger({event: "turn.ended", around: {radius: 5, on: "others"}})]}), "none",
    "an aura on others' turns");
  assert.equal(summonInitiative({initiative: "summoner"}, {items: [action()]}), "summoner", "a controlled mount");
  assert.equal(summonInitiative({initiative: "own"}, {items: []}), "own");
  assert.equal(summonInitiative({initiative: "none"}, {items: [action()]}), "none");
  const definition = summon => ({schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon});
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.steed", initiative: "summoner"})).ok, true);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.steed", initiative: "caster"})).ok, false);
});

test("a summon names exactly one creature source and a count from 1 to 20", () => {
  const definition = summon => ({schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon});
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", count: 3, rounds: 10, concentration: true})).ok, true);
  assert.equal(validateActionDefinition(definition({choiceId: "beast"})).ok, true);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", choiceId: "beast"})).ok, false);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", count: 0})).ok, false);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.zombie", fromKilled: {types: ["humanoid"]}})).ok, true);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.zombie", fromKilled: {types: []}})).ok, false);
});

test("summons join their caster's combat with one Initiative roll of their own, though the tracker shows another, and leave it with their Tokens", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const calls = [];
  const combatants = [{id: "cc", tokenId: "caster", sceneId: "s", initiative: 12}];
  combatants.get = id => combatants.find(entry => entry.id === id);
  const combat = {id: "c", round: 1, turn: 0, started: true, combatants,
    createEmbeddedDocuments: async (type, data) => { calls.push(["create", type, data]);
      const made = data.map((entry, i) => ({id: `w${i}`, ...entry})); combatants.push(...made); return made; },
    // The active GM rolls the first under the dice policy (Combat#rollInitiative); the rest of the cast share it.
    rollInitiative: async ids => { calls.push(["roll", ids]); combatants.get(ids[0]).initiative = 17; },
    updateEmbeddedDocuments: async (type, data) => calls.push(["update", type, data]),
    deleteEmbeddedDocuments: async (type, ids) => calls.push(["delete", type, ids])};
  const tokens = new Map();
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: () => ({i: 0, j: 0}), getAdjacentOffsets: square, getTopLeftPoint: ({i, j}) => ({x: i * 100, y: j * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `t${i}`, actorId: "wolf", parent: scene}; tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async (type, ids) => { calls.push(["delete", type, ids]); for ( const id of ids ) tokens.delete(id); }};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  const bite = {type: "action", system: {definition: {costs: {allOf: [{capability: "action", amount: 1}]}}}};
  const wolf = {uuid: "Actor.wolf", items: [bite], getTokenDocument: async data => ({toObject: () => ({...data})})};
  // The GM's tracker (`game.combat`) shows a fight on another Scene.
  const elsewhere = {id: "e", round: 4, turn: 2, started: true, combatants: [{id: "x", tokenId: "other", sceneId: "s2"}],
    createEmbeddedDocuments: async () => calls.push(["create elsewhere"])};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combat: elsewhere,
    combats: [elsewhere, combat], scenes: [scene]},
    companions: {setControllers: async () => {}}, fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.wolf": wolf})[uuid] ?? null});
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 2, rounds: 1}}}});
  const joined = calls.find(call => call[0] === "create")[2];
  assert.deepEqual(joined.map(entry => [entry.tokenId, entry.initiative]), [["t0", null], ["t1", null]]);
  assert.deepEqual(calls.filter(call => ["roll", "update"].includes(call[0])), [["roll", ["w0"]],
    ["update", "Combatant", [{_id: "w1", initiative: 17}]]], "one roll for the cast, which both wolves share (Q99)");
  assert.deepEqual(tokens.get("t0").flags.wildpath.summon.createdAt, {combatId: "c", round: 1, turn: 0}, "its rounds count in its caster's combat");
  await summons.onTurnStart({id: "c", round: 2, turn: 0});
  assert.deepEqual(calls.filter(call => call[0] === "delete").map(call => call.slice(1)),
    [["Combatant", ["w0", "w1"]], ["Token", ["t0", "t1"]]], "combatants go before their Tokens");
  // An encounter set up but not begun yet: they still join and roll.
  calls.length = 0;
  combat.started = false;
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 1, rounds: 1}}}});
  assert.deepEqual(calls.filter(call => call[0] !== "delete").map(call => call[0]), ["create", "roll"]);
  // The physical-dice prompt closed: the first stays unrolled, and the rest of the cast are not given a number either.
  calls.length = 0;
  combatants.splice(1); // The earlier wolves (their stub ids repeat).
  const rolls = combat.rollInitiative;
  combat.rollInitiative = async ids => { calls.push(["roll", ids]); };
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 2, rounds: 1}}}});
  assert.deepEqual(calls.filter(call => call[0] !== "delete").map(call => call[0]), ["create", "roll"]);
  combat.rollInitiative = rolls;
  // A controlled mount (Find Steed) keeps its rider's turn, right after it; no roll.
  calls.length = 0;
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 1, initiative: "summoner"}}}});
  assert.deepEqual(calls.filter(call => call[0] !== "delete").map(call => [call[0], call[2]?.map(entry => entry.initiative)]),
    [["create", [11.999]]]);
  // A summon that never acts (an Arcane Eye: its Move is its summoner's) gets no combat turn.
  calls.length = 0;
  wolf.items = [{type: "action", system: {definition: {controllerCosts: {allOf: [{capability: "bonus-action", amount: 1}]}}}}];
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 1}}}});
  assert.deepEqual(calls.filter(call => call[0] !== "delete"), []);
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
  // A creature on another plane (planeOf: an Ethereal one) holds no field for a summon; one in the world does.
  const standing = (id, x, statuses) => tokens.set(id, {id, x, y: 0, parent: scene, actor: {uuid: `Actor.${id}`, statuses: new Set(statuses)},
    getOccupiedGridSpaceOffsets: () => [{i: 0, j: x / 100}]});
  standing("ghost", 100, ["ethereal"]);
  const summonOne = () => summons.afterResolution({options: {actor: {uuid: "Actor.caster"}},
    state: {source: {tokenRef: "Scene.s.Token.caster"}, actionDefinition: {summon: {actorRef: "Actor.wolf", count: 1}}}});
  assert.deepEqual((await summonOne()).map(token => [token.x, token.y]), [[100, 0]], "on the Ethereal creature's field");
  standing("ghost", 100, []);
  assert.deepEqual((await summonOne()).map(token => [token.x, token.y]), [[0, 100]], "beside a creature in the world");

  const points = Array.from({length: 25}, (_, i) => ({x: i, y: i}));
  const sanitized = sanitizeActionIntentPayload({intent: {actorRef: "Actor.a", summon: {points: [...points, {x: "nope"}], extra: 1}}});
  assert.equal(sanitized.summon.points.length, 20);
  assert.deepEqual(Object.keys(sanitized.summon), ["points"]);
});

test("an uncontrolled summon is no one's: no controller and its own disposition (Pipes of the Sewers' called swarms, Q18.6)", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const place = async summon => {
    const tokens = new Map();
    const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
      grid: {getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}), getAdjacentOffsets: square,
        getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100})},
      createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `t${i}`, parent: scene,
        actor: {uuid: `Scene.s.Token.t${i}.Actor.rats`}}; tokens.set(token.id, token); return token; })};
    const casterToken = {id: "caster", x: 0, y: 0, disposition: 1, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
    tokens.set("caster", casterToken);
    const rats = {uuid: "Actor.rats", getTokenDocument: async data => ({toObject: () => ({...data})})};
    const controlled = [];
    const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene]},
      companions: {setControllers: async (actor, options) => controlled.push([actor.uuid, options])},
      fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.rats": rats})[uuid] ?? null});
    const placed = await summons.afterResolution({options: {actor: {uuid: "Actor.piper"}},
      state: {source: {tokenRef: "Scene.s.Token.caster"}, actionDefinition: {summon: {actorRef: "Actor.rats", count: 2, ...summon}}}});
    return {placed, controlled};
  };
  const own = await place({});
  assert.deepEqual(own.controlled.map(([, options]) => options), [{controllers: ["Actor.piper"], kind: "summon"},
    {controllers: ["Actor.piper"], kind: "summon"}], "a summon is its caster's");
  assert.deepEqual(own.placed.map(token => token.disposition), [1, 1], "on its caster's side");
  const called = await place({uncontrolled: true});
  assert.equal(called.placed.length, 2);
  assert.deepEqual(called.controlled, [], "no controller set");
  assert.equal(called.placed.some(token => "disposition" in token), false, "its own disposition, from its prototype");
  assert.equal(validateActionDefinition({schemaVersion: 1, id: "action:call", label: "Call", costs: {allOf: []},
    summon: {actorRef: "Actor.rats", uncontrolled: true}}).ok, true);
  assert.equal(validateActionDefinition({schemaVersion: 1, id: "action:call", label: "Call", costs: {allOf: []},
    summon: {actorRef: "Actor.rats", uncontrolled: "yes"}}).ok, false);
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
  // A Find Steed steed's Healing Touch heals the spell's level more: a Modifier on its healing.
  assert.deepEqual(summonBonusesAt({healing: level}, 3).rules, [{schemaVersion: 1, id: "summon-healing", type: "Modifier",
    data: {domains: ["healing"], modifierType: "untyped", value: 3}}]);
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
  const {summonBonusesAt, matchedAttacks} = await import("../module/adapters/foundry-v14-summons.mjs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const artificer = level => ({system: {abilities: {intellect: {value: 16}}, classes: [{id: "artificer", name: "artificer", level}],
    details: {level}, spellcasting: {ability: "intellect"}}});
  const hp = {type: "add", terms: [{type: "ability-modifier", ability: "intellect"}, {type: "multiply", terms: [{type: "constant", value: 5},
    {type: "class-level", class: "artificer"}]}]};
  const caster = artificer(5);
  assert.equal(summonBonusesAt({hp}, 0, {actor: caster, actorSystem: caster.system}).hp, 28, "Intelligence +3 and 5 per artificer level");
  const defender = {system: {details: {level: 1}}};
  assert.deepEqual(matchedAttacks(caster, defender), [], "nothing without attacks");
  // Two attacks with different bonuses (+4 and +2): each made up to the caster's +6 (Intelligence +3, Proficiency +3),
  // on that Action alone.
  const attackItem = (id, bonus) => ({id, type: "action", system: {ruleElements: [], definition: {tags: [], attack: {fixedBonus: undefined,
    statistic: "melee", ability: "might"}}}, bonus});
  const spirit = {id: "spirit", system: {details: {level: 1}}, items: [attackItem("bite", 4), attackItem("claw", 2)],
    getStatistic: (domains, {item}) => ({totalModifier: item.bonus})};
  assert.deepEqual(matchedAttacks(caster, spirit).map(update => [update._id, update["system.ruleElements"][0].data.value]),
    [["bite", 2], ["claw", 4]]);
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

test("a creature the Action killed rises as its summon in its own space, its caster's, in its combat (fromKilled)", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const tokens = new Map();
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}), getAdjacentOffsets: square,
      getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `z${tokens.size}-${i}`,
      parent: scene, actor: {}}; tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async () => {}};
  const cell = token => () => [{i: token.y / 100, j: token.x / 100}];
  const place = (id, x, y, actor) => { const token = {id, x, y, parent: scene, actor}; token.getOccupiedGridSpaceOffsets = cell(token);
    tokens.set(id, token); return token; };
  place("caster", 0, 0, {});
  const creature = (id, type) => ({uuid: `Scene.s.Token.${id}.Actor.x`, system: {details: {type}}});
  place("guard", 900, 300, creature("guard", "humanoid"));
  place("wolf", 500, 500, creature("wolf", "beast"));
  place("knight", 700, 0, creature("knight", "humanoid"));
  place("corpse", 300, 300, creature("corpse", "humanoid"));
  const zombie = {uuid: "Actor.zombie", items: [{type: "action", system: {definition: {}}}],
    getTokenDocument: async data => ({toObject: () => ({...data})})};
  const controlled = [];
  const created = [];
  const rolled = [];
  const combat = {id: "c", round: 1, turn: 0, started: true, combatants: [{id: "cc", tokenId: "caster", sceneId: "s", initiative: 15}],
    createEmbeddedDocuments: async (type, data) => { created.push(...data); return data.map((entry, i) => ({id: `z${i}`, ...entry})); },
    rollInitiative: async ids => rolled.push(...ids)};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene], combats: [combat]},
    companions: {setControllers: async (actor, options) => controlled.push(options)},
    fromUuid: uuid => ({"Scene.s.Token.caster": tokens.get("caster"), "Actor.zombie": zombie})[uuid] ?? null});
  const hit = (tokenId, from) => ({type: "durabilityDamage", target: {tokenId}, plan: {from, to: 0}});
  // `killed`: the dying adapter's uuids of the creatures this Action killed.
  const resolve = (mutationPlans, killed) => summons.afterResolution({killed: killed.map(id => tokens.get(id).actor.uuid),
    options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"}, mutationPlans,
      actionDefinition: {label: "Finger of Death", range: {normal: {value: 60}}, summon: {actorRef: "Actor.zombie", fromKilled: {types: ["humanoid"]}}}}});
  const risen = await resolve([hit("guard", 40), hit("wolf", 20), hit("knight", 30), hit("corpse", 0)], ["guard", "wolf"]);
  assert.deepEqual(risen.map(token => [token.x, token.y]), [[900, 300]], "on the Humanoid it killed, out of range and over its corpse");
  assert.deepEqual(controlled, [{controllers: ["Actor.caster"], kind: "summon"}]);
  assert.deepEqual(created.map(entry => [entry.tokenId, entry.initiative]), [[risen[0].id, null]]);
  assert.deepEqual(rolled, ["z0"], "with an Initiative of its own (Q32)");
  assert.ok(tokens.has("guard"), "the corpse stays");
  assert.deepEqual(await resolve([hit("wolf", 20), hit("knight", 30), hit("corpse", 10)], ["wolf"]), [],
    "none from a dead Beast, a living Humanoid, or a corpse (healed since) it did not kill");
  const finished = await resolve([hit("knight", 0)], ["knight"]);
  assert.deepEqual(finished.map(token => [token.x, token.y]), [[700, 0]], "a dying Humanoid it finished off at 0 rises");
});

test("match.saves: a summon's save and escape DCs, its Actions' and its Triggers', become its caster's spell save DC", async () => {
  const {matchedSaves} = await import("../module/adapters/foundry-v14-summons.mjs");
  // Intelligence 18 (+4) and Proficiency +3: DC 15.
  const caster = {system: {abilities: {intellect: {value: 18}}, spellcasting: {ability: "intellect"}, details: {level: 5}}};
  const grasp = {id: "grasp", type: "action", system: {definition: {save: {ability: "agility", dc: {value: 5}},
    effects: [{id: "effect-1", type: "condition", conditionId: "grappled", metadata: {escapeDC: 5}}]}}};
  const flames = {id: "flames", type: "feature", system: {ruleElements: [{id: "t", type: "Trigger", data: {action: {save: {ability: "agility", dc: {value: 5}}}}},
    {id: "m", type: "Modifier", data: {save: {dc: 1}}}]}};
  const fist = {id: "fist", type: "action", system: {definition: {attack: {type: "melee"}, check: {dc: {value: 12}}}}};
  const updates = matchedSaves(caster, {items: [grasp, flames, fist]});
  assert.deepEqual(updates.map(update => update._id), ["grasp", "flames"], "nothing without a save");
  assert.deepEqual(updates[0]["system.definition"].save.dc, {value: 15});
  assert.equal(updates[0]["system.definition"].effects[0].metadata.escapeDC, 15);
  assert.deepEqual(updates[1]["system.ruleElements"].map(rule => rule.data.action?.save.dc ?? rule.data.save.dc), [{value: 15}, 1],
    "a Trigger's Action, not another rule");
  assert.deepEqual(grasp.system.definition.save.dc, {value: 5}, "the Item itself is left to the update");
  // Read as its summoning spell reads its own DC: its caster's dc.spell (a Robe of the Archmagi's +2) and the casting
  // ability a granting feature gives that spell (Wisdom 12, +1).
  const robed = {...caster, system: {...caster.system, abilities: {...caster.system.abilities, spirit: {value: 12}}},
    getStatistic: (domain, {tags}) => (((domain === "dc.spell") && tags.includes("spell")) ? {totalModifier: 2} : null)};
  const dcOf = options => matchedSaves(robed, {items: [grasp]}, options)[0]["system.definition"].save.dc.value;
  assert.equal(dcOf({tags: ["spell"]}), 17, "8 + 3 + 4 + 2");
  const spell = {flags: {wildpath: {grantedBy: "feat"}}, actor: {system: robed.system,
    items: [{id: "feat", flags: {wildpath: {castingAbilities: ["spirit"]}}}]}};
  assert.equal(dcOf({item: spell, tags: ["spell"]}), 14, "8 + 3 + 1 + 2");
});

test("match.saves alone is applied as the summon appears (Guardian of Faith has no bonuses)", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const tokens = new Map();
  const updated = [];
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: () => ({i: 0, j: 0}), getAdjacentOffsets: square, getTopLeftPoint: ({i, j}) => ({x: i * 100, y: j * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `g${i}`, parent: scene,
      actor: {items: [{id: "roll", type: "action", system: {definition: {save: {ability: "agility", dc: {value: 5}}}}}],
        updateEmbeddedDocuments: async (kind, list) => updated.push(...list)}}; tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async () => {}};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  const guardian = {uuid: "Actor.guardian", getTokenDocument: async data => ({toObject: () => ({...data})})};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene]},
    companions: {setControllers: async () => {}}, fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.guardian": guardian})[uuid] ?? null});
  const caster = {uuid: "Actor.caster", system: {abilities: {spirit: {value: 16}}, spellcasting: {ability: "spirit"}, details: {level: 7}}};
  await summons.afterResolution({options: {actor: caster}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.guardian", count: 1, match: {saves: true}}}}});
  assert.deepEqual(updated.map(update => [update._id, update["system.definition"].save.dc]), [["roll", {value: 14}]], "8 + 3 + 3");
});

test("a lasting spell's summon keeps its cast level; its cast leaves together, and its caster's concentration with its last creature (Q31, Q99 (f))", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const tokens = new Map();
  let made = 0;
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: () => ({i: 0, j: 0}), getAdjacentOffsets: square, getTopLeftPoint: ({i, j}) => ({x: i * 100, y: j * 100})},
    createEmbeddedDocuments: async (type, data) => data.map(entry => { const token = {...entry, id: `w${made++}`, parent: scene};
      tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async (type, ids) => { for ( const id of ids ) tokens.delete(id); }};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  const wolf = {uuid: "Actor.wolf", getTokenDocument: async data => ({toObject: () => ({...data})})};
  const caster = {uuid: "Actor.caster", system: {}, effects: [],
    createEmbeddedDocuments: async (type, data) => { caster.effects.push(...data.map((entry, i) => ({...entry, id: `m${caster.effects.length + i}`}))); },
    deleteEmbeddedDocuments: async (type, ids) => { caster.effects = caster.effects.filter(effect => !ids.includes(effect.id)); }};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene]},
    companions: {setControllers: async () => {}},
    fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.wolf": wolf, "Actor.caster": caster})[uuid] ?? null});
  const cast = async (spec, castingLevel=null, metadata=undefined) => {
    const placed = await summons.afterResolution({options: {actor: caster}, state: {source: {tokenRef: "Scene.s.Token.caster"},
      configuration: {castingLevel}, actionDefinition: {id: "action:conjure", metadata, summon: {actorRef: "Actor.wolf", ...spec}}}});
    for ( const token of placed ) token.flags.wildpath.summon.at = made; // Each cast its own moment.
    return placed.map(token => token.id);
  };
  const conjure = {count: 2, rounds: 100, concentration: true, spellLevel: 3};
  const first = await cast(conjure, 5);
  assert.deepEqual(first.map(id => tokens.get(id).flags.wildpath.summon.castLevel), [5, 5], "the slot it was cast with");
  assert.equal((await cast({count: 1, spellLevel: 1}).then(ids => tokens.get(ids[0]))).flags.wildpath.summon.castLevel, undefined,
    "an instantaneous spell's creature (Find Familiar) has none");
  assert.equal(tokens.get((await cast({count: 1, rounds: 10}))[0]).flags.wildpath.summon.castLevel, undefined, "nor a feature's");
  assert.equal(tokens.get((await cast({count: 1, rounds: 10}, null, {spellLevel: 0}))[0]).flags.wildpath.summon.castLevel, 0,
    "a lasting cantrip's (Mage Hand), by its Action's own level");
  assert.equal(tokens.get((await cast({count: 1, rounds: 10}, null, {spellLevel: 2}))[0]).flags.wildpath.summon.castLevel, 2,
    "a spell whose summon names no level of its own");
  // `dispellable` says so instead (wave D S7): one lasting until dispelled (Continual Flame) keeps its level, one no
  // Dispel ends keeps none; a feature's still has no level to keep.
  const castLevel = async (spec, level, metadata) => tokens.get((await cast({count: 1, ...spec}, level, metadata))[0]).flags.wildpath.summon.castLevel;
  assert.equal(await castLevel({spellLevel: 2, dispellable: true}, 4), 4);
  assert.equal(await castLevel({rounds: 10, dispellable: false}, 4, {spellLevel: 3}), undefined);
  assert.equal(await castLevel({rounds: 10, dispellable: true}), undefined);
  // `leavesAtDeath` marks any summon's Tokens to leave at its death (the dying adapter's settle), not only a copy's.
  const leaving = async spec => tokens.get((await cast({count: 1, ...spec}))[0]).flags.wildpath.leavesAtDeath;
  assert.deepEqual([await leaving({leavesAtDeath: true}), await leaving({})], [true, undefined]);
  const markers = () => caster.effects.map(effect => effect.flags.wildpath.summonTokens.tokenIds);
  await summons.dismiss(scene, [first[0]]);
  assert.deepEqual(markers(), [first], "one of two dismissed: the spell, and its concentration, go on");
  await summons.dismiss(scene, [first[1]]);
  assert.deepEqual(markers(), [], "its last creature dismissed: its caster's concentration ends");
  // One of a cast ended (dispelled): the whole cast goes, another cast of the same spell stays.
  const second = await cast(conjure);
  const third = await cast(conjure);
  await summons.dismissCast(scene, [second[1]]);
  assert.deepEqual([second.concat(third).map(id => tokens.has(id)), markers()], [[false, false, true, true], [third]]);
});

test("a summon's carried area is an emanation lasting as its summon does; a budget is a positive whole number of damage", async () => {
  const {damageTaken} = await import("../module/resolvers/action-pipeline-resolver.mjs");
  const burn = {schemaVersion: 1, id: "action:burn", label: "Burn", costs: {allOf: []}};
  const definition = area => ({schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []},
    summon: {actorRef: "Actor.sphere", area: {shape: "emanation", size: {value: 5, unit: "ft"}, ...area}}});
  const paths = area => validateActionDefinition(definition(area)).errors?.map(error => error.path) ?? [];
  assert.deepEqual(paths({persistence: {affects: "enemies", budget: {damage: 60}, light: {bright: 20, dim: 40},
    triggers: [{on: ["area.entered", "turn.started"], action: burn}]}}), []);
  assert.deepEqual(paths({shape: "radial"}), ["summon.area"]);
  for ( const persistence of [{concentration: true}, {duration: {unit: "round", value: 10}}, {onObject: "on-object"}] ) {
    assert.deepEqual(paths({persistence}), ["summon.area.persistence"], JSON.stringify(persistence));
  }
  assert.deepEqual(paths({persistence: {budget: {damage: 0}}}), ["summon.area.persistence.budget"]);
  assert.deepEqual(paths({persistence: {budget: {damage: 2.5}}}), ["summon.area.persistence.budget"]);
  // A trigger only for creatures its caster sees (2024 Conjure Animals, Q30): its Action's targeting.eligible, a predicate.
  const seen = eligible => paths({persistence: {triggers: [{on: ["turn.ended"], action: {...burn, targeting: {type: "single", eligible}}}]}});
  assert.deepEqual(seen({equals: {path: "seenBySource", value: true}}), []);
  assert.equal(seen({sees: true}).length, 1);
  assert.deepEqual(paths({persistence: {triggers: [{on: ["attack.hit"], action: burn}]}}), ["summon.area.persistence.triggers.0.on"]);
  // What a run dealt in all, as damage.applied counts it: Temporary Hit Points it took count; a failed plan does not.
  assert.equal(damageTaken({mutationPlans: [{type: "durabilityDamage", plan: {amount: 3, temporary: {from: 5, to: 0}}},
    {type: "durabilityDamage", plan: {ok: false, amount: 9}}, {type: "healing", plan: {amount: 4}}]}), 8);
});

test("a compendium summon's world import is reused while out and deleted by the GM with its last Token, never a GM's own Actor", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const tokens = new Map();
  const actors = [];
  let made = 0;
  let placed = 0;
  let summons = null;
  let gm = "gm";
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: () => ({i: 0, j: 0}), getAdjacentOffsets: square, getTopLeftPoint: ({i, j}) => ({x: i * 100, y: j * 100})},
    createEmbeddedDocuments: async (type, data) => data.map(entry => {
      const token = {...entry, id: `t${++placed}`, parent: scene};
      tokens.set(token.id, token);
      return token;
    }),
    // Foundry's deleteToken hook, on every client, after each Token is gone.
    deleteEmbeddedDocuments: async (type, ids) => {
      const gone = ids.map(id => tokens.get(id));
      for ( const id of ids ) tokens.delete(id);
      for ( const token of gone ) await summons.onTokenDeleted(token);
    }};
  const casterToken = {id: "caster", x: 0, y: 0, parent: scene, getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
  tokens.set("caster", casterToken);
  // A delete held open (`hold`) answers only when released, as a server round trip does; `fail` rejects it.
  let hold = null;
  let fail = false;
  const warnings = [];
  const worldActor = (data, id = `a${++made}`) => {
    const actor = {...data, id, uuid: `Actor.${id}`, toObject: () => data,
      getTokenDocument: async token => ({toObject: () => ({...token, actorId: actor.id})}),
      delete: async () => {
        if ( fail ) throw new Error("gone already");
        if ( hold ) await hold.promise;
        actors.splice(actors.indexOf(actor), 1);
      }};
    actors.push(actor);
    return actor;
  };
  const sphere = {uuid: "Compendium.wildpath.srd-creatures.Actor.sphere", pack: "wildpath.srd-creatures", name: "Sphere",
    toObject: () => ({name: "Sphere", flags: {}})};
  const previous = {CONFIG: globalThis.CONFIG, foundry: globalThis.foundry};
  // Foundry keeps a given _id only with keepId; otherwise the new Actor gets its own.
  globalThis.CONFIG = {Actor: {documentClass: {create: async (data, {keepId} = {}) => worldActor(data, keepId ? data._id : undefined)}}};
  globalThis.foundry = {utils: {randomID: () => `r${++made}`}};
  try {
    summons = createFoundrySummons({game: {user: {id: "gm"}, users: {get activeGM() { return {id: gm}; }, get: id => ({isGM: id === "gm"})},
      get scenes() { return [scene]; }, get actors() { return actors; }, combats: []},
    companions: {setControllers: async () => {}}, logger: {warn: (...args) => warnings.push(args)},
    fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, [sphere.uuid]: sphere})[uuid] ?? null});
    const cast = (summon) => summons.afterResolution({options: {actor: {uuid: "Actor.caster"}},
      state: {source: {tokenRef: "Scene.s.Token.caster"}, actionDefinition: {id: "action:sphere", summon: {actorRef: sphere.uuid, ...summon}}}});
    const [first] = await cast({count: 1});
    const [second] = await cast({count: 1});
    assert.equal(actors.length, 1, "one import, reused by the next summon");
    assert.equal(second.actorId, first.actorId);
    assert.equal(second.flags.wildpath.summon.sourceUuid, sphere.uuid, "its Token names the creature it was imported from");
    await summons.dismiss(scene, [first.id]);
    assert.equal(actors.length, 1, "kept while a summon of it is still out");
    await summons.dismiss(scene, [second.id]);
    assert.equal(actors.length, 0, "deleted with its last Token");
    // Its deletion undone (Ctrl+Z): the Token comes back with no Actor, and the GM imports its creature again for it.
    const updates = [];
    await summons.onTokenCreated({...second, actor: null, update: async data => updates.push(data)});
    assert.equal(actors.length, 1);
    assert.deepEqual(updates, [{actorId: actors[0].id}], "the restored Token stands for the new import");
    await summons.onTokenCreated({...second, actor: {uuid: "x"}, update: async data => updates.push(data)});
    assert.equal(updates.length, 1, "a Token with its Actor is left alone");
    actors.length = 0;
    // A summon cast while its import's deletion is still in flight imports a fresh copy, never the one going.
    const [lone] = await cast({count: 1});
    let release;
    hold = {promise: new Promise(resolve => { release = resolve; })};
    const going = summons.dismiss(scene, [lone.id]);
    await new Promise(resolve => setImmediate(resolve));
    hold = null;
    const [next] = await cast({count: 1});
    release();
    await going;
    assert.notEqual(next.actorId, lone.actorId);
    assert.deepEqual(actors.map(actor => actor.id), [next.actorId], "the new summon stands for a live import");
    await summons.dismiss(scene, [next.id]);
    assert.equal(actors.length, 0);
    // An import whose delete fails is told to the GM and never fails the Action (a cast that placed nothing).
    fail = true;
    assert.deepEqual(await cast({counts: [{actorRef: sphere.uuid, count: 0}]}), []);
    fail = false;
    assert.ok(warnings.some(([text]) => String(text).includes("WILDPATH.NOTICE.StepFailed")));
    // Any other Action leaves every import alone, and so does a Token the GM placed of one by hand.
    const left = actors[0];
    assert.deepEqual(await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {actionDefinition: {id: "action:hit"}}}), []);
    await summons.onTokenDeleted({actorId: left.id});
    assert.deepEqual(actors, [left]);
    await cast({counts: [{actorRef: sphere.uuid, count: 0}]});
    assert.equal(actors.length, 0, "a cast that placed nothing removes its import");
    // A limited summon cast again: the old one dismissed while the new one is placed keeps the import under it.
    const [old] = await cast({count: 1, limit: 1});
    const [fresh] = await cast({count: 1, limit: 1});
    assert.equal(tokens.has(old.id), false);
    assert.deepEqual(actors.map(actor => actor.id), [fresh.actorId], "the new summon's Token stands for a live import");
    await summons.dismiss(scene, [fresh.id]);
    assert.equal(actors.length, 0);
    // A GM's copy of an import (the sidebar's Duplicate, or Actor.create(import.toObject())) carries its flags under a
    // new id, and an import made before summonImport existed names no id: neither is reused nor deleted.
    const [out] = await cast({count: 1});
    const real = actors.find(actor => actor.id === out.actorId);
    assert.equal(real.flags.wildpath.summonImport, real.id, "an import names its own id");
    const copy = worldActor(real.toObject());
    const legacy = worldActor({name: "Sphere", ownership: {default: 0, gm: 3}, flags: {wildpath: {summonSource: sphere.uuid}}});
    await summons.dismiss(scene, [out.id]);
    assert.deepEqual(actors, [copy, legacy], "the real import still goes with its last Token");
    const [again] = await cast({count: 1});
    assert.ok(![copy.id, legacy.id].includes(again.actorId), "the next summon imports afresh");
    await summons.dismiss(scene, [again.id]);
    assert.deepEqual(actors, [copy, legacy], "and its dismissal deletes only its own import");
    // A summon Token standing for either (one placed before summonImport existed, or a Token of the copy) leaves it too.
    await summons.onTokenDeleted({actorId: legacy.id, flags: {wildpath: {summon: {kind: "summon"}}}});
    await summons.onTokenDeleted({actorId: copy.id, flags: {wildpath: {summon: {kind: "summon"}}}});
    assert.deepEqual(actors, [copy, legacy], "a summon Token's deletion never deletes a copy or an older import");
    actors.length = 0;
    // Kept: a GM's own Actor, an import a GM gave a Player by hand, and any import while a Player's client sees a Token go.
    const own = worldActor({name: "Wolf"});
    const given = worldActor({name: "Sphere", ownership: {default: 0, gm: 3, player: 3},
      flags: {wildpath: {summonSource: sphere.uuid, summonImport: "given"}}}, "given");
    const summoned = {wildpath: {summon: {kind: "summon"}}};
    await summons.onTokenDeleted({actorId: own.id, flags: summoned});
    await summons.onTokenDeleted({actorId: given.id, flags: summoned});
    assert.equal(actors.length, 2);
    const stale = worldActor({name: "Sphere", ownership: {default: 0, gm: 3},
      flags: {wildpath: {summonSource: "Compendium.x.y.Actor.z", summonImport: "stale"}}}, "stale");
    gm = "other";
    await summons.onTokenDeleted({actorId: stale.id, flags: summoned});
    assert.equal(actors.length, 3, "only the active GM deletes");
    gm = "gm";
    await summons.onTokenDeleted({actorId: stale.id, flags: summoned});
    assert.deepEqual(actors.map(actor => actor.name), ["Wolf", "Sphere"]);
    assert.equal(actors[1], given);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("copyTarget: the GM copies the target Token's creature into one linked world Actor, at its own halved maximum (Simulacrum, Q137)", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const events = [];
  const tokens = new Map();
  const actors = [];
  const scene = {id: "s", tokens: {[Symbol.iterator]: () => tokens.values(), get: id => tokens.get(id)},
    grid: {getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}), getAdjacentOffsets: square,
      getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100})},
    createEmbeddedDocuments: async (type, data) => data.map((entry, i) => { const token = {...entry, id: `c${tokens.size}-${i}`, parent: scene,
      actor: actors.find(actor => actor.id === entry.actorId)}; tokens.set(token.id, token); return token; }),
    deleteEmbeddedDocuments: async (type, ids) => { events.push(`delete ${ids}`); for ( const id of ids ) tokens.delete(id); }};
  const place = (id, x, data) => { const token = {id, x, y: 0, parent: scene, ...data}; token.getOccupiedGridSpaceOffsets = () => [{i: 0, j: x / 100}];
    tokens.set(id, token); return token; };
  place("caster", 0, {disposition: 1});
  // An unlinked Token whose own data differs from its base Actor's: its synthetic Actor's toObject is what is copied.
  const source = {_id: "spy", _stats: {createdTime: 1}, name: "Spy", img: "spy.webp", type: "npc", folder: "f", ownership: {default: 0, player: 3},
    flags: {core: {sheetClass: "x"}, wildpath: {source: {identifier: "spy"}, summonLevel: 3, attackTurn: {turn: 1}, summonImport: "spy"}},
    effects: [{name: "Bless"}], items: [{name: "Dagger"}, {name: "Bite", flags: {wildpath: {transformedBy: "e1"}}}],
    prototypeToken: {name: "Spy", actorLink: false, texture: {src: "spy.webp"}, flags: {}},
    system: {biography: "<p>Its real name</p>", companion: {kind: "companion", controllers: ["Actor.other"]}, details: {type: "humanoid"},
      resources: {health: {base: 61, value: 40, temp: 5}, action: {spent: 1}, movement: {spent: 20}}, deathSaves: {successes: 1, failures: 2},
      status: {turnsTaken: 3}, pools: [{id: "spell-slot.1", value: 0}, {id: "spell-slot.pact", value: 0}, {id: "spell-slotted", value: 1},
        {id: "heroic-inspiration", value: 1}, {id: "hit-die.d8", value: 2}]}};
  const spy = {uuid: "Scene.s.Token.target.Actor.spy", id: "spy", name: "Spy", toObject: () => structuredClone(source),
    getTokenDocument: async data => ({toObject: () => ({...data})})};
  place("target", 300, {name: "Merchant", texture: {src: "merchant.webp"}, actor: spy});
  // An earlier copy from the same Action, which its limit dismisses before the new one is made.
  place("old", 600, {actor: {uuid: "Actor.old"}, flags: {wildpath: {summon: {casterUuid: "Actor.caster", actionId: "action:simulacrum", at: 1}}}});
  const constructed = [];
  const flagged = [];
  // Foundry prepares an unsaved Actor as it is made: here its Hit Point maximum is its base, times 0.5 with the halving rule.
  class ActorClass {
    constructor(data) {
      constructed.push(structuredClone(data));
      const halved = data.items.some(item => item.system?.ruleElements?.some(rule => rule.data?.domains?.includes("resources.health.max.multiplier")));
      this.system = {resources: {health: {max: Math.floor(data.system.resources.health.base * (halved ? 0.5 : 1))}},
        pools: data.system.pools.map(pool => ({id: pool.id, max: 4}))};
    }
    // Foundry keeps the given _id with keepId, as the copy is created.
    static async create(data, {keepId} = {}) {
      events.push("create");
      const id = keepId ? data._id : `other${actors.length}`;
      const actor = {...data, id, uuid: `Actor.${id}`, setFlag: async (...args) => flagged.push(args),
        delete: async () => events.push(`delete ${actor.id}`),
        getTokenDocument: async token => ({toObject: () => ({...token, actorId: actor.id})})};
      actors.push(actor);
      return actor;
    }
  }
  const controlled = [];
  const created = [];
  const warnings = [];
  const combat = {id: "c", round: 1, turn: 0, started: true, combatants: [{id: "cc", tokenId: "caster", sceneId: "s", initiative: 15}],
    createEmbeddedDocuments: async (type, data) => { created.push(...data); return data.map((entry, i) => ({id: `cb${i}`, ...entry})); }};
  const previous = {CONFIG: globalThis.CONFIG, foundry: globalThis.foundry};
  globalThis.CONFIG = {Actor: {documentClass: ActorClass}};
  globalThis.foundry = {utils: {randomID: () => `copy${actors.length}`}};
  try {
    const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene], combats: [combat],
      i18n: {format: (key, data) => ((key === "WILDPATH.SUMMON.CopyName") ? `${data.name} (${data.action})` : key)}},
      companions: {setControllers: async (actor, options) => controlled.push([actor.uuid, options])}, logger: {warn: (...args) => warnings.push(args)},
      fromUuid: uuid => ({"Scene.s.Token.caster": tokens.get("caster")})[uuid] ?? null});
    const rules = [{schemaVersion: 1, id: "half", type: "Modifier", data: {domains: ["resources.health.max.multiplier"], modifierType: "untyped", value: 0.5}},
      {schemaVersion: 1, id: "bars", type: "Forbid", data: {actions: {tagsAny: ["spell:simulacrum", "rest"]}}}];
    const cast = (summon, targets) => summons.afterResolution({options: {actor: {uuid: "Actor.caster"}},
      state: {source: {tokenRef: "Scene.s.Token.caster"}, targets, configuration: {castingLevel: 7},
        actionDefinition: {id: "action:simulacrum", label: "Simulacrum", metadata: {spellLevel: 7}, summon}}});
    const spec = {copyTarget: {pools: {"spell-slot": "full", "heroic-inspiration": "empty"}}, limit: 1, initiative: "summoner",
      system: {details: {type: "construct"}, dyingMode: "dies"}, rules};
    const [token] = await cast(spec, [{tokenId: "target"}]);
    assert.deepEqual(events, ["delete old", "create"], "the old copy goes before the new one is made, in one create");
    const [copy] = actors;
    assert.deepEqual([copy.name, copy.img], ["Merchant (Simulacrum)", "merchant.webp"], "named and pictured as the Token the caster saw");
    assert.deepEqual([copy._id, copy.id, copy._stats, copy.folder, copy.ownership, copy.effects], ["copy0", "copy0", undefined, null, {default: 0}, []],
      "its own id, chosen as it is created");
    assert.deepEqual(copy.flags, {core: {sheetClass: "x"}, wildpath: {source: {identifier: "spy"}, summonLevel: 3, summonCopy: "copy0"}},
      "turn and import flags dropped, its own summon level kept, and the mark naming its own id (B10)");
    assert.deepEqual(copy.items.map(item => item.name), ["Dagger", "Simulacrum"], "its gear, and one feature with the spell's rules");
    assert.deepEqual(copy.items[1].system, {active: true, ruleElements: rules});
    const system = copy.system;
    assert.deepEqual([system.biography, system.companion, system.deathSaves, system.status.turnsTaken], ["",
      {kind: "summon", controllers: []}, {successes: 0, failures: 0}, 0]);
    assert.deepEqual([system.details.type, system.dyingMode], ["construct", "dies"], "summon.system merged in");
    assert.deepEqual([system.resources.health.value, system.resources.health.temp, system.resources.action.spent, system.resources.movement.spent],
      [30, 0, 0, 0], "at its halved maximum, prepared in memory before the create");
    assert.equal(constructed.length, 1);
    assert.deepEqual(system.pools.map(pool => pool.value), [4, 4, 1, 0, 2], "slots full, Heroic Inspiration empty, the rest as they were");
    const made = copy.prototypeToken.flags.wildpath.summon;
    const flag = {casterUuid: "Actor.caster", kind: "summon", rounds: null, createdAt: made.createdAt, actionId: "action:simulacrum",
      at: made.at, of: spy.uuid};
    assert.deepEqual(copy.prototypeToken, {name: "Merchant (Simulacrum)", actorLink: true, disposition: 1, texture: {src: "merchant.webp"},
      flags: {wildpath: {summon: flag}}}, "a Token of it from the sidebar is linked and its summon too");
    assert.deepEqual([token.actorLink, token.actorId, token.disposition, token.flags.wildpath.summon], [true, copy.id, 1, flag]);
    assert.deepEqual(controlled, [[copy.uuid, {controllers: ["Actor.caster"], kind: "summon"}]], "its caster's Players command it");
    assert.deepEqual(created.map(entry => [entry.tokenId, entry.initiative]), [[token.id, 14.999]], "it acts right after its caster");
    assert.deepEqual(flagged, [], "the cast level is not written over its own summonLevel");
    assert.equal(source.name, "Spy", "the original is untouched");
    // An uncontrolled copy keeps the original's disposition and has no controller; with no target nothing is made.
    controlled.length = 0;
    const [twin] = await cast({...spec, limit: undefined, uncontrolled: true}, [{tokenId: "target"}]);
    assert.deepEqual([controlled, "disposition" in twin, "disposition" in actors[1].prototypeToken], [[], false, false]);
    assert.deepEqual(await cast(spec, []), []);
    assert.equal(actors.length, 2);
    assert.ok(warnings.some(([text]) => String(text).includes("WILDPATH.NOTICE.SummonNoTarget")));
    // Its Token refused: the copy's Actor, which nothing else would remove, is deleted and the failure still raised.
    const createTokens = scene.createEmbeddedDocuments;
    scene.createEmbeddedDocuments = async () => { throw new Error("refused"); };
    await assert.rejects(cast({...spec, limit: undefined}, [{tokenId: "target"}]), /refused/u);
    scene.createEmbeddedDocuments = createTokens;
    assert.deepEqual([actors.length, events.at(-1)], [3, "delete copy2"]);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("a copy ends whole, its Tokens on every Scene and then its Actor: by its limit (with a Token or none), at its death, dispelled; never by a hand-deleted Token (wave D B10)", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const {createFoundryDying} = await import("../module/adapters/foundry-v14-dying.mjs");
  const events = [];
  const actors = [];
  const scenes = [];
  let made = 0;
  const sceneOf = id => {
    const tokens = new Map();
    const scene = {id, tokens: {[Symbol.iterator]: () => tokens.values(), get: tokenId => tokens.get(tokenId)},
      grid: {getOffset: ({x, y}) => ({i: Math.floor(y / 100), j: Math.floor(x / 100)}), getAdjacentOffsets: square,
        getTopLeftPoint: ({i, j}) => ({x: j * 100, y: i * 100})},
      createEmbeddedDocuments: async (type, data) => data.map(entry => { const token = {...entry, id: `${id}${made++}`, parent: scene,
        actor: entry.actor ?? actors.find(actor => actor.id === entry.actorId)}; tokens.set(token.id, token); return token; }),
      deleteEmbeddedDocuments: async (type, ids) => { events.push(`delete ${ids}`); for ( const tokenId of ids ) tokens.delete(tokenId); }};
    scenes.push(scene);
    return scene;
  };
  const here = sceneOf("s");
  const there = sceneOf("o");
  const place = async (x, data) => {
    const [token] = await here.createEmbeddedDocuments("Token", [{x, y: 0, ...data}]);
    return Object.assign(token, {getOccupiedGridSpaceOffsets: () => [{i: 0, j: x / 100}]});
  };
  const caster = await place(0, {disposition: 1});
  const spy = {uuid: "Actor.spy", id: "spy", effects: [], getTokenDocument: async data => ({toObject: () => ({...data})}), toObject: () => ({name: "Spy", items: [], prototypeToken: {}, system: {resources: {health: {base: 20, value: 20}}}})};
  const target = await place(300, {name: "Merchant", actor: spy});
  // The copy's Actor: prepared in memory, then created; its Tokens are those standing for it on any Scene.
  class ActorClass {
    constructor(data) { this.system = {resources: {health: {max: data.system.resources.health.base}}}; }
    static async create(data, {keepId} = {}) {
      const id = keepId ? data._id : `other${made++}`;
      const actor = {...data, id, uuid: `Actor.${id}`, delete: async () => { events.push(`delete ${id}`); actors.splice(actors.indexOf(actor), 1); },
        getTokenDocument: async token => ({toObject: () => ({...token, actorId: id})}),
        getDependentTokens: () => scenes.flatMap(scene => [...scene.tokens].filter(token => token.actorId === id))};
      actors.push(actor);
      return actor;
    }
  }
  const previous = {CONFIG: globalThis.CONFIG, foundry: globalThis.foundry};
  globalThis.CONFIG = {Actor: {documentClass: ActorClass}};
  globalThis.foundry = {utils: {randomID: () => `copy${made++}`}};
  try {
    const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes, actors, combats: []};
    const summons = createFoundrySummons({game, companions: {setControllers: async () => {}},
      fromUuid: uuid => ((uuid === "Scene.s.Token.caster") ? caster : actors.find(actor => actor.uuid === uuid) ?? null)});
    const warnings = [];
    const dying = createFoundryDying({game, coordinator: {}, resolveAction: async () => ({ok: false}), logger: {warn: (...args) => warnings.push(args)},
      fromUuid: uuid => actors.find(actor => actor.uuid === uuid) ?? null, removeTokens: (scene, ids) => summons.dismiss(scene, ids)});
    const cast = summon => summons.afterResolution({options: {actor: {uuid: "Actor.caster"}},
      state: {source: {tokenRef: "Scene.s.Token.caster"}, targets: [{tokenId: target.id}], configuration: {castingLevel: 7},
        actionDefinition: {id: "action:simulacrum", label: "Simulacrum", metadata: {spellLevel: 7}, summon}}});
    // The GM drags a Token of the copy from the sidebar onto the other Scene: it carries the prototype's flags.
    const dragged = copy => there.createEmbeddedDocuments("Token", [{actorId: copy.id, flags: structuredClone(copy.prototypeToken.flags)}]);
    const spec = {copyTarget: true, limit: 1, leavesAtDeath: true, dispellable: true};
    const [first] = await cast(spec);
    const [old] = actors;
    assert.deepEqual([first.flags.wildpath.leavesAtDeath, old.prototypeToken.flags.wildpath.leavesAtDeath], [true, true],
      "its placed Token and one dragged from the sidebar leave at its death");
    assert.equal(first.flags.wildpath.summon.castLevel, 7, "dispellable: it lasts until dispelled, at the level it was cast at");
    // A recast counts the copy once, with its two Tokens, and ends it whole before the new one is made.
    const [far] = await dragged(old);
    events.length = 0;
    await cast(spec);
    assert.deepEqual(events, [`delete ${first.id}`, `delete ${far.id}`, `delete ${old.id}`], "its Tokens on every Scene, then its Actor");
    // A Token the GM deletes by hand leaves the copy; a recast still ends that copy, though no Token stands for it.
    const [second] = actors;
    await here.deleteEmbeddedDocuments("Token", [...here.tokens].filter(token => token.actorId === second.id).map(token => token.id));
    assert.deepEqual(actors, [second], "a hand-deleted Token never deletes its copy");
    events.length = 0;
    const [third] = await cast(spec);
    assert.deepEqual([events, actors.length], [[`delete ${second.id}`], 1], "the copy with no Token went before the new one");
    // Its death settles: every Token of it leaves and its Actor is deleted, once.
    const [thirdFar] = await dragged(actors[0]);
    events.length = 0;
    await dying.settleDeaths([actors[0].uuid]);
    assert.deepEqual([events, actors, warnings], [[`delete ${third.id}`, `delete ${thirdFar.id}`, `delete ${third.actorId}`], [], []]);
    // Dispelled (the runtime's endSummon is dismissCast): the same.
    const [fourth] = await cast(spec);
    await summons.dismissCast(here, [fourth.id]);
    assert.deepEqual([here.tokens.get(fourth.id), actors], [undefined, []]);
    // Without leavesAtDeath its Tokens stay at its death (a plain summon's corpse stays too).
    const [fifth] = await cast({copyTarget: true});
    assert.equal("leavesAtDeath" in fifth.flags.wildpath, false);
    await dying.settleDeaths([actors[0].uuid]);
    assert.deepEqual([Boolean(here.tokens.get(fifth.id)), actors.length], [true, 1]);
    // The GM's Duplicate of a copy carries its flags, its mark naming the other id, so it is the GM's Actor: a recast,
    // or its death, dismisses its Tokens but never deletes it.
    const [original] = actors;
    const {name, flags, prototypeToken, system} = structuredClone({name: original.name, flags: original.flags,
      prototypeToken: original.prototypeToken, system: original.system});
    const duplicate = {name, flags, prototypeToken, system, effects: [], id: "dup", uuid: "Actor.dup", delete: async () => events.push("delete dup"),
      getDependentTokens: () => scenes.flatMap(scene => [...scene.tokens].filter(token => token.actorId === "dup"))};
    actors.push(duplicate);
    const [dupToken] = await dragged(duplicate);
    events.length = 0;
    const [sixth] = await cast(spec);
    assert.deepEqual([events.includes(`delete ${original.id}`), events.includes("delete dup"), Boolean(there.tokens.get(dupToken.id))],
      [true, false, false], "the copy ends whole; the Duplicate's Token is dismissed and the Duplicate kept");
    assert.deepEqual(actors.map(actor => actor.id), ["dup", sixth.actorId]);
    const [dying2] = await there.createEmbeddedDocuments("Token", [{actorId: "dup",
      flags: {wildpath: {...structuredClone(duplicate.prototypeToken.flags.wildpath), leavesAtDeath: true}}}]);
    events.length = 0;
    await dying.settleDeaths(["Actor.dup"]);
    assert.deepEqual([events, actors.map(actor => actor.id)], [[`delete ${dying2.id}`], ["dup", sixth.actorId]],
      "its Token leaves at its death; the Duplicate stays");
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("copyTarget's shape: one creature source, pools full or empty, and rules and system only on a copy, never its companion", () => {
  const valid = summon => validateActionDefinition({schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon}).ok;
  const halve = {schemaVersion: 1, id: "half", type: "Modifier", data: {domains: ["resources.health.max.multiplier"], value: 0.5}};
  assert.equal(valid({copyTarget: true}), true);
  assert.equal(valid({copyTarget: {pools: {"spell-slot": "full", "heroic-inspiration": "empty"}}, rules: [halve], system: {dyingMode: "dies"}}), true);
  assert.equal(valid({copyTarget: true, actorRef: "Actor.wolf"}), false, "one source");
  assert.equal(valid({copyTarget: false}), false);
  assert.equal(valid({copyTarget: {pools: {"spell-slot": "half"}}}), false);
  assert.equal(valid({copyTarget: true, count: 2}), false, "one creature");
  assert.equal(valid({copyTarget: true, fromKilled: {types: ["humanoid"]}}), false);
  assert.equal(valid({copyTarget: true, bonuses: {ac: 2}}), false, "a copy's changes are its rules and system, not refused silently");
  assert.equal(valid({copyTarget: true, match: {attacks: true}}), false);
  assert.equal(valid({actorRef: "Actor.wolf", rules: [halve]}), false, "rules only on a copy this wave");
  assert.equal(valid({copyTarget: true, system: {companion: {kind: "companion"}}}), false, "control is set as it is placed");
  assert.equal(valid({copyTarget: true, system: "construct"}), false);
  assert.equal(valid({copyTarget: true, rules: [{schemaVersion: 1, id: "x", type: "NoSuchRule", data: {}}]}), false);
  assert.equal(valid({copyTarget: true, rules: halve}), false);
  // Its endings (wave D B10): booleans, on any summon.
  assert.equal(valid({copyTarget: true, leavesAtDeath: true, dispellable: true}), true);
  assert.equal(valid({actorRef: "Actor.wolf", leavesAtDeath: false, dispellable: false}), true);
  assert.equal(valid({actorRef: "Actor.wolf", leavesAtDeath: "yes"}), false);
  assert.equal(valid({actorRef: "Actor.wolf", dispellable: 1}), false);
});

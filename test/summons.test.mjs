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
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.zombie", fromKilled: {types: ["humanoid"]}})).ok, true);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.zombie", fromKilled: {types: []}})).ok, false);
});

test("summons join their caster's combat right after it, though the tracker shows another, and leave it with their Tokens", async () => {
  const {createFoundrySummons} = await import("../module/adapters/foundry-v14-summons.mjs");
  const calls = [];
  const combatants = [{id: "cc", tokenId: "caster", sceneId: "s", initiative: 12}];
  const combat = {id: "c", round: 1, turn: 0, started: true, combatants,
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
  // The GM's tracker (`game.combat`) shows a fight on another Scene.
  const elsewhere = {id: "e", round: 4, turn: 2, started: true, combatants: [{id: "x", tokenId: "other", sceneId: "s2"}],
    createEmbeddedDocuments: async () => calls.push(["create elsewhere"])};
  const summons = createFoundrySummons({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combat: elsewhere,
    combats: [elsewhere, combat], scenes: [scene]},
    companions: {setControllers: async () => {}}, fromUuid: uuid => ({"Scene.s.Token.caster": casterToken, "Actor.wolf": wolf})[uuid] ?? null});
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 2, rounds: 1}}}});
  const joined = calls.find(call => call[0] === "create")[2];
  assert.deepEqual(joined.map(entry => [entry.tokenId, entry.initiative]), [["t0", 11.999], ["t1", 11.998]]);
  assert.deepEqual(tokens.get("t0").flags.wildpath.summon.createdAt, {combatId: "c", round: 1, turn: 0}, "its rounds count in its caster's combat");
  await summons.onTurnStart({id: "c", round: 2, turn: 0});
  assert.deepEqual(calls.filter(call => call[0] === "delete").map(call => call.slice(1)),
    [["Combatant", ["w0", "w1"]], ["Token", ["t0", "t1"]]], "combatants go before their Tokens");
  // An encounter set up but not begun yet: they still join at the caster's Initiative.
  calls.length = 0;
  combat.started = false;
  await summons.afterResolution({options: {actor: {uuid: "Actor.caster"}}, state: {source: {tokenRef: "Scene.s.Token.caster"},
    actionDefinition: {summon: {actorRef: "Actor.wolf", count: 1, rounds: 1}}}});
  assert.deepEqual(calls.find(call => call[0] === "create")?.[2].map(entry => entry.initiative), [11.999]);
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

test("a creature the Action killed rises as its summon in its own space, its caster's, after it in combat (fromKilled)", async () => {
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
  const zombie = {uuid: "Actor.zombie", getTokenDocument: async data => ({toObject: () => ({...data})})};
  const controlled = [];
  const created = [];
  const combat = {id: "c", round: 1, turn: 0, started: true, combatants: [{id: "cc", tokenId: "caster", sceneId: "s", initiative: 15}],
    createEmbeddedDocuments: async (type, data) => created.push(...data)};
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
  assert.deepEqual(created.map(entry => [entry.tokenId, entry.initiative]), [[risen[0].id, 14.999]], "its turn right after its caster's");
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
  const worldActor = data => {
    const actor = {...data, id: `a${++made}`, uuid: `Actor.a${made}`, toObject: () => data,
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
  const previous = globalThis.CONFIG;
  globalThis.CONFIG = {Actor: {documentClass: {create: async data => worldActor(data)}}};
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
    // Kept: a GM's own Actor, an import a GM gave a Player by hand, and any import while a Player's client sees a Token go.
    const own = worldActor({name: "Wolf"});
    const given = worldActor({name: "Sphere", ownership: {default: 0, gm: 3, player: 3}, flags: {wildpath: {summonSource: sphere.uuid}}});
    const summoned = {wildpath: {summon: {kind: "summon"}}};
    await summons.onTokenDeleted({actorId: own.id, flags: summoned});
    await summons.onTokenDeleted({actorId: given.id, flags: summoned});
    assert.equal(actors.length, 2);
    const stale = worldActor({name: "Sphere", ownership: {default: 0, gm: 3}, flags: {wildpath: {summonSource: "Compendium.x.y.Actor.z"}}});
    gm = "other";
    await summons.onTokenDeleted({actorId: stale.id, flags: summoned});
    assert.equal(actors.length, 3, "only the active GM deletes");
    gm = "gm";
    await summons.onTokenDeleted({actorId: stale.id, flags: summoned});
    assert.deepEqual(actors.map(actor => actor.name), ["Wolf", "Sphere"]);
    assert.equal(actors[1], given);
  } finally {
    globalThis.CONFIG = previous;
  }
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryFalling, fallDamageDice} from "../module/adapters/foundry-v14-falling.mjs";

test("a fall hurts 1d6 per full 10 feet, 20d6 at most", () => {
  assert.deepEqual([0, 9, 10, 35, 500].map(fallDamageDice), [0, 0, 1, 3, 20]);
});

test("a creature in the air that gets Prone, or loses its Speed, falls unless it can hover", async () => {
  const resolved = [];
  const coordinator = {resolveAuthorityAction: async ({resolved: options, onComplete}) => {
    resolved.push(options.action.system.definition);
    onComplete({state: {status: "completed"}});
    return {ok: true, state: {status: "completed"}};
  }};
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, i18n: {localize: () => "Falling"}};
  const falling = createFoundryFalling({game, coordinator, resolveAction: async options => ({ok: true, action: options.action})});
  const token = (elevation, level=null) => ({id: "bat", elevation, level, updates: [], parent: {id: "scene",
    levels: {get: id => (id === "upper" ? {elevation: {bottom: 20}} : undefined)}}, async update(data, operation) { this.updates.push({data, operation}); }});
  const actor = (bat, movement=[]) => ({uuid: "Actor.bat", isToken: true, token: bat, getGrantedMovement: () => movement});

  const flying = token(35);
  await falling.onEffectCreated({parent: actor(flying), statuses: new Set(["prone"])});
  assert.deepEqual(flying.updates, [{data: {elevation: 0}, operation: {wildpath: {movementKind: "forced"}}}], "to the floor, as forced movement");
  assert.deepEqual(resolved[0].damage, [{id: "fall", expression: {type: "dice", number: 3, faces: 6}, damageType: "bludgeoning"}]);
  assert.equal(resolved[0].effects[0].conditionId, "prone");

  const hovering = token(35);
  await falling.onEffectCreated({parent: actor(hovering, [{hover: true}]), statuses: new Set(["prone"])});
  assert.deepEqual(hovering.updates, [], "a creature that can hover stays up");
  const grounded = token(0);
  await falling.onEffectCreated({parent: actor(grounded), statuses: new Set(["stunned"])});
  assert.deepEqual(grounded.updates, [], "on the floor already");
  const upstairs = token(25, "upper");
  await falling.onEffectCreated({parent: actor(upstairs), statuses: new Set(["restrained"])});
  assert.deepEqual(upstairs.updates[0].data, {elevation: 20}, "to its own Level's floor");
  assert.equal(resolved.length, 1, "5 feet: no damage");
  const blessed = token(30);
  await falling.onEffectCreated({parent: actor(blessed), statuses: new Set(["blessed"])});
  assert.deepEqual(blessed.updates, [], "other effects do nothing");
  // A linked creature whose Token is on a Scene the GM's canvas does not show still falls.
  const away = token(20);
  await falling.onEffectCreated({parent: {uuid: "Actor.bat", getActiveTokens: () => [], getDependentTokens: () => [away],
    getGrantedMovement: () => []}, statuses: new Set(["prone"])});
  assert.deepEqual(away.updates[0]?.data, {elevation: 0}, "on its own Scene");
});

test("an Action's fall drops each creature that failed its save (every target without one) its feet and resolves that fall once", async t => {
  const resolved = [];
  const coordinator = {resolveAuthorityAction: async ({resolved: options, onComplete}) => {
    resolved.push({definition: options.action.system.definition, intent: options.intent});
    onComplete({state: {status: "completed"}});
    return {ok: true, state: {status: "completed"}};
  }};
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, i18n: {localize: () => "Falling"}};
  const scene = {id: "scene", levels: {get: () => undefined}, tokens: null};
  const token = (id, elevation=0) => ({id, elevation, level: null, parent: scene, updates: [],
    actor: {uuid: `Actor.${id}`, getGrantedMovement: () => [{hover: true}]},
    async update(data, operation) { this.updates.push({data, operation}); Object.assign(this, data); }});
  const list = [token("caster"), token("failed"), token("saved"), token("ledge", 50)];
  scene.tokens = {get: id => list.find(entry => entry.id === id)};
  const falling = createFoundryFalling({game, coordinator, resolveAction: async options => ({ok: true, ...options}),
    fromUuid: uuid => (uuid === "Scene.scene.Token.caster" ? list[0] : null)});
  const save = (success, tokenId) => ({ok: true, success, target: {tokenId}});
  const state = {source: {tokenRef: "Scene.scene.Token.caster"}, actionDefinition: {save: {ability: "agility"}, fall: {feet: 40}},
    results: {saveResolution: {results: [save(false, "failed"), save(true, "saved"), save(false, "ledge")]}}};

  const fallen = await falling.afterResolution({state});
  assert.deepEqual(fallen.map(entry => entry.id), ["failed", "ledge"], "one that saved stays");
  assert.deepEqual(list[1].updates, [{data: {elevation: -40}, operation: {wildpath: {movementKind: "forced"}}}],
    "40 feet below where it stood, as forced movement, though it can hover");
  assert.equal(list[3].elevation, -40, "the opening is in the floor: one 50 feet above it falls 90 feet into it");
  assert.deepEqual(resolved.map(entry => entry.definition.damage[0].expression), [{type: "dice", number: 4, faces: 6},
    {type: "dice", number: 9, faces: 6}], "a 40-foot fall, and a 90-foot one");
  assert.deepEqual(resolved[0].definition.effects, [{id: "fall-prone", type: "condition", conditionId: "prone", whenDamaged: true}],
    "Prone only if the fall hurt it (an immune creature stays standing)");
  assert.deepEqual(resolved[0].intent.targetRefs, [{actorRef: "Actor.failed", tokenId: "failed", sceneId: "scene"}]);
  await falling.onEffectCreated({parent: {uuid: "Actor.failed", isToken: true, token: list[1], getGrantedMovement: () => []},
    statuses: new Set(["prone"])});
  assert.equal(list[1].updates.length, 1, "the Prone it lands with does not drop it again");
  await falling.onEffectCreated({parent: {uuid: "Actor.ledge", isToken: true, token: list[3], getGrantedMovement: () => []},
    statuses: new Set(["prone"])});
  assert.equal(list[3].updates.length, 1, "nor one that fell from above the floor");
  assert.equal(resolved.length, 2);

  const all = await falling.afterResolution({state: {...state, actionDefinition: {fall: {feet: 5}}, targets: [{tokenId: "saved"}]}});
  assert.deepEqual([all.map(entry => entry.id), list[2].elevation, resolved.length], [["saved"], -5, 2],
    "without a save every target falls; under 10 feet, no damage");
  const missed = await falling.afterResolution({state: {...state, actionDefinition: {attack: {type: "melee"}, fall: {feet: 10}},
    results: {attackResolution: {hits: [{target: {tokenId: "saved"}}]}}, targets: [{tokenId: "saved"}, {tokenId: "failed"}]}});
  assert.deepEqual([missed.map(entry => entry.id), list[2].elevation, list[1].elevation], [["saved"], -15, -40],
    "with an attack, only the creatures it hit fall, one already in a pit from where it stands");
  // No feet of its own: as deep as the opening whose trigger ran it (parentArea's depth), none without one.
  const opening = {...state, actionDefinition: {fall: {}}, targets: [{tokenId: "caster"}]};
  assert.deepEqual(await falling.afterResolution({state: opening, options: {parentArea: {regionId: "fissure"}}}), [],
    "an area with no depth drops nobody");
  const intoIt = await falling.afterResolution({state: opening, options: {parentArea: {regionId: "fissure", depth: 30}}});
  assert.deepEqual([intoIt.map(entry => entry.id), list[0].elevation], [["caster"], -30], "the fissure's 30 feet");
  assert.deepEqual(await createFoundryFalling({game: {...game, user: {id: "player"}}, coordinator, resolveAction: async () => ({ok: true}),
    fromUuid: () => list[0]}).afterResolution({state}), [], "only the active GM");
  const warned = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await createFoundryFalling({game, coordinator, resolveAction: async () => ({ok: true})}).afterResolution({state}), []);
  assert.match(String(warned.mock.calls[0]?.arguments[0]), /WILDPATH\.NOTICE\.FallNoToken/, "no source Token: the GM is told");
});

test("the runtime resolves an Action's fall once it completes, after its pushes", async () => {
  // registerFoundryV14MultiplayerResolution's afterCompleted has no harness of its own; its order is read from its source.
  const {readFileSync} = await import("node:fs");
  const runtime = readFileSync(new URL("../module/resolvers/foundry-multiplayer-runtime.mjs", import.meta.url), "utf8");
  const fall = runtime.indexOf("await falling.afterResolution(event)");
  assert.ok(fall > runtime.indexOf("await pushes.afterResolution(event)"));
  assert.ok(fall < runtime.indexOf("await dying.settleDeaths(killed)"));
});

test("a fall's feet are a positive number, kept on the Action, or none: as deep as the opening that ran it", async () => {
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const definition = {schemaVersion: 1, id: "action:pit", label: "Pit", costs: {allOf: []}, targeting: {type: "self"}};
  assert.equal(validateActionDefinition({...definition, fall: {feet: 10}}).ok, true);
  assert.equal(validateActionDefinition({...definition, fall: {}}).ok, true, "its depth is the area's (parentArea)");
  for ( const fall of [{feet: 0}, {feet: "deep"}, [10]] ) {
    assert.deepEqual(validateActionDefinition({...definition, fall}).errors.map(error => error.path), ["fall.feet"]);
  }
});

test("a push out of an area has no distance, direction or landing, and out is true or false", async () => {
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const definition = {schemaVersion: 1, id: "action:edge", label: "Edge", costs: {allOf: []}, targeting: {type: "self"},
    save: {ability: "agility", dc: {value: 15}}};
  assert.equal(validateActionDefinition({...definition, push: {out: true, on: "success", maxSize: "large"}}).ok, true);
  for ( const [push, path] of [[{out: true, distance: 10}, "push.distance"], [{out: true, toward: true}, "push.toward"],
    [{out: true, choose: "space"}, "push.choose"], [{out: true, thrown: true}, "push.thrown"], [{out: false}, "push.distance"]] ) {
    assert.ok(validateActionDefinition({...definition, push}).errors.some(error => error.path === path), JSON.stringify(push));
  }
  assert.ok(validateActionDefinition({...definition, push: {out: "yes"}}).errors.some(error => error.path === "push.out"));
});

test("a fly Speed that can hover says so (GrantMovement hover)", async () => {
  const {grantedMovementFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const owners = [{ruleElements: [{schemaVersion: 1, id: "fly", type: "GrantMovement", data: {mode: "fly", distance: 90, hover: true}},
    {schemaVersion: 1, id: "swim", type: "GrantMovement", data: {mode: "swim", distance: 30}}]}];
  assert.deepEqual(grantedMovementFromRuleElements(owners).map(movement => [movement.mode, movement.hover ?? false]),
    [["fly", true], ["swim", false]]);
});

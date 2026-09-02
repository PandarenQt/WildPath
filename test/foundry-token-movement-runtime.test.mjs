import {test} from "node:test";
import assert from "node:assert/strict";
import {
  MOVEMENT_KINDS,
  MOVEMENT_MEASUREMENT_MODES
} from "../module/helpers/movement.mjs";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  fieldKey
} from "../module/helpers/grid-footprints.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope,
  isPlainSerializableData
} from "../module/helpers/multiplayer-authority.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {
  FOUNDRY_GRID_TYPES,
  FOUNDRY_HEX_OFFSET_VARIANTS
} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {
  FOUNDRY_MOVEMENT_CODES,
  buildFoundryMovementCompletion,
  buildFoundryMovementIntent,
  foundryMovementIntentToMovementPath
} from "../module/adapters/foundry-v14-movement-adapter.mjs";
import {createMultiplayerMovementAuthority} from "../module/resolvers/multiplayer-movement-authority.mjs";
import WildPathTokenDocument from "../module/documents/token.mjs";

/* -------------------------------------------- */
/*  Fixtures                                    */
/* -------------------------------------------- */

class FakeSquareGrid {
  constructor({distance=5, units="ft", size=50}={}) {
    this.type = FOUNDRY_GRID_TYPES.SQUARE;
    this.isSquare = true;
    this.isHexagonal = false;
    this.isGridless = false;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }

  getOffset(point) {
    return {i: Math.floor(Number(point.x) / this.sizeX), j: Math.floor(Number(point.y) / this.sizeY)};
  }

  getCenterPoint(offset) {
    return {x: (Number(offset.i) + 0.5) * this.sizeX, y: (Number(offset.j) + 0.5) * this.sizeY};
  }

  getVertices(offset) {
    const x = Number(offset.i) * this.sizeX;
    const y = Number(offset.j) * this.sizeY;
    return [{x, y}, {x: x + this.sizeX, y}, {x: x + this.sizeX, y: y + this.sizeY}, {x, y: y + this.sizeY}];
  }

  getAdjacentOffsets(offset) {
    return [
      {i: offset.i, j: offset.j - 1},
      {i: offset.i + 1, j: offset.j},
      {i: offset.i, j: offset.j + 1},
      {i: offset.i - 1, j: offset.j}
    ];
  }
}

class FakeHexGrid {
  constructor({distance=5, units="ft", size=50}={}) {
    this.type = FOUNDRY_GRID_TYPES.HEXODDR;
    this.isSquare = false;
    this.isHexagonal = true;
    this.isGridless = false;
    this.columns = false;
    this.even = false;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }

  get variant() {
    return FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R;
  }

  getOffset(point) {
    return {i: Math.floor(Number(point.x) / this.sizeX), j: Math.floor(Number(point.y) / this.sizeY)};
  }

  getCenterPoint(offset) {
    return {x: (Number(offset.i) + 0.5) * this.sizeX, y: (Number(offset.j) + 0.5) * this.sizeY};
  }

  getVertices(offset) {
    const center = this.getCenterPoint(offset);
    return Array.from({length: 6}, (_, index) => {
      const angle = (Math.PI / 3) * index;
      return {
        x: center.x + Math.cos(angle) * (this.size / 2),
        y: center.y + Math.sin(angle) * (this.size / 2)
      };
    });
  }

  getAdjacentOffsets(offset) {
    return [
      {i: offset.i + 1, j: offset.j},
      {i: offset.i + 1, j: offset.j - 1},
      {i: offset.i, j: offset.j - 1},
      {i: offset.i - 1, j: offset.j},
      {i: offset.i - 1, j: offset.j + 1},
      {i: offset.i, j: offset.j + 1}
    ];
  }

  offsetToCube(offset) {
    const q = Number(offset.i);
    const r = Number(offset.j);
    return {q, r, s: -q - r};
  }

  cubeToOffset(cube) {
    return {i: Number(cube.q), j: Number(cube.r)};
  }
}

const PLAYER = {id: "player-a", name: "Player", active: true, isGM: false, isSelf: true};
const OTHER_PLAYER = {id: "player-b", name: "Other Player", active: true, isGM: false};
const GM = {id: "gm-a", name: "GM", active: true, isGM: true, isActiveGM: true};

function actorSystem({movement=30, maxMovement=30, size=CREATURE_SIZES.MEDIUM}={}) {
  return {
    traits: {size},
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: movement, max: maxMovement}
    },
    pools: []
  };
}

function fakeActor(id, {movement=30, maxMovement=30, size=CREATURE_SIZES.MEDIUM, owners=["player-a"]}={}) {
  return {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system: actorSystem({movement, maxMovement, size}),
    effects: [],
    token: null,
    tokens: [],
    getActiveTokens() {
      return this.tokens;
    },
    testUserPermission(user) {
      return user?.isGM === true || owners.includes(user?.id);
    }
  };
}

function fakeScene(grid, {id="scene-a"}={}) {
  const scene = {
    id,
    uuid: `Scene.${id}`,
    name: id,
    grid,
    dimensions: {
      distance: grid.distance,
      units: grid.units,
      size: grid.size,
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 1000,
      sceneHeight: 1000,
      columns: 20,
      rows: 20
    },
    tokens: new Map()
  };
  return scene;
}

function fakeTokenDocument({
  id="token-a",
  actor,
  scene,
  offset={i: 0, j: 0},
  size=actor?.system?.traits?.size ?? CREATURE_SIZES.MEDIUM,
  expandCompletePath=true,
  includeOriginInCompletePath=true,
  owners=["player-a"]
}={}) {
  const token = Object.assign(new WildPathTokenDocument(), {
    documentName: "Token",
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    parent: scene,
    actor,
    wildpathSize: size,
    completePathCalls: 0,
    lastCompletePathWaypoints: null,
    expandCompletePath,
    includeOriginInCompletePath,
    disposition: 1,
    setOffset(nextOffset) {
      this.x = Number(nextOffset.i) * scene.grid.sizeX;
      this.y = Number(nextOffset.j) * scene.grid.sizeY;
      this.offset = {i: Number(nextOffset.i), j: Number(nextOffset.j)};
    },
    getOccupiedGridSpaceOffsets() {
      const base = scene.grid.getOffset({x: this.x, y: this.y});
      if ( scene.grid.isSquare && size === CREATURE_SIZES.LARGE ) {
        return [
          base,
          {i: base.i + 1, j: base.j},
          {i: base.i, j: base.j + 1},
          {i: base.i + 1, j: base.j + 1}
        ];
      }
      return [base];
    },
    getCompleteMovementPath(waypoints) {
      this.completePathCalls += 1;
      this.lastCompletePathWaypoints = JSON.parse(JSON.stringify(waypoints));
      return completeMovementPathForToken(this, waypoints, {
        expand: this.expandCompletePath,
        includeOrigin: this.includeOriginInCompletePath
      });
    },
    testUserPermission(user) {
      return user?.isGM === true || owners.includes(user?.id);
    }
  });
  token.setOffset(offset);
  scene.tokens.set(token.id, token);
  if ( actor ) {
    actor.token = token;
    actor.tokens = [token];
  }
  return token;
}

function fakeGame({user=PLAYER, users=[PLAYER, GM], scenes=[], actors=[], movementMode=MOVEMENT_MEASUREMENT_MODES.DISTANCE}={}) {
  const userCollection = new Map(users.map(entry => [entry.id, {...entry, isSelf: entry.id === user.id}]));
  userCollection.activeGM = userCollection.get("gm-a") ?? null;
  return {
    user: userCollection.get(user.id) ?? user,
    userId: user.id,
    users: userCollection,
    scenes: new Map(scenes.map(scene => [scene.id, scene])),
    actors: new Map(actors.map(actor => [actor.id, actor])),
    canvas: {scene: scenes[0] ?? null},
    settings: {
      get(namespace, key) {
        return namespace === "wildpath" && key === "movementMeasurementMode" ? movementMode : null;
      }
    },
    wildpath: {}
  };
}

function createMovementRuntimeFixture({
  grid=new FakeSquareGrid(),
  actor=fakeActor("actor-a"),
  tokenOptions={},
  measurementMode=MOVEMENT_MEASUREMENT_MODES.DISTANCE
}={}) {
  const scene = fakeScene(grid);
  const token = fakeTokenDocument({actor, scene, ...tokenOptions});
  const users = [PLAYER, OTHER_PLAYER, GM];
  const hub = createTestResolutionTransportHub({users});
  const playerTransport = hub.createEndpoint({userId: PLAYER.id});
  const gmTransport = hub.createEndpoint({userId: GM.id});
  const persistence = createTestDocumentPersistenceAdapter({
    actors: {
      [actor.id]: actor,
      [actor.uuid]: actor
    }
  });
  const playerGame = fakeGame({user: PLAYER, users, scenes: [scene], actors: [actor], movementMode: measurementMode});
  const gmGame = fakeGame({user: GM, users, scenes: [scene], actors: [actor], movementMode: measurementMode});
  const authorityOptions = {
    users: () => hub.userDirectory(),
    activeGMUserId: () => GM.id,
    persistencePort: persistence,
    measurementMode,
    approvalTimeoutMs: 50
  };
  const playerAuthority = createMultiplayerMovementAuthority({
    ...authorityOptions,
    userId: PLAYER.id,
    transport: playerTransport,
    game: playerGame
  });
  const gmAuthority = createMultiplayerMovementAuthority({
    ...authorityOptions,
    userId: GM.id,
    transport: gmTransport,
    game: gmGame
  });
  playerAuthority.register();
  gmAuthority.register();
  playerGame.wildpath.movement = playerAuthority;
  return {
    actor,
    scene,
    token,
    users,
    hub,
    playerGame,
    gmGame,
    playerAuthority,
    gmAuthority,
    persistence,
    warnings: []
  };
}

async function withFoundryGlobals(fixture, fn) {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const warnings = fixture.warnings ?? [];
  globalThis.game = fixture.playerGame;
  globalThis.ui = {
    notifications: {
      warn(message) {
        warnings.push(message);
      }
    }
  };
  try {
    return await fn();
  } finally {
    if ( previousGame === undefined ) delete globalThis.game;
    else globalThis.game = previousGame;
    if ( previousUi === undefined ) delete globalThis.ui;
    else globalThis.ui = previousUi;
  }
}

function movementOperation(token, {id="movement-a", offsets=[{i: 1, j: 0}], kind=null, mode=null}={}) {
  const waypoints = offsets.map((offset, index) => ({
    ...pointForOffset(token.parent, offset),
    index
  }));
  return {
    id,
    origin: pointForToken(token),
    destination: waypoints.at(-1),
    method: "drag",
    pending: {waypoints},
    passed: {waypoints: []},
    finished: Promise.resolve(true),
    ...(kind || mode ? {wildpath: {movementKind: kind, movementMode: mode}} : {})
  };
}

function completeMovementPathForToken(token, waypoints, {expand=true, includeOrigin=true}={}) {
  const grid = token.parent.grid;
  let cursor = grid.getOffset(pointForToken(token));
  const route = includeOrigin ? [pointForOffset(token.parent, cursor)] : [];
  for ( const waypoint of waypoints ) {
    const target = grid.getOffset(waypoint);
    if ( !expand ) {
      cursor = target;
      route.push(pointForOffset(token.parent, cursor));
      continue;
    }
    while ( cursor.i !== target.i || cursor.j !== target.j ) {
      if ( cursor.i !== target.i ) cursor = {...cursor, i: cursor.i + Math.sign(target.i - cursor.i)};
      else cursor = {...cursor, j: cursor.j + Math.sign(target.j - cursor.j)};
      route.push(pointForOffset(token.parent, cursor));
    }
  }
  return route;
}

function pointForToken(token) {
  return {x: token.x, y: token.y};
}

function pointForOffset(scene, offset) {
  return {
    x: Number(offset.i) * scene.grid.sizeX,
    y: Number(offset.j) * scene.grid.sizeY
  };
}

function anchorKeys(path) {
  return path.anchors.map(anchor => fieldKey(anchor, path.topology));
}

function moveTokenToOffset(token, offset) {
  token.setOffset(offset);
}

/* -------------------------------------------- */
/*  Tests                                       */
/* -------------------------------------------- */

test("production TokenDocument movement routes through active-GM authority and commits movement once", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, hub, gmAuthority, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-medium-square",
    offsets: [{i: 1, j: 0}, {i: 2, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.deepEqual(anchorKeys(approval.path), ["square:0,0", "square:1,0", "square:2,0"]);
  assert.equal(approval.evaluation.valid, true);
  assert.equal(approval.evaluation.cost.amount, 10);
  assert.equal(approval.evaluation.affordable, true);
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_INTENT), true);
  assert.equal(hub.messages.every(message => isPlainSerializableData(message)), true);

  moveTokenToOffset(token, {i: 2, j: 0});
  await withFoundryGlobals(fixture, async () => {
    token._onUpdateMovement(movement, {}, {...PLAYER, isSelf: true});
    const committed = await token._wildpathLastMovementCommit;
    assert.equal(committed.ok, true);
  });

  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT), true);
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_RESULT), true);
});

test("unaffordable TokenDocument movement is rejected before commit and leaves budget unchanged", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-too-far",
    offsets: [{i: 7, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.equal(allowed, false);
  });

  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(token.x, 0);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.playerAuthority.errors.at(-1).approval.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_UNAFFORDABLE);
});

test("ordinary movement rejects non-adjacent topology when Foundry complete path is not expanded", async () => {
  const fixture = createMovementRuntimeFixture({
    tokenOptions: {
      expandCompletePath: false
    }
  });
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-endpoint-shortcut",
    offsets: [{i: 2, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.equal(allowed, false);
  });

  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.playerAuthority.errors.at(-1).approval.code, "NON_ADJACENT_STEP");
});

test("Foundry segment endpoint waypoints are expanded before MovementPath evaluation", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, scene, gmGame} = fixture;
  const movement = movementOperation(token, {
    id: "move-expanded",
    offsets: [{i: 3, j: 0}]
  });
  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: gmGame
  });

  assert.equal(built.ok, true);
  assert.equal(built.intent.waypoints.length, 1);
  const translated = foundryMovementIntentToMovementPath({
    intent: built.intent,
    tokenDocument: token,
    scene
  });

  assert.equal(translated.ok, true);
  assert.equal(token.completePathCalls, 1);
  assert.equal(token.lastCompletePathWaypoints.length, 1);
  assert.deepEqual(anchorKeys(translated.path), ["square:0,0", "square:1,0", "square:2,0", "square:3,0"]);
});

test("large square movement reconstructs the 2x2 footprint from the Foundry token", async () => {
  const actor = fakeActor("large-actor", {size: CREATURE_SIZES.LARGE});
  const fixture = createMovementRuntimeFixture({
    actor,
    tokenOptions: {
      id: "large-token",
      size: CREATURE_SIZES.LARGE
    }
  });
  const {token, gmAuthority} = fixture;
  const movement = movementOperation(token, {
    id: "move-large-square",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.equal(approval.path.size, CREATURE_SIZES.LARGE);
  assert.deepEqual(new Set(approval.evaluation.footprints[1].fieldKeys), new Set([
    "square:1,0",
    "square:2,0",
    "square:1,1",
    "square:2,1"
  ]));
});

test("hex Foundry adapter movement produces hex MovementPath anchors", async () => {
  const fixture = createMovementRuntimeFixture({
    grid: new FakeHexGrid()
  });
  const {token, gmAuthority} = fixture;
  const movement = movementOperation(token, {
    id: "move-hex",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.equal(approval.path.topology, GRID_TOPOLOGIES.HEX);
  assert.deepEqual(anchorKeys(approval.path), ["hex:0,0", "hex:1,0"]);
  assert.equal(approval.evaluation.valid, true);
});

test("duplicate completed movement spends ordinary movement budget only once", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-duplicate-completion",
    offsets: [{i: 2, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  moveTokenToOffset(token, {i: 2, j: 0});

  const completion = buildFoundryMovementCompletion({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  }).completion;
  const first = await fixture.playerAuthority.commitMovementCompletion(completion);
  const second = await fixture.playerAuthority.commitMovementCompletion(completion);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
});

test("rejected movement completion does not spend without a valid approval record", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-rejected-completion",
    offsets: [{i: 7, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.equal(await token._preUpdateMovement(movement, {}), false);
  });
  moveTokenToOffset(token, {i: 7, j: 0});
  const completion = buildFoundryMovementCompletion({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  }).completion;
  const result = await fixture.playerAuthority.commitMovementCompletion(completion);

  assert.equal(result.ok, true);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.gmAuthority.errors.length, 0);
});

test("wrong user, wrong token, and stale movement id cannot reuse an approval", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, scene, token, gmAuthority} = fixture;
  const otherToken = fakeTokenDocument({
    id: "token-b",
    actor: fakeActor("actor-b"),
    scene,
    offset: {i: 0, j: 1}
  });
  const movement = movementOperation(token, {
    id: "move-secure",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  moveTokenToOffset(token, {i: 1, j: 0});

  const completion = buildFoundryMovementCompletion({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  }).completion;
  const wrongUserEnvelope = createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
    senderUserId: OTHER_PLAYER.id,
    recipientUserId: GM.id,
    resolutionId: completion.resolutionId,
    payload: {
      completion: {...completion, sourceUserId: OTHER_PLAYER.id}
    }
  });
  const wrongUser = await gmAuthority.handleEnvelope(wrongUserEnvelope);
  assert.equal(wrongUser.result.code, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER);
  assert.equal(actor.system.resources.movement.value, 30);

  const wrongToken = await fixture.playerAuthority.commitMovementCompletion({
    ...completion,
    tokenRef: {
      ...completion.tokenRef,
      id: otherToken.id,
      ref: otherToken.uuid,
      uuid: otherToken.uuid
    }
  });
  assert.equal(wrongToken.ok, true);
  assert.equal(fixture.playerAuthority.errors.at(-1).result.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_NOT_APPROVED);
  assert.equal(actor.system.resources.movement.value, 30);

  const staleId = await fixture.playerAuthority.commitMovementCompletion({
    ...completion,
    movementId: "move-secure-stale",
    resolutionId: "movement:move-secure-stale"
  });
  assert.equal(staleId.ok, true);
  assert.equal(fixture.playerAuthority.errors.at(-1).result.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_NOT_APPROVED);
  assert.equal(actor.system.resources.movement.value, 30);
});

test("MovementIntent and movement socket envelopes survive JSON round-trip without Foundry objects", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, hub} = fixture;
  const movement = movementOperation(token, {
    id: "move-serializable",
    offsets: [{i: 1, j: 0}]
  });
  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  });

  assert.equal(built.ok, true);
  assert.equal(isPlainSerializableData(built.intent), true);
  assert.deepEqual(JSON.parse(JSON.stringify(built.intent)), built.intent);

  await fixture.playerAuthority.requestMovementApproval(built.intent);
  for ( const message of hub.messages ) {
    assert.equal(isPlainSerializableData(message), true);
    assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
  }
});

test("explicit forced and teleport movement preserve no-ordinary-budget semantics", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token} = fixture;

  const forced = movementOperation(token, {
    id: "move-forced",
    offsets: [{i: 1, j: 0}],
    kind: MOVEMENT_KINDS.FORCED,
    mode: "walk"
  });
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(forced, {}), false);
  });
  moveTokenToOffset(token, {i: 1, j: 0});
  await fixture.playerAuthority.commitMovementCompletion(buildFoundryMovementCompletion({
    tokenDocument: token,
    movement: forced,
    user: PLAYER,
    game: fixture.playerGame
  }).completion);

  const teleport = movementOperation(token, {
    id: "move-teleport",
    offsets: [{i: 6, j: 0}],
    kind: MOVEMENT_KINDS.TELEPORT,
    mode: "teleport"
  });
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(teleport, {}), false);
  });
  moveTokenToOffset(token, {i: 6, j: 0});
  await fixture.playerAuthority.commitMovementCompletion(buildFoundryMovementCompletion({
    tokenDocument: token,
    movement: teleport,
    user: PLAYER,
    game: fixture.playerGame
  }).completion);

  assert.equal(actor.system.resources.movement.value, 30);
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
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
import {onFoundryV14MoveToken} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
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
  owners=["player-a"]
}={}) {
  const gridUnits = tokenGridUnitsForSize(size);
  const token = Object.assign(new WildPathTokenDocument(), {
    documentName: "Token",
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    parent: scene,
    actor,
    wildpathSize: size,
    width: gridUnits,
    height: gridUnits,
    depth: gridUnits,
    elevation: 0,
    _source: {},
    _sourcePosition: null,
    completePathCalls: 0,
    lastCompletePathWaypoints: null,
    expandCompletePath,
    disposition: 1,
    setOffset(nextOffset) {
      this.setPreparedOffset(nextOffset);
      this.setSourceOffset(nextOffset);
    },
    setPreparedOffset(nextOffset) {
      this.x = Number(nextOffset.i) * scene.grid.sizeX;
      this.y = Number(nextOffset.j) * scene.grid.sizeY;
      this.offset = {i: Number(nextOffset.i), j: Number(nextOffset.j)};
    },
    setSourceOffset(nextOffset) {
      const point = pointForOffset(scene, nextOffset);
      this._sourcePosition = {
        x: point.x,
        y: point.y,
        elevation: this.elevation,
        width: this.width,
        height: this.height,
        depth: this.depth
      };
      this._source = JSON.parse(JSON.stringify(this._sourcePosition));
    },
    toObject(source=true) {
      const position = source === true
        ? this._sourcePosition
        : {
            x: this.x,
            y: this.y,
            elevation: this.elevation,
            width: this.width,
            height: this.height,
            depth: this.depth
          };
      return JSON.parse(JSON.stringify({
        id: this.id,
        name: this.name ?? this.id,
        ...position
      }));
    },
    getOccupiedGridSpaceOffsets(data=null) {
      const position = explicitFoundryPosition(data) ? data : {x: this.x, y: this.y};
      const base = scene.grid.getOffset(position);
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
        expand: this.expandCompletePath
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
  measurementMode=MOVEMENT_MEASUREMENT_MODES.DISTANCE,
  persistenceOptions={}
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
    },
    ...persistenceOptions
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
  gmGame.wildpath.movement = gmAuthority;
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

async function withFoundryGlobals(fixture, fn, {game=fixture.playerGame}={}) {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const warnings = fixture.warnings ?? [];
  globalThis.game = game;
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

function movementOperation(token, {id="movement-a", offsets=[{i: 1, j: 0}], kind=null, mode=null, finished=true}={}) {
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
    finished: Promise.resolve(finished),
    ...(kind || mode ? {wildpath: {movementKind: kind, movementMode: mode}} : {})
  };
}

function completeMovementPathForToken(token, waypoints, {expand=true}={}) {
  const grid = token.parent.grid;
  if ( !waypoints.length ) return [];
  let cursor = grid.getOffset(waypoints[0]);
  const route = [pointForOffset(token.parent, cursor)];
  for ( const waypoint of waypoints.slice(1) ) {
    const target = grid.getOffset(waypoint);
    if ( !expand ) {
      cursor = target;
      route.push(pointForOffset(token.parent, cursor));
      continue;
    }
    while ( cursor.i !== target.i || cursor.j !== target.j ) {
      if ( cursor.i !== target.i ) cursor = {...cursor, i: cursor.i + Math.sign(target.i - cursor.i)};
      if ( cursor.j !== target.j ) cursor = {...cursor, j: cursor.j + Math.sign(target.j - cursor.j)};
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

function observedTokenAtOffset(token, offset) {
  return observedTokenWithOffsets(token, {
    preparedOffset: offset,
    sourceOffset: offset
  });
}

function observedTokenWithOffsets(token, {preparedOffset, sourceOffset}) {
  const observed = Object.assign(Object.create(Object.getPrototypeOf(token)), token);
  observed.setPreparedOffset(preparedOffset);
  observed.setSourceOffset(sourceOffset);
  return observed;
}

function sourcePointForToken(token) {
  const source = token.toObject(true);
  return {x: source.x, y: source.y};
}

function explicitFoundryPosition(data) {
  return data && typeof data === "object"
    && Number.isFinite(Number(data.x))
    && Number.isFinite(Number(data.y));
}

function tokenGridUnitsForSize(size) {
  switch ( size ) {
    case CREATURE_SIZES.LARGE:
      return 2;
    case CREATURE_SIZES.HUGE:
      return 3;
    case CREATURE_SIZES.GARGANTUAN:
      return 4;
    default:
      return 1;
  }
}

async function runTokenDocumentOnUpdateMovement(fixture, {
  token=fixture.token,
  movement,
  operation={},
  user=PLAYER,
  game=fixture.gmGame
}={}) {
  return withFoundryGlobals(fixture, async () => {
    if ( typeof token._onUpdateMovement !== "function" ) return {
      ok: true,
      ignored: true,
      reason: "WildPath does not account movement in TokenDocument#_onUpdateMovement."
    };
    const returned = token._onUpdateMovement(movement, operation, user);
    if ( token._wildpathLastMovementCommit ) return token._wildpathLastMovementCommit;
    return returned ?? {
      ok: true,
      ignored: true
    };
  }, {game});
}

async function fireMoveTokenHook(fixture, {
  token=fixture.token,
  movement,
  operation={},
  user=PLAYER,
  game=fixture.gmGame
}={}) {
  return withFoundryGlobals(fixture, () => onFoundryV14MoveToken(token, movement, operation, user, {game}), {game});
}

/* -------------------------------------------- */
/*  Tests                                       */
/* -------------------------------------------- */

test("WildPath registers the moveToken hook as the normal movement completion seam", () => {
  const source = readFileSync(new URL("../wildpath.mjs", import.meta.url), "utf8");
  const registrations = source.match(/Hooks\.on\("moveToken"/g) ?? [];
  assert.equal(registrations.length, 1);
  assert.match(source, /onFoundryV14MoveToken/);
});

test("production TokenDocument movement routes through active-GM authority and commits from moveToken once", async () => {
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

  const early = await runTokenDocumentOnUpdateMovement(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(early.ok, true);
  assert.equal(early.ignored, true);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);

  moveTokenToOffset(token, {i: 2, j: 0});
  const playerObserved = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: true},
    game: fixture.playerGame
  });
  assert.equal(playerObserved.ok, true);
  assert.equal(playerObserved.ignored, true);

  const committed = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.committed, true);

  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT), false);
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_RESULT), true);
});

test("moveToken completion verifies source Token state while prepared state remains old", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, gmAuthority, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-source-state-prepared-old",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  }, {game: fixture.gmGame});
  assert.equal(gmAuthority.approvedMovements.size, 1);

  const early = await runTokenDocumentOnUpdateMovement(fixture, {
    movement,
    user: {...GM, isSelf: true},
    game: fixture.gmGame
  });
  assert.equal(early.ok, true);
  assert.equal(early.ignored, true);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.gmAuthority.errors.some(event => event.result?.code === FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH), false);
  assert.equal(fixture.warnings.some(message => message.includes(FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH)), false);

  const observedToken = observedTokenWithOffsets(token, {
    preparedOffset: {i: 0, j: 0},
    sourceOffset: {i: 1, j: 0}
  });
  assert.deepEqual(pointForToken(observedToken), pointForOffset(token.parent, {i: 0, j: 0}));
  assert.deepEqual(sourcePointForToken(observedToken), pointForOffset(token.parent, {i: 1, j: 0}));
  assert.deepEqual(observedToken.getOccupiedGridSpaceOffsets(), [{i: 0, j: 0}]);
  assert.deepEqual(observedToken.getOccupiedGridSpaceOffsets(observedToken.toObject(true)), [{i: 1, j: 0}]);
  const committed = await fireMoveTokenHook(fixture, {
    token: observedToken,
    movement,
    user: {...GM, isSelf: true},
    game: fixture.gmGame
  });

  assert.equal(committed.ok, true);
  assert.equal(committed.committed, true);
  assert.equal(actor.system.resources.movement.value, 25);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
  assert.equal(fixture.gmAuthority.errors.length, 0);
});

test("moveToken completion rejects source state that differs from the approved destination", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-source-mismatch",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  const observedToken = observedTokenWithOffsets(token, {
    preparedOffset: {i: 1, j: 0},
    sourceOffset: {i: 2, j: 0}
  });

  const committed = await fireMoveTokenHook(fixture, {
    token: observedToken,
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(committed.ok, false);
  assert.equal(committed.code, FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH);

  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
});

test("moveToken completion does not trust movement.destination over Token source state", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-destination-disagrees-with-source",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  assert.deepEqual({x: movement.destination.x, y: movement.destination.y}, pointForOffset(token.parent, {i: 1, j: 0}));
  const observedToken = observedTokenWithOffsets(token, {
    preparedOffset: {i: 0, j: 0},
    sourceOffset: {i: 2, j: 0}
  });

  const committed = await fireMoveTokenHook(fixture, {
    token: observedToken,
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(committed.ok, false);
  assert.equal(committed.code, FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
});

test("fake Foundry complete path expands only between supplied waypoints", () => {
  const fixture = createMovementRuntimeFixture();
  const {token} = fixture;
  const destination = pointForOffset(token.parent, {i: 2, j: 0});
  const origin = pointForOffset(token.parent, {i: 0, j: 0});

  const destinationOnly = token.getCompleteMovementPath([destination]);
  const withOrigin = token.getCompleteMovementPath([origin, destination]);

  assert.deepEqual(destinationOnly, [destination]);
  assert.deepEqual(withOrigin, [
    origin,
    pointForOffset(token.parent, {i: 1, j: 0}),
    destination
  ]);
});

test("10-ft orthogonal drag with one raw endpoint expands through the authoritative origin", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, gmAuthority} = fixture;
  const movement = movementOperation(token, {
    id: "move-raw-orthogonal-10",
    offsets: [{i: 2, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.deepEqual(anchorKeys(approval.path), ["square:0,0", "square:1,0", "square:2,0"]);
  assert.equal(approval.evaluation.valid, true);
  assert.equal(approval.evaluation.cost.amount, 10);
  assert.equal(approval.evaluation.failures.some(failure => failure.code === "NON_ADJACENT_STEP"), false);
});

test("adapter does not duplicate origin when Foundry waypoints already include it", () => {
  const fixture = createMovementRuntimeFixture();
  const {token, scene, gmGame} = fixture;
  const movement = movementOperation(token, {
    id: "move-origin-already-present",
    offsets: [{i: 0, j: 0}, {i: 2, j: 0}]
  });
  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: gmGame
  });
  const translated = foundryMovementIntentToMovementPath({
    intent: built.intent,
    tokenDocument: token,
    scene
  });

  assert.equal(translated.ok, true);
  assert.deepEqual(token.lastCompletePathWaypoints.map(({x, y}) => ({x, y})), [
    pointForOffset(token.parent, {i: 0, j: 0}),
    pointForOffset(token.parent, {i: 2, j: 0})
  ]);
  assert.deepEqual(anchorKeys(translated.path), ["square:0,0", "square:1,0", "square:2,0"]);
});

test("square diagonal TokenDocument movement is valid and costs one grid distance per step", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, gmAuthority} = fixture;
  const movement = movementOperation(token, {
    id: "move-square-diagonal",
    offsets: [{i: 1, j: 1}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.deepEqual(anchorKeys(approval.path), ["square:0,0", "square:1,1"]);
  assert.equal(approval.evaluation.valid, true);
  assert.equal(approval.evaluation.transitions[0].adjacent, true);
  assert.equal(approval.evaluation.cost.amount, 5);
});

test("two-step square diagonal route remains ordered route costing", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, gmAuthority} = fixture;
  const movement = movementOperation(token, {
    id: "move-square-diagonal-two-step",
    offsets: [{i: 2, j: 2}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.deepEqual(anchorKeys(approval.path), ["square:0,0", "square:1,1", "square:2,2"]);
  assert.equal(approval.evaluation.valid, true);
  assert.equal(approval.evaluation.transitions.length, 2);
  assert.equal(approval.evaluation.transitions.every(transition => transition.adjacent), true);
  assert.equal(approval.evaluation.cost.amount, 10);
});

test("unaffordable one-endpoint drag rejects before Foundry moves the Token", async () => {
  const actor = fakeActor("slow-actor", {movement: 5, maxMovement: 5});
  const fixture = createMovementRuntimeFixture({actor});
  const {token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-unaffordable-expanded",
    offsets: [{i: 2, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.equal(allowed, false);
  });

  assert.equal(actor.system.resources.movement.value, 5);
  assert.equal(token.x, 0);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.playerAuthority.errors.at(-1).approval.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_UNAFFORDABLE);
});

test("active GM duplicate moveToken observations remain idempotent", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-observed-duplicate",
    offsets: [{i: 1, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  moveTokenToOffset(token, {i: 1, j: 0});

  const first = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(first.ok, true);
  assert.equal(first.committed, true);

  const duplicate = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_ALREADY_COMMITTED);

  assert.equal(actor.system.resources.movement.value, 25);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
});

test("moveToken observation does not spend when Foundry movement finished false", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-finished-false",
    offsets: [{i: 1, j: 0}],
    finished: false
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  moveTokenToOffset(token, {i: 1, j: 0});

  const observed = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  assert.equal(observed.ok, true);
  assert.equal(observed.ignored, true);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
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
  assert.deepEqual(token.lastCompletePathWaypoints.map(({x, y}) => ({x, y})), [
    pointForOffset(token.parent, {i: 0, j: 0}),
    pointForOffset(token.parent, {i: 3, j: 0})
  ]);
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

test("concurrent duplicate movement completions share one budget commit", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-concurrent-direct-completion",
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
  const [first, second] = await Promise.all([
    fixture.playerAuthority.commitMovementCompletion(completion),
    fixture.playerAuthority.commitMovementCompletion(completion)
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
});

test("concurrent movement commit socket envelopes spend movement once", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, gmAuthority, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-concurrent-socket-completion",
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
  const envelopeA = createResolutionSocketEnvelope({
    messageId: "movement-commit-concurrent-a",
    messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
    senderUserId: PLAYER.id,
    recipientUserId: GM.id,
    resolutionId: completion.resolutionId,
    payload: {completion}
  });
  const envelopeB = createResolutionSocketEnvelope({
    messageId: "movement-commit-concurrent-b",
    messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
    senderUserId: PLAYER.id,
    recipientUserId: GM.id,
    resolutionId: completion.resolutionId,
    payload: {completion}
  });

  const results = await Promise.all([
    gmAuthority.handleEnvelope(envelopeA),
    gmAuthority.handleEnvelope(envelopeB)
  ]);

  assert.equal(results.every(result => result.ok === true), true);
  assert.equal(results.some(result => result.result.code === FOUNDRY_MOVEMENT_CODES.OK), true);
  assert.equal(results.some(result => result.result.code === FOUNDRY_MOVEMENT_CODES.MOVEMENT_ALREADY_COMMITTED), true);
  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
});

test("failed movement commit clears the in-flight idempotency guard for retry", async () => {
  let failNextMovementSpend = true;
  const fixture = createMovementRuntimeFixture({
    persistenceOptions: {
      failOn(operation) {
        if ( operation.type !== "updateActor" || failNextMovementSpend !== true ) return false;
        failNextMovementSpend = false;
        return true;
      }
    }
  });
  const {actor, token, gmAuthority, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-commit-retry-after-failure",
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

  const failed = await fixture.playerAuthority.commitMovementCompletion(completion);
  assert.equal(failed.ok, true);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(gmAuthority.getCommitted(completion), null);
  assert.equal(fixture.playerAuthority.errors.at(-1).result.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED);

  const retry = await fixture.playerAuthority.commitMovementCompletion(completion);
  assert.equal(retry.ok, true);
  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 2);
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

  const spoofedSourceUserEnvelope = createResolutionSocketEnvelope({
    messageId: "movement-commit-spoofed-source-user",
    messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
    senderUserId: OTHER_PLAYER.id,
    recipientUserId: GM.id,
    resolutionId: completion.resolutionId,
    payload: {
      completion: {...completion, sourceUserId: PLAYER.id}
    }
  });
  const spoofedSourceUser = await gmAuthority.handleEnvelope(spoofedSourceUserEnvelope);
  assert.equal(spoofedSourceUser.result.code, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER);
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

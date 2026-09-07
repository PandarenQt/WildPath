import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {normalizeEntityRef, sameEntityRef} from "../module/helpers/entity-refs.mjs";
import {
  MOVEMENT_KINDS,
  MOVEMENT_MEASUREMENT_MODES
} from "../module/helpers/movement.mjs";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  createTokenGridFootprint,
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
  FOUNDRY_HEX_OFFSET_VARIANTS,
  createFoundryV14TacticalGridAdapter
} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {
  FOUNDRY_MOVEMENT_CODES,
  FOUNDRY_TOKEN_OPERATION_TYPES,
  authorizeFoundryMovementIntent,
  buildFoundryMovementCompletion,
  buildFoundryMovementIntent,
  classifyFoundryTokenOperation,
  foundryMovementIntentToMovementPath
} from "../module/adapters/foundry-v14-movement-adapter.mjs";
import {createMultiplayerMovementAuthority} from "../module/resolvers/multiplayer-movement-authority.mjs";
import {onFoundryV14MoveToken, onFoundryV14PauseToken, onFoundryV14StopToken, registerFoundryV14MultiplayerResolution} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
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

class FakeOddRowHexGrid extends FakeHexGrid {
  offsetToCube({i, j}) {
    const q = i - ((j - Math.abs(j % 2)) / 2);
    return {q, r: j, s: -q - j};
  }

  cubeToOffset({q, r}) {
    return {i: q + ((r - Math.abs(r % 2)) / 2), j: r};
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
  width=null,
  height=null,
  depth=1,
  shape=0,
  expandCompletePath=true,
  owners=["player-a"]
}={}) {
  const gridUnits = tokenGridUnitsForSize(size);
  const tokenWidth = width ?? gridUnits;
  const tokenHeight = height ?? gridUnits;
  const token = Object.assign(new WildPathTokenDocument(), {
    documentName: "Token",
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    parent: scene,
    actor,
    wildpathSize: size,
    width: tokenWidth,
    height: tokenHeight,
    depth,
    shape,
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
        depth: this.depth,
        shape: this.shape
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
            depth: this.depth,
            shape: this.shape
          };
      return JSON.parse(JSON.stringify({
        id: this.id,
        name: this.name ?? this.id,
        ...position
      }));
    },
    getOccupiedGridSpaceOffsets(data=null) {
      const position = explicitFoundryPosition(data) ? data : this;
      const base = scene.grid.getOffset(position);
      return occupiedOffsetsForTokenState({
        grid: scene.grid,
        offset: base,
        state: position,
        fallbackSize: size
      });
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
  persistenceOptions={},
  onAutomationEvent=null
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
    activeGMUserId: () => gmGame.users.activeGM?.id ?? null,
    persistencePort: persistence,
    measurementMode,
    approvalTimeoutMs: 50
  };
  const semanticEvents = {player: [], gm: []};
  const playerAuthority = createMultiplayerMovementAuthority({
    ...authorityOptions,
    userId: PLAYER.id,
    transport: playerTransport,
    game: playerGame,
    onAutomationEvent: event => semanticEvents.player.push(event)
  });
  const gmAuthority = createMultiplayerMovementAuthority({
    ...authorityOptions,
    userId: GM.id,
    transport: gmTransport,
    game: gmGame,
    onAutomationEvent: event => {
      semanticEvents.gm.push(structuredClone(event));
      onAutomationEvent?.(event);
    }
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
    semanticEvents,
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

function resizeOperation(token, {
  id="resize-token",
  origin=null,
  destination=null,
  finished=true
}={}) {
  const originState = origin ?? tokenStateForOffset(token, token.offset ?? token.parent.grid.getOffset(token));
  const destinationState = destination ?? {
    ...originState,
    width: 2,
    height: 2,
    depth: 1,
    shape: 0
  };
  return {
    id,
    method: "config",
    origin: originState,
    destination: destinationState,
    constrained: false,
    constrainOptions: {
      ignoreWalls: true,
      ignoreCost: true
    },
    passed: {
      cost: 0,
      distance: 0,
      spaces: 0,
      diagonals: 0,
      waypoints: [{
        ...destinationState,
        cost: 0,
        action: "displace",
        explicit: true,
        intermediate: false,
        snapped: false
      }]
    },
    pending: {
      cost: 0,
      distance: 0,
      spaces: 0,
      diagonals: 0,
      waypoints: []
    },
    finished: Promise.resolve(finished)
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

function tokenStateForOffset(token, offset, dimensions={}) {
  return {
    ...pointForOffset(token.parent, offset),
    elevation: dimensions.elevation ?? token.elevation ?? 0,
    width: dimensions.width ?? token.width,
    height: dimensions.height ?? token.height,
    depth: dimensions.depth ?? token.depth,
    shape: dimensions.shape ?? token.shape ?? 0
  };
}

function anchorKeys(path) {
  return path.anchors.map(anchor => fieldKey(anchor, path.topology));
}

function moveTokenToOffset(token, offset) {
  token.setOffset(offset);
}

function resizeTokenSource(token, dimensions) {
  token.width = dimensions.width ?? token.width;
  token.height = dimensions.height ?? token.height;
  token.depth = dimensions.depth ?? token.depth;
  token.shape = dimensions.shape ?? token.shape;
  token.setSourceOffset(token.offset ?? token.parent.grid.getOffset(token));
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

function occupiedOffsetsForTokenState({grid, offset, state, fallbackSize=CREATURE_SIZES.MEDIUM}) {
  const topology = grid.isHexagonal ? GRID_TOPOLOGIES.HEX : GRID_TOPOLOGIES.SQUARE;
  const size = creatureSizeForTokenState(state, fallbackSize);
  const anchor = grid.isHexagonal
    ? {q: offset.i, r: offset.j}
    : {x: offset.i, y: offset.j};
  const footprint = createTokenGridFootprint({size, topology, anchor});
  return footprint.fields.map(field => grid.isHexagonal ? {i: field.q, j: field.r} : {i: field.x, j: field.y});
}

function creatureSizeForTokenState(state, fallbackSize=CREATURE_SIZES.MEDIUM) {
  const width = Number(state?.width);
  const height = Number(state?.height);
  const maximum = Math.max(Number.isFinite(width) ? width : 0, Number.isFinite(height) ? height : 0);
  if ( maximum >= 4 ) return CREATURE_SIZES.GARGANTUAN;
  if ( maximum >= 3 ) return CREATURE_SIZES.HUGE;
  if ( maximum >= 2 ) return CREATURE_SIZES.LARGE;
  return fallbackSize;
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

function footprintTranslationFixture({topology=GRID_TOPOLOGIES.HEX, size=CREATURE_SIZES.LARGE, row=2}={}) {
  const hex = topology === GRID_TOPOLOGIES.HEX;
  const grid = hex ? new FakeOddRowHexGrid() : new FakeSquareGrid();
  const fixture = createMovementRuntimeFixture({
    grid,
    actor: fakeActor("footprint-actor", {size}),
    tokenOptions: {
      offset: hex ? grid.cubeToOffset({q: 2, r: row}) : {i: 2, j: row},
      expandCompletePath: false
    }
  });
  const occupiedStates = [];
  const defaultOccupancy = fixture.token.getOccupiedGridSpaceOffsets;
  fixture.token.getOccupiedGridSpaceOffsets = function(data=null) {
    const state = data ?? this;
    occupiedStates.push(JSON.parse(JSON.stringify(data ?? pointForToken(this))));
    if ( !hex ) return defaultOccupancy.call(this, data);

    // Contract fixture: multi-field occupied spaces have an anchor distinct from the
    // top-left placement field. These explicit samples do not emulate Foundry rendering.
    // Missing dimensions deliberately represent one field, exposing waypoint data loss.
    const offsets = state.width >= 3 && state.height >= 3
      ? [[0, 0], [0, 1], [1, -1], [1, 0], [1, 1], [2, -1], [2, 0]]
      : state.width >= 2 && state.height >= 2
        ? [[1, 0], [2, 0], [1, 1]]
        : [[0, 0]];
    const base = grid.offsetToCube(grid.getOffset(state));
    return offsets.map(([q, r]) => grid.cubeToOffset({q: base.q + q, r: base.r + r}));
  };
  return {...fixture, occupiedStates};
}

// V14 checkpoints commit passed waypoints and continue with a new ID plus the prior chain.
function checkpointOperation(token, {id="checkpoint-root", offsets=null, passedCount=2, chain=[], subpathId=chain[0] ?? id, kind=null}={}) {
  const origin = token.toObject(true);
  const start = token.parent.grid.getOffset(origin);
  const route = offsets ?? [1, 2, 3].map(step => ({i: start.i + step, j: start.j}));
  const waypoints = route.map((offset, index) => ({...pointForOffset(token.parent, offset),
    checkpoint: true, movementId: index < passedCount ? id : null, subpathId, userId: PLAYER.id}));
  return {id, chain, subpathId, split: false, origin,
    destination: waypoints[passedCount - 1] ?? origin, method: "drag", constrained: false,
    passed: {waypoints: waypoints.slice(0, passedCount)}, pending: {waypoints: waypoints.slice(passedCount)},
    finished: passedCount < route.length ? new Promise(() => {}) : Promise.resolve(true),
    ...(kind ? {wildpath: {movementKind: kind}} : {})};
}

async function approveCheckpoint(fixture, movement) {
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false, fixture.warnings.at(-1));
  });
}

function checkpointSnapshot(fixture, movement, state="pending") {
  const offset = fixture.scene.grid.getOffset(movement.passed.waypoints.at(-1) ?? movement.origin);
  const document = observedTokenAtOffset(fixture.token, offset);
  document.movement = {...movement, state, user: PLAYER,
    pending: state === "stopped" ? {waypoints: []} : movement.pending};
  return document;
}

function progressOf(fixture, movement) {
  const {completion} = buildFoundryMovementCompletion({tokenDocument: fixture.token, movement, user: PLAYER, game: fixture.gmGame});
  return fixture.gmAuthority.getMovementProgress(completion);
}

async function lifecycleHook(fixture, document, state, game=fixture.gmGame) {
  const handler = state === "paused" ? onFoundryV14PauseToken : onFoundryV14StopToken;
  return withFoundryGlobals(fixture, () => handler(document, {game}), {game});
}

for ( const topology of ["square", "hex"] ) for ( const size of ["medium", "large"] ) {
  test(`${size} ${topology} player stop after two of three steps pays 10 and preserves full footprints once`, async () => {
    const fixture = footprintTranslationFixture({topology, size});
    const movement = checkpointOperation(fixture.token);
    await approveCheckpoint(fixture, movement);
    assert.equal(progressOf(fixture, movement).completedTransitionCount, 0);
    const document = checkpointSnapshot(fixture, movement, "stopped");
    assert.equal((await lifecycleHook(fixture, document, "stopped", fixture.playerGame)).ignored, true);
    assert.equal((await lifecycleHook(fixture, document, "stopped")).ok, true);
    assert.equal((await lifecycleHook(fixture, document, "stopped")).duplicate, true);
    const events = fixture.semanticEvents.gm;
    assert.deepEqual(events.map(event => event.type), ["movement.started", "movement.transition", "movement.transition", "movement.interrupted"]);
    assert.deepEqual(events.filter(event => event.type === "movement.transition").map(event => event.data.transitionIndex), [0, 1]);
    const fields = size === "medium" ? 1 : topology === "hex" ? 3 : 4;
    assert.equal(events[1].data.to.footprint.fields.length, fields);
    assert.equal(events[2].data.to.footprint.fields.length, fields);
    assert.equal(events[1].data.stepCost.amount, 5);
    if ( size === "large" ) {
      assert.equal(events[1].data.enteredFields.length, 2);
      assert.equal(events[1].data.leftFields.length, 2);
      assert.equal(events[1].data.retainedFields.length, topology === "hex" ? 1 : 2);
    }
    const progress = progressOf(fixture, movement);
    assert.equal(progress.status, "interrupted");
    assert.equal(progress.completedTransitionCount, 2);
    assert.equal(progress.remainingTransitionCount, 1);
    assert.equal(progress.cumulativeMovementCost, 10);
    assert.equal(progress.committedMovementCost, 10);
    assert.equal(progress.paidTransitionCount, 2);
    assert.equal(fixture.actor.system.resources.movement.value, 20);
    assert.equal(fixture.persistence.operations.length, 1);
    assert.deepEqual(fixture.semanticEvents.player, []);
    assert.equal(isPlainSerializableData(progress), true);
    progress.operationIds.push("mutated");
    progress.actualDestination.footprint.fields.length = 0;
    assert.equal(progressOf(fixture, movement).operationIds.length, 1);
    assert.equal(progressOf(fixture, movement).actualDestination.footprint.fields.length, fields);
  });
}

test("concurrent increasing checkpoints serialize deltas and ignore a late lower prefix", async () => {
  const fixture = createMovementRuntimeFixture();
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  const second = checkpointOperation(fixture.token, {passedCount: 2});
  await approveCheckpoint(fixture, first);
  const before = checkpointSnapshot(fixture, first);
  const after = checkpointSnapshot(fixture, second);
  await withFoundryGlobals(fixture, async () => {
    const results = await Promise.all([before, after, after].map(document =>
      onFoundryV14MoveToken(document, document.movement, {}, PLAYER, {game: fixture.gmGame})));
    assert.equal(results.every(result => result.ok), true);
  });
  assert.equal((await fireMoveTokenHook(fixture, {token: before, movement: before.movement})).duplicate, true);
  assert.equal(fixture.actor.system.resources.movement.value, 20);
  assert.deepEqual(fixture.persistence.operations.map(operation => operation.updates["system.resources.movement.value"]), [25, 20]);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(progressOf(fixture, first).completedTransitionCount, 2);
});

test("checkpoint snapshots survive the same Token updating again before queued reconciliation", async () => {
  const fixture = createMovementRuntimeFixture();
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  const second = checkpointOperation(fixture.token, {passedCount: 2});
  await approveCheckpoint(fixture, first);
  await withFoundryGlobals(fixture, async () => {
    fixture.token.setSourceOffset({i: 1, j: 0});
    const before = onFoundryV14MoveToken(fixture.token, first, {}, PLAYER, {game: fixture.gmGame});
    fixture.token.setSourceOffset({i: 2, j: 0});
    const after = onFoundryV14MoveToken(fixture.token, second, {}, PLAYER, {game: fixture.gmGame});
    assert.equal((await Promise.all([before, after])).every(result => result.ok), true);
  });
  assert.deepEqual(fixture.persistence.operations.map(operation => operation.updates["system.resources.movement.value"]), [25, 20]);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(fixture.gmAuthority.getMovementProgress({movementId: first.id,
    sceneRef: fixture.scene.uuid, tokenRef: fixture.token.uuid}).completedTransitionCount, 2);
});

test("continuation approval waits for the prior checkpoint payment instead of dropping the new operation", async () => {
  const fixture = createMovementRuntimeFixture();
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  await approveCheckpoint(fixture, first);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = fixture.persistence.updateActor;
  fixture.persistence.updateActor = async args => { entered(); await gate; return update(args); };
  await withFoundryGlobals(fixture, async () => {
    fixture.token.setOffset({i: 1, j: 0});
    const observing = onFoundryV14MoveToken(fixture.token, first, {}, PLAYER, {game: fixture.gmGame});
    await enteredPromise;
    const next = checkpointOperation(fixture.token, {id: "queued-continuation", chain: [first.id], passedCount: 1,
      offsets: [{i: 2, j: 0}, {i: 3, j: 0}]});
    const approving = fixture.token._preUpdateMovement(next, {});
    release();
    assert.equal((await observing).ok, true);
    assert.notEqual(await approving, false);
    assert.deepEqual(progressOf(fixture, next).operationIds, [first.id, next.id]);
  });
  assert.equal(fixture.actor.system.resources.movement.value, 25);
  assert.equal(fixture.persistence.operations.length, 1);
});

test("pause preserves the approved suffix and linked continuation completes without replay", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  const paused = checkpointSnapshot(fixture, movement, "paused");
  assert.equal((await lifecycleHook(fixture, paused, "paused")).ok, true);
  assert.equal((await lifecycleHook(fixture, paused, "paused")).duplicate, true);
  assert.equal(progressOf(fixture, movement).status, "paused");
  assert.equal(fixture.semanticEvents.gm.length, 3);
  fixture.token.setOffset({i: 2, j: 0});
  const resumed = checkpointOperation(fixture.token, {id: "checkpoint-resumed", chain: [movement.id], offsets: [{i: 3, j: 0}], passedCount: 1});
  await approveCheckpoint(fixture, resumed);
  assert.equal(progressOf(fixture, resumed).completedTransitionCount, 2);
  const completed = checkpointSnapshot(fixture, resumed, "completed");
  assert.equal((await fireMoveTokenHook(fixture, {token: completed, movement: resumed})).ok, true);
  assert.equal((await fireMoveTokenHook(fixture, {token: completed, movement: resumed})).duplicate, true);
  assert.deepEqual(fixture.semanticEvents.gm.map(event => event.type), [
    "movement.started", "movement.transition", "movement.transition", "movement.transition", "movement.completed"
  ]);
  assert.deepEqual(fixture.semanticEvents.gm.filter(event => event.type === "movement.transition").map(event => event.data.transitionIndex), [0, 1, 2]);
  assert.equal(new Set(fixture.semanticEvents.gm.map(event => event.id)).size, 5);
  assert.equal(progressOf(fixture, movement).status, "completed");
  assert.equal(progressOf(fixture, resumed).committedMovementCost, 15);
  assert.equal(fixture.actor.system.resources.movement.value, 15);
  assert.equal(fixture.persistence.operations.length, 2);
});

test("late root moveToken after Large hex pause continuation ignores historical source mismatch", async () => {
  const fixture = footprintTranslationFixture();
  const {token, actor, gmAuthority} = fixture;
  actor.uuid = `Scene.${fixture.scene.id}.Token.${token.id}.Actor.${actor.id}`;
  const worldActor = fakeActor(actor.id, {size: CREATURE_SIZES.LARGE});
  fixture.gmGame.actors.set(actor.id, worldActor);
  fixture.playerGame.actors.set(actor.id, worldActor);
  const start = token.offset;
  const offsets = [1, 2, 3].map(step => ({i: start.i + step, j: start.j}));
  const root = checkpointOperation(token, {id: "delayed-root", offsets});
  await approveCheckpoint(fixture, root);
  // V14.367 dispatches pauseToken in the document update, while moveToken runs in
  // the operation post-workflow after an await. Keep that older raw operation pending.
  let deliverRoot;
  const rootReady = new Promise(resolve => { deliverRoot = resolve; });
  await withFoundryGlobals(fixture, async () => {
    const lateRoot = rootReady.then(() => onFoundryV14MoveToken(token, root, {}, PLAYER, {game: fixture.gmGame}));
    token.setOffset(offsets[1]);
    token.movement = {...root, state: "paused", user: PLAYER};
    assert.equal((await onFoundryV14PauseToken(token, {game: fixture.gmGame})).ok, true);
    assert.equal(progressOf(fixture, root).status, "paused");
    assert.equal(actor.system.resources.movement.value, 20);
    const prefixIds = fixture.semanticEvents.gm.map(event => event.id);
    const resumed = checkpointOperation(token, {id: "delayed-child", chain: [root.id], offsets: [offsets[2]], passedCount: 1});
    assert.notEqual(await token._preUpdateMovement(resumed, {}), false);
    token.setOffset(offsets[2]);
    token.movement = {...resumed, state: "completed", user: PLAYER};
    assert.equal((await onFoundryV14MoveToken(token, resumed, {}, PLAYER, {game: fixture.gmGame})).ok, true);
    const beforeLate = progressOf(fixture, root);
    assert.equal(beforeLate.completedTransitionCount, 3);
    assert.equal(beforeLate.committedMovementCost, 15);
    deliverRoot();
    const stale = await lateRoot;
    assert.equal(stale.ok, true, JSON.stringify(stale));
    assert.equal(stale.stale, true);
    assert.deepEqual(progressOf(fixture, root), beforeLate);
    assert.deepEqual(fixture.semanticEvents.gm.slice(0, 3).map(event => event.id), prefixIds);
    assert.equal((await onFoundryV14MoveToken(token, root, {}, PLAYER, {game: fixture.playerGame})).ignored, true);
  });
  assert.deepEqual(fixture.semanticEvents.gm.map(event => event.type), [
    "movement.started", "movement.transition", "movement.transition", "movement.transition", "movement.completed"
  ]);
  assert.deepEqual(fixture.semanticEvents.gm.filter(event => event.type === "movement.transition").map(event => event.data.transitionIndex), [0, 1, 2]);
  assert.equal(new Set(fixture.semanticEvents.gm.map(event => event.id)).size, 5);
  for ( const event of fixture.semanticEvents.gm.filter(event => event.type === "movement.transition") ) {
    assert.equal(event.data.to.footprint.fields.length, 3);
    assert.equal(event.data.leftFields.length, 2);
    assert.equal(event.data.enteredFields.length, 2);
    assert.equal(event.data.retainedFields.length, 1);
    assert.equal(event.data.stepCost.amount, 5);
  }
  assert.deepEqual(fixture.persistence.operations.map(operation => operation.updates["system.resources.movement.value"]), [20, 15]);
  assert.equal(actor.system.resources.movement.value, 15);
  assert.equal(worldActor.system.resources.movement.value, 30);
  assert.deepEqual(fixture.semanticEvents.player, []);
  assert.deepEqual(fixture.warnings, []);
  assert.deepEqual(gmAuthority.errors, []);
});

test("historical checkpoints still validate ordered route and chain before being ignored", async () => {
  const fixture = createMovementRuntimeFixture();
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  await approveCheckpoint(fixture, first);
  const second = checkpointOperation(fixture.token, {passedCount: 2});
  await lifecycleHook(fixture, checkpointSnapshot(fixture, second, "paused"), "paused");
  const document = checkpointSnapshot(fixture, second, "paused");
  const before = progressOf(fixture, first);
  const historical = await fireMoveTokenHook(fixture, {token: document, movement: first});
  assert.equal(historical.ok, true, JSON.stringify(historical));
  assert.equal(historical.stale, true);
  assert.equal(historical.committed, false);
  assert.deepEqual(fixture.warnings, []);
  assert.deepEqual(progressOf(fixture, first), before);
  const invalidRoute = {...first, passed: {waypoints: [{...first.passed.waypoints[0], y: 50}]}};
  assert.equal((await fireMoveTokenHook(fixture, {token: document, movement: invalidRoute})).ok, false);
  const invalidChain = {...first, chain: ["foreign-root"]};
  assert.equal((await fireMoveTokenHook(fixture, {token: document, movement: invalidChain})).code,
    FOUNDRY_MOVEMENT_CODES.MOVEMENT_CONTINUATION_MISMATCH);
  const invalidSubpath = {...first, subpathId: "foreign-subpath"};
  assert.equal((await fireMoveTokenHook(fixture, {token: document, movement: invalidSubpath})).ok, false);
  const invalidOperation = {...first, id: "foreign-operation"};
  assert.equal((await fireMoveTokenHook(fixture, {token: document, movement: invalidOperation})).ok, false);
  assert.deepEqual(progressOf(fixture, first), before);
  assert.equal(progressOf(fixture, first).completedTransitionCount, 2);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(fixture.persistence.operations.length, 1);
});

test("stale history cannot retry unpaid debt or replay facts after a newer prefix", async () => {
  let failNext = true;
  const fixture = createMovementRuntimeFixture({persistenceOptions: {
    failOn() { const failed = failNext; failNext = false; return failed; }
  }});
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  const second = checkpointOperation(fixture.token, {passedCount: 2});
  await approveCheckpoint(fixture, first);
  const document = checkpointSnapshot(fixture, second, "paused");
  assert.equal((await lifecycleHook(fixture, document, "paused")).ok, false);
  const before = progressOf(fixture, first);
  assert.equal(before.completedTransitionCount, 2);
  assert.equal(before.committedMovementCost, 0);
  assert.notEqual(before.paymentFailure, null);
  const eventIds = fixture.semanticEvents.gm.map(event => event.id);
  const warningCount = fixture.warnings.length;
  for ( let i = 0; i < 2; i++ ) {
    const result = await fireMoveTokenHook(fixture, {token: document, movement: first});
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.equal(result.committed, false);
  }
  assert.deepEqual(progressOf(fixture, first), before);
  assert.equal(fixture.persistence.operations.length, 1);
  assert.equal(fixture.warnings.length, warningCount);
  assert.equal(fixture.actor.system.resources.movement.value, 30);
  // Current, spatially consistent evidence may still settle that existing debt once.
  assert.equal((await lifecycleHook(fixture, document, "paused")).ok, true);
  assert.equal(fixture.actor.system.resources.movement.value, 20);
  assert.deepEqual(fixture.semanticEvents.gm.map(event => event.id), eventIds);
});

test("finished false never reads a replacement lifecycle snapshot after awaiting", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token, {passedCount: 3});
  let finish;
  movement.finished = new Promise(resolve => { finish = resolve; });
  await approveCheckpoint(fixture, movement);
  await withFoundryGlobals(fixture, async () => {
    fixture.token.setOffset({i: 3, j: 0});
    fixture.token.movement = {...movement, user: PLAYER, state: "pending"};
    const observing = onFoundryV14MoveToken(fixture.token, movement, {}, PLAYER, {game: fixture.gmGame});
    fixture.token.movement = {...movement, user: PLAYER, state: "stopped"};
    finish(false);
    assert.equal((await observing).code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_OBSERVATION_AMBIGUOUS);
  });
  assert.equal(fixture.persistence.operations.length, 0);
  assert.equal(fixture.semanticEvents.gm.length, 0);
});

for ( const authoritativeCount of [1, 2] ) {
  test(`${authoritativeCount === 2 ? "same" : "advancing"}-prefix source mismatch includes plain reconciliation diagnostics`, async () => {
    const fixture = createMovementRuntimeFixture();
    const initial = checkpointOperation(fixture.token, {passedCount: authoritativeCount});
    await approveCheckpoint(fixture, initial);
    await lifecycleHook(fixture, checkpointSnapshot(fixture, initial, "paused"), "paused");
    const before = progressOf(fixture, initial);
    const events = structuredClone(fixture.semanticEvents);
    const bad = checkpointOperation(fixture.token, {passedCount: 2});
    const document = checkpointSnapshot(fixture, bad, "paused");
    document.setSourceOffset({i: 8, j: 0});
    const result = await lifecycleHook(fixture, document, "paused");
    assert.equal(result.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_PREFIX_MISMATCH);
    assert.equal(isPlainSerializableData(result.observation), true);
    assert.equal(result.observation.lifecycle, "pauseToken");
    assert.equal(result.observation.operationId, initial.id);
    assert.equal(result.observation.rootMovementId, initial.id);
    assert.equal(result.observation.observedTransitionCount, 2);
    assert.equal(result.observation.authoritativeTransitionCount, authoritativeCount);
    assert.notDeepEqual(result.observation.observedSourceFootprint, result.observation.expectedFootprint);
    assert.deepEqual(progressOf(fixture, initial), before);
    assert.deepEqual(fixture.semanticEvents, events);
    assert.equal(fixture.persistence.operations.length, 1);
  });
}

test("same-count moving checkpoint cannot hide corrupt source behind paused progress", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  const document = checkpointSnapshot(fixture, movement, "paused");
  await lifecycleHook(fixture, document, "paused");
  const before = progressOf(fixture, movement);
  document.setSourceOffset({i: 8, j: 0});
  const result = await fireMoveTokenHook(fixture, {token: document, movement});
  assert.equal(result.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_PREFIX_MISMATCH);
  assert.equal(result.observation.lifecycle, "moveToken");
  assert.equal(result.observation.observedTransitionCount, 2);
  assert.equal(result.observation.authoritativeTransitionCount, 2);
  assert.deepEqual(progressOf(fixture, movement), before);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(fixture.persistence.operations.length, 1);
});

test("QA Token ref normalization selects the authoritative movement events for only that Scene Token", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "paused"), "paused");
  const expectedRef = normalizeEntityRef({tokenId: fixture.token.id, sceneId: fixture.scene.id});
  const otherSceneRef = normalizeEntityRef({tokenId: fixture.token.id, sceneId: "other-scene"});
  assert.notEqual(fixture.semanticEvents.gm[0].data.tokenRef, fixture.token.uuid);
  assert.equal(fixture.semanticEvents.gm.filter(event => sameEntityRef(event.data.tokenRef, expectedRef)).length, 3);
  assert.equal(fixture.semanticEvents.gm.filter(event => sameEntityRef(event.data.tokenRef, otherSceneRef)).length, 0);
  assert.equal(fixture.semanticEvents.player.filter(event => sameEntityRef(event.data.tokenRef, expectedRef)).length, 0);
});

test("pause followed by stop is terminal without replay or suffix payment", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "paused"), "paused");
  await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "stopped"), "stopped");
  fixture.token.setOffset({i: 2, j: 0});
  const resumed = checkpointOperation(fixture.token, {id: "cannot-resume", chain: [movement.id], offsets: [{i: 3, j: 0}], passedCount: 1});
  await withFoundryGlobals(fixture, async () => assert.equal(await fixture.token._preUpdateMovement(resumed, {}), false));
  assert.equal(fixture.semanticEvents.gm.at(-1).type, "movement.interrupted");
  assert.equal(fixture.semanticEvents.gm.length, 4);
  assert.equal(fixture.persistence.operations.length, 1);
});

for ( const mismatch of ["route", "footprint", "movementId", "pending-id", "subpath", "missing-passed"] ) {
  test(`interruption fails closed for ${mismatch} evidence`, async () => {
    const fixture = createMovementRuntimeFixture();
    const movement = checkpointOperation(fixture.token);
    await approveCheckpoint(fixture, movement);
    const document = checkpointSnapshot(fixture, movement, "stopped");
    document.movement.passed = structuredClone(movement.passed);
    if ( mismatch === "route" ) document.movement.passed.waypoints[0].y += 50;
    if ( mismatch === "footprint" ) { document.width = 2; document.setSourceOffset({i: 2, j: 0}); }
    if ( mismatch === "movementId" ) document.movement.passed.waypoints[0].movementId = "unrelated";
    if ( mismatch === "pending-id" ) document.movement.passed.waypoints[0].movementId = null;
    if ( mismatch === "subpath" ) document.movement.subpathId = "unrelated";
    if ( mismatch === "missing-passed" ) delete document.movement.passed;
    assert.equal((await lifecycleHook(fixture, document, "stopped")).ok, false);
    assert.equal(fixture.persistence.operations.length, 0);
    assert.equal(fixture.semanticEvents.gm.length, 0);
    assert.equal(progressOf(fixture, movement).status, "pending");
  });
}

for ( const mismatch of ["chain", "malformed-chain", "subpath", "split", "route", "unobserved"] ) {
  test(`continuation rejects ${mismatch} rather than guessing the root or suffix`, async () => {
    const fixture = createMovementRuntimeFixture();
    const root = checkpointOperation(fixture.token);
    await approveCheckpoint(fixture, root);
    if ( mismatch !== "unobserved" ) await lifecycleHook(fixture, checkpointSnapshot(fixture, root, "paused"), "paused");
    fixture.token.setOffset({i: 2, j: 0});
    const next = checkpointOperation(fixture.token, {id: "next", chain: [root.id], offsets: [{i: 3, j: 0}], passedCount: 1});
    if ( mismatch === "chain" ) next.chain.push("missing-operation");
    if ( mismatch === "malformed-chain" ) next.chain = null;
    if ( mismatch === "subpath" ) next.subpathId = "other-subpath";
    if ( mismatch === "split" ) next.split = true;
    if ( mismatch === "route" ) next.passed.waypoints[0].y = 50;
    await withFoundryGlobals(fixture, async () => assert.equal(await fixture.token._preUpdateMovement(next, {}), false));
    assert.equal(progressOf(fixture, root).operationIds.length, 1);
    assert.equal(fixture.actor.system.resources.movement.value, mismatch === "unobserved" ? 30 : 20);
  });
}

test("repeated anchors are matched by ordered prefix, not by first endpoint occurrence", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token, {offsets: [{i: 1, j: 0}, {i: 0, j: 0}, {i: 1, j: 0}, {i: 2, j: 0}], passedCount: 3});
  await approveCheckpoint(fixture, movement);
  await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "stopped"), "stopped");
  assert.equal(progressOf(fixture, movement).completedTransitionCount, 3);
  assert.equal(fixture.actor.system.resources.movement.value, 15);
  assert.deepEqual(fixture.semanticEvents.gm.filter(event => event.type === "movement.transition").map(event => event.data.transitionIndex), [0, 1, 2]);
});

test("interrupted synthetic Token Actor payment preserves the unrelated world Actor", async () => {
  const synthetic = fakeActor("synthetic");
  synthetic.uuid = "Scene.scene-a.Token.token-a.Actor.synthetic";
  const fixture = createMovementRuntimeFixture({actor: synthetic});
  const worldActor = fakeActor("synthetic");
  fixture.playerGame.actors.set(worldActor.id, worldActor);
  fixture.gmGame.actors.set(worldActor.id, worldActor);
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "stopped"), "stopped");
  assert.equal(synthetic.system.resources.movement.value, 20);
  assert.equal(worldActor.system.resources.movement.value, 30);
  assert.equal(fixture.persistence.operations[0].actorRef, synthetic.uuid);
});

test("forced interruption retains actual travel facts without ordinary movement payment", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token, {kind: "forced"});
  await approveCheckpoint(fixture, movement);
  await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "stopped"), "stopped");
  assert.equal(progressOf(fixture, movement).cumulativeMovementCost, 10);
  assert.equal(progressOf(fixture, movement).committedMovementCost, 0);
  assert.equal(fixture.actor.system.resources.movement.value, 30);
  assert.equal(fixture.semanticEvents.gm[2].data.budgetCost, 0);
  assert.equal(fixture.persistence.operations.length, 0);
});

test("teleport stopped before displacement does not invent the approved jump", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token, {kind: "teleport", passedCount: 0, offsets: [{i: 8, j: 0}]});
  await approveCheckpoint(fixture, movement);
  assert.equal((await lifecycleHook(fixture, checkpointSnapshot(fixture, movement, "stopped"), "stopped")).ok, true);
  assert.equal(progressOf(fixture, movement).completedTransitionCount, 0);
  assert.deepEqual(fixture.semanticEvents.gm.map(event => event.type), ["movement.interrupted"]);
  assert.equal(fixture.actor.system.resources.movement.value, 30);
});

test("prefix payment failure preserves facts and retries only the unpaid cumulative amount", async () => {
  let failNext = true;
  const fixture = createMovementRuntimeFixture({persistenceOptions: {
    failOn() { const fail = failNext; failNext = false; return fail; }
  }, onAutomationEvent() { throw new Error("observer failure"); }});
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  const stopped = checkpointSnapshot(fixture, movement, "stopped");
  assert.equal((await lifecycleHook(fixture, stopped, "stopped")).ok, false);
  const failed = progressOf(fixture, movement);
  assert.equal(failed.completedTransitionCount, 2);
  assert.equal(failed.committedMovementCost, 0);
  assert.equal(failed.paidTransitionCount, 0);
  assert.equal(failed.cumulativeMovementCost, 10);
  assert.equal(failed.paymentFailure.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED);
  assert.equal(fixture.semanticEvents.gm.length, 4);
  assert.equal((await lifecycleHook(fixture, stopped, "stopped")).ok, true);
  assert.equal((await lifecycleHook(fixture, stopped, "stopped")).duplicate, true);
  assert.equal(progressOf(fixture, movement).committedMovementCost, 10);
  assert.equal(progressOf(fixture, movement).paymentFailure, null);
  assert.equal(fixture.semanticEvents.gm.length, 4);
  assert.equal(fixture.actor.system.resources.movement.value, 20);
  assert.equal(fixture.persistence.operations.length, 2);
});

test("handoff or reload cannot infer an interrupted prefix from an approval on another client", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token);
  await approveCheckpoint(fixture, movement);
  const stopped = checkpointSnapshot(fixture, movement, "stopped");
  fixture.gmGame.users.activeGM = {id: "replacement", active: true, isGM: true};
  assert.equal((await lifecycleHook(fixture, stopped, "stopped")).ok, false);
  assert.equal(fixture.semanticEvents.gm.length, 0);
  fixture.gmGame.users.activeGM = GM;
  fixture.gmGame.wildpath.movement = createMultiplayerMovementAuthority({userId: GM.id, users: fixture.users,
    activeGMUserId: GM.id, game: fixture.gmGame, persistencePort: fixture.persistence});
  assert.equal((await lifecycleHook(fixture, stopped, "stopped")).code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_NOT_APPROVED);
  assert.equal(fixture.persistence.operations.length, 0);
});

test("authority loss during asynchronous approval cannot retain or approve the route", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token);
  const authority = createMultiplayerMovementAuthority({userId: GM.id, users: fixture.users,
    activeGMUserId: () => fixture.gmGame.users.activeGM?.id, game: fixture.gmGame,
    authorizeMovement: async options => {
      const result = await authorizeFoundryMovementIntent(options);
      fixture.gmGame.users.activeGM = OTHER_PLAYER;
      return result;
    }});
  const {intent} = buildFoundryMovementIntent({tokenDocument: fixture.token, movement, user: PLAYER, game: fixture.playerGame});
  assert.equal((await authority.requestMovementApproval(intent)).approved, false);
  assert.equal(authority.getMovementProgress(intent), null);
  assert.equal(fixture.persistence.operations.length, 0);
});

test("three linked Large hex checkpoints retain one route and original measurement mode", async () => {
  const fixture = footprintTranslationFixture();
  const start = fixture.token.offset;
  const offsets = [1, 2, 3].map(step => ({i: start.i + step, j: start.j}));
  const chain = [];
  for ( let index = 0; index < 3; index++ ) {
    const movement = checkpointOperation(fixture.token, {id: `linked-${index}`, offsets: offsets.slice(index), passedCount: 1, chain: [...chain]});
    await approveCheckpoint(fixture, movement);
    // Later configuration changes must not change the approved route's cost units.
    fixture.gmGame.settings.get = () => MOVEMENT_MEASUREMENT_MODES.FIELDS;
    const document = checkpointSnapshot(fixture, movement, index === 2 ? "completed" : "pending");
    assert.equal((await fireMoveTokenHook(fixture, {token: document, movement})).ok, true);
    fixture.token.setOffset(offsets[index]);
    chain.push(movement.id);
    assert.equal(progressOf(fixture, movement).completedTransitionCount, index + 1);
    assert.equal(progressOf(fixture, movement).measurementMode, MOVEMENT_MEASUREMENT_MODES.DISTANCE);
    assert.equal(progressOf(fixture, movement).committedMovementCost, 5 * (index + 1));
  }
  assert.equal(fixture.actor.system.resources.movement.value, 15);
  assert.equal(fixture.semanticEvents.gm.length, 5);
  assert.equal(fixture.semanticEvents.gm.filter(event => event.type === "movement.transition").every(event => event.data.to.footprint.fields.length === 3), true);
});

test("field-mode interrupted cost converts only the newly verified fields into Actor movement", async () => {
  const fixture = createMovementRuntimeFixture({measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS});
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  await approveCheckpoint(fixture, first);
  await lifecycleHook(fixture, checkpointSnapshot(fixture, first, "paused"), "paused");
  const stopped = checkpointOperation(fixture.token, {passedCount: 2});
  await lifecycleHook(fixture, checkpointSnapshot(fixture, stopped, "stopped"), "stopped");
  assert.equal(progressOf(fixture, first).cumulativeMovementCost, 2);
  assert.equal(progressOf(fixture, first).committedMovementCost, 2);
  assert.deepEqual(fixture.persistence.operations.map(operation => operation.updates["system.resources.movement.value"]), [25, 20]);
});

test("a longer verified prefix retries failed debt together with only the new step", async () => {
  let attempt = 0;
  const fixture = createMovementRuntimeFixture({persistenceOptions: {failOn() { return ++attempt === 2; }}});
  const first = checkpointOperation(fixture.token, {passedCount: 1});
  await approveCheckpoint(fixture, first);
  assert.equal((await lifecycleHook(fixture, checkpointSnapshot(fixture, first, "paused"), "paused")).ok, true);
  const second = checkpointOperation(fixture.token, {passedCount: 2});
  assert.equal((await lifecycleHook(fixture, checkpointSnapshot(fixture, second, "paused"), "paused")).ok, false);
  assert.equal(progressOf(fixture, first).committedMovementCost, 5);
  const third = checkpointOperation(fixture.token, {passedCount: 3});
  const document = checkpointSnapshot(fixture, third, "completed");
  assert.equal((await fireMoveTokenHook(fixture, {token: document, movement: third})).ok, true);
  assert.equal(progressOf(fixture, first).committedMovementCost, 15);
  assert.equal(progressOf(fixture, first).paymentFailure, null);
  assert.equal(fixture.actor.system.resources.movement.value, 15);
  assert.equal(fixture.semanticEvents.gm.length, 5);
  assert.deepEqual(fixture.persistence.operations.map(operation => operation.updates["system.resources.movement.value"]), [25, 20, 15]);
});

test("a constrained stop at the approved final waypoint remains interruption, never guessed completion", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = checkpointOperation(fixture.token, {passedCount: 3});
  movement.constrained = true;
  movement.finished = Promise.resolve(false);
  await approveCheckpoint(fixture, movement);
  const document = checkpointSnapshot(fixture, movement, "stopped");
  assert.equal((await fireMoveTokenHook(fixture, {token: document, movement})).ok, true);
  assert.equal((await lifecycleHook(fixture, document, "stopped")).duplicate, true);
  assert.equal(progressOf(fixture, movement).status, "interrupted");
  assert.equal(progressOf(fixture, movement).remainingTransitionCount, 0);
  assert.equal(fixture.semanticEvents.gm.at(-1).data.interruption.reason, "foundry-constrained");
  assert.equal(fixture.semanticEvents.gm.some(event => event.type === "movement.completed"), false);
  assert.equal(fixture.actor.system.resources.movement.value, 15);
});

/* -------------------------------------------- */
/*  Tests                                       */
/* -------------------------------------------- */

for ( const row of [2, 3] ) {
  for ( const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] ) {
    test(`Large hex translation approves direction ${dq},${dr} from row ${row} and pays once`, async () => {
      const fixture = footprintTranslationFixture({row});
      const {token, actor, scene, gmAuthority, persistence, hub} = fixture;
      const adapter = createFoundryV14TacticalGridAdapter({scene});
      const original = adapter.tokenToFootprint(token);
      assert.equal(original.footprint.fields.length, 3);
      assert.notDeepEqual(adapter.pointToField(token).field, original.anchor);
      const target = scene.grid.cubeToOffset({q: 2 + dq, r: row + dr});
      const movement = movementOperation(token, {offsets: [target]});

      await withFoundryGlobals(fixture, async () => {
        assert.notEqual(await token._preUpdateMovement(movement, {}), false, fixture.warnings.join("\n"));
      });
      const approval = [...gmAuthority.approvedMovements.values()][0].approval;
      assert.deepEqual(anchorKeys(approval.path), [`hex:3,${row}`, `hex:${3 + dq},${row + dr}`]);
      assert.equal(approval.evaluation.cost.amount, 5);
      assert.deepEqual(approval.evaluation.footprints.map(footprint => footprint.fields.length), [3, 3]);
      assert.equal(actor.system.resources.movement.value, 30);
      assert.equal(persistence.operations.length, 0);
      assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
      assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_INTENT
        && message.senderUserId === PLAYER.id && message.recipientUserId === GM.id), true);

      // V14 completion can expose old prepared values and updated source values.
      token.setSourceOffset(target);
      assert.equal((await fireMoveTokenHook(fixture, {movement, game: fixture.playerGame})).ignored, true);
      assert.equal((await fireMoveTokenHook(fixture, {movement})).committed, true);
      assert.equal((await fireMoveTokenHook(fixture, {movement})).duplicate, true);
      assert.equal(actor.system.resources.movement.value, 25);
      assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
      assert.equal(hub.messages.every(message => isPlainSerializableData(message)), true);
      assert.deepEqual(fixture.semanticEvents.player, []);
      assert.deepEqual(fixture.semanticEvents.gm.map(event => event.type), [
        "movement.started", "movement.transition", "movement.completed"
      ]);
      const transition = fixture.semanticEvents.gm[1];
      assert.deepEqual(transition.data.from.footprint, approval.evaluation.footprints[0]);
      assert.deepEqual(transition.data.to.footprint, approval.evaluation.footprints[1]);
      assert.equal(transition.data.stepCost.amount, 5);
      assert.equal(transition.metadata.authority.userId, GM.id);
    });
  }
}

for ( const [topology, size, fieldCount] of [
  [GRID_TOPOLOGIES.SQUARE, CREATURE_SIZES.MEDIUM, 1],
  [GRID_TOPOLOGIES.HEX, CREATURE_SIZES.MEDIUM, 1],
  [GRID_TOPOLOGIES.SQUARE, CREATURE_SIZES.LARGE, 4],
  [GRID_TOPOLOGIES.HEX, CREATURE_SIZES.LARGE, 3],
  [GRID_TOPOLOGIES.HEX, CREATURE_SIZES.HUGE, 7]
] ) {
  for ( const steps of [1, 2] ) {
    test(`${size} ${topology} translation reconstructs dimensionless waypoints and spends ${steps * 5} ft`, async () => {
      const fixture = footprintTranslationFixture({topology, size});
      const {token, actor, scene, gmAuthority, persistence, occupiedStates} = fixture;
      const offsets = Array.from({length: steps}, (_, index) => topology === GRID_TOPOLOGIES.HEX
        ? scene.grid.cubeToOffset({q: 3 + index, r: 2}) : {i: 3 + index, j: 2});
      const movement = movementOperation(token, {offsets});
      await withFoundryGlobals(fixture, async () => {
        assert.notEqual(await token._preUpdateMovement(movement, {}), false, fixture.warnings.join("\n"));
      });
      const approval = [...gmAuthority.approvedMovements.values()][0].approval;
      assert.equal(approval.path.size, size);
      assert.equal(approval.path.anchors.length, steps + 1);
      assert.deepEqual(approval.evaluation.footprints.map(footprint => footprint.fields.length), Array(steps + 1).fill(fieldCount));
      assert.equal(approval.evaluation.cost.amount, steps * 5);
      for ( const offset of offsets ) {
        const position = pointForOffset(scene, offset);
        assert.equal(occupiedStates.some(state => state.x === position.x && state.y === position.y
          && state.width === token.width && state.height === token.height
          && state.depth === token.depth && state.shape === token.shape && state.elevation === token.elevation), true);
      }
      token.setSourceOffset(offsets.at(-1));
      assert.equal((await fireMoveTokenHook(fixture, {movement})).committed, true);
      assert.equal(actor.system.resources.movement.value, 30 - steps * 5);
      assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
      const transitions = fixture.semanticEvents.gm.filter(event => event.type === "movement.transition");
      assert.equal(transitions.length, steps);
      assert.deepEqual(transitions.map(event => event.data.transitionIndex), Array.from({length: steps}, (_, i) => i));
      for ( const [index, event] of transitions.entries() ) {
        assert.equal(event.data.from.footprint.fields.length, fieldCount);
        assert.equal(event.data.to.footprint.fields.length, fieldCount);
        assert.equal(event.data.cumulativeCost, (index + 1) * 5);
        assert.equal(event.data.leftFields.length + event.data.retainedFields.length, fieldCount);
        assert.equal(event.data.enteredFields.length + event.data.retainedFields.length, fieldCount);
      }
      assert.equal(fixture.semanticEvents.gm.at(-1).data.actualTotalCost, steps * 5);
    });
  }
}

test("Large translation validates and expands from source state while prepared origin is stale", async () => {
  const fixture = footprintTranslationFixture();
  const {token, scene, playerAuthority} = fixture;
  token.setSourceOffset(scene.grid.cubeToOffset({q: 3, r: 2}));
  const movement = movementOperation(token, {offsets: [scene.grid.cubeToOffset({q: 4, r: 2})]});
  movement.origin = token.toObject(true);
  const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement, user: PLAYER});
  const approval = await playerAuthority.requestMovementApproval(intent);
  assert.equal(approval.approved, true, approval.reason);
  assert.deepEqual(anchorKeys(approval.path), ["hex:4,2", "hex:5,2"]);
  assert.deepEqual(token.lastCompletePathWaypoints[0], intent.origin);
  assert.equal(approval.payment.actorResourceAmount, 5);
});

test("stale Large origin position is rejected against source footprint with plain diagnostics", async () => {
  const fixture = footprintTranslationFixture();
  const {token, scene, playerAuthority, gmAuthority, actor, persistence} = fixture;
  const movement = movementOperation(token, {offsets: [scene.grid.cubeToOffset({q: 3, r: 2})]});
  const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement, user: PLAYER});
  token.setSourceOffset(scene.grid.cubeToOffset({q: 4, r: 2}));
  const approval = await playerAuthority.requestMovementApproval(intent);
  assert.equal(approval.approved, false);
  assert.equal(approval.code, FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH);
  assert.deepEqual(approval.diagnostics.clientOriginAnchor, {q: 3, r: 2});
  assert.deepEqual(approval.diagnostics.authoritativeOriginAnchor, {q: 5, r: 2});
  assert.equal(approval.diagnostics.clientOriginFields.length, 3);
  assert.equal(approval.diagnostics.authoritativeOriginFields.length, 3);
  assert.equal(isPlainSerializableData(approval.diagnostics), true);
  assert.equal(token.completePathCalls, 0);
  assert.equal(gmAuthority.approvedMovements.size, 0);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
});

test("client Large dimensions cannot authorize translation of an authoritative Medium Token", async () => {
  const fixture = footprintTranslationFixture();
  const {token, actor, playerAuthority} = fixture;
  const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement: movementOperation(token), user: PLAYER});
  token.wildpathSize = actor.system.traits.size = CREATURE_SIZES.MEDIUM;
  token._sourcePosition = {...token._sourcePosition, width: 1, height: 1};
  const approval = await playerAuthority.requestMovementApproval(intent);
  assert.equal(approval.approved, false);
  assert.equal(approval.code, FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH);
  assert.equal(approval.diagnostics.authoritativeOriginFields.length, 1);
  assert.deepEqual(approval.diagnostics.mismatches.map(entry => entry.field), ["width", "height"]);
  assert.equal(token.completePathCalls, 0);
});

for ( const [field, value] of [["width", 2.5], ["height", 2.5], ["depth", 2], ["shape", 1], ["elevation", 5], ["width", null]] ) {
  test(`Large origin rejects stale or missing ${field}=${value} even with identical occupied fields`, async () => {
    const fixture = footprintTranslationFixture();
    const {token, playerAuthority} = fixture;
    const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement: movementOperation(token), user: PLAYER});
    if ( value === null ) delete intent.origin[field];
    else intent.origin[field] = value;
    // An omitted width must be rejected even if Foundry can infer the same occupied fields.
    const occupied = token.getOccupiedGridSpaceOffsets;
    token.getOccupiedGridSpaceOffsets = function(data) {
      return occupied.call(this, {...data, width: data?.width ?? this.width});
    };
    const approval = await playerAuthority.requestMovementApproval(intent);
    assert.equal(approval.approved, false);
    assert.equal(approval.code, FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH);
    assert.deepEqual(approval.diagnostics.clientOriginFields, approval.diagnostics.authoritativeOriginFields);
    assert.equal(approval.diagnostics.mismatches.some(entry => entry.field === field), true);
    assert.equal(fixture.persistence.operations.length, 0);
  });
}

test("pixel origins representing the same full tactical footprint remain valid", async () => {
  const fixture = footprintTranslationFixture();
  const {token, scene, playerAuthority} = fixture;
  const movement = movementOperation(token, {offsets: [scene.grid.cubeToOffset({q: 3, r: 2})]});
  const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement, user: PLAYER});
  intent.origin.x += 1;
  intent.origin.y += 1;
  const approval = await playerAuthority.requestMovementApproval(intent);
  assert.equal(approval.approved, true, approval.reason);
  assert.equal(approval.payment.actorResourceAmount, 5);
  const record = [...fixture.gmAuthority.approvedMovements.values()][0];
  assert.equal(record.originState.x, intent.origin.x - 1);
  assert.equal(record.originState.y, intent.origin.y - 1);
  token.setSourceOffset(scene.grid.cubeToOffset({q: 3, r: 2}));
  assert.equal((await fireMoveTokenHook(fixture, {movement})).committed, true);
  assert.equal(fixture.semanticEvents.gm.length, 3);
});

test("translation fails closed when authoritative Token source cannot be read", async () => {
  const fixture = footprintTranslationFixture();
  const {token, playerAuthority, persistence} = fixture;
  const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement: movementOperation(token), user: PLAYER});
  token.toObject = () => { throw new Error("Source unavailable"); };
  const approval = await playerAuthority.requestMovementApproval(intent);
  assert.equal(approval.approved, false);
  assert.equal(approval.reason, "Source unavailable");
  assert.equal(token.completePathCalls, 0);
  assert.equal(persistence.operations.length, 0);
});

test("completed waypoint resize remains unsupported even if the intent was labeled translation", async () => {
  const fixture = footprintTranslationFixture();
  const {token, scene, playerAuthority} = fixture;
  const movement = movementOperation(token, {offsets: [scene.grid.cubeToOffset({q: 3, r: 2})]});
  const {intent} = buildFoundryMovementIntent({tokenDocument: token, movement, user: PLAYER});
  const completePath = token.getCompleteMovementPath;
  token.getCompleteMovementPath = function(waypoints) {
    return completePath.call(this, waypoints).map((waypoint, index) => index ? {...waypoint, width: 3} : waypoint);
  };
  const approval = await playerAuthority.requestMovementApproval(intent);
  assert.equal(approval.approved, false);
  assert.equal(approval.code, FOUNDRY_MOVEMENT_CODES.UNSUPPORTED_TOKEN_OPERATION);
  assert.equal(fixture.persistence.operations.length, 0);
});

test("resize then Large hex player movement spends only the synthetic Token Actor once", async () => {
  const fixture = footprintTranslationFixture({size: CREATURE_SIZES.MEDIUM});
  const {token, actor, scene, gmAuthority, persistence} = fixture;
  const worldActor = fakeActor(actor.id);
  actor.isToken = true;
  actor.parent = token;
  actor.uuid = `${token.uuid}.Actor.${actor.id}`;
  fixture.playerGame.actors.set(actor.id, worldActor);
  fixture.gmGame.actors.set(actor.id, worldActor);
  const resize = resizeOperation(token);
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(resize, {}), false);
  });
  resizeTokenSource(token, {width: 2, height: 2});
  assert.equal((await fireMoveTokenHook(fixture, {movement: resize})).spent, false);
  assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);

  const target = scene.grid.cubeToOffset({q: 3, r: 2});
  const movement = movementOperation(token, {id: "move-after-resize", offsets: [target]});
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false, fixture.warnings.join("\n"));
  });
  const approval = [...gmAuthority.approvedMovements.values()].find(record => record.movementId === movement.id).approval;
  assert.equal(approval.path.size, CREATURE_SIZES.LARGE);
  assert.deepEqual(approval.evaluation.footprints.map(footprint => footprint.fields.length), [3, 3]);
  assert.equal(approval.actorRef.synthetic, true);
  token.setSourceOffset(target);
  assert.equal((await fireMoveTokenHook(fixture, {movement, game: fixture.playerGame})).ignored, true);
  const results = await withFoundryGlobals(fixture, () => Promise.all([
    onFoundryV14MoveToken(token, movement, {}, PLAYER, {game: fixture.gmGame}),
    onFoundryV14MoveToken(token, movement, {}, PLAYER, {game: fixture.gmGame})
  ]), {game: fixture.gmGame});
  assert.equal(results.filter(result => result.committed).length, 1);
  assert.equal(actor.system.resources.movement.value, 25);
  assert.equal(worldActor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 1);
  assert.equal(persistence.operations[0].actorRef, actor.uuid);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.deepEqual(fixture.semanticEvents.player, []);
  assert.equal(fixture.semanticEvents.gm.every(event => event.data.actorRef === `uuid:${actor.uuid}`), true);
});

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

test("raw Foundry movement serialization preserves Token footprint dimensions", () => {
  const fixture = createMovementRuntimeFixture();
  const {token} = fixture;
  const movement = resizeOperation(token, {id: "resize-serialize"});
  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  });

  assert.equal(built.ok, true);
  assert.equal(built.intent.origin.width, 1);
  assert.equal(built.intent.origin.height, 1);
  assert.equal(built.intent.origin.depth, 1);
  assert.equal(built.intent.origin.shape, 0);
  assert.equal(built.intent.destination.width, 2);
  assert.equal(built.intent.destination.height, 2);
  assert.equal(built.intent.destination.depth, 1);
  assert.equal(built.intent.destination.shape, 0);
  assert.equal(built.intent.waypoints[0].action, "displace");
  assert.equal(built.intent.waypoints[0].explicit, true);
  assert.equal(built.intent.waypoints[0].intermediate, false);
  assert.equal(built.intent.waypoints[0].snapped, false);
  assert.equal(built.intent.waypoints[0].cost, 0);
  assert.equal(isPlainSerializableData(built.intent), true);
  assert.deepEqual(JSON.parse(JSON.stringify(built.intent)), built.intent);
});

test("live-shaped zero-cost config displace payload is classified as footprint resize", () => {
  const fixture = createMovementRuntimeFixture();
  const {token} = fixture;
  const movement = resizeOperation(token, {id: "resize-classifier"});
  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  });
  const classified = classifyFoundryTokenOperation({
    movement,
    origin: built.intent.origin,
    destination: built.intent.destination,
    waypoints: built.intent.waypoints
  });

  assert.equal(classified.type, FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE);
  assert.equal(classified.hasFootprintChange, true);
  assert.equal(classified.hasTranslation, false);
  assert.equal(built.intent.movementKind, MOVEMENT_KINDS.VOLUNTARY);
  assert.equal(built.intent.foundry.tokenOperationType, FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE);
});

test("square Token resize is approved through production movement and consumes no movement", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, gmAuthority, persistence} = fixture;
  const movement = resizeOperation(token, {id: "resize-square"});

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.equal(approval.footprintTransition.operationType, FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE);
  assert.equal(approval.payment.consumesBudget, false);
  assert.equal(approval.payment.amount, 0);
  assert.equal(approval.path, null);
  assert.equal(approval.footprintTransition.destination.footprint.size, CREATURE_SIZES.LARGE);
  assert.deepEqual(new Set(approval.footprintTransition.destination.footprint.fieldKeys), new Set([
    "square:0,0",
    "square:1,0",
    "square:0,1",
    "square:1,1"
  ]));

  resizeTokenSource(token, {width: 2, height: 2, depth: 1, shape: 0});
  const committed = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });

  assert.equal(committed.ok, true);
  assert.equal(committed.committed, true);
  assert.equal(committed.spent, false);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
});

test("Token resize succeeds with nearly exhausted movement and does not refresh it", async () => {
  const actor = fakeActor("nearly-exhausted", {movement: 5, maxMovement: 30});
  const fixture = createMovementRuntimeFixture({actor});
  const {token, persistence} = fixture;
  const movement = resizeOperation(token, {id: "resize-nearly-exhausted"});

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });
  resizeTokenSource(token, {width: 2, height: 2, depth: 1, shape: 0});
  const committed = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });

  assert.equal(committed.ok, true);
  assert.equal(committed.spent, false);
  assert.equal(actor.system.resources.movement.value, 5);
  assert.equal(persistence.operations.length, 0);
});

test("stale Token resize origin is rejected before payment or completion", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const origin = tokenStateForOffset(token, {i: 0, j: 0}, {width: 1, height: 1, depth: 1, shape: 0});
  const movement = resizeOperation(token, {
    id: "resize-stale-origin",
    origin,
    destination: {...origin, width: 2, height: 2}
  });
  resizeTokenSource(token, {width: 2, height: 2, depth: 1, shape: 0});

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.equal(allowed, false);
  });

  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.playerAuthority.errors.at(-1).approval.code, FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH);
});

test("hex Token resize uses the existing Large hex footprint provider and consumes no movement", async () => {
  const fixture = createMovementRuntimeFixture({
    grid: new FakeHexGrid()
  });
  const {actor, token, gmAuthority, persistence} = fixture;
  const movement = resizeOperation(token, {id: "resize-hex"});

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.equal(approval.code, FOUNDRY_MOVEMENT_CODES.OK);
  assert.equal(approval.footprintTransition.destination.footprint.topology, GRID_TOPOLOGIES.HEX);
  assert.equal(approval.footprintTransition.destination.footprint.size, CREATURE_SIZES.LARGE);
  assert.equal(approval.footprintTransition.destination.footprint.fields.length, 3);
  assert.equal(
    approval.footprintTransition.destination.footprint.fieldKeys.every(key => key.startsWith("hex:")),
    true
  );

  resizeTokenSource(token, {width: 2, height: 2, depth: 1, shape: 0});
  const committed = await fireMoveTokenHook(fixture, {
    movement,
    user: {...PLAYER, isSelf: false},
    game: fixture.gmGame
  });
  const actualFootprint = createFoundryV14TacticalGridAdapter({scene: token.parent}).tokenToFootprint(token);

  assert.equal(committed.ok, true);
  assert.equal(committed.spent, false);
  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
  assert.equal(actualFootprint.footprint.size, CREATURE_SIZES.LARGE);
  assert.equal(actualFootprint.footprint.fields.length, 3);
});

test("config position changes with unchanged dimensions remain translation movement", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, gmAuthority} = fixture;
  const movement = movementOperation(token, {
    id: "move-config-position",
    offsets: [{i: 1, j: 0}]
  });
  movement.method = "config";
  movement.constrainOptions = {ignoreCost: true};

  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  });
  assert.equal(built.intent.foundry.tokenOperationType, FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION);

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.notEqual(allowed, false);
  });

  const approval = [...gmAuthority.approvedMovements.values()][0].approval;
  assert.equal(approval.path.type, "MovementPath");
  assert.equal(approval.payment.consumesBudget, true);
  assert.equal(approval.evaluation.cost.amount, 5);
});

test("combined translation and resize is distinguished and explicitly rejected", async () => {
  const fixture = createMovementRuntimeFixture();
  const {actor, token, persistence} = fixture;
  const origin = tokenStateForOffset(token, {i: 0, j: 0}, {width: 1, height: 1, depth: 1, shape: 0});
  const destination = tokenStateForOffset(token, {i: 1, j: 0}, {width: 2, height: 2, depth: 1, shape: 0});
  const movement = resizeOperation(token, {
    id: "resize-and-translate",
    origin,
    destination
  });
  movement.passed.cost = 5;
  movement.passed.distance = 5;
  movement.passed.spaces = 1;
  movement.passed.waypoints = [{
    ...destination,
    cost: 5,
    action: "move",
    explicit: true,
    intermediate: false,
    snapped: false
  }];

  const built = buildFoundryMovementIntent({
    tokenDocument: token,
    movement,
    user: PLAYER,
    game: fixture.playerGame
  });
  assert.equal(built.intent.foundry.tokenOperationType, FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION_RESIZE);

  await withFoundryGlobals(fixture, async () => {
    const allowed = await token._preUpdateMovement(movement, {});
    assert.equal(allowed, false);
  });

  assert.equal(actor.system.resources.movement.value, 30);
  assert.equal(persistence.operations.length, 0);
  assert.equal(fixture.playerAuthority.errors.at(-1).approval.code, FOUNDRY_MOVEMENT_CODES.UNSUPPORTED_TOKEN_OPERATION);
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
  assert.equal(observed.ok, false);
  assert.equal(observed.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_OBSERVATION_AMBIGUOUS);
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
  assert.equal((await fireMoveTokenHook(fixture, {movement})).ok, true);

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
    fixture.gmAuthority.observeMovementCompletion(completion, {tokenDocument: token}),
    fixture.gmAuthority.observeMovementCompletion(completion, {tokenDocument: token})
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 1);
});

test("concurrent movement commit socket envelopes spend movement once", async () => {
  let failNext = true;
  const fixture = createMovementRuntimeFixture({persistenceOptions: {
    failOn() { const fail = failNext; failNext = false; return fail; }
  }});
  const {actor, token, gmAuthority, persistence} = fixture;
  const movement = movementOperation(token, {
    id: "move-concurrent-socket-completion",
    offsets: [{i: 2, j: 0}]
  });

  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  moveTokenToOffset(token, {i: 2, j: 0});
  assert.equal((await fireMoveTokenHook(fixture, {movement})).ok, false);
  assert.equal(fixture.semanticEvents.gm.length, 4);

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
  assert.equal(persistence.operations.filter(operation => operation.type === "updateActor").length, 2);
  assert.equal(fixture.semanticEvents.gm.length, 4);
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

  const failed = await fireMoveTokenHook(fixture, {movement});
  assert.equal(failed.ok, false);
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

test("authoritative facts wait for finished and emit once across concurrent GM and repeated player observations", async () => {
  const fixture = createMovementRuntimeFixture();
  const {token, gmAuthority, semanticEvents, actor} = fixture;
  const movement = movementOperation(token, {offsets: [{i: 2, j: 0}]});
  let finish;
  movement.finished = new Promise(resolve => { finish = resolve; });
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await token._preUpdateMovement(movement, {}), false);
  });
  const record = [...gmAuthority.approvedMovements.values()][0];
  assert.equal(record.progress.status, "pending");
  assert.deepEqual(record.semanticEvents, []);
  token.setSourceOffset({i: 2, j: 0});
  await withFoundryGlobals(fixture, async () => {
    const observations = [fixture.playerGame, fixture.gmGame, fixture.gmGame].map(game =>
      onFoundryV14MoveToken(token, movement, {}, PLAYER, {game}));
    await Promise.resolve();
    assert.deepEqual(semanticEvents, {player: [], gm: []});
    assert.equal(actor.system.resources.movement.value, 30);
    finish(true);
    const results = await Promise.all(observations);
    assert.equal(results.filter(result => result.committed).length, 1);
  }, {game: fixture.gmGame});
  assert.equal((await fireMoveTokenHook(fixture, {movement})).duplicate, true);
  assert.equal((await fireMoveTokenHook(fixture, {movement, game: fixture.playerGame})).ignored, true);
  assert.deepEqual(semanticEvents.player, []);
  assert.deepEqual(semanticEvents.gm.map(event => event.type), [
    "movement.started", "movement.transition", "movement.transition", "movement.completed"
  ]);
  assert.equal(new Set(semanticEvents.gm.map(event => event.id)).size, 4);
  assert.equal(record.progress.status, "completed");
  assert.equal(record.progress.completedTransitionCount, 2);
  assert.equal(record.progress.cumulativeCost, 10);
  assert.equal(actor.system.resources.movement.value, 20);
  assert.equal(fixture.persistence.operations.length, 1);
  for ( const event of semanticEvents.gm ) {
    assert.equal(isPlainSerializableData(event), true);
    assert.deepEqual(event.metadata.authority, {userId: GM.id, mode: "active-gm"});
    assert.deepEqual(event.metadata.observation, {
      source: "foundry-v14", lifecycle: "moveToken", timing: "completion-reconciled", finished: true
    });
  }
});

for ( const outcome of ["false", "rejected", "missing"] ) {
  test(`movement with ${outcome} finished confirmation emits no movement facts`, async () => {
    const fixture = createMovementRuntimeFixture();
    const movement = movementOperation(fixture.token);
    await withFoundryGlobals(fixture, async () => {
      assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
    });
    fixture.token.setSourceOffset({i: 1, j: 0});
    movement.finished = outcome === "missing" ? undefined
      : outcome === "rejected" ? Promise.reject(new Error("stopped")) : Promise.resolve(false);
    assert.equal((await fireMoveTokenHook(fixture, {movement})).ignored, true);
    assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
    assert.equal(fixture.persistence.operations.length, 0);
    assert.equal([...fixture.gmAuthority.approvedMovements.values()][0].progress.status, "pending");
  });
}

for ( const mismatch of ["source", "route", "missing-route"] ) {
  test(`completed movement rejects ${mismatch} mismatch without authoring approved route facts`, async () => {
    const fixture = createMovementRuntimeFixture();
    const movement = movementOperation(fixture.token, {offsets: [{i: 2, j: 0}]});
    await withFoundryGlobals(fixture, async () => {
      assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
    });
    fixture.token.setSourceOffset({i: mismatch === "source" ? 1 : 2, j: 0});
    if ( mismatch === "route" ) movement.pending.waypoints.unshift(pointForOffset(fixture.scene, {i: 0, j: 1}));
    if ( mismatch === "missing-route" ) movement.pending.waypoints = [];
    const result = await fireMoveTokenHook(fixture, {movement});
    assert.equal(result.ok, false);
    assert.equal(result.code, mismatch === "source" ? FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH
      : FOUNDRY_MOVEMENT_CODES.COMPLETION_ROUTE_MISMATCH);
    assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
    assert.equal(fixture.persistence.operations.length, 0);
  });
}

test("socket claims cannot pay an unverified route or suppress later local GM observation", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = movementOperation(fixture.token);
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
  });
  fixture.token.setSourceOffset({i: 1, j: 0});
  const {completion} = buildFoundryMovementCompletion({
    tokenDocument: fixture.token, movement, user: PLAYER, game: fixture.playerGame
  });
  await fixture.playerAuthority.commitMovementCompletion(completion);
  assert.equal(fixture.actor.system.resources.movement.value, 30);
  assert.equal(fixture.playerAuthority.errors.at(-1).result.code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_PROGRESS_UNVERIFIED);
  assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
  assert.equal((await fireMoveTokenHook(fixture, {movement})).committed, true);
  assert.equal((await fireMoveTokenHook(fixture, {movement})).duplicate, true);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(fixture.persistence.operations.length, 1);
});

test("verified movement facts survive payment failure without repeating on successful retry", async () => {
  let failNext = true;
  const fixture = createMovementRuntimeFixture({persistenceOptions: {
    failOn() { const fail = failNext; failNext = false; return fail; }
  }});
  const movement = movementOperation(fixture.token);
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
  });
  fixture.token.setSourceOffset({i: 1, j: 0});
  assert.equal((await fireMoveTokenHook(fixture, {movement})).code, FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(fixture.actor.system.resources.movement.value, 30);
  assert.equal((await fireMoveTokenHook(fixture, {movement})).committed, true);
  assert.equal(fixture.semanticEvents.gm.length, 3);
  assert.equal(fixture.actor.system.resources.movement.value, 25);
});

test("consumer mutation and synchronous failure cannot corrupt stored facts or repeat movement payment", async () => {
  const fixture = createMovementRuntimeFixture({onAutomationEvent(event) {
    event.data.movementId = "listener-mutated";
    throw new Error("consumer failed");
  }});
  const movement = movementOperation(fixture.token);
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
  });
  fixture.token.setSourceOffset({i: 1, j: 0});
  assert.equal((await fireMoveTokenHook(fixture, {movement})).committed, true);
  assert.equal((await fireMoveTokenHook(fixture, {movement})).duplicate, true);
  const record = [...fixture.gmAuthority.approvedMovements.values()][0];
  assert.equal(record.semanticEvents.length, 3);
  assert.equal(record.semanticEvents.every(event => event.data.movementId === movement.id), true);
  assert.equal(record.eventDeliveryErrors.length, 3);
  assert.equal(record.eventDeliveryErrors.every(error => error.code === FOUNDRY_MOVEMENT_CODES.MOVEMENT_EVENT_DELIVERY_FAILED), true);
  assert.equal(fixture.persistence.operations.length, 1);
});

for ( const kind of ["forced", "teleport"] ) {
  test(`${kind} production semantics retain costs and topology without ordinary payment`, async () => {
    const fixture = createMovementRuntimeFixture();
    const movement = movementOperation(fixture.token, {kind, offsets: [{i: 6, j: 0}]});
    await withFoundryGlobals(fixture, async () => {
      assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
    });
    fixture.token.setSourceOffset({i: 6, j: 0});
    assert.equal((await fireMoveTokenHook(fixture, {movement})).spent, false);
    const events = fixture.semanticEvents.gm;
    const transitions = events.filter(event => event.type === "movement.transition");
    assert.equal(transitions.length, kind === "teleport" ? 1 : 6);
    assert.equal(events.every(event => event.data.movementKind === kind && event.data.consumesBudget === false), true);
    assert.equal(transitions.every(event => event.data.discontinuous === (kind === "teleport")), true);
    assert.equal(events.at(-1).data.actualTotalCost, kind === "teleport" ? 0 : 30);
    assert.equal(events.at(-1).data.budgetCost, 0);
    if ( kind === "teleport" ) {
      assert.deepEqual(transitions[0].data.leftFields, [{x: 0, y: 0}]);
      assert.deepEqual(transitions[0].data.enteredFields, [{x: 6, y: 0}]);
      assert.equal(fixture.token.completePathCalls, 0);
    }
    assert.equal(fixture.actor.system.resources.movement.value, 30);
    assert.equal(fixture.persistence.operations.length, 0);
  });
}

test("zero-transition production update emits no locomotion facts", async () => {
  const fixture = createMovementRuntimeFixture();
  const movement = movementOperation(fixture.token, {offsets: [{i: 0, j: 0}]});
  await withFoundryGlobals(fixture, async () => {
    assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
  });
  assert.equal((await fireMoveTokenHook(fixture, {movement})).spent, false);
  assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
});

test("Foundry runtime publishes informational AutomationEvents through the generic hook", async () => {
  const fixture = createMovementRuntimeFixture();
  const game = fixture.gmGame;
  game.socket = {on() {}, emit() {}};
  const previousHooks = globalThis.Hooks;
  const delivered = [];
  globalThis.Hooks = {callAll(name, event) { delivered.push({name, event}); return false; }};
  try {
    const registered = registerFoundryV14MultiplayerResolution({game});
    assert.equal(registered.ok, true);
    const movement = movementOperation(fixture.token, {kind: "forced"});
    await withFoundryGlobals(fixture, async () => {
      assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
    }, {game});
    fixture.token.setSourceOffset({i: 1, j: 0});
    assert.equal((await fireMoveTokenHook(fixture, {movement, user: GM})).committed, true);
    assert.equal(delivered.length, 3);
    assert.equal(delivered.every(({name, event}) => name === "wildpath.automationEvent" && event.phase === "information"), true);
  } finally {
    if ( previousHooks === undefined ) delete globalThis.Hooks;
    else globalThis.Hooks = previousHooks;
  }
});

for ( const handoff of [false, true] ) {
  test(`approval owner cannot author events after its GM authority is ${handoff ? "replaced" : "unavailable"}`, async () => {
    const fixture = createMovementRuntimeFixture();
    const movement = movementOperation(fixture.token);
    await withFoundryGlobals(fixture, async () => {
      assert.notEqual(await fixture.token._preUpdateMovement(movement, {}), false);
    });
    fixture.token.setSourceOffset({i: 1, j: 0});
    fixture.hub.users.set(GM.id, {...GM, active: false});
    const nextGM = handoff ? {...GM, id: "gm-b"} : null;
    fixture.gmGame.users.activeGM = nextGM;
    if ( nextGM ) fixture.hub.users.set(nextGM.id, nextGM);
    const result = await fireMoveTokenHook(fixture, {movement});
    assert.equal(result.ok, false);
    assert.equal(result.code, handoff ? MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY : MULTIPLAYER_AUTHORITY_CODES.AUTHORITY_UNAVAILABLE, JSON.stringify(result));
    assert.deepEqual(fixture.semanticEvents, {player: [], gm: []});
    assert.equal(fixture.persistence.operations.length, 0);
  });
}

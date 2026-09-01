# Foundry V14 Tactical Grid Adapter

This document records the first Foundry V14 tactical-grid adapter proof for WildPath.

Production wiring: `module/resolvers/foundry-multiplayer-runtime.mjs`'s
`foundryActionIntentToStagedOptions()` now instantiates this adapter on the authoritative client to
build source/target footprints from the real Actor's canvas Token(s) and the player's
`game.user.targets` selection, feeding `context.spatial` into the staged Action pipeline. Previously
this adapter had no production caller and was exercised only by Node tests against fake Scene/Grid
data; see `test/foundry-action-runtime.test.mjs` for the production-entry regression proof. Live
Foundry V14 runtime QA is still required.

## Ownership

On gridded scenes, WildPath spatial mechanics remain authoritative:

```text
Foundry Scene / Grid / Token
-> FoundryV14TacticalGridAdapter
-> GridField / GridVertex / TokenGridFootprint
-> WildPath Spatial
-> range / reach / Area / targeting
```

Foundry supplies scene configuration, public grid conversions, token placement, and optional
representation diagnostics. It does not become a second range, reach, area, footprint, or targeting
rules engine.

## Adapter

The implementation lives in:

```text
module/adapters/foundry-v14-tactical-grid-adapter.mjs
```

Its public factory is `createFoundryV14TacticalGridAdapter()`. The adapter may hold a live Foundry
`Scene`, `BaseGrid`, or `TokenDocument`, but returned tactical data is plain serializable data:
scene refs, token refs, actor refs, fields, vertices, diagnostics, and target candidate payloads.

The TypeScript-facing contract shapes live in `module/types/contracts.d.ts`:

- `GridField`
- `GridVertex`
- `TokenGridFootprint`
- `GridFootprint`
- `TacticalSceneContext`
- `FoundryTokenTargetFootprint`
- `TacticalGridPort`

## Verified Foundry V14 APIs

The adapter was written against Foundry VTT V14.365 API documentation:

- `foundry.grid.BaseGrid` and its public grid type/accessor/mapping methods:
  `isSquare`, `isHexagonal`, `isGridless`, `getOffset`, `getCenterPoint`, `getVertices`,
  `getAdjacentOffsets`, `getSnappedPoint`.
- `foundry.grid.SquareGrid` for square grid offsets, centers, vertices, and adjacency.
- `foundry.grid.HexagonalGrid` for hex grid configuration and conversion, including `columns`,
  `even`, `offsetToCube`, `cubeToOffset`, `getOffset`, `getCenterPoint`, and
  `getAdjacentOffsets`.
- `foundry.grid.GridlessGrid` for explicit gridless capability detection.
- `CONST.GRID_TYPES`: `GRIDLESS`, `SQUARE`, `HEXODDR`, `HEXEVENR`, `HEXODDQ`, `HEXEVENQ`.
- `foundry.documents.Scene#grid` and `Scene#dimensions` for grid instance and scale metadata.
- `foundry.documents.TokenDocument#getOccupiedGridSpaceOffsets()` for represented occupied-space
  diagnostics.
- Token level/elevation-related APIs were inspected for compatibility: `TokenDocument#locatedInLevel`,
  `TokenDocument#includedInLevel`, `TokenDocument#measureMovementPath`, `TokenDocument#move`,
  `TokenDocument#startMovement`, `TokenDocument#stopMovement`, `RegionDocument`, `Level`, and
  region shape/elevation data.

The adapter currently uses Regions and planned movement only as documented future boundaries; it
does not call Region geometry or movement APIs for mechanical area/range resolution.

## Grid Mapping

Square Foundry offsets map directly:

```text
Foundry {i, j} <-> WildPath {x, y}
```

Hex Foundry offsets map through canonical WildPath axial fields:

```text
Foundry {i, j} <-> cube {q, r, s} <-> WildPath {q, r}
```

When `HexagonalGrid#offsetToCube()` and `#cubeToOffset()` are available, the adapter uses them.
For contract tests without a Foundry runtime it also supports the documented V14 `GRID_TYPES`
variants:

- `HEXODDR` -> `odd-r`
- `HEXEVENR` -> `even-r`
- `HEXODDQ` -> `odd-q`
- `HEXEVENQ` -> `even-q`

This keeps Foundry display orientation and offset parity inside the adapter. WildPath hex mechanics
continue to consume canonical axial fields.

## Field And Vertex Identity

`GridField` identity is tactical, not pixel-based. Pixels are presentation metadata only.

For vertices, the adapter converts Foundry grid-space vertices into stable WildPath `GridVertex`
records. Square vertices use stable `square-vertex:x,y` identities. Hex vertices use the existing
incident-field identity from `grid-footprints.mjs`, so adjacent fields normalize shared vertices to
the same logical id.

Clicked/snapped points can be translated to fields or vertices for battlefield presentation, but the
returned vertex id remains topology-derived. Pixel points are kept under `metadata.foundry.point`.

## Token Footprints

Token footprint authority remains:

```text
effective creature size
+ topology
+ CreatureFootprintProvider
-> TokenFootprintDefinition
-> Token scene anchor
-> TokenGridFootprint
```

The adapter translates Foundry token placement into the anchor field, then calls
`createTokenGridFootprint()`. It does not infer D&D/house-rule creature size from Foundry token
`width`, `height`, art scale, or bounding rectangles.

The default size resolver reads an explicit WildPath/token/actor size if present and otherwise
defaults to Medium. Future effective-size logic should be supplied by rules/application code through
the `sizeResolver` option or a domain provider.

Tiny shared-field semantics remain in `CreatureFootprintProvider` through `creaturesPerField`; the
adapter does not force Tiny tokens to be exclusive occupants.

Irregular/custom footprints remain possible by passing a custom footprint `definition` or provider.
The adapter positions the supplied topology-aware offsets rather than assuming rectangles.

## Foundry Occupied Spaces

`TokenDocument#getOccupiedGridSpaceOffsets()` is used only to compare Foundry's represented occupied
spaces against WildPath's expected tactical footprint.

If the represented spaces match, the adapter can use them to choose the best anchor for the token's
actual scene placement. If they differ, the adapter returns a structured `FOOTPRINT_MISMATCH`
diagnostic and keeps the WildPath footprint definition intact. With `strictOccupancy: true`, the
result is marked not ok, but the expected WildPath footprint is still returned for debugging.

This prevents Foundry token shape data from silently rewriting creature-size rules.

## Range, Reach, Areas, And Targets

The adapter does not implement range, reach, lines, cones, radial areas, or target eligibility.

Existing WildPath helpers consume adapter output:

- `footprintDistance()` measures range from full footprint to full footprint.
- `createReachFootprint()` expands from the source footprint by tactical layers.
- `createRadialFootprint()`, `createLineFootprint()`, `createConeFootprint()`, and
  `previewSourceBoundaryArea()` produce authoritative `GridFootprint` data.
- `resolveAreaTargetCandidates()` and `resolveAreaTargetSet()` intersect that `GridFootprint` with
  adapted token footprints and deduplicate multi-field targets.
- Targeting/refinement decides logical eligibility and per-target overrides after physical
  inclusion.

Scene distance conversion is centralized through the tactical scene context and
`sceneDistanceToGridFields()`, so callers use the scene's configured grid distance and units instead
of hardcoding `5 ft`.

## Gridless

Gridless scenes are detected through `BaseGrid#isGridless` or `CONST.GRID_TYPES.GRIDLESS`.

The adapter returns explicit gridless capabilities:

```text
fields: false
vertices: false
tokenFootprints: false
continuousGeometry: true
```

Gridless field, vertex, token-footprint, and physical-distance-to-field requests return
`GRIDLESS_UNSUPPORTED`. The adapter does not fabricate gridded fields for a gridless scene.

## Level And Elevation

WildPath does not yet have a full vertical tactical model. The adapter preserves token level and
elevation metadata and exposes `validateTokenLevelRelation()`.

For now:

- same explicit level and same elevation are supported,
- different explicit Foundry level refs are rejected with `UNSUPPORTED_LEVEL_RELATION`,
- different explicit elevations are rejected with `UNSUPPORTED_LEVEL_RELATION`,
- missing level metadata is treated as unknown rather than invented.

Area candidate collection can skip unsupported cross-level targets when a source token is supplied.

## Serialization

No live `Scene`, `TokenDocument`, `Actor`, `PIXI`, `Application`, `Map`, `Set`, function, or DOM
object is returned for storage in `ResolutionState`. The adapter returns plain refs and plain
metadata. Live Foundry objects remain in the adapter boundary and are resolved again only when a
future commit/mutation port needs them.

## Future Regions

Foundry V14 Regions are suitable future infrastructure for persistent WildPath areas, hazards,
auras, emanations, and enter/exit/start/end triggers. The intended direction remains:

```text
WildPath persistent GridFootprint / Area state
-> Foundry Region representation
```

Region polygons must not become the mechanical authority for gridded WildPath areas.

## Future Movement

Foundry V14 token movement APIs can provide interaction, path preview, movement execution, and
terrain/region infrastructure. WildPath movement mechanics should still consume topology-aware
complete token footprints and emit semantic movement events. Planned movement should adapt into the
same `GridField`/`TokenGridFootprint` model rather than introducing another spatial representation.

## Future Battlefield UI

The adapter is ready for a small future tactical selection boundary that can choose tokens, fields,
vertices, directions, and endpoints. Such a boundary should feed the existing
`ResolutionState.pendingRequests`/`ChoiceCoordinator` flow and return correlated plain responses.
It should not create a parallel prompt/resume framework, and visual previews should render the exact
`GridFootprint` that resolution will consume.

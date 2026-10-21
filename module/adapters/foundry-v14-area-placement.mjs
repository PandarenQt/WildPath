import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { AREA_SHAPES, createCubeFootprint, createRadialFootprint, createWallFootprint, cubeCornersAgainst, previewSourceBoundaryArea, selectSourceBoundaryOrigin } from "../helpers/tactical-areas.mjs";
import { createReachFootprint, footprintDistance } from "../helpers/grid-footprints.mjs";
// The JS area helpers infer narrow default types; these are the only places their shapes are asserted.
const radialFootprint = createRadialFootprint;
const selectOrigin = selectSourceBoundaryOrigin;
const boundaryArea = previewSourceBoundaryArea;
const reachFootprint = createReachFootprint;
const createCube = createCubeFootprint;
const createWall = createWallFootprint;
const cornersAgainst = cubeCornersAgainst;
/** Clicks that place this area: none for an emanation, one field for a radial area or a Cube, a corner and a direction otherwise. */
export function areaClickCount(definition) {
    const shape = definition.area?.shape;
    return shape === AREA_SHAPES.EMANATION ? 0 : (((shape === AREA_SHAPES.RADIAL) || (shape === AREA_SHAPES.CUBE)) ? 1 : 2);
}
/**
 * The grid fields an area Action covers, from the canvas points that placed it. The client's preview and the
 * authority's resolution both call this, so the highlighted fields are exactly the ones that resolve.
 * Radial: `points[0]` picks the center field, within the Action's range of the caster. Cone and line:
 * `points[0]` picks a corner on the caster's Token edge and `points[1]` the direction.
 */
/** Whether a canvas point's field is within the Action's range of the caster; true when the Action has no range. */
export function foundryPointInRange({ definition, sourceToken, point }) {
    const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
    if (!Number.isFinite(range))
        return true;
    const adapter = createFoundryV14TacticalGridAdapter({ scene: sourceToken.parent });
    const scene = adapter.getSceneContext();
    if (!scene.ok || !("context" in scene))
        return true;
    const { topology, distance: gridDistance } = scene.context.grid;
    const source = adapter.tokenToFootprint(sourceToken);
    const field = adapter.pointToField(point);
    if (!source.ok || !("footprint" in source) || !source.footprint || !field.ok || !field.field)
        return false;
    return footprintDistance(source.footprint, { topology, fields: [field.field] }) * gridDistance <= range;
}
export function foundryAreaFootprint({ definition, sourceToken, points }) {
    const adapter = createFoundryV14TacticalGridAdapter({ scene: sourceToken.parent });
    const scene = adapter.getSceneContext();
    if (!scene.ok || !("context" in scene))
        return { ok: false, code: "NoGrid", reason: "Areas need a square or hex grid." };
    const { topology, distance: gridDistance } = scene.context.grid;
    const sourceResult = adapter.tokenToFootprint(sourceToken);
    if (!sourceResult.ok || !("footprint" in sourceResult) || !sourceResult.footprint)
        return { ok: false, code: "NoFootprint", reason: "The caster's Token has no footprint." };
    const source = sourceResult.footprint;
    const shape = definition.area?.shape;
    const size = Number(definition.area?.size?.value) || 0;
    // An emanation surrounds the caster; its own fields are not part of it.
    if (shape === AREA_SHAPES.EMANATION) {
        const fields = reachFootprint({ source, reachDistance: size, gridDistance }).fields;
        return { ok: true, footprint: { topology, fields, shape } };
    }
    const [first, second] = points;
    if (!first)
        return { ok: false, code: "NeedOrigin", reason: "Choose where the area starts.", needs: "origin" };
    if (shape === AREA_SHAPES.RADIAL) {
        const fieldResult = adapter.pointToField(first);
        if (!fieldResult.ok || !fieldResult.field)
            return { ok: false, code: "OffGrid", reason: "That point is not on the grid.", needs: "origin" };
        const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
        if (Number.isFinite(range) && (footprintDistance(source, { topology, fields: [fieldResult.field] }) * gridDistance > range)) {
            return { ok: false, code: "OutOfRange", reason: "That point is out of range.", needs: "origin" };
        }
        return { ok: true, footprint: radialFootprint({ topology, origin: fieldResult.field, radiusDistance: size, gridDistance }) };
    }
    if (shape === AREA_SHAPES.CUBE)
        return cubeFootprint({ definition, adapter, source, point: first, topology, size, gridDistance });
    if (shape === AREA_SHAPES.WALL)
        return wallFootprint({ definition, adapter, source, points: [first, second], topology, size, gridDistance });
    if ((shape !== AREA_SHAPES.CONE) && (shape !== AREA_SHAPES.LINE))
        return { ok: false, code: "UnsupportedShape", reason: `Unsupported area shape: ${shape}.` };
    const vertexResult = adapter.pointToVertex(first);
    const placement = vertexResult.ok && vertexResult.vertex
        ? selectOrigin({ sources: [{ id: sourceToken.id, footprint: source, token: { id: sourceToken.id } }], vertexId: vertexResult.vertex.id })
        : { ok: false };
    if (!placement.ok)
        return { ok: false, code: "NotOnEdge", reason: "Start the area at a corner on your Token's edge.", needs: "origin" };
    if (!second)
        return { ok: false, code: "NeedDirection", reason: "Choose the area's direction.", needs: "direction" };
    const directionResult = adapter.pointToVertex(second);
    if (!directionResult.ok || !directionResult.vertex)
        return { ok: false, code: "BadDirection", reason: "That direction is not on the grid.", needs: "direction" };
    const preview = boundaryArea({ shape, placement, directionVertex: directionResult.vertex,
        rangeDistance: size, gridDistance, topology });
    if (!preview.ok || !preview.resolved)
        return { ok: false, code: "BadDirection", reason: preview.reason ?? "That direction is not allowed.", needs: "direction" };
    // Where it was aimed: a creature there, above or below, tilts it toward that height (foundryAreaTargetTokens).
    return { ok: true, footprint: { ...preview.resolved, aim: { x: second.x, y: second.y } } };
}
/**
 * A Cube (2024) on a square grid, `size` across. Originating from its caster ("a 15-foot Cube originating from you",
 * a `self` range), it touches the caster's Token on the side toward the click; otherwise it is centered on the click,
 * within range when any of its fields is.
 */
function cubeFootprint({ definition, adapter, source, point, topology, size, gridDistance }) {
    const side = Math.max(1, Math.round(size / gridDistance));
    const fieldResult = adapter.pointToField(point);
    if (!fieldResult.ok || !fieldResult.field)
        return { ok: false, code: "OffGrid", reason: "That point is not on the grid.", needs: "origin" };
    const clicked = fieldResult.field;
    const cube = (corner) => createCube({ topology, corner, side });
    if (definition.range?.type === "self") {
        // The block touching the caster whose center is nearest the click.
        const centerOf = (corner) => ({ x: corner.x + ((side - 1) / 2), y: corner.y + ((side - 1) / 2) });
        const corners = cornersAgainst(source.fields, side);
        const best = corners.sort((a, b) => Math.hypot(centerOf(a).x - clicked.x, centerOf(a).y - clicked.y)
            - Math.hypot(centerOf(b).x - clicked.x, centerOf(b).y - clicked.y))[0];
        const footprint = best ? cube(best) : null;
        return footprint ? { ok: true, footprint } : { ok: false, code: "UnsupportedShape", reason: "Cubes need a square grid.", needs: "origin" };
    }
    const corner = cube({ x: clicked.x - Math.floor((side - 1) / 2), y: clicked.y - Math.floor((side - 1) / 2) });
    // Its point (the clicked field) decides its height (areaHeights).
    const footprint = corner ? { ...corner, point: clicked } : null;
    if (!footprint)
        return { ok: false, code: "UnsupportedShape", reason: "Cubes need a square grid.", needs: "origin" };
    const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
    if (Number.isFinite(range) && (footprintDistance(source, footprint) * gridDistance > range)) {
        return { ok: false, code: "OutOfRange", reason: "That point is out of range.", needs: "origin" };
    }
    return { ok: true, footprint };
}
/**
 * A wall (2024: Wall of Fire, Wall of Thorns, Blade Barrier) on a square grid: it starts on the first clicked field,
 * within range, and runs toward the second for its whole length, in a straight grid path at any angle.
 */
function wallFootprint({ definition, adapter, source, points, topology, size, gridDistance }) {
    const field = (point) => adapter.pointToField(point).field ?? null;
    const start = points[0] ? field(points[0]) : null;
    if (!start)
        return { ok: false, code: "OffGrid", reason: "That point is not on the grid.", needs: "origin" };
    const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
    if (Number.isFinite(range) && (footprintDistance(source, { topology, fields: [start] }) * gridDistance > range)) {
        return { ok: false, code: "OutOfRange", reason: "That point is out of range.", needs: "origin" };
    }
    if (!points[1])
        return { ok: false, code: "NeedDirection", reason: "Choose the area's direction.", needs: "direction" };
    const end = field(points[1]);
    if (!end)
        return { ok: false, code: "BadDirection", reason: "That direction is not on the grid.", needs: "direction" };
    const footprint = createWall({ topology, start, end, length: Math.max(1, Math.round(size / gridDistance)) });
    return footprint ? { ok: true, footprint } : { ok: false, code: "UnsupportedShape", reason: "Walls need a square grid.", needs: "origin" };
}
/**
 * Every Token on the caster's Scene and Level that any covered field touches, the caster included, and (given its
 * `definition`) within the heights the area reaches (areaHeights).
 */
export function foundryAreaTargetTokens({ sourceToken, footprint, definition = null }) {
    const scene = sourceToken.parent;
    const tokensOn = (covered) => {
        const candidates = createFoundryV14TacticalGridAdapter({ scene }).resolveAreaTargetCandidates({ footprint: covered, sourceToken });
        return candidates.candidates.map(candidate => scene.tokens.get(String(candidate.metadata?.foundry?.tokenId))).filter(Boolean);
    };
    const tokens = tokensOn(footprint);
    if (!definition)
        return tokens;
    const gridDistance = Number(scene.grid?.distance) || 5;
    // The height of the creature standing on a field, the highest of several; null with none.
    const heightOn = (field) => {
        const standing = tokensOn({ topology: footprint.topology, fields: [field] }).map(token => Number(token.elevation) || 0);
        return standing.length ? Math.max(0, ...standing) : null;
    };
    const point = (footprint.point ?? footprint.origin);
    const pointHeight = point ? (heightOn(point) ?? 0) : 0;
    const { bottom, top } = areaHeights({ definition, sourceToken, pointHeight, gridDistance });
    const tilt = aimedTilt({ footprint, sourceToken, scene, gridDistance, heightOn });
    return tokens.filter(token => {
        const elevation = Number(token.elevation) || 0;
        const rise = tilt ? tilt.slope * tilt.distanceTo(token) : 0;
        return (elevation <= (top + rise)) && ((elevation + ((Number(token.depth) || 1) * gridDistance)) >= (bottom + rise));
    });
}
/**
 * A cone or line aimed at a creature above or below its caster tilts toward it: from the caster's height to that
 * creature's, so a creature `d` feet away (across) is reached `slope * d` feet higher or lower (2024: areas are 3D). Aimed
 * where no creature stands, it stays level. Null when it is level.
 */
function aimedTilt({ footprint, sourceToken, scene, gridDistance, heightOn }) {
    const aim = footprint.aim;
    if (!aim)
        return null;
    const size = Number(scene.grid?.size) || 100;
    const field = createFoundryV14TacticalGridAdapter({ scene }).pointToField(aim).field ?? null;
    if (!field)
        return null;
    const centerOf = (token) => ({ x: (Number(token.x) || 0) + (((Number(token.width) || 1) * size) / 2),
        y: (Number(token.y) || 0) + (((Number(token.height) || 1) * size) / 2) });
    const from = centerOf(sourceToken);
    const across = (point) => (Math.hypot(point.x - from.x, point.y - from.y) / size) * gridDistance;
    const reach = across(aim);
    const caster = Number(sourceToken.elevation) || 0;
    const aimed = heightOn(field);
    const slope = (reach && (aimed !== null)) ? (aimed - caster) / reach : 0;
    return slope ? { slope, distanceTo: (token) => across(centerOf(token)) } : null;
}
/**
 * How high an area reaches, in feet. On a grid, 2024's 3D areas count cubes as distance does: a Sphere reaches its
 * radius above and below its point, a Cylinder its `area.height` up from it (a circle, height 0, stays on it), a Cube
 * its side up from it. From its caster (a cone, a line, an emanation, a Cube "originating from you") it is level with
 * the caster. A point is as high as the creature standing on it (`pointHeight`), else the ground.
 * A cone or line aimed up or down tilts (aimedTilt).
 */
export function areaHeights({ definition, sourceToken, pointHeight = 0, gridDistance = 5 }) {
    const shape = definition.area?.shape;
    const size = Number(definition.area?.size?.value) || 0;
    const height = definition.area?.height?.value;
    const caster = Number(sourceToken.elevation) || 0;
    const casterTop = caster + ((Number(sourceToken.depth) || 1) * gridDistance);
    if (shape === AREA_SHAPES.LINE)
        return { bottom: caster, top: casterTop };
    if ((shape === AREA_SHAPES.CONE))
        return { bottom: caster - (size / 2), top: casterTop + (size / 2) };
    if (shape === AREA_SHAPES.EMANATION)
        return { bottom: caster - size, top: casterTop + size };
    if (shape === AREA_SHAPES.CUBE) {
        const base = (definition.range?.type === "self") ? caster : pointHeight;
        return { bottom: base, top: base + size };
    }
    if (height != null)
        return { bottom: pointHeight, top: pointHeight + Number(height) };
    // A wall without a height reaches up without end; a Sphere both ways.
    return (shape === AREA_SHAPES.WALL) ? { bottom: pointHeight, top: Infinity } : { bottom: pointHeight - size, top: pointHeight + size };
}

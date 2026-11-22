import { sceneCollision } from "./foundry-v14-walls.mjs";
import { gmNotice } from "../helpers/gm-notice.mjs";
import { pushable, pushedTargets } from "../helpers/forced-movement.mjs";
import { foundryTokenCreatureSize, gridFieldToFoundryOffset } from "./foundry-v14-tactical-grid-adapter.mjs";
import { blink, spaceBeside, teleportDestination } from "./foundry-v14-teleport.mjs";
import { foundryPointInRange } from "./foundry-v14-area-placement.mjs";
import { deadCreature, planeOf } from "./foundry-v14-creature-tokens.mjs";
import { areaBarsLanding } from "./foundry-v14-persistent-areas.mjs";
const key = (offset) => `${offset.i}.${offset.j}`;
/**
 * Where `token` ends up, pushed `fields` fields from `from` (or pulled toward it). Each step is one field along the
 * line between them: on a square grid the longer axis moves a whole field, so a diagonal push crosses diagonals.
 * `until` (a chosen landing's top-left, `from` its centre): it stops there rather than walking on past it.
 */
export function forcedDestination(token, from, fields, { toward = false, blocked, until }) {
    const scene = token.parent;
    const [sizeX, sizeY] = [scene.grid.sizeX ?? scene.grid.size ?? 100, scene.grid.sizeY ?? scene.grid.size ?? 100];
    const centre = token.getCenterPoint();
    const [dx, dy] = toward ? [from.x - centre.x, from.y - centre.y] : [centre.x - from.x, centre.y - from.y];
    const scale = scene.grid.isSquare ? Math.max(Math.abs(dx) / sizeX, Math.abs(dy) / sizeY) : Math.hypot(dx / sizeX, dy / sizeY);
    if (!scale)
        return null;
    let position = { x: token.x, y: token.y };
    const last = until ? Math.min(fields, Math.ceil(scale)) : fields;
    for (let step = 1; step <= last; step++) {
        const next = token.getSnappedPosition({ x: token.x + ((dx / scale) * step), y: token.y + ((dy / scale) * step) });
        if ((next.x === position.x) && (next.y === position.y))
            continue;
        if (blocked(token.getCenterPoint(position), token.getCenterPoint(next), next, position))
            break;
        position = next;
        if (until && (position.x === until.x) && (position.y === until.y))
            break;
    }
    return ((position.x === token.x) && (position.y === token.y)) ? null : position;
}
/**
 * Whether a forced step of `token` to `position` (its top left; `origin` to `destination` its centre's path) is stopped:
 * by the Scene's edge, a wall (on any Scene, viewed or not: foundry-v14-walls.mts), or another creature's space (one on
 * another plane, planeOf, holds none). The `except` Tokens' spaces don't stop it (a carrier the creature moves along
 * with: foundry-v14-carry.mts). Given the top left it steps `from`, a lasting area whose `bars` judge forced moves stops
 * it at its edge as a wall would (areaBarsLanding: Antilife Shell against a Shove), unless the area is attached to an
 * `except` Token (its carrier's own emanation moves with it).
 */
export function forcedStepBlocker(scene, token, { collides = sceneCollision(scene), except = [] } = {}) {
    const plane = (other) => planeOf(other.actor);
    const others = new Set([...scene.tokens].filter(other => (other !== token) && !except.includes(other) && (plane(other) === plane(token)))
        .flatMap(other => (other.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
    return (origin, destination, position, from) => !(scene.dimensions?.sceneRect?.contains(destination.x, destination.y) ?? true)
        || Boolean(collides(origin, destination, { type: "move" }))
        || (token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => others.has(key(offset)))
        || Boolean(from && areaBarsLanding(token, position, "forced", { from, along: except }));
}
/**
 * Whether `token` may be pushed to the field at `point` by an Action whose `push` its user aims (`choose`), as the
 * client's placement and the authority both judge it: a free field on the Scene within `distance` feet of it (as a
 * teleport's landing), within the Action's range of `sourceToken` too with `inRange`, and with `choose: "line"` one on
 * the straight line through `sourceToken`, toward or away ("5 feet toward or away from you"), and one its walk reaches
 * (no creature or wall on the straight way). With `seen`, one `sourceToken` sees (no sight-blocking wall between their
 * centres). A `thrown` creature flies: `distance` is from `sourceToken`, nothing on the way stops it, and a field with
 * creatures on the ground (`occupants`) puts it in the nearest free space beside (Q106 (a) and (d) defaults; refused
 * when none is free, or on its thrower). A lasting area whose `bars` judge forced moves refuses a walk or a throw across
 * its edge (forcedStepBlocker, areaBarsLanding). A refusal is a lang key.
 */
export function pushLanding({ token, sourceToken, point, push, definition }) {
    const landing = teleportDestination({ token, point, distance: push.thrown ? Infinity : (Number(push.distance) || 0),
        occupied: Boolean(push.thrown) });
    if (!landing.ok)
        return { ok: false, key: { NoToken: "WILDPATH.PUSH.NoTarget", OutOfRange: "WILDPATH.PUSH.OutOfRange",
                Occupied: "WILDPATH.TELEPORT.Occupied", OffScene: "WILDPATH.TELEPORT.OffScene" }[landing.code] };
    if (!sourceToken)
        return { ok: false, key: "WILDPATH.PUSH.NoTarget" };
    const scene = token.parent;
    const collides = sceneCollision(scene);
    // A throw reaches from its thrower's space (footprint distance, as an Action's range), not from its centre.
    const throwReach = { range: { normal: { value: Number(push.distance) || 0 } } };
    // shortcut: sight is walls only, from centre to centre (not darkness, invisibility or each field it covers); upgrade with tokenSees.
    const refusal = (at) => ((push.thrown && !foundryPointInRange({ definition: throwReach, sourceToken: sourceToken, point: at }))
        ? "WILDPATH.PUSH.OutOfRange"
        : (push.seen && collides(sourceToken.getCenterPoint(), at, { type: "sight" })) ? "WILDPATH.PUSH.NotSeen" : null);
    const at = token.getCenterPoint(landing.position);
    if (push.inRange && !foundryPointInRange({ definition, sourceToken: sourceToken, point }))
        return { ok: false, key: "WILDPATH.PUSH.OutOfReach" };
    const refused = refusal(at);
    if (refused)
        return { ok: false, key: refused };
    if (push.thrown) {
        const spaces = new Set((token.getOccupiedGridSpaceOffsets?.(landing.position) ?? []).map(key));
        const floor = (other) => Number(scene.levels?.get(String(other.level))?.elevation?.bottom) || 0;
        // A lasting area whose bars judge forced moves keeps it from landing across its edge, on its floor (areaBarsLanding).
        const barred = (position) => Boolean(areaBarsLanding(token, { ...position, elevation: floor(token) }, "forced"));
        if (barred(landing.position))
            return { ok: false, key: "WILDPATH.TELEPORT.Barred" };
        const statuses = (other) => other?.actor?.statuses ?? null;
        // Only a living creature on its Level and its plane is where it lands (as foundry-v14-occupancy counts them).
        const there = [...scene.tokens].filter(other => (other !== token) && ((other.level ?? null) === (token.level ?? null))
            && !deadCreature({ statuses: statuses(other) }) && (planeOf({ statuses: statuses(other) }) === planeOf({ statuses: statuses(token) }))
            && (other.getOccupiedGridSpaceOffsets?.() ?? []).some(offset => spaces.has(key(offset))));
        if (there.some(other => other === sourceToken))
            return { ok: false, key: "WILDPATH.TELEPORT.Occupied" };
        // Those in the air above it are not where it lands.
        const occupants = there.filter(other => (Number(other.elevation) || 0) <= floor(other));
        if (!occupants.length)
            return { ...landing, occupants };
        // The space beside is one the throw reaches too: within its distance, seen with `seen`, and no wall from the landing.
        const beside = spaceBeside(token, { getOccupiedGridSpaceOffsets: () => token.getOccupiedGridSpaceOffsets?.(landing.position) ?? [] }, position => !refusal(token.getCenterPoint(position)) && !barred(position) && !collides(at, token.getCenterPoint(position), { type: "move" }));
        return beside ? { ok: true, position: beside, occupants } : { ok: false, key: "WILDPATH.TELEPORT.Occupied" };
    }
    const fields = Math.floor((Number(push.distance) || 0) / (Number(token.parent?.grid.distance) || 5));
    if (push.choose === "line") {
        const line = [];
        // Toward ends at its user's space: the walk (forcedStepBlocker) never passes through it to the far side.
        const source = new Set((sourceToken.getOccupiedGridSpaceOffsets?.() ?? []).map(key));
        for (const toward of [false, true])
            forcedDestination(token, sourceToken.getCenterPoint(), fields, { toward,
                blocked: (_origin, _destination, at) => {
                    if (toward && (token.getOccupiedGridSpaceOffsets?.(at) ?? []).some(offset => source.has(key(offset))))
                        return true;
                    line.push(at);
                    return false;
                } });
        if (!line.some(at => (at.x === landing.position.x) && (at.y === landing.position.y)))
            return { ok: false, key: "WILDPATH.PUSH.OffLine" };
    }
    // It walks there as afterResolution walks it: a landing a creature or wall on the way would stop it short of is refused,
    // so the click never promises a move the walk does not make.
    const stepBlocked = forcedStepBlocker(token.parent, token);
    let stopped = false;
    forcedDestination(token, token.getCenterPoint(landing.position), fields, { toward: true, until: landing.position,
        blocked: (origin, destination, at, from) => (stopped = stepBlocked(origin, destination, at, from)) });
    return stopped ? { ok: false, key: "WILDPATH.PUSH.Blocked" } : landing;
}
/**
 * Moves `token` out of `fields` (an area's GridFields) to the nearest free space beside it whose footprint lies wholly
 * outside them and no wall stands between (a creature a new wall appears on: "pushed to one side"), as a Blink of
 * `movementKind`. With none, it
 * stays and the GM is told; the landing, or null (also for one already outside them, which stays).
 * shortcut: one ring around its space (spaceBeside), so an area more than a field thick around it leaves it there;
 * upgrade to a wider search if play needs it.
 */
export async function stepOut(token, fields, movementKind) {
    const scene = token.parent;
    const offsetOf = gridFieldToFoundryOffset;
    const covered = new Set(fields.flatMap(field => {
        const offset = offsetOf(field, { grid: scene?.grid }).offset;
        return offset ? [key(offset)] : [];
    }));
    if (!(token.getOccupiedGridSpaceOffsets?.() ?? []).some(offset => covered.has(key(offset))))
        return null;
    const collides = sceneCollision(scene);
    // A Blink passes walls, so a landing behind one (the next room, solid rock) is refused here.
    const landing = spaceBeside(token, token, position => !(token.getOccupiedGridSpaceOffsets?.(position) ?? [])
        .some(offset => covered.has(key(offset))) && !collides(token.getCenterPoint(), token.getCenterPoint(position), { type: "move" }));
    if (!landing) {
        gmNotice("WILDPATH.NOTICE.AreaNoRoom", { name: token.name ?? "" });
        return null;
    }
    await blink(token, landing, movementKind);
    return landing;
}
export function createFoundryForcedMovement({ game, logger = console, fromUuid }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    async function afterResolution({ state, options }) {
        const definition = state?.actionDefinition;
        // Its own push, or a reaction's rider's on it (Forceful Blow: the creature its attack hit).
        const spec = definition?.push ?? (state?.input?.riderPush);
        if (!spec || !state || !isActiveGM())
            return [];
        const source = await fromUuid(String(state.source?.tokenRef ?? ""));
        const scene = source?.parent ?? null;
        if (!source || !scene) {
            gmNotice("WILDPATH.NOTICE.PushNoToken", {}, undefined, { logger });
            return [];
        }
        const gridDistance = Number(scene.grid.distance) || 5;
        const reduction = state.input?.pushReduction ?? {};
        const from = source.getCenterPoint();
        // An aimed push moves only the creature its user aimed, to where they aimed it; none when nothing was aimed. A
        // reaction's landing (`input.pushTo`) came from its chooser's client, so it is checked as the authority checks an
        // Item's; a refused one moves nobody.
        const offered = state.input?.pushTo;
        const checked = (spec.choose && !options?.pushTo && offered) ? pushLanding({ token: scene.tokens.get(String(offered.tokenId)) ?? null,
            sourceToken: source, point: { x: Number(offered.x), y: Number(offered.y) }, push: spec, definition: definition }) : null;
        if (checked && !checked.ok)
            gmNotice("WILDPATH.NOTICE.PushLanding", { name: scene.tokens.get(String(offered.tokenId))?.name ?? "" }, undefined, { logger });
        const aimed = spec.choose ? (options?.pushTo ?? (checked?.ok ? { tokenId: String(offered.tokenId), ...checked.position } : null)) : null;
        const distanceOf = (token) => Math.hypot(token.getCenterPoint().x - from.x, token.getCenterPoint().y - from.y);
        const tokens = pushedTargets(state, definition ?? {}).map(target => scene.tokens.get(String(target?.tokenId ?? "")))
            // An aimed push may move its user itself (a self-targeted Action), and a step out of an area its user too (a caster in
            // its own fissure); any other never moves its source.
            .filter((token) => Boolean(token) && (spec.choose ? (token.id === aimed?.tokenId) : (spec.out || (token !== source)))
            // The size the before-push window judged (actor size on a 1x1 Token), so nobody asked is left behind, or moved unasked.
            && pushable(foundryTokenCreatureSize(token), spec.maxSize))
            // The farthest moves first when pushed, the nearest when pulled, so none blocks another needlessly.
            .sort((a, b) => (spec.toward ? 1 : -1) * (distanceOf(a) - distanceOf(b)));
        const moved = [];
        const collides = sceneCollision(scene);
        // Out of the Action's own lasting area, else out of the area whose trigger ran it (`parentArea`: a fissure's edge).
        const outOf = options?.persistentArea?.footprint?.fields ?? options?.parentArea?.fields ?? [];
        for (const token of tokens) {
            // Out of an area: to the nearest free space beside it (Q142 default), one outside it already staying.
            if (spec.out) {
                if (await stepOut(token, outOf, "forced"))
                    moved.push(token);
                continue;
            }
            // Thrown: set down on its landing (Q42: "not in the air"), so only an area there sees it arrive (Q106 (c) default).
            if (spec.thrown && aimed) {
                await blink(token, { x: aimed.x, y: aimed.y, elevation: Number(scene.levels?.get(String(token.level))?.elevation?.bottom) || 0 }, "forced");
                moved.push(token);
                continue;
            }
            const fields = Math.floor(Math.max((Number(spec.distance) || 0) - (Number(reduction[token.id]) || 0), 0) / gridDistance);
            if (!fields)
                continue;
            const blocked = forcedStepBlocker(scene, token, { collides });
            const destination = aimed ? forcedDestination(token, token.getCenterPoint({ x: aimed.x, y: aimed.y }), fields, { toward: true, blocked, until: { x: aimed.x, y: aimed.y } }) : forcedDestination(token, from, fields, { toward: spec.toward === true, blocked });
            if (!destination)
                continue;
            await token.update({ ...destination }, { wildpath: { movementKind: "forced" } });
            moved.push(token);
        }
        return moved;
    }
    return { afterResolution };
}

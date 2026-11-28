import { createFoundryV14TacticalGridAdapter, foundryOffsetToGridField, gridFieldToFoundryCenterPoint, gridFieldToFoundryOffset } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint, fieldDistance, fieldKey, footprintDistance, offsetGridField } from "../helpers/grid-footprints.mjs";
import { AREA_SHAPES, createRadialFootprint, suggestLanes, wallSections } from "../helpers/tactical-areas.mjs";
import { rollAmount } from "./foundry-digital-roll-provider.mjs";
import { customEffectId, damageExpressionOf } from "../helpers/action-definitions.mjs";
import { MAX_INTERVAL_RUNS, playerOf, runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
import { difficultTerrainBehavior } from "./foundry-v14-terrain.mjs";
import { combatOf, combatStart, deadCreature, planeOf, roundsPassed } from "./foundry-v14-creature-tokens.mjs";
import { damageTaken } from "../resolvers/action-pipeline-resolver.mjs";
import { ineligibleTarget } from "./foundry-v14-senses.mjs";
import { AUTOMATION_EVENT_TYPES } from "../helpers/automation-events.mjs";
import { parseEntityRef } from "../helpers/entity-refs.mjs";
import { sharingSpace } from "./foundry-v14-occupancy.mjs";
import { brokenConcentrationTargets } from "../helpers/forced-movement.mjs";
import { areaWallData, cellPolygons, outlineEdges, sectionWallData, segmentOutside, wallSenses } from "./foundry-v14-walls.mjs";
import { forcedDestination, forcedStepBlocker, lineFields, stepOut } from "./foundry-v14-forced-movement.mjs";
import { areaSpares } from "./foundry-v14-hostility.mjs";
import { gmNotice } from "../helpers/gm-notice.mjs";
import { OBJECT_RULE, actionTags } from "../helpers/rule-elements.mjs";
import { durationSeconds } from "../helpers/metamagic.mjs";
import { fillContextPaths } from "../helpers/value-expressions.mjs";
/** A section Token's image when its `sections` names none: a standing object, not Foundry's creature silhouette. */
export const OBJECT_IMG = "icons/svg/obelisk.svg";
/**
 * The Region colours of an area made from another (an `opens` opening, a `sections.leaves` child), fixed rather than the
 * casting user's, so it never looks like its parent: `pending` while laid out for the GM's Open, `derived` once in effect.
 */
export const DERIVED_AREA_COLORS = Object.freeze({ pending: "#ffd21f", derived: "#e0561b" });
/**
 * An object's world Actor (an area's sections, a statue, a crate): an `npc` of threat 0 with its AC and Hit Points typed,
 * and one feature carrying the object rule (`OBJECT_RULE`) and its own rules (Wall of Ice's Immunity to Cold, Vulnerability
 * to Fire). An unlinked Token of it keeps its own Hit Points; at 0 it dies, as any npc does.
 */
export function objectActorData(object, label) {
    // shortcut: a definition cannot drop the object rule (the GM can, on the Actor); upgrade if Q141's answer wants that.
    const img = object.img || OBJECT_IMG;
    return { name: label, type: "npc", img,
        system: { details: { threat: 0 }, defenses: { ac: { value: object.ac } },
            resources: { health: { base: object.hp, value: object.hp } } },
        prototypeToken: { actorLink: false, disposition: globalThis.CONST
                ?.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0, texture: { src: img } },
        items: [{ type: "feature", name: label, system: { active: true, ruleElements: [structuredClone(OBJECT_RULE),
                        ...structuredClone(object.ruleElements ?? [])] } }] };
}
/**
 * Where a section's Token stands and its size in squares: over the whole section when its fields fill a rectangle (a
 * straight 10-foot section on a 5-foot grid is 2x1 or 1x2), else 1x1 on its first field (a diagonal one).
 */
export function sectionTokenPlacement(scene, fields) {
    const points = fields.map(field => scene.grid.getTopLeftPoint(toOffset(field, { grid: scene.grid }).offset));
    const xs = [...new Set(points.map(point => point.x))];
    const ys = [...new Set(points.map(point => point.y))];
    return (xs.length * ys.length === points.length)
        ? { x: Math.min(...xs), y: Math.min(...ys), width: xs.length, height: ys.length }
        : { ...points[0], width: 1, height: 1 };
}
/** A sectioned area's fields, section by section (`ceil(size / grid distance)` fields each, wallSections). */
const sectionFields = (flag, sections, scene) => wallSections(flag.fields, Math.ceil(Number(sections.size) / (Number(scene.grid.distance) || 5)));
const ROUND = Object.freeze({ value: 1, units: "rounds" });
/** A clock's tick length in seconds (a round by default). */
const tickSeconds = (clock) => durationSeconds(clock.every ?? ROUND) || 6;
/**
 * How many times an area's clock has ticked, its age (`area.ticks` in its triggers' expressions, their `ticks` gates): the
 * seconds it counted over its `every` (a round by default); 0 with no clock.
 */
export function areaTicks(flag) {
    const clock = flag.persistence.clock;
    if (!clock)
        return 0;
    return Math.floor((Number(flag.clock?.seconds) || 0) / tickSeconds(clock));
}
/** A trigger's Action with its area's age written in wherever it reads `area.ticks` (a bead's growing damage). */
const aged = (action, flag) => fillContextPaths(action, { "area.ticks": areaTicks(flag) });
/** The Token an attached area surrounds and follows: the object it was cast on, else its caster. */
const anchorOf = (flag) => flag.anchorTokenId ?? flag.sourceTokenId;
export const AREA_EVENTS = Object.freeze({ CREATED: "area.created", ENTERED: "area.entered", EXITED: "area.exited", MOVED: "area.moved",
    RAMMED: "area.rammed", ENDED: "area.ended", TURN_STARTED: "turn.started", TURN_ENDED: "turn.ended" });
const TURN_EVENTS = [AREA_EVENTS.TURN_STARTED, AREA_EVENTS.TURN_ENDED];
const selfTargeted = (action) => action.targeting?.type === "self";
/**
 * A trigger's action with its damage `count` times over, in one roll: 2d4 three times is 6d4. Any other expression
 * (dice counted or bonused by an expression, a constant, a sum) is added to itself.
 */
const repeatedDamage = (action, count) => ((count === 1) ? action : { ...action,
    damage: (action.damage ?? []).map(part => {
        const expression = damageExpressionOf(part);
        const dice = expression?.number ?? expression?.count ?? 1;
        const plain = (expression?.type === "dice") && (typeof dice === "number")
            && ((expression.bonus == null) || (typeof expression.bonus === "number"));
        return { ...part, expression: plain
                ? { ...expression, number: count * dice, ...((expression.bonus == null) ? {} : { bonus: count * expression.bonus }) }
                : { type: "add", terms: Array.from({ length: count }, () => expression) } };
    }) });
/** An effect its trigger gives only while its creature is in the area (`metadata.endsWhen: "leavesArea"`: Web's Restrained). */
const leavesArea = (effect) => effect.metadata?.endsWhen === "leavesArea";
/**
 * Its Action with only what it gives while in the area whatever a save does (Spirit Guardians' Half Speed: `leavesArea`, no
 * outcome policy), else null. That is on every creature in the area: given again on each entering, though once a turn has
 * spent the save and damage, and as the area appears around it.
 */
const heldOnly = (action) => {
    if (!action)
        return null;
    const gated = (effect) => (effect.saveOutcomePolicy ?? effect.savePolicy ?? effect.checkOutcomePolicy
        ?? effect.application?.saveOutcomePolicy) != null;
    const effects = (action.effects ?? []).filter(effect => leavesArea(effect) && !gated(effect));
    return (effects.length && !action.attack) ? { schemaVersion: action.schemaVersion, id: action.id, label: action.label,
        costs: { allOf: [] }, ...(action.tags ? { tags: action.tags } : {}), effects } : null;
};
/** An area acting on one side (Spirit Guardians' enemies, a sanctuary's allies) leaves the other alone (areaSpares). */
function spares(flag, token) {
    const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
    return areaSpares(flag.persistence.affects, caster, token);
}
/**
 * Whether an area's trigger may act on a creature, on every event: not one its rules leave untouched by the area's spell
 * (`Unaffected`; its caster's own excepted), nor one the trigger's `targeting.eligible` leaves out, judged with the caster
 * as source (2024 Conjure Animals' "a creature you can see": `seenBySource`, Q30), nor one on another plane than its
 * caster (an Ethereal one, a Trapped prisoner's hidden Token; planeOf), which the authority would leave out of the run
 * anyway, leaving it an empty target prompt. `except`: ids of the creature's effects whose rules count for nothing here
 * (release: what the area it leaves gave it, which is going).
 */
function reaches(flag, trigger, token, except = []) {
    const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
    // shortcut: no exception for a creature its caster holds there (`targeting.sourceCondition`, the runtime's heldThere): an
    // area trigger never carries one to the authority (runAuthorityAction sets its own targeting); add both when one must.
    return (planeOf(token.actor) === planeOf(caster?.actor))
        && !((token.actor?.uuid !== flag.sourceActorRef) && token.actor?.unaffectingRule?.(trigger.action ?? {}, { except }))
        && !ineligibleTarget(trigger.action?.targeting?.eligible, token, caster);
}
const releases = (flag) => flag.persistence.triggers.some(trigger => (trigger.action?.effects ?? []).some(leavesArea));
/** Whether an area answers `event`: a trigger on it, or for leaving, effects that end on leaving (release). */
const answers = (flag, event) => flag.persistence.triggers.some(trigger => trigger.on.includes(event))
    || ((event === AREA_EVENTS.EXITED) && releases(flag));
/**
 * Its trigger's Action, each effect that ends on leaving naming its Region (`metadata.regionId`), so release finds it.
 * A condition is its own instance per source (Q19), so the webs' Restrained is stamped beside a Net's and leaving ends only
 * the webs'. A custom effect is still one effect (Q93 (d)): applied again it refreshes the one its creature holds, known
 * by its status, its custom id (it has no condition type, so any other custom effect would otherwise look like it), and
 * keeps that one's stamp: none when given from elsewhere, another area's when held from it (two Antimagic Fields
 * overlapping), which hands it over on leaving (release).
 */
const stamped = (action, region, actor) => {
    const regionOf = (effect) => {
        const held = (effect.type === "effect") ? [...(actor.effects ?? [])].find(held => [...(held.statuses ?? [])].includes(customEffectId(String(action.id), effect))) : undefined;
        return held ? held.flags?.wildpath?.conditionEffect?.metadata?.regionId : region.id;
    };
    return (action.effects ?? []).some(leavesArea) ? { ...action, effects: action.effects.map(effect => {
            const regionId = leavesArea(effect) ? regionOf(effect) : null;
            return regionId ? { ...effect, metadata: { ...effect.metadata, regionId } } : effect;
        }) } : action;
};
const reachFootprint = createReachFootprint;
const radialFootprint = createRadialFootprint;
const keyOf = fieldKey;
const distanceOf = fieldDistance;
const toOffset = gridFieldToFoundryOffset;
const laneFields = suggestLanes;
const toCenter = gridFieldToFoundryCenterPoint;
/**
 * A lasting area is a Foundry Region (V14's template successor) whose `flags.wildpath.area` holds the rules:
 * the covered fields, the caster, the vertical band and the triggers. Foundry draws the exact fields as a
 * `grid` shape and keeps an emanation's Region attached to its caster's Token; WildPath decides who is inside.
 */
export function persistentAreaRegionData({ placement, sourceToken, combat, color }) {
    const definition = placement.definition;
    const area = definition.area ?? {};
    const persistence = (area.persistence ?? {});
    const scene = sourceToken.parent;
    // Bands are authored relative to the floor of the caster's Level; a missing bound is open.
    const floor = Number(scene.levels?.get(String(sourceToken.level))?.elevation?.bottom) || 0;
    const bound = (value) => (value === null) || (value === undefined) ? null : floor + Number(value);
    const attached = area.shape === AREA_SHAPES.EMANATION;
    // Without its own band, a placed area keeps its cast's height (areaHeights): Sleet Storm's 40-foot Cylinder, a Wall of
    // Fire's 20 feet. shortcut: from the floor, not the cast's point height; upgrade by carrying that height in the placement.
    const height = Number(area.height?.value ?? NaN);
    const elevation = persistence.elevation
        ?? ((!attached && Number.isFinite(height)) ? { bottom: Math.min(0, height), top: Math.max(0, height) } : undefined);
    const band = { bottom: bound(elevation?.bottom), top: bound(elevation?.top) };
    const offsets = placement.footprint.fields.map(field => toOffset(field, { grid: scene.grid }).offset).filter(Boolean);
    const flag = {
        schemaVersion: 1,
        actionDefinitionId: definition.id ?? null, label: definition.label ?? "Area",
        sourceActorRef: sourceToken.actor?.uuid ?? "", sourceTokenId: sourceToken.id,
        topology: placement.footprint.topology, fields: placement.footprint.fields, shape: String(area.shape),
        size: Number(area.size?.value) || 0, attached, band,
        ...((Number(area.width?.value) > 0) ? { width: Number(area.width?.value) } : {}),
        persistence: { oncePerTurn: persistence.oncePerTurn !== false, concentration: persistence.concentration === true,
            duration: persistence.duration ?? null, triggers: persistence.triggers ?? [], light: persistence.light ?? null,
            ...((persistence.affects === "enemies") || (persistence.affects === "allies") ? { affects: persistence.affects } : {}),
            ...(OBSCURITIES.includes(persistence.obscures) ? { obscures: persistence.obscures } : {}),
            ...(persistence.budget ? { budget: { damage: Number(persistence.budget.damage) || 0,
                    ...((Number(persistence.budget.springs) > 0) ? { springs: Number(persistence.budget.springs) } : {}),
                    ...(persistence.budget.leaves ? { leaves: structuredClone(persistence.budget.leaves) } : {}) } } : {}),
            ...(persistence.endsWhen === "sourceDies" ? { endsWhen: "sourceDies" } : {}),
            ...(persistence.blocks?.length ? { blocks: [...persistence.blocks] } : {}),
            ...(persistence.sections ? { sections: structuredClone(persistence.sections) } : {}),
            ...(persistence.walls === "open" ? { walls: "open" } : {}),
            ...(persistence.includesAnchor === true ? { includesAnchor: true } : {}),
            ...(persistence.includesSpace === true ? { includesSpace: true } : {}),
            ...(persistence.bars ? { bars: structuredClone(persistence.bars) } : {}),
            ...(persistence.clock ? { clock: structuredClone(persistence.clock) } : {}) },
        ...(persistence.bars ? { tags: actionTags(definition) } : {}),
        createdAt: combatStart(combat),
        applied: {},
        // How deep it is (a pit's floor), for a `fall` with no feet that its trigger runs; an opening's rolled depth replaces it.
        ...((Number(persistence.depth) > 0) ? { depth: Number(persistence.depth) } : {}),
        ...(persistence.difficultTerrain ? { difficultTerrain: { types: [...(persistence.difficultTerrain.types ?? [])] } } : {})
    };
    return {
        name: flag.label,
        ...(color === undefined ? {} : { color }),
        shapes: [{ type: "grid", offsets }],
        // Difficult Terrain costs its movement twice over (foundry-v14-terrain.mts); Foundry's ruler shows that too.
        ...(flag.difficultTerrain ? { behaviors: [difficultTerrainBehavior()] } : {}),
        elevation: { bottom: band.bottom, top: band.top },
        ...(sourceToken.level ? { levels: [sourceToken.level] } : {}),
        attachment: { token: attached ? sourceToken.id : null },
        // Everyone sees a known hazard; V14's default would show it only on the Regions layer.
        visibility: globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
        highlightMode: "coverage",
        flags: { wildpath: { area: flag } }
    };
}
/**
 * The fields an area covers: an emanation is recomputed around its caster's footprint, now or at `position`
 * (where a step takes it).
 */
export function areaFields(flag, scene, { position = null } = {}) {
    if (!flag.attached)
        return flag.fields;
    const anchor = anchorOf(flag);
    const caster = anchor ? scene.tokens.get(anchor) : null;
    if (!caster)
        return [];
    const footprint = createFoundryV14TacticalGridAdapter({ scene }).tokenToFootprint(caster, position ? { position } : {});
    if (!footprint.ok || !footprint.footprint)
        return [];
    return reachFootprint({ source: footprint.footprint, reachDistance: flag.size, gridDistance: scene.grid.distance,
        includeOccupied: flag.persistence?.includesSpace === true }).fields;
}
/** Whether a Token stands in an area: any of its fields is covered and its height overlaps the area's band. */
export function areaCovers(flag, token, { fields = null, position = null } = {}) {
    // An emanation surrounds its caster (or object), outside it unless it `includesAnchor`: then inside wherever it steps.
    if ((token.id === anchorOf(flag)) && flag.attached)
        return flag.persistence?.includesAnchor === true;
    const scene = token.parent;
    const covered = fields ?? areaFields(flag, scene);
    if (!covered.length)
        return false;
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const footprint = adapter.tokenToFootprint(token, position ? { position } : {});
    if (!footprint.ok)
        return false;
    return footprintCovered(flag, covered, footprint.footprint?.fields, token, Number(position?.elevation ?? token.elevation ?? 0));
}
/** Whether a footprint's fields, `token` standing in them with its feet at `feet`, are in an area's `covered` fields and band. */
function footprintCovered(flag, covered, footprint, token, feet) {
    const keys = new Set(covered.map(field => keyOf(field, flag.topology)));
    if (!footprint?.some(field => keys.has(keyOf(field, flag.topology))))
        return false;
    const head = feet + ((Number(token.depth) || 0) * token.parent.grid.distance);
    return ((flag.band.bottom === null) || (head >= flag.band.bottom)) && ((flag.band.top === null) || (feet <= flag.band.top));
}
/**
 * The way ("in" or "out") a step from the fields `from` to `to` would cross an area's edge that its `bars` keep `token`
 * from crossing by a `kind` of move, else null. Never barred: the Token an attached area surrounds (it carries the edge),
 * a creature the area's `affects` spares, one on another plane than its caster (planeOf), one its rules leave untouched by
 * the area's Action (`Unaffected` against its flag's `tags`, its caster's own excepted, as reaches judges a trigger), one
 * `bars.who` leaves out (judged with the caster as source, as a trigger's `eligible` is: Q30), and a step that stays
 * inside or outside.
 * `feet`: its elevation before and after the step.
 */
export function barredCrossing(flag, token, { from, to, feet }, kind) {
    if (!(flag.persistence?.bars?.moves ?? ["voluntary"]).includes(kind) || !barsHold(flag, token))
        return null;
    const covered = areaFields(flag, token.parent);
    return barredWay(flag.persistence.bars, footprintCovered(flag, covered, from, token, feet[0]), footprintCovered(flag, covered, to, token, feet[1]));
}
/** Whether an area's `bars` judge `token` at all (barredCrossing lists who they never judge). */
function barsHold(flag, token) {
    const bars = flag.persistence?.bars;
    if (!bars || flag.pending || (flag.attached && (token.id === anchorOf(flag))))
        return false;
    const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
    return !(areaSpares(flag.persistence.affects, caster, token) || (planeOf(token.actor) !== planeOf(caster?.actor))
        || ((token.actor?.uuid !== flag.sourceActorRef) && token.actor?.unaffectingRule?.({ tags: flag.tags ?? [] }))
        || ineligibleTarget(bars.who, token, caster));
}
/** The way ("in" or "out") a creature inside `before` and `after` a move crosses the edge, when `bars` bar that way; else null. */
function barredWay(bars, before, after) {
    if (before === after)
        return null;
    const way = after ? "in" : "out";
    return ((bars.way ?? "in") === way) || (bars.way === "both") ? way : null;
}
/**
 * The Regions of `owner`'s attached areas with `bars.pressed: "ends"` that its step from `previous` to `position` carries
 * across a creature they bar, in a way they bar: newly inside under "in", newly outside under "out", either under "both"
 * (Antilife Shell: "If you move so that an affected creature is forced to pass through the barrier, the spell ends"). The
 * creature does not move, so the bars' `moves` do not apply: `pressed` is the opt-in, and any move of the anchor counts. A
 * creature removed from the scene (removedMarker), a dead one and a Token with no actor are not pressed.
 */
export function pressedAreas(owner, { previous, position }) {
    // shortcut: the anchor's forced moves and teleports press too (the design's "its anchor's move"); pass the step's
    // movement kind and skip them if the owner rules that only "you move" (its own movement) counts.
    const scene = owner?.parent;
    if (!scene)
        return [];
    return sceneAreas(scene).filter(({ flag }) => flag.attached && (anchorOf(flag) === owner.id) && (flag.persistence?.bars?.pressed === "ends"))
        .filter(({ flag }) => {
        const [before, after] = [areaFields(flag, scene, { position: previous }), areaFields(flag, scene, { position })];
        // A dead creature or an actor-less Token is an object (as apply judges): pressing it ends nothing.
        return [...scene.tokens].some(token => token.actor && !deadCreature(token.actor) && !removedMarker(token) && barsHold(flag, token)
            && barredWay(flag.persistence.bars, areaCovers(flag, token, { fields: before }), areaCovers(flag, token, { fields: after })));
    }).map(({ region }) => region);
}
/**
 * The transition policy (movement-paths.mjs) of `token`'s voluntary move: a step crossing a lasting area's edge its `bars`
 * keep it from crossing is refused (Hallow's "can't willingly enter"), for the GM's drags too, as Frightened is. Null
 * when no area on its Scene bars. `elevation` is where the move ends; shortcut: a path's anchors carry no elevation, so
 * each step but the last is judged at its starting one (as creatureOccupancyPolicy does); read each waypoint's when
 * MovementPath anchors carry it.
 */
export function areaBarPolicy(token, { elevation } = {}) {
    const barring = token?.parent ? sceneAreas(token.parent).filter(({ flag }) => flag.persistence?.bars) : [];
    if (!barring.length)
        return null;
    const start = Number(token.elevation) || 0;
    const end = ((elevation != null) && Number.isFinite(Number(elevation))) ? Number(elevation) : start;
    return ({ fromFootprint, toFootprint, movementKind, transitionIndex, path }) => {
        if ((movementKind && (movementKind !== "voluntary")) || !fromFootprint || !toFootprint)
            return { ok: true };
        const last = transitionIndex === ((path?.anchors?.length ?? 0) - 2);
        for (const { flag } of barring) {
            const way = barredCrossing(flag, token, { from: fromFootprint.fields, to: toFootprint.fields, feet: [start, last ? end : start] }, "voluntary");
            if (way)
                return { ok: false, code: "AREA_BARRED", reason: `${flag.label} bars it from ${way === "in" ? "entering" : "leaving"}.` };
        }
        return { ok: true };
    };
}
/**
 * The first lasting area whose `bars` keep `token` from a `kind` of move ("forced": a push's step or a throw's landing;
 * "teleport") from where it stands (or `from`, a top left) to `position` (a top left, at its `elevation`, else the Token's),
 * as its label and the way it would cross; null when none. Only the moves WildPath judges as an Action's own call it
 * (forcedStepBlocker, pushLanding, a teleport's or swap's landing), never spaceBeside, so a creature stepping out of a new
 * wall or reappearing from Banishment is not barred. An area attached to one of the `along` Tokens (a carrier the creature
 * moves with) is skipped: its edge moves with them, so the creature never crosses it.
 */
export function areaBarsLanding(token, position, kind, { from, along = [] } = {}) {
    const scene = token?.parent;
    const barring = scene ? sceneAreas(scene).filter(({ flag }) => flag.persistence?.bars
        && !(flag.attached && along.some(other => other.id === anchorOf(flag)))) : [];
    if (!barring.length)
        return null;
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const fieldsAt = (at) => adapter.tokenToFootprint(token, { position: at }).footprint?.fields;
    const feet = (at) => Number(at.elevation ?? token.elevation) || 0;
    const start = from ?? { x: Number(token.x), y: Number(token.y) };
    const step = { from: fieldsAt(start), to: fieldsAt(position), feet: [feet(start), feet(position)] };
    for (const { flag } of barring) {
        const way = barredCrossing(flag, token, step, kind);
        if (way)
            return { label: flag.label, way };
    }
    return null;
}
/** Every lasting area on a Scene, with its Region. */
/** The center of an area's fields, in pixels; null when none resolve. */
function areaCenter(flag, scene) {
    const points = flag.fields.map(field => toCenter(field, { scene, grid: scene.grid }).point).filter(Boolean);
    if (!points.length)
        return null;
    return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}
/** The Token standing on a point (its rectangle holds it), or null. */
function tokenAt(scene, point) {
    const size = Number(scene.grid.size) || 100;
    if (!point)
        return null;
    return [...scene.tokens].find(token => {
        const [x, y] = [Number(token.x) || 0, Number(token.y) || 0];
        return (point.x >= x) && (point.x < x + ((Number(token.width) || 1) * size)) && (point.y >= y) && (point.y < y + ((Number(token.height) || 1) * size));
    }) ?? null;
}
export const OBSCURITIES = Object.freeze(["heavily", "lightly"]);
/** The most a lasting area a Token stands in obscures it (Fog Cloud "heavily", Web "lightly"), or null. */
export function areaObscurityAt(token) {
    if (!token?.parent)
        return null;
    const levels = new Set(sceneAreas(token.parent).filter(({ flag }) => flag.persistence?.obscures && areaCovers(flag, token))
        .map(({ flag }) => flag.persistence.obscures));
    return OBSCURITIES.find(level => levels.has(level)) ?? null;
}
/** Whether a Token stands in a Heavily Obscured lasting area (Fog Cloud, Cloudkill): no sight sees it, or out. */
export function heavilyObscuredAt(token) {
    return areaObscurityAt(token) === "heavily";
}
/**
 * Whether a Token carries `flags.wildpath.removed`: the removed adapter hid it while a `removes` status held its
 * creature, and keeps the marker until its release has placed it. It enters and moves in no area meanwhile (nor does
 * a dragged hidden prisoner), so reappearing calls for no save; leaving is still processed, so an effect held only
 * while in an area (`leavesArea`) is released.
 */
function removedMarker(token) {
    return Boolean(token.flags?.wildpath?.removed);
}
export function sceneAreas(scene) {
    return [...(scene.regions ?? [])].flatMap(region => region.flags?.wildpath?.area ? [{ region, flag: region.flags.wildpath.area }] : []);
}
/** The lasting area a creature (`actorRef`) left with the Action `of` (its definition id), on `scene`; null when none. */
export function ownArea(scene, { of, actorRef }) {
    return sceneAreas(scene).find(({ flag }) => (flag.actionDefinitionId === of) && (flag.sourceActorRef === actorRef)) ?? null;
}
/**
 * The area a lasting area was made with (its shape, size and width), to lay it out again where it moves (`moveArea`): the
 * client's preview and the authority's placement both read it, so they place the same fields.
 */
export function areaOfFlag(flag) {
    return { shape: flag.shape, size: { value: flag.size, unit: "ft" }, ...(flag.width ? { width: { value: flag.width, unit: "ft" } } : {}) };
}
/**
 * The lasting areas of spells (their cast level known) that reach within `feet` of a Token's space: what Dispel Magic
 * can choose as its "magical effect". Measured as targets are, between the nearest spaces.
 */
export function spellAreasWithin(token, feet) {
    const scene = token.parent;
    const footprint = createFoundryV14TacticalGridAdapter({ scene }).tokenToFootprint(token);
    if (!footprint.ok || !footprint.footprint)
        return [];
    const grid = Number(scene.grid.distance) || 5;
    return sceneAreas(scene).filter(({ flag }) => Number.isFinite(flag.castLevel ?? NaN) && (areaFields(flag, scene).length > 0)
        && ((footprintDistance(footprint.footprint, { topology: flag.topology, fields: areaFields(flag, scene) }) * grid) <= feet));
}
/** Where a placed area's fields are centered, in canvas coordinates; null with no fields. */
export function areaFieldsCenter(fields, scene) {
    return areaCenter({ fields }, scene);
}
/**
 * Whether an area's duration has run out at the start of this combat turn: N rounds after the turn it was
 * created on. Outside combat, or in another combat, rounds do not pass.
 */
export function areaExpired(flag, combat) {
    return roundsPassed(flag.createdAt, Number(flag.persistence.duration?.value), combat);
}
/**
 * The lasting area whose trigger runs an Action (`parentArea`), as the authority reads it when the Action starts, so the
 * Action's follow-ups find it though it has ended since: its fields (an emanation's where it stands now), the level it was
 * cast at and, for an opening, its depth. Null when it is gone.
 */
export function parentAreaOf(scene, regionId) {
    const flag = [...(scene?.regions ?? [])].find(region => region.id === regionId)?.flags?.wildpath?.area;
    if (!scene || !flag)
        return null;
    return { sceneId: scene.id, regionId, topology: flag.topology, fields: areaFields(flag, scene), castLevel: flag.castLevel ?? null,
        ...((Number(flag.depth) > 0) ? { depth: Number(flag.depth) } : {}) };
}
/** A once-per-turn key: the current combat turn, or null outside combat (no limit). */
export function turnKey(combat) {
    return combat ? `${combat.id}:${combat.round}:${combat.turn ?? 0}` : null;
}
/**
 * Applies a lasting area's triggers to a creature. Each trigger's Action resolves through the authority with
 * the caster as source and the creature as its only target (saves route to the creature's controller, as for
 * any Action). Once per turn by default: the area remembers whom it affected in the current combat turn.
 */
export function createFoundryPersistentAreas({ game, coordinator, resolveAction, logger = globalThis.console, fromUuid = null, dismissSummon = null }) {
    let sequence = 0;
    // Each budget area's spend or springs count in flight (queued), so two never read its dealt damage or springs at once.
    const spending = new Map();
    // Each Scene's wall opening in flight (syncOpenedWalls): Regions ended in one batch fire their delete hooks unawaited,
    // and two runs at once would delete the same pieces twice.
    const opening = new Map();
    // The creatures a drifting area is carrying right now, by Token id to its Region id (driftArea): their carried step neither
    // enters, leaves nor moves in that area (crossed, moved), as they stay where they are in it.
    const carrying = new Map();
    async function create({ options, state }, { anchor = null, pending = null } = {}) {
        // The area as cast: its configured definition, so an upcast's dice stay in its triggers for its whole life.
        const placement = options.persistentArea && state?.configuration?.effectiveDefinition
            ? { ...options.persistentArea, definition: state.configuration.effectiveDefinition } : options.persistentArea;
        if (!placement)
            return null;
        const token = game.scenes?.get(placement.sceneId)?.tokens.get(placement.sourceTokenId) ?? null;
        if (!token)
            return null;
        // Its caster's combat, not the one the GM's tracker shows: its rounds pass there (onTurn).
        // shortcut: a caster that is no Combatant counts rounds in the tracker's combat; upgrade with the turn-clock question.
        const data = persistentAreaRegionData({ placement, sourceToken: token, combat: combatOf(token, game) ?? game.combat ?? null,
            color: pending ? DERIVED_AREA_COLORS.pending : game.user.color });
        const flag = data.flags.wildpath.area;
        const persistence = (placement.definition.area?.persistence ?? {});
        // A spell's, so Dispel Magic can end it: the level it was cast at, else its own. `dispellable: false` keeps no level,
        // so Dispel Magic never lists it and no light dispels it (Antimagic Field, a fissure).
        const spellLevel = Number(placement.definition.metadata?.spellLevel);
        flag.castLevel = (persistence.dispellable === false) ? null : state?.configuration?.castingLevel ?? flag.persistence.light?.spellLevel
            ?? (Number.isFinite(spellLevel) ? spellLevel : null);
        // Cast on an object (Daylight, Darkness): the area surrounds the Token at its center and goes where it goes.
        const chosen = persistence.onObject && (state?.configuration?.choices ?? []).some(choice => (choice.id === persistence.onObject)
            && (choice.value === true));
        const object = anchor ?? (chosen ? tokenAt(token.parent, areaCenter(flag, token.parent)) : null);
        if (object)
            Object.assign(flag, { attached: true, anchorTokenId: object.id }), data.attachment = { token: object.id };
        // An opening laid out for the GM to confirm or drag (rollOpenings): seen by the GM only and nothing more until Open.
        if (pending) {
            Object.assign(flag, { pending: true, depth: pending.depth });
            data.visibility = globalThis.CONST?.REGION_VISIBILITY?.GAMEMASTER ?? 1;
        }
        return createRegion(token, data, placement.definition);
    }
    /**
     * A lasting area's Region made from its data (create; leaveBehind for what an opened section leaves), coming into effect
     * at once (appear) unless it is a pending opening, which comes into effect at its Open (openOpenings).
     */
    async function createRegion(token, data, definition, created = []) {
        const flag = data.flags.wildpath.area;
        if (!flag.pending)
            await dispelOpposed(token.parent, flag);
        const [region] = await token.parent.createEmbeddedDocuments("Region", [data]);
        if (!region)
            return null;
        return flag.pending ? region : appear(region, token, flag, definition, created);
    }
    /**
     * What a lasting area brings as it comes into effect: its concentration, light, walls, held effects on the creatures it
     * appears around, its `area.created` triggers (answerOnce), and its once-only caster-turn triggers outside combat.
     * shortcut: a pending opening's Difficult Terrain and obscuring already hold before its Open; upgrade if an opening that
     * slows or hides must wait for it. `created`: gathers its `area.created` triggers' states (springOut's mover).
     */
    async function appear(region, token, flag, definition, created = []) {
        if (flag.persistence.concentration)
            await markConcentration(region, token, flag.label);
        const light = flag.persistence.light;
        if (light)
            await shedLight(region, token.parent, flag, light);
        if (flag.persistence.blocks)
            await raiseWalls(region, token, flag, definition);
        if (flag.persistence.walls === "open")
            await syncOpenedWalls(region);
        // What it holds while in it whatever the save is on each creature it appears around (heldOnly: Spirit Guardians' Half Speed).
        if (flag.persistence.triggers.some(trigger => trigger.on.includes(AREA_EVENTS.ENTERED) && heldOnly(trigger.action))) {
            for (const covered of [...token.parent.tokens].filter(entry => areaCovers(flag, entry))) {
                await apply(region, region.flags?.wildpath?.area ?? flag, covered, AREA_EVENTS.ENTERED, { key: null, appearing: true });
            }
        }
        created.push(...(await answerOnce(region, AREA_EVENTS.CREATED)).filter(Boolean));
        // A caster with no combat turn to wait for (outside combat, or no Combatant): what its area does once on that turn
        // (`once: "area"`) it does now; a repeating caster-turn trigger waits for combat, as other turn triggers do.
        if (!combatOf(token, game) && flag.persistence.triggers.some(trigger => (trigger.turnOf === "source") && (trigger.once === "area"))) {
            for (const event of TURN_EVENTS)
                await runSourceTriggers(event, token, null, { region, creating: true });
        }
        return region;
    }
    /**
     * An area coming into effect answers `area.created` (a fissure's save as it opens), and an area that has ended answers
     * `area.ended` (a bead's explosion; onRegionDeleted): each such trigger once, as one Action on the creatures it covers
     * then (runGroup), with no cover against it (Q37) and itself as the Action's `parentArea` (an ended one's Region is gone,
     * so the authority reads none: parentAreaOf). A creature removed from the scene is not in it. An ended area spends no
     * budget, as it has nothing left to end.
     */
    async function answerOnce(region, event) {
        const flag = region.flags?.wildpath?.area;
        const scene = region.parent;
        if (!flag || !scene || !answers(flag, event))
            return [];
        const covered = [...scene.tokens].filter(token => !removedMarker(token) && areaCovers(flag, token));
        const { runs, spent } = await dueRuns(region, flag, covered, event);
        const states = [];
        for (const [index, trigger] of flag.persistence.triggers.entries()) {
            const group = runs.filter(run => run.index === index);
            if (group.length)
                states.push(...await runGroup(region, flag, trigger, index, group, event.replace("area.", "")));
        }
        // Its last spring ends it (springOut), so it spends no budget: an end by its damage first would leave nothing.
        if (spent)
            states.push(...await springOut(region));
        else if (runs.length && (event !== AREA_EVENTS.ENDED))
            await charge(region, flag, states.filter(Boolean));
        return states;
    }
    /**
     * A GM card's roll entry for an Action's `opens` (gm-prompts): the count, then each opening's depth, rolled by the dice
     * policy on the active GM (the GM rolls them, Q140 (3) default); the openings laid across the area that ran the Action
     * (`parentArea`, as it stood then) in lanes (suggestLanes), each field scored by the original walls crossing it (walls
     * stand in for the structures the openings keep off, as far as the map shows them); and each made a pending area of the
     * Action's caster (create): seen by the GM only, answering nothing and opening no walls, which the GM may drag or redraw
     * until Open (Q92 (b)). Null, with nothing written, when a die is closed unrolled or the caster's Token is gone (a
     * failed creation deletes what it made). None laid (no band fits, or a count of 0): the GM is told.
     * shortcut: every original wall on the Scene is scored, whatever its Level; upgrade if a multi-Level Scene's walls skew it.
     */
    async function rollOpenings(entry, card) {
        const scene = game.scenes?.get(card.sceneId);
        const caster = scene?.tokens.get(card.sourceTokenId);
        if (!scene || !caster?.actor) {
            gmNotice("WILDPATH.NOTICE.OpensNoCaster", { name: entry.name }, undefined, { game, logger });
            return null;
        }
        const { opens, parentArea } = entry;
        const title = (key) => game.i18n?.format(key, { label: entry.name }) ?? entry.name;
        const context = { actor: caster.actor, actorSystem: caster.actor.system };
        const count = await rollAmount(opens.count, context, title("WILDPATH.OPENS.Count"), { game });
        if (!count)
            return null;
        const originals = [...(scene.walls ?? [])].filter(wall => Array.isArray(wall.c) && !wall.flags?.wildpath?.areaRegion
            && !wall.flags?.wildpath?.pieceOf);
        // Each cell grown a pixel, so a wall drawn on its grid line (as walls snap) counts for the cells on both sides of it.
        const cost = (field) => {
            const cell = cellPolygons(scene, [field]).map(polygon => {
                const [cx, cy] = ["x", "y"].map(axis => polygon.reduce((sum, point) => sum + point[axis], 0) / polygon.length);
                return polygon.map(({ x, y }) => {
                    const away = Math.hypot(x - cx, y - cy) || 1;
                    return { x: x + ((x - cx) / away), y: y + ((y - cy) / away) };
                });
            });
            return originals.filter(wall => segmentOutside(wall.c, cell)[0] !== wall.c).length;
        };
        const lanes = laneFields({ fields: parentArea.fields, topology: parentArea.topology, gridDistance: scene.grid.distance,
            width: Number(opens.width?.value), count: count.total, cost });
        const depths = [];
        for (const _lane of lanes) {
            const depth = await rollAmount(opens.depth, context, title("WILDPATH.OPENS.Depth"), { game });
            if (!depth)
                return null;
            depths.push(depth.total);
        }
        const definition = { id: `${entry.actionId}:opens`, label: entry.name, ...(entry.tags?.length ? { tags: [...entry.tags] } : {}),
            area: { shape: AREA_SHAPES.LINE, persistence: opens.persistence } };
        const made = [];
        try {
            for (const [index, fields] of lanes.entries()) {
                const region = await create({ options: { persistentArea: { footprint: { topology: parentArea.topology, fields }, definition,
                            sourceTokenId: caster.id, sceneId: scene.id } }, state: { configuration: { castingLevel: parentArea.castLevel ?? null } } }, { pending: { depth: depths[index] } });
                if (region)
                    made.push(region);
            }
        }
        catch (error) {
            // Released, the roll lays a whole set again: the part already made, which no Open entry names, goes.
            for (const region of made)
                await region.delete();
            throw error;
        }
        if (!made.length)
            gmNotice("WILDPATH.NOTICE.OpensNone", { name: entry.name }, undefined, { game, logger });
        return { regionIds: made.map(region => region.id), definition, count: count.total, depths };
    }
    /**
     * A GM card's Open entry: each pending area its roll laid out that still stands (the GM may have deleted one) comes into
     * effect as any lasting area does (appear): seen by everyone, the walls under it opened, its `area.created` triggers
     * answered (a fissure's save, one Action over the creatures in it then). Null when the caster's Token is gone.
     */
    async function openOpenings(entry, card) {
        const scene = game.scenes?.get(card.sceneId);
        const caster = scene?.tokens.get(card.sourceTokenId);
        if (!scene || !caster) {
            gmNotice("WILDPATH.NOTICE.OpensNoCaster", { name: String(entry.definition?.label ?? "") }, undefined, { game, logger });
            return null;
        }
        const regions = [...(scene.regions ?? [])].filter(region => (entry.regionIds ?? []).includes(region.id)
            && region.flags?.wildpath?.area?.pending);
        for (const region of regions) {
            await dispelOpposed(scene, region.flags.wildpath.area);
            await region.update({ visibility: globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
                color: DERIVED_AREA_COLORS.derived, "flags.wildpath.area.pending": false });
            await appear(region, caster, region.flags.wildpath.area, entry.definition ?? {});
        }
        return { regionIds: regions.map(region => region.id) };
    }
    /**
     * After an Action that summons (`summon.area`: Flaming Sphere, Guardian of Faith, Conjure Animals): each summoned Token
     * carries a lasting area of its caster's, attached to it, so it goes where the Token goes and ends with it (V14 deletes
     * a Token's attached Regions). Its triggers resolve with the caster as source: its spell save DC, its slot's dice. It
     * has its spell's cast level (none with `persistence.dispellable: false`, or its summon's `dispellable: false`, as
     * ending it ends the summon), so Dispel Magic (or 2024 Darkness over its light) ends it, and with it the spell (end,
     * Q31); Dispel Magic on the summoned Token still dismisses it and its area.
     */
    async function carry({ state }, tokens = []) {
        const configured = state?.configuration?.effectiveDefinition;
        const definition = (configured ?? state?.actionDefinition ?? null);
        const summon = definition?.summon;
        const area = (summon?.dispellable === false) && summon.area
            ? { ...summon.area, persistence: { ...(summon.area.persistence ?? {}), dispellable: false } } : summon?.area;
        const casterId = String(state?.source?.tokenId ?? "");
        if (!area || !casterId || !isActiveGM())
            return [];
        const regions = [];
        for (const token of tokens) {
            const scene = token.parent;
            if (!scene?.tokens.get(casterId))
                continue;
            const footprint = createFoundryV14TacticalGridAdapter({ scene }).tokenToFootprint(token);
            if (!footprint.ok || !footprint.footprint)
                continue;
            // Drawn as it is worked out: the fields within its size around the Token (areaFields), its own only with `includesSpace`.
            const fields = areaFields({ attached: true, anchorTokenId: token.id, size: Number(area.size?.value) || 0,
                persistence: area.persistence ?? {} }, scene);
            // Only the slot: the whole configuration would swap in its effective definition, which has no top-level area.
            const castingLevel = state?.configuration?.castingLevel ?? null;
            const region = await create({ options: { persistentArea: { footprint: { topology: footprint.footprint.topology, fields },
                        definition: { ...definition, area }, sourceTokenId: casterId, sceneId: scene.id } }, state: { configuration: { castingLevel } } }, { anchor: token });
            if (region)
                regions.push(region);
        }
        return regions;
    }
    /**
     * A lasting area that sheds light (Daylight) or darkness (Darkness) gets it at its center, tagged as sunlight when its
     * light is; it goes when the area goes. An attached area's light is its Token's own, so it moves with the Token; the
     * Token's own light comes back after.
     */
    async function shedLight(region, scene, flag, light) {
        const config = { bright: Number(light.bright) || 0, dim: Math.max(Number(light.dim) || 0, Number(light.bright) || 0),
            negative: light.darkness === true };
        const anchor = flag.attached ? scene.tokens.get(anchorOf(flag) ?? "") : null;
        if (anchor?.update) {
            const previous = { light: anchor.toObject?.().light ?? null, sunlight: anchor.flags?.wildpath?.sunlight === true };
            await anchor.update({ light: config, "flags.wildpath.sunlight": light.sunlight === true });
            await region.update({ "flags.wildpath.area.lightToken": { id: anchor.id, previous } });
            return;
        }
        const center = areaCenter(flag, scene);
        if (!center)
            return;
        const [created] = await scene.createEmbeddedDocuments("AmbientLight", [{ ...center, elevation: flag.band.bottom ?? 0, config,
                flags: { wildpath: { sunlight: light.sunlight === true, areaRegion: region.id } } }]);
        if (created)
            await region.update({ "flags.wildpath.area.lightId": created.id });
    }
    /**
     * An area that walls off its fields (`persistence.blocks`: Wall of Ice's `["move", "sight"]`): each creature in them first
     * steps out to the nearest free space beside them, as forced movement (before any wall could stop it), then its outline
     * becomes two-way Wall documents on its caster's Level, flagged with its Region (`areaRegion`), which onRegionDeleted
     * removes. Foundry's movement, vision and WildPath's cover, pushes and sight read them as any wall.
     */
    async function raiseWalls(region, caster, flag, definition) {
        const scene = caster.parent;
        // A V14 Wall has no elevation bounds (only `levels`): it stands the whole height of the caster's Level, so every
        // creature on that Level over the fields steps out, whatever the area's band.
        const open = { ...flag, band: { bottom: null, top: null } };
        // A creature on another plane than the caster (an Ethereal one, a Trapped one's hidden Token; planeOf) is not caught, nor
        // one its rules leave untouched by the area's Action (an object: another wall's section stays by its own walls).
        const caught = [...scene.tokens].filter(token => ((token.level ?? null) === (caster.level ?? null))
            && (planeOf(token.actor) === planeOf(caster.actor)) && areaCovers(open, token)
            && !((token.actor?.uuid !== flag.sourceActorRef) && token.actor?.unaffectingRule?.(definition)));
        for (const covered of caught)
            await stepOut(covered, flag.fields, "forced");
        if (flag.persistence.sections)
            return raiseSections(region, caster, flag, flag.persistence.sections);
        const walls = areaWallData(outlineEdges(cellPolygons(scene, flag.fields)), { blocks: flag.persistence.blocks ?? [],
            level: caster.level ?? null, flags: { wildpath: { areaRegion: region.id } } });
        if (walls.length)
            await scene.createEmbeddedDocuments("Wall", walls);
    }
    /**
     * A blocking area in object sections (`persistence.sections`: Wall of Ice's 10-foot sections of AC 12 and 30 HP): its
     * fields split in order from the wall's start (`wallSections`), one world Actor for them (`objectActorData`, its id in
     * the flag's `sectionActorId`), and per section an unlinked Token over its fields, neutral, flagged with its section
     * (`section: {regionId, index}`) and `leavesAtDeath` (so it leaves when brought to 0), and its own walls
     * (`sectionWallData`, flagged `{areaRegion, section: index}`), so each section can open alone. onRegionDeleted removes
     * them all. Walls stand even if the Actor could not be made.
     */
    async function raiseSections(region, caster, flag, sections) {
        const scene = caster.parent;
        const groups = sectionFields(flag, sections, scene);
        const { CONFIG } = globalThis;
        const actor = await CONFIG?.Actor?.documentClass?.create(objectActorData(sections, flag.label));
        if (actor) {
            await region.update({ "flags.wildpath.area.sectionActorId": actor.id });
            const tokens = await Promise.all(groups.map(async (fields, index) => (await actor.getTokenDocument({
                ...sectionTokenPlacement(scene, fields),
                name: game.i18n?.format("WILDPATH.AREA.Section", { area: flag.label, number: String(index + 1) }) ?? `${flag.label} ${index + 1}`,
                ...(caster.level ? { level: caster.level } : {}),
                flags: { wildpath: { section: { regionId: region.id, index }, leavesAtDeath: true } }
            }, { parent: scene })).toObject()));
            await scene.createEmbeddedDocuments("Token", tokens);
        }
        else
            logger.warn("Wild Path | An area's sections could not be made", flag.label);
        const walls = groups.flatMap((fields, index) => sectionWallData(cellPolygons(scene, fields), { blocks: flag.persistence.blocks ?? [],
            level: caster.level ?? null, flags: { wildpath: { areaRegion: region.id, section: index } } }));
        if (walls.length)
            await scene.createEmbeddedDocuments("Wall", walls);
    }
    /**
     * An area that opens the walls under it (`persistence.walls: "open"`: Earthquake's fissures, a Passwall): each original
     * wall on its Level that its cells cut is hidden (every sense NONE, its own kept in `flags.wildpath.senses`) and stands
     * again as pieces (`pieceOf`) outside the cells of every area opening it (`openedBy`); once none does, its senses come
     * back. Walls an area raised (`areaRegion`) and pieces are never originals, so a fissure never opens a Wall of Ice. The
     * pieces are derived, so areas made, moved and ended in any order give the same walls. Run on create, after a move
     * (relocate) and on its Region's deletion (`ended`: it opens nothing more).
     * shortcut: a door is opened whole, with no pieces, and an original the GM deletes while opened leaves its pieces;
     * upgrade if a door half across an area or a deleted original matters.
     */
    async function syncOpenedWalls(region, options = {}) {
        const key = region.parent?.id ?? "";
        const queued = (opening.get(key) ?? Promise.resolve()).then(() => openWalls(region, options));
        opening.set(key, queued.catch(() => undefined));
        await queued;
    }
    async function openWalls(region, { ended = false }) {
        const scene = region.parent;
        if (!scene?.walls)
            return;
        const regions = [...(scene.regions ?? [])];
        const opens = (id) => ((id === region.id) ? !ended
            : regions.some(other => (other.id === id) && (other.flags?.wildpath?.area?.persistence.walls === "open")));
        const sceneLevels = [...(scene.levels?.keys?.() ?? [])];
        // The Levels a Region or wall stands on: those it names, or every Level of the Scene when it names none (an empty list
        // still meaning every Level, as wallsBlock reads it, on a Scene listing none).
        const span = (named) => {
            const own = [...(named ?? [])];
            return own.length ? own : sceneLevels;
        };
        const meets = (a, b) => !a.length || !b.length || a.some(level => b.includes(level));
        const areaOf = (id) => ((id === region.id) ? region : regions.find(other => other.id === id));
        const cellsOf = (id) => cellPolygons(scene, areaOf(id)?.flags?.wildpath?.area?.fields ?? []);
        // A pending opening opens nothing yet (rollOpenings); its Open does.
        const own = (ended || region.flags?.wildpath?.area?.pending) ? [] : cellsOf(region.id);
        const crosses = (wall) => meets(span(wall.levels), span(region.levels))
            && (segmentOutside(wall.c, own)[0] !== wall.c);
        const walls = [...scene.walls];
        const changed = walls.filter(wall => {
            const marks = wall.flags?.wildpath;
            if (marks?.areaRegion || marks?.pieceOf || !Array.isArray(wall.c))
                return false;
            return marks?.openedBy?.includes(region.id) || crosses(wall);
        });
        const updates = [];
        const pieces = [];
        for (const wall of changed) {
            const crossed = crosses(wall);
            const openedBy = [...(wall.flags?.wildpath?.openedBy ?? []).filter(id => (id !== region.id) && opens(id)),
                ...(crossed ? [region.id] : [])];
            const senses = wall.flags?.wildpath?.senses ?? { move: wall.move, sight: wall.sight, light: wall.light, sound: wall.sound };
            if (!openedBy.length) {
                updates.push({ _id: wall.id, ...senses, "flags.wildpath.openedBy": null, "flags.wildpath.senses": null });
                continue;
            }
            updates.push({ _id: wall.id, ...wallSenses([]), "flags.wildpath.openedBy": openedBy, "flags.wildpath.senses": senses });
            if (Number(wall.door))
                continue;
            // A piece is the original as drawn (its Level, direction, threshold), with its own senses. A wall standing on several
            // Levels is cut on each only by the areas opening it there, and stands whole on a Level none opens it.
            const { _id, id, flags, ...source } = (wall.toObject?.() ?? { ...wall });
            const byOpeners = new Map();
            const standing = span(wall.levels);
            for (const level of standing.length ? standing : [""]) {
                const ids = openedBy.filter(opener => meets(span(areaOf(opener)?.levels), level ? [level] : []));
                if (!byOpeners.has(ids.join()))
                    byOpeners.set(ids.join(), { on: [], ids });
                byOpeners.get(ids.join()).on.push(level);
            }
            for (const { on, ids } of byOpeners.values()) {
                for (const c of ids.length ? segmentOutside(wall.c, ids.flatMap(cellsOf)) : [wall.c]) {
                    pieces.push({ ...source, ...senses, c, ...((byOpeners.size > 1) ? { levels: on } : {}), flags: { wildpath: { pieceOf: wall.id } } });
                }
            }
        }
        const ids = new Set(changed.map(wall => wall.id));
        const stale = walls.filter(wall => ids.has(wall.flags?.wildpath?.pieceOf ?? "")).map(wall => wall.id);
        if (stale.length)
            await scene.deleteEmbeddedDocuments?.("Wall", stale);
        if (updates.length)
            await scene.updateEmbeddedDocuments?.("Wall", updates);
        if (pieces.length)
            await scene.createEmbeddedDocuments("Wall", pieces);
    }
    /**
     * 2024 Daylight and Darkness: an area whose light `dispels` ends each overlapping area of the opposite kind (darkness
     * for light, light for darkness) whose spell was cast at that level or lower. An attached area's light is its Token's,
     * reaching as far as its dim light (Flaming Sphere's 40 feet), so it overlaps there, not only within its own size.
     * shortcut: a placed area's light past its own fields (Daylight's dim) is not counted; upgrade with a light-reach part.
     */
    async function dispelOpposed(scene, flag) {
        const light = flag.persistence.light;
        if (!light?.dispels)
            return;
        const covered = new Set(areaFields(flag, scene).map(field => keyOf(field, flag.topology)));
        for (const other of sceneAreas(scene)) {
            const theirs = other.flag.persistence.light;
            if (!theirs || ((theirs.darkness === true) === (light.darkness === true)))
                continue;
            if (!((other.flag.castLevel ?? Infinity) <= light.dispels))
                continue;
            const lit = other.flag.attached ? { ...other.flag, size: Math.max(Number(other.flag.size) || 0, Number(theirs.dim) || 0, Number(theirs.bright) || 0) } : other.flag;
            if (areaFields(lit, scene).some(field => covered.has(keyOf(field, other.flag.topology))))
                await end(other.region);
        }
    }
    /**
     * An area's spell ends (dispelled, or its budget spent): a summon carrying it is dismissed with its cast, its Region going
     * with its Token (Flaming Sphere, Guardian of Faith, the 2024 pack); any other area's Region is deleted, one only cast on
     * a summon (Darkness on a Spiritual Weapon) too: carried means summoned by this area's own Action.
     */
    async function end(region) {
        const flag = region.flags?.wildpath?.area;
        const scene = region.parent;
        // What an opened section left (leaveBehind) is the wall's spell: ending it (Dispel Magic on the sheet) ends the wall,
        // whose Region's end takes it along.
        const parent = flag?.parentRegionId ? [...(scene?.regions ?? [])].find(entry => entry.id === flag.parentRegionId) : null;
        if (parent)
            return end(parent);
        const carrier = (flag?.anchorTokenId && scene) ? scene.tokens.get(flag.anchorTokenId) : undefined;
        // Its Token is gone (a cast dismissed with an earlier area's): V14 is already deleting its attached Region, unawaited.
        if (flag?.anchorTokenId && scene && !carrier)
            return;
        const summon = carrier?.flags?.wildpath?.summon;
        if (scene && summon && (summon.actionId === flag?.actionDefinitionId) && dismissSummon)
            await dismissSummon(scene, [carrier.id]);
        else
            await region.delete();
    }
    /**
     * A creature died: each lasting area of its own on any Scene that ends with it (`persistence.endsWhen: "sourceDies"`)
     * ends through `end`. Called by the death settle step (plan S2), before its effects go, so nobody is saved against again.
     */
    async function endWithSource(actor) {
        if (!actor?.uuid || !isActiveGM())
            return;
        for (const scene of game.scenes ?? []) {
            for (const { region, flag } of sceneAreas(scene)) {
                if ((flag.sourceActorRef === actor.uuid) && (flag.persistence.endsWhen === "sourceDies"))
                    await end(region);
            }
        }
    }
    /**
     * A concentration area is sustained like any concentration effect: a marker on the caster names the caster
     * as its concentration source, so a failed concentration check ends it, and with it the Region.
     */
    async function markConcentration(region, caster, label) {
        const name = game.i18n?.format("WILDPATH.AREA.Concentrating", { area: label }) ?? label;
        const [effect] = await caster.actor?.createEmbeddedDocuments?.("ActiveEffect", [{ name, type: "effect", system: {},
                flags: { wildpath: { areaRegion: { sceneId: caster.parent.id, regionId: region.id },
                        conditionEffect: { concentration: { sourceRef: `token:${caster.id}` } } } } }]) ?? [];
        if (effect)
            await region.update({ "flags.wildpath.area.concentrationEffect": effect.uuid });
    }
    /**
     * After any Action: a concentration check it broke ends every concentration area that caster sustains
     * (the Region's deletion then removes the caster's marker).
     */
    /** The creatures (`token:<id>`) whose concentration a resolved Action's checks broke. */
    function brokenConcentration(state) {
        const checks = state?.results?.concentrationResolution?.checks;
        return new Set((checks?.breakEvents ?? []).map(event => event.sourceRef ?? event.ref).filter(Boolean));
    }
    async function afterResolution({ state }) {
        const broken = brokenConcentration(state);
        if (!broken.size)
            return;
        for (const scene of game.scenes ?? []) {
            for (const { region, flag } of sceneAreas(scene)) {
                if (flag.persistence.concentration && broken.has(`token:${flag.sourceTokenId}`))
                    await region.delete();
            }
        }
    }
    /** The active GM keeps a concentration area and its marker together: either one ending ends the other. */
    async function onEffectDeleted(effect) {
        const link = effect.flags?.wildpath?.areaRegion;
        if (!link || !isActiveGM())
            return;
        const region = [...(game.scenes?.get(link.sceneId)?.regions ?? [])].find(entry => entry.id === link.regionId);
        await region?.delete();
    }
    async function onRegionDeleted(region) {
        if (!isActiveGM())
            return;
        // The walls it raised go with it (raiseWalls); a wall drawn by hand or another area's stays.
        const walls = region.flags?.wildpath?.area ? [...(region.parent?.walls ?? [])]
            .filter(wall => wall.flags?.wildpath?.areaRegion === region.id).map(wall => wall.id) : [];
        if (walls.length)
            await region.parent?.deleteEmbeddedDocuments?.("Wall", walls);
        // Its sections' Tokens still standing, then the Actor they stood for (raiseSections).
        const sectionTokens = region.flags?.wildpath?.area ? [...(region.parent?.tokens ?? [])]
            .filter(token => token.flags?.wildpath?.section?.regionId === region.id).map(token => token.id) : [];
        if (sectionTokens.length)
            await region.parent?.deleteEmbeddedDocuments?.("Token", sectionTokens);
        const sectionActorId = region.flags?.wildpath?.area?.sectionActorId;
        if (sectionActorId)
            await game.actors?.get(sectionActorId)?.delete();
        // What its opened sections left (leaveBehind) goes with it; each child's own deletion hook releases what it held.
        const children = region.flags?.wildpath?.area ? [...(region.parent?.regions ?? [])]
            .filter(child => child.flags?.wildpath?.area?.parentRegionId === region.id).map(child => child.id) : [];
        if (children.length)
            await region.parent?.deleteEmbeddedDocuments?.("Region", children);
        // The walls it opened stand again, but where another opening area still lies (syncOpenedWalls).
        if (region.flags?.wildpath?.area?.persistence.walls === "open")
            await syncOpenedWalls(region, { ended: true });
        // Its light goes with it; a Token whose light it was gets its own back.
        const lightId = region.flags?.wildpath?.area?.lightId;
        if (lightId)
            await region.parent?.lights?.get(lightId)?.delete();
        const lightToken = region.flags?.wildpath?.area?.lightToken;
        const holder = lightToken ? region.parent?.tokens.get(lightToken.id) : null;
        if (lightToken && holder?.update) {
            await holder.update({ light: lightToken.previous.light ?? { bright: 0, dim: 0, negative: false },
                "flags.wildpath.sunlight": lightToken.previous.sunlight });
        }
        // What it held only while in it ends with it (Web's Restrained once the webs are gone).
        if (region.flags?.wildpath?.area && releases(region.flags.wildpath.area)) {
            for (const token of region.parent?.tokens ?? [])
                await release(region, token);
        }
        const uuid = region.flags?.wildpath?.area?.concentrationEffect;
        const effect = uuid ? await fromUuid?.(uuid) : null;
        await effect?.delete();
        // Last, once nothing of it stands, its `area.ended` triggers (a bead's explosion), whatever ended it: concentration, its
        // duration, a spent budget, Dispel Magic or a light, its caster's death, a parent's end or a GM's delete (Q150 (a)
        // default). Their saves may wait on players, so nothing above waits with them. Not for a Region whose Scene is going
        // (guard: whether V14 fires this hook on a Scene's deletion is unverified).
        if (game.scenes?.get?.(String(region.parent?.id)))
            await answerOnce(region, AREA_EVENTS.ENDED);
    }
    /**
     * A section's Token gone (brought to 0 and removed by the death settle step, or deleted by hand) opens that section:
     * its own walls go (raiseSections flags them `{areaRegion, section: index}`), its neighbours' stay. Its Region's end
     * deletes the walls before the Tokens, so a Token it removes finds none. A section still standing in another Token
     * (a GM's pasted copy of it, or the original once the copy is gone) keeps its walls.
     */
    async function onTokenDeleted(token) {
        const section = token.flags?.wildpath?.section;
        if (!section || !isActiveGM())
            return;
        if ([...(token.parent?.tokens ?? [])].some(other => (other.id !== token.id)
            && (other.flags?.wildpath?.section?.regionId === section.regionId) && (other.flags.wildpath.section.index === section.index)))
            return;
        const walls = [...(token.parent?.walls ?? [])].filter(wall => (wall.flags?.wildpath?.areaRegion === section.regionId)
            && (wall.flags.wildpath.section === section.index)).map(wall => wall.id);
        if (walls.length)
            await token.parent?.deleteEmbeddedDocuments?.("Wall", walls);
        if (token.parent)
            await leaveBehind(token.parent, section);
    }
    /**
     * An opened section's space keeps what its area leaves there (`persistence.sections.leaves`: Wall of Ice's Frigid Air,
     * rubble's Difficult Terrain): a child area over that section's fields, an ordinary placed area of the same caster with
     * the parent's band, Level and cast level, named after its first trigger's Action. It names its parent
     * (`parentRegionId`), so the parent's end deletes it (onRegionDeleted) and ending it ends the parent (end). A Region
     * already gone (the parent's own end removing its Tokens) leaves nothing.
     * shortcut: with its caster's Token gone nothing is left (the GM is told), as an area needs its caster's Token to
     * resolve; upgrade if a wall outliving its caster's Token must still leave its child.
     */
    async function leaveBehind(scene, section) {
        const parent = [...(scene.regions ?? [])].find(region => region.id === section.regionId);
        const flag = parent?.flags?.wildpath?.area;
        const sections = flag?.persistence.sections;
        if (!parent || !flag || !sections?.leaves)
            return;
        const fields = sectionFields(flag, sections, scene)[section.index];
        if (!fields?.length)
            return;
        const caster = scene.tokens.get(flag.sourceTokenId ?? "");
        if (!caster)
            return void gmNotice("WILDPATH.NOTICE.AreaLeavesNoCaster", { name: flag.label }, undefined, { game, logger });
        await deriveArea(parent, flag, caster, fields, { shape: AREA_SHAPES.WALL, persistence: sections.leaves }, { parentRegionId: parent.id });
    }
    /**
     * Its springs used up (dueRuns), after the runs that used them: the area ends as any end does (its `area.ended`
     * triggers answer), then what its budget leaves (`budget.leaves`: Symbol's sphere) comes into effect, a radial area of
     * `leaves.size` around its center field, standing alone (no parent), its rounds counted in its caster's combat as a
     * cast area's are, so its duration runs out; its `area.created` triggers act on everyone in it. An area already gone
     * (Dispel Magic first) leaves nothing; with its caster's Token gone nothing is left and the GM is told (as leaveBehind).
     * The states of what it leaves acting as it appears.
     */
    async function springOut(region) {
        const flag = region.flags?.wildpath?.area;
        const scene = region.parent;
        if (!flag || !scene || ![...(scene.regions ?? [])].some(entry => entry.id === region.id))
            return [];
        // Where it stood, read before its end takes an emanation's carrier along.
        const center = areaCenter({ ...flag, fields: areaFields(flag, scene) }, scene);
        await end(region);
        const leaves = flag.persistence.budget?.leaves;
        if (!leaves)
            return [];
        const caster = scene.tokens.get(flag.sourceTokenId ?? "");
        if (!caster) {
            gmNotice("WILDPATH.NOTICE.AreaSpentNoCaster", { name: flag.label }, undefined, { game, logger });
            return [];
        }
        const origin = center ? createFoundryV14TacticalGridAdapter({ scene }).pointToField(center) : null;
        if (!origin?.ok)
            return [];
        const { fields } = radialFootprint({ topology: flag.topology, origin: origin.field, radiusDistance: Number(leaves.size.value),
            gridDistance: scene.grid.distance });
        const created = [];
        await deriveArea(region, flag, caster, fields, { shape: AREA_SHAPES.RADIAL, size: leaves.size, persistence: leaves.persistence }, { combat: combatOf(caster, game) ?? game.combat ?? null, created });
        return created;
    }
    /**
     * An area another leaves (leaveBehind: an opened section's; springOut: a spent budget's): an ordinary placed area of the
     * same caster over `fields`, with the other's band, Level and cast level, named after its first trigger's Action.
     * `combat`: where its rounds count (null: they never pass, for one that lasts as its parent does).
     */
    async function deriveArea(other, flag, caster, fields, area, { combat = null, parentRegionId = null, created = [] }) {
        const triggers = area.persistence?.triggers;
        const definition = { id: `${flag.actionDefinitionId}:leaves`, label: triggers?.[0]?.action?.label ?? flag.label, area };
        const data = persistentAreaRegionData({ placement: { footprint: { topology: flag.topology, fields }, sceneId: caster.parent.id,
                sourceTokenId: caster.id, definition }, sourceToken: caster, combat, color: DERIVED_AREA_COLORS.derived });
        Object.assign(data.flags.wildpath.area, { band: flag.band, castLevel: flag.castLevel ?? null, ...(parentRegionId ? { parentRegionId } : {}) });
        Object.assign(data, { elevation: { ...flag.band }, ...(other.levels ? { levels: [...other.levels] } : {}) });
        return createRegion(caster, data, definition, created);
    }
    function isActiveGM() {
        return game.users?.activeGM?.id === game.user.id;
    }
    /**
     * What the area gave `token`'s creature only while in it (stamped with its Region) ends: it left, or the area ended.
     * A custom effect that another area covering the creature at `position` (where its step ended; else where it stands)
     * also holds on everyone in it (an entering trigger's heldOnly, acting on it: a second Antimagic Field, another Spirit
     * Guardians' Half Speed) is handed over instead: one update names that area, so nothing goes off and on again.
     */
    async function release(region, token, { position = null } = {}) {
        const actor = token.actor;
        const held = [...(actor?.effects ?? [])].filter(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId === region.id);
        // A removed Token enters no area, and a dead creature is passed by (crossed, dueRuns): none takes its effect over.
        const others = (held.length && !removedMarker(token) && !(actor && deadCreature(actor))) ? sceneAreas(token.parent).filter(({ region: other, flag }) => (other.id !== region.id)
            && !spares(flag, token) && areaCovers(flag, token, { position })) : [];
        // What this area gave it is going, so its rules bar no heir (Winked Out's own Unaffected {} would bar every one).
        const going = held.map(effect => effect.id);
        const heir = (statuses) => others.find(({ flag }) => flag.persistence.triggers.some(trigger => trigger.on.includes(AREA_EVENTS.ENTERED)
            && reaches(flag, trigger, token, going) && (heldOnly(trigger.action)?.effects ?? []).some(effect => (effect.type === "effect")
            && statuses.includes(customEffectId(String(trigger.action?.id), effect)))))?.region ?? null;
        const heirs = held.map(effect => ({ effect, heir: heir([...(effect.statuses ?? [])]) }));
        const updates = heirs.filter(({ heir }) => heir)
            .map(({ effect, heir }) => ({ _id: effect.id, "flags.wildpath.conditionEffect.metadata.regionId": heir?.id }));
        const ids = heirs.filter(({ heir }) => !heir).map(({ effect }) => effect.id);
        if (updates.length)
            await actor?.updateEmbeddedDocuments?.("ActiveEffect", updates);
        if (ids.length)
            await actor?.deleteEmbeddedDocuments?.("ActiveEffect", ids);
        return ids;
    }
    // Keyed on the creature's own combat, as onTurn is, not the one the GM's tracker shows. `feet`: for `area.moved`, how
    // far the creature moved in the area on that step (moved). `position`: where the step that left it ended (release).
    // `swept`: its anchor's step moved the area onto (or off) the creature (swept), which a `mover: "anchor"` trigger waits for.
    async function apply(region, flag, token, event, { feet = 0, key = turnKey(combatOf(token, game) ?? game.combat), appearing = false, position = null, swept = false } = {}) {
        if (event === AREA_EVENTS.EXITED)
            await release(region, token, { position });
        const { runs, spent } = await dueRuns(region, flag, [token], event, { feet, key, appearing, swept });
        const results = [];
        for (const run of runs) {
            const state = await runOne(region, flag, run);
            if (state)
                results.push(state);
        }
        // What its spent area leaves acting on the mover affects it too, so its move stops there (resolveAreaCrossings).
        if (spent)
            results.push(...await springOut(region));
        else if (runs.length)
            await charge(region, flag, results);
        return results;
    }
    /**
     * The runs `event` makes in an area for each of `tokens`, after the area's creature filters and once records; the
     * records are written (one update) before anything resolves, as an effect that moves a creature must not re-enter the
     * same area this turn. `sourceTurn`: its caster's turn (runSourceTriggers), so only its `turnOf: "source"` triggers
     * answer a turn event, a self-targeted one on its caster and any other on each creature the area covers; on any other
     * turn only the rest do. `creating`: only its `once: "area"` triggers (create). `swept`: its anchor moved it onto (or off)
     * the creature; a `mover: "anchor"` trigger answers only that, never a creature stepping in or an area appearing.
     * `spent`: these runs used up its budget's `springs`, so once they have run it ends (springOut).
     */
    function dueRuns(region, flag, tokens, event, options = {}) {
        // Springs are counted one call at a time on the area's queue: two creatures stepping in at once from two clients read
        // its count in turn, so a glyph of one spring is spent once. Its end is never counted, nor waits on the queue.
        return ((Number(flag.persistence.budget?.springs) > 0) && (event !== AREA_EVENTS.ENDED))
            ? queued(region, () => collectRuns(region, flag, tokens, event, options)) : collectRuns(region, flag, tokens, event, options);
    }
    async function collectRuns(region, flag, tokens, event, { feet = 0, key = null, appearing = false, sourceTurn = false, creating = false, swept = false }) {
        const none = { runs: [], spent: false };
        // A pending opening answers nothing until its Open (rollOpenings).
        if (flag.pending)
            return none;
        // Spent (a budget dealt in all, or its springs used up): nothing more, though a sweep listed more creatures before it
        // ended (its live flag); but its end, as any end, still answers `area.ended`.
        const live = region.flags?.wildpath?.area;
        const budget = Number(flag.persistence.budget?.damage) || 0;
        if (budget && (event !== AREA_EVENTS.ENDED) && ((Number(live?.dealt) || 0) >= budget))
            return none;
        const springs = (event === AREA_EVENTS.ENDED) ? 0 : (Number(flag.persistence.budget?.springs) || 0);
        const sprung = Number(live?.sprung) || 0;
        if (springs && (sprung >= springs))
            return none;
        let springing = 0;
        // Moving in an area acts on every step, whatever once per turn says, and spends none of it (Spike Growth).
        if (event === AREA_EVENTS.MOVED)
            key = null;
        const runs = [];
        const records = {};
        // Outside combat (no turn to key on) a `once: "turn"` trigger acts once while its creature stays in the area (`stay`),
        // its leaving freeing it: a crossing is one save though the trigger answers entering and leaving (Frigid Air), and
        // each new entering is another, as outside combat there is no limit.
        const mark = (trigger) => key ?? (((trigger.once === "turn") && (event !== AREA_EVENTS.MOVED)) ? "stay" : null);
        // A stage of the area's life (`ticks`: a storm's second round); `flag` is read after this turn's tick (tickClock).
        const ticks = areaTicks(flag);
        const staged = ({ ticks: stage }) => !stage || ((ticks >= (stage.from ?? 0)) && (ticks <= (stage.to ?? Infinity)));
        for (const token of tokens) {
            if (!key && (event === AREA_EVENTS.EXITED))
                for (const [slot, value] of Object.entries(flag.applied)) {
                    if ((value === "stay") && slot.startsWith(`${token.id}-`))
                        records[slot] = null;
                }
            // How many times a trigger acts: once, or on a move once for every `per` feet of it (none for less).
            const times = (trigger) => (((event === AREA_EVENTS.MOVED) && trigger.per) ? Math.floor(feet / trigger.per) : 1);
            // On its caster's turn a self-targeted trigger acts on its caster, wherever it stands, as the area's own act.
            const self = (trigger) => sourceTurn && selfTargeted(trigger.action ?? {});
            const whose = (trigger) => !TURN_EVENTS.includes(event) || ((trigger.turnOf === "source") === sourceTurn);
            const here = (trigger) => !sourceTurn || (self(trigger) ? (token.id === flag.sourceTokenId) : areaCovers(flag, token));
            const triggers = flag.persistence.triggers.map((trigger, index) => ({ trigger, index }))
                .filter(({ trigger }) => trigger.on.includes(event) && whose(trigger) && (!creating || (trigger.once === "area"))
                && (self(trigger) || !spares(flag, token)) && reaches(flag, trigger, token) && staged(trigger) && (swept || (trigger.mover !== "anchor"))
                && (times(trigger) > 0) && here(trigger));
            // A dead creature is an object: its area passes it by (an exit still releases it).
            if (!triggers.length || !token.actor || deadCreature(token.actor))
                continue;
            // A trigger with `once: "turn"` (or a self-targeted one on its caster's turn) keeps its own record
            // (`<token id>-<index>`), spending and spent by no other trigger; `once: "area"` keeps one for the whole area
            // (`area-<index>`), spent at its first run even outside combat; the rest share the area's (2026-11-14).
            const slot = ({ trigger, index }) => ((trigger.once === "area") ? `area-${index}`
                : ((trigger.once === "turn") || self(trigger)) ? `${token.id}-${index}` : token.id);
            const spent = (entry) => ((entry.trigger.once === "area") ? !!flag.applied[slot(entry)]
                : !!(mark(entry.trigger) && ((entry.trigger.once === "turn") || self(entry.trigger) || flag.persistence.oncePerTurn)
                    && (flag.applied[slot(entry)] === mark(entry.trigger))));
            const due = triggers.filter(entry => !spent(entry));
            // Each due trigger on a creature springs it once, one with no Action too (a glyph stepped on); once its springs are
            // used up the creatures after it are passed by.
            if (springs && !appearing) {
                if (sprung + springing >= springs)
                    break;
                springing += due.length;
            }
            // Spent this turn, an entering still gives what it holds while in it whatever the save (heldOnly); `appearing`, only that.
            const held = triggers.map(entry => ({ ...entry, token: token, count: times(entry.trigger),
                action: (due.includes(entry) && !appearing) ? entry.trigger.action : ((event === AREA_EVENTS.ENTERED) ? heldOnly(entry.trigger.action) : null) }))
                .filter((run) => !!run.action);
            runs.push(...held);
            if (!appearing)
                for (const entry of due) {
                    const value = (entry.trigger.once === "area") ? (key ?? "area") : mark(entry.trigger);
                    if (value && !((value === "stay") && (event === AREA_EVENTS.EXITED)))
                        records[slot(entry)] = value;
                }
        }
        const update = Object.fromEntries(Object.entries(records).map(([slot, value]) => [`flags.wildpath.area.applied.${slot}`, value]));
        if (springing)
            update["flags.wildpath.area.sprung"] = sprung + springing;
        if (Object.keys(update).length)
            await region.update(update);
        return { runs, spent: springing > 0 && (sprung + springing >= springs) };
    }
    /**
     * Who answers a trigger's Action that refines its targets (`targeting.refinementPolicy`: "six creatures of your choice
     * beneath it"): its caster's player (playerOf), else the authority, as for any trigger Action without one (unchanged).
     */
    function refiner(flag, scene, action) {
        const caster = flag.sourceTokenId ? scene.tokens.get(flag.sourceTokenId)?.actor : null;
        return (caster && action.targeting?.refinementPolicy)
            // Widened to what playerOf reads (its testUserPermission); this file types an Actor's effects narrower than it does.
            ? playerOf(game, caster) : null;
    }
    /** One trigger's Action on one creature, with the caster as source. */
    function runOne(region, flag, { token, action, count }) {
        return runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
            resolutionId: `area:${region.id}:${token.id}:${++sequence}`,
            definition: repeatedDamage(stamped(aged(action, flag), region, token.actor), count), label: flag.label,
            actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? { tokenId: flag.sourceTokenId, sceneId: token.parent.id } : {},
            // A lasting area's own trigger (placed, carried or an emanation): no cover against it (Q37); the area is its parent.
            target: { actorRef: token.actor.uuid, tokenId: token.id, sceneId: token.parent.id }, noCover: true,
            parentArea: { sceneId: token.parent.id, regionId: region.id }, initiatorUserId: refiner(flag, token.parent, action) });
    }
    /**
     * One trigger's runs on several creatures: one Action for all of them (an aura's: one damage roll), or one per creature
     * when it gives what it holds only while in the area (`stamped` is per creature). Their states.
     */
    async function runGroup(region, flag, trigger, index, group, kind) {
        // A group is made only of runs of a trigger with an Action (dueRuns).
        const action = trigger.action ?? {};
        if ((action.effects ?? []).some(leavesArea)) {
            const states = [];
            for (const run of group)
                states.push(await runOne(region, flag, run));
            return states;
        }
        const scene = group[0].token.parent;
        return [await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `area:${region.id}:${kind}-${index}:${++sequence}`, definition: aged(action, flag), label: flag.label,
                actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? { tokenId: flag.sourceTokenId, sceneId: scene.id } : {},
                targets: group.map(({ token }) => ({ actorRef: token.actor.uuid, tokenId: token.id, sceneId: scene.id })), noCover: true,
                parentArea: { sceneId: scene.id, regionId: region.id }, initiatorUserId: refiner(flag, scene, action) })];
    }
    /** A budget's area adds what its runs dealt (spend). */
    async function charge(region, flag, results) {
        if (!(Number(flag.persistence.budget?.damage) || 0))
            return;
        await queued(region, () => spend(region, results));
    }
    /**
     * `work` once the area's earlier queued work is done (a spend, a springs count): one after another per area, so an update
     * still on its way to the server is never read stale by the next.
     */
    function queued(region, work) {
        const next = (spending.get(region.id) ?? Promise.resolve()).then(work);
        spending.set(region.id, next.catch(() => undefined));
        return next;
    }
    /**
     * Its caster's turn starts or ends (`caster`, its Token): each of its areas on the Scene answers with its
     * `turnOf: "source"` triggers, in their order. A self-targeted one acts once, on its caster; any other is one Action for
     * every creature the area covers (runGroup). An area an earlier trigger ended (its caster's concentration broken)
     * answers no more. `region`: that area alone (create).
     */
    async function runSourceTriggers(event, caster, key, { region: only = null, creating = false } = {}) {
        const scene = caster.parent;
        const results = [];
        const areas = sceneAreas(scene).filter(({ region, flag }) => (flag.sourceTokenId === caster.id) && (!only || (region.id === only.id))
            && flag.persistence.triggers.some(trigger => (trigger.turnOf === "source") && trigger.on.includes(event)));
        // Ended: deleted, or a concentration area whose caster's concentration a trigger here broke. A resolved Action returns
        // before its follow-ups (afterResolution) delete the area, so its Region is still on the Scene then.
        let broken = false;
        const ended = (region, flag) => (broken && flag.persistence.concentration)
            || ![...(scene.regions ?? [])].some(entry => entry.id === region.id);
        for (const { region, flag } of areas) {
            if (ended(region, flag))
                continue;
            const { runs, spent } = await dueRuns(region, flag, [...scene.tokens], event, { key, sourceTurn: true, creating });
            const states = [];
            for (const [index, trigger] of flag.persistence.triggers.entries()) {
                const group = runs.filter(run => run.index === index);
                if (!group.length)
                    continue;
                if (ended(region, flag))
                    break;
                states.push(...await runGroup(region, flag, trigger, index, group, "source"));
                // Only a completed Action's follow-ups end anything (afterCompleted); a failed or cancelled one broke nothing.
                broken ||= states.some(state => (state?.status === "completed")
                    && (brokenConcentration(state).has(`token:${caster.id}`)
                        || brokenConcentrationTargets(state).some(target => target?.tokenId === caster.id)));
            }
            const done = states.filter(Boolean);
            if (spent && !ended(region, flag))
                done.push(...await springOut(region));
            else if (runs.length && !ended(region, flag))
                await charge(region, flag, done);
            results.push(...done);
        }
        return results;
    }
    /**
     * A budget's area adds the damage its completed runs dealt (Temporary Hit Points and overkill included, Q29; a failed or
     * cancelled run changed no Hit Points), queued per area (apply); at its budget it ends (end). One already ended by an
     * earlier spend is left alone.
     */
    async function spend(region, results) {
        const flag = region.flags.wildpath.area;
        const budget = Number(flag.persistence.budget?.damage) || 0;
        if ((Number(flag.dealt) || 0) >= budget)
            return;
        const dealt = (Number(flag.dealt) || 0) + results.filter(state => state?.status === "completed")
            .reduce((sum, state) => sum + damageTaken(state), 0);
        await region.update({ "flags.wildpath.area.dealt": dealt });
        if (dealt < budget)
            return;
        await end(region);
    }
    /**
     * Its caster's turn at its clock's `at` (`turn.started` by default): the area counts 6 seconds more, once per turn key
     * (a repeated hook never ticks twice); its flag as it stands after, or null once that tick ended it. Its clock never
     * ticks on another creature's turn, and a pending opening, not yet in effect, does not age.
     */
    async function tickClock(region, flag, event, key) {
        const clock = flag.persistence.clock;
        if (!clock || flag.pending || ((clock.at ?? AREA_EVENTS.TURN_STARTED) !== event) || (key && (flag.clock?.last === key)))
            return flag;
        return advanceClock(region, flag, 6, key);
    }
    /**
     * An area's clock counts `seconds` more (`last`: the turn key it ticked on), in an update no GM drag is read from
     * (`areaMove`, onRegionUpdated). Once it has ticked `ends` times it ends (end); else each tick it gained resizes it
     * (resizeArea), then moves it (driftArea). Its flag as it stands after, or null once it has ended.
     */
    async function advanceClock(region, flag, seconds, last) {
        const before = areaTicks(flag);
        await region.update({ "flags.wildpath.area.clock": { seconds: (Number(flag.clock?.seconds) || 0) + seconds, last } }, { wildpath: { areaMove: true } });
        const live = region.flags?.wildpath?.area ?? flag;
        const ticks = areaTicks(live);
        if (ticks <= before)
            return live;
        const ends = Number(live.persistence.clock?.ends) || 0;
        if (ends && (ticks >= ends)) {
            await end(region);
            return null;
        }
        const resized = await resizeArea(region, live, ticks - before);
        return resized && driftArea(region, resized, ticks - before);
    }
    /**
     * `gained` ticks of its clock's `resize`: an attached area's size changes by `size` a tick, kept within `min` (0 by
     * default) and `max`, its Region redrawn around its anchor (Eversmoking Bottle's smoke growing to 120 feet), and its
     * band's top by `top` a tick, its Region's with it (Tsunami's falling wall). At a size of 0, or a top at or below its
     * bottom, it ends (end); else each creature it now covers is entered and what each it left held while in it ends
     * (rehome). Its flag as it stands after, or null once it has ended.
     * shortcut: a placed area (an onObject area cast without its object) keeps its size, as it would not grow from its
     * center; upgrade by storing its origin field when a homebrew needs it.
     */
    async function resizeArea(region, flag, gained) {
        const resize = flag.persistence.clock?.resize;
        const scene = region.parent;
        if (!resize || !scene)
            return flag;
        const size = (resize.size && flag.attached)
            ? Math.min(Math.max(flag.size + (resize.size * gained), Number(resize.min) || 0), resize.max ?? Infinity) : flag.size;
        const top = (resize.top && (flag.band.top !== null)) ? flag.band.top + (resize.top * gained) : flag.band.top;
        if ((size === flag.size) && (top === flag.band.top))
            return flag;
        // Only what changed ends it: an area cast as a flat band (top at its bottom) that only grows stays.
        if (((size !== flag.size) && (size <= 0))
            || ((top !== flag.band.top) && (top !== null) && (flag.band.bottom !== null) && (top <= flag.band.bottom))) {
            await end(region);
            return null;
        }
        const resized = { ...flag, size, band: { ...flag.band, top } };
        const before = new Set([...scene.tokens].filter(token => areaCovers(flag, token)).map(token => token.id));
        const offsets = areaFields(resized, scene).map(field => toOffset(field, { grid: scene.grid }).offset).filter(Boolean);
        await region.update({ "flags.wildpath.area.size": size, "flags.wildpath.area.band.top": top, "elevation.top": top,
            ...((size === flag.size) ? {} : { shapes: [{ type: "grid", offsets }] }) }, { wildpath: { areaMove: true } });
        const live = region.flags?.wildpath?.area ?? resized;
        await rehome(region, before, live);
        return live;
    }
    /**
     * `gained` ticks of its clock's `drift`: a placed area moves `distance` feet a tick in a straight line from its caster's
     * center through its own (Cloudkill rolling away), snapped to fields, passing walls as a cloud does; with its caster on its
     * center, or gone, it stays. With `carries` (Tsunami: "along with any creatures in it") each creature it covered on its
     * caster's plane first moves by the same displacement as forced movement, the farthest along it first so that none blocks
     * another, and no step of it enters, leaves or moves in this area (carrying); a wall, a creature or the Scene's edge that
     * stops one leaves it behind. Then the area moves (relocate): each creature it now covers that it did not before is
     * entered, and each it covered before and no longer does (one stopped, one it drifted off) loses what it held only while
     * in it. Another wall's section Tokens are objects, never carried. Its flag as it stands after.
     */
    async function driftArea(region, flag, gained) {
        const drift = flag.persistence.clock?.drift;
        const scene = region.parent;
        const caster = scene?.tokens.get(flag.sourceTokenId ?? "");
        const center = scene ? areaCenter(flag, scene) : null;
        if (!drift || !scene || flag.attached || !caster || !center)
            return flag;
        const from = caster.getCenterPoint();
        // shortcut: always straight away from its caster (Q150 (b) default: the GM drags the Region for Incendiary Cloud's "a
        // direction you choose"); upgrade with a chosen direction when one is wanted.
        const [dx, dy] = [center.x - from.x, center.y - from.y];
        const scale = lineFields(scene.grid, dx, dy);
        const steps = Math.floor((Number(drift.distance) * gained) / (Number(scene.grid.distance) || 5));
        if (!scale || !(steps > 0))
            return flag;
        const adapter = createFoundryV14TacticalGridAdapter({ scene });
        const fieldAt = (point) => adapter.pointToField(point);
        const at = fieldAt(center);
        // From the center of the field its center is in, not its own (an even-width area's is a vertex, which snaps one way), so
        // casters mirrored either side of its line drift it alike.
        const start = at.field ? toCenter(at.field, { scene, grid: scene.grid }).point : null;
        const to = start ? fieldAt({ x: start.x + ((dx / scale) * steps), y: start.y + ((dy / scale) * steps) }) : null;
        const finish = to?.field ? toCenter(to.field, { scene, grid: scene.grid }).point : null;
        if (!at.field || !to?.field || !start || !finish)
            return flag;
        const offset = Object.fromEntries(Object.keys(to.field).map(key => [key, Number(to.field[key]) - Number(at.field[key])]));
        const fields = flag.fields.map(field => offsetGridField(field, offset, flag.topology));
        const before = new Set([...scene.tokens].filter(token => areaCovers(flag, token)).map(token => token.id));
        if (drift.carries) {
            const shift = { x: finish.x - start.x, y: finish.y - start.y };
            const along = (token) => (token.getCenterPoint().x * shift.x) + (token.getCenterPoint().y * shift.y);
            const carried = [...scene.tokens].filter(token => before.has(token.id) && !removedMarker(token)
                && !token.flags?.wildpath?.section && (planeOf(token.actor) === planeOf(caster.actor)));
            for (const token of carried.sort((a, b) => along(b) - along(a))) {
                const until = { x: token.x + shift.x, y: token.y + shift.y };
                const aim = token.getCenterPoint(until);
                carrying.set(token.id, region.id);
                try {
                    // One field an update: on a Scene with a crossing area Foundry commits a longer move one checkpoint at a time, the
                    // rest after its update returns (prepareFoundryReactionCheckpoints), past this guard and the front-first order.
                    for (let step = 0; step < steps; step++) {
                        const next = forcedDestination(token, aim, 1, { toward: true, until, blocked: forcedStepBlocker(scene, token) });
                        if (!next)
                            break;
                        await token.update({ ...next }, { wildpath: { movementKind: "forced" } });
                    }
                }
                finally {
                    carrying.delete(token.id);
                }
            }
        }
        await relocate(region, fields, { before });
        return region.flags?.wildpath?.area ?? { ...flag, fields };
    }
    /**
     * World time moved on by `seconds` (the updateWorldTime hook's dt), on the active GM, one change after another: each
     * lasting area whose clock ticks every minute or longer (`every`) and whose caster is in no started combat counts it,
     * at most MAX_INTERVAL_RUNS ticks a change (the rest is dropped, as for a `time.elapsed` Trigger). A round clock never
     * ticks on world time, as no duration runs out there (areaExpired); in combat a minute clock counts its caster's turns
     * (tickClock).
     */
    let worldTimeQueue = Promise.resolve();
    function onWorldTime(seconds) {
        if (!isActiveGM() || !(seconds > 0))
            return Promise.resolve();
        worldTimeQueue = worldTimeQueue.catch(() => { }).then(async () => {
            for (const scene of game.scenes ?? []) {
                for (const { region, flag } of sceneAreas(scene)) {
                    const clock = flag.persistence.clock;
                    // Gone meanwhile: another area's end took it along (a parent's child).
                    if (!clock || flag.pending || (tickSeconds(clock) < 60) || ![...(scene.regions ?? [])].includes(region))
                        continue;
                    if (combatOf(scene.tokens.get(flag.sourceTokenId ?? ""), game)?.started)
                        continue;
                    await advanceClock(region, flag, Math.min(seconds, MAX_INTERVAL_RUNS * tickSeconds(clock)), flag.clock?.last ?? null);
                }
            }
        });
        return worldTimeQueue;
    }
    /**
     * A combatant's turn starts or ends: every area it stands in answers that event, once per turn counted in that turn,
     * and then every area it is the caster of answers with its `turnOf: "source"` triggers (runSourceTriggers).
     * Foundry runs `_onEndTurn` after the Combat has advanced, so the ended turn is its `context`'s ({round, turn}).
     */
    async function onTurn(event, { combatant, context = null }) {
        const token = combatant?.token ?? null;
        if (!token?.parent?.regions)
            return [];
        const combat = combatant?.combat;
        const key = (combat && (context?.round != null)) ? turnKey({ id: combat.id, round: context.round, turn: context.turn })
            : turnKey(game.combat);
        const applied = [];
        for (const { region, flag: read } of sceneAreas(token.parent)) {
            // An area whose rounds have run out is gone before anyone starts a turn in it.
            // The turn's own combat, not the one the GM's tracker shows.
            if ((event === AREA_EVENTS.TURN_STARTED) && areaExpired(read, combatant?.combat)) {
                await region.delete();
                continue;
            }
            // Its caster's turn moves its clock on first, so this turn's triggers see the new age (and size); a tick may end it.
            const flag = (read.sourceTokenId === token.id) ? await tickClock(region, read, event, key) : read;
            if (flag && areaCovers(flag, token))
                applied.push(...await apply(region, flag, token, event, { key }));
        }
        applied.push(...await runSourceTriggers(event, token, key));
        return applied;
    }
    /**
     * Areas a Token enters by stepping from `previous` to `position` (covered after, not before), or with
     * `area.exited` leaves (covered before, not after). Only areas that answer that event count.
     * A Token removed from the scene (removedMarker) enters nothing, but still leaves; one a drifting area carries neither
     * enters nor leaves it (carrying).
     */
    function crossed(token, { previous, position }, event) {
        if ((event !== AREA_EVENTS.EXITED) && removedMarker(token))
            return [];
        const [inside, outside] = event === AREA_EVENTS.EXITED ? [previous, position] : [position, previous];
        return sceneAreas(token.parent).filter(({ region, flag }) => (carrying.get(token.id) !== region.id) && answers(flag, event)
            && areaCovers(flag, token, { position: inside }) && !areaCovers(flag, token, { position: outside }));
    }
    const entered = (token, step) => crossed(token, step, AREA_EVENTS.ENTERED);
    const exited = (token, step) => crossed(token, step, AREA_EVENTS.EXITED);
    /**
     * Areas answering `area.moved` that a Token's step from `previous` to `position` moves it in, each with the feet moved
     * there: one grid distance for each space of the step that ends in the area, so a step in from outside counts only
     * its part inside and a step out counts nothing. Distance as movement measures it (any step to an adjacent space is
     * one grid distance, diagonals too); Difficult Terrain's extra cost is not distance moved. A Token removed from the
     * scene (removedMarker) moves in none, nor one in the drifting area carrying it (carrying).
     */
    function moved(token, { previous, position }) {
        if (removedMarker(token))
            return [];
        const scene = token.parent;
        // An area its Token carries goes with it: the Token moves in it no more than out of it (includesAnchor).
        const areas = sceneAreas(scene).filter(({ region, flag }) => answers(flag, AREA_EVENTS.MOVED) && (carrying.get(token.id) !== region.id)
            && !(flag.attached && (anchorOf(flag) === token.id)));
        if (!areas.length)
            return [];
        const adapter = createFoundryV14TacticalGridAdapter({ scene });
        const anchor = (at) => adapter.tokenToFootprint(token, { position: at });
        const [from, to] = [anchor(previous), anchor(position)];
        const spaces = (from.ok && to.ok && from.anchor && to.anchor) ? distanceOf(from.anchor, to.anchor, to.topology) : 0;
        // shortcut: a step of several spaces is cut into equal parts along a straight line; a checkpointed drag moves one
        // space a step (one resolution and card per space), so this, and the one-roll merge, only matter for a step
        // Foundry did not split.
        const along = Array.from({ length: spaces }, (_, index) => ({ ...position, ...Object.fromEntries(["x", "y", "elevation"]
                .filter(key => Number.isFinite(Number(position[key])) && Number.isFinite(Number(previous[key])))
                .map(key => [key, Number(previous[key]) + ((Number(position[key]) - Number(previous[key])) * (index + 1) / spaces)])) }));
        return areas.map(({ region, flag }) => ({ region, flag,
            feet: along.filter(at => areaCovers(flag, token, { position: at })).length * scene.grid.distance }))
            .filter(entry => entry.feet > 0);
    }
    /**
     * Creatures an aura newly covers as its caster steps from `previous` to `position` (the aura enters them),
     * and creatures it stops covering (they exit it), each with that event. While either the caster or a creature is
     * removed from the scene (removedMarker), the aura enters nothing of it, but still exits.
     */
    function swept(owner, { previous, position }) {
        const scene = owner.parent;
        return sceneAreas(scene).filter(({ flag }) => flag.attached && (anchorOf(flag) === owner.id))
            .flatMap(({ region, flag }) => {
            const before = areaFields(flag, scene, { position: previous });
            const after = areaFields(flag, scene, { position });
            return [AREA_EVENTS.ENTERED, AREA_EVENTS.EXITED].filter(event => answers(flag, event)).map(event => {
                const [inside, outside] = event === AREA_EVENTS.EXITED ? [before, after] : [after, before];
                const entering = event !== AREA_EVENTS.EXITED;
                const tokens = (entering && removedMarker(owner)) ? [] : [...scene.tokens].filter(token => (token.id !== owner.id)
                    && !(entering && removedMarker(token))
                    && areaCovers(flag, token, { fields: inside }) && !areaCovers(flag, token, { fields: outside }));
                return { region, flag, tokens, event };
            });
        }).filter(entry => entry.tokens.length);
    }
    /**
     * A creature that rams (`occupancy.ram`: a Flaming Sphere its Roll moves) ended a voluntary move in other creatures'
     * spaces (foundry-v14-occupancy lets it end in the first it enters): it moves no more this turn (its movement spent), and
     * each area it carries answers `area.rammed` for each of them (the sphere's save, at its caster's DC and slot). Runs once,
     * on the active GM, on `movement.completed`.
     */
    async function rammed(event) {
        const data = event?.data;
        if ((event?.type !== AUTOMATION_EVENT_TYPES.MOVEMENT_COMPLETED) || (data?.movementKind !== "voluntary") || !isActiveGM())
            return [];
        const ref = parseEntityRef(data.tokenRef);
        const scene = ref.ok ? game.scenes?.get(String(ref.scope)) : undefined;
        const mover = scene?.tokens.get(String(ref.id));
        if (!scene || !mover?.actor || !((Number(mover.actor.getStatistic?.(["occupancy.ram"])?.totalModifier) || 0) > 0))
            return [];
        // Only those it entered: a creature it was already in when it set out was rammed then.
        const origin = data.origin?.footprint;
        const before = new Set(origin ? sharingSpace(mover, origin).map(token => token.id) : []);
        const struck = sharingSpace(mover).filter(token => !before.has(token.id));
        if (!struck.length)
            return [];
        const movement = mover.actor.system?.resources?.movement;
        if (movement && (Number(movement.spent) < Number(movement.max))) {
            await mover.actor.update?.({ "system.resources.movement.spent": movement.max });
        }
        const applied = [];
        for (const { region, flag } of sceneAreas(scene).filter(({ flag }) => flag.attached && (anchorOf(flag) === mover.id)
            && answers(flag, AREA_EVENTS.RAMMED))) {
            for (const token of struck)
                applied.push(...await apply(region, flag, token, AREA_EVENTS.RAMMED));
        }
        return applied;
    }
    /**
     * Whether any lasting area on the Scene answers entering, leaving or moving in it, or ends when pressed (pressedAreas);
     * moves there are then checkpointed per step.
     */
    function hasCrossingAreas(scene) {
        return sceneAreas(scene).some(({ flag }) => (flag.attached && (flag.persistence?.bars?.pressed === "ends"))
            || [AREA_EVENTS.ENTERED, AREA_EVENTS.EXITED, AREA_EVENTS.MOVED].some(event => answers(flag, event)));
    }
    /** Its anchor's committed step pressed an area's edge across a creature it bars (pressedAreas): it ends, and the GM is told. */
    async function press(region) {
        const flag = region.flags?.wildpath?.area;
        if (!flag)
            return;
        await end(region);
        gmNotice("WILDPATH.NOTICE.AreaPressed", { name: flag.label }, undefined, { game, logger });
    }
    /**
     * A placed lasting area now covers `fields` (moved by its caster's Action, or dragged by the GM). They become its
     * fields, and each creature newly inside it is entered ("when the Cylinder moves into its space"), once per turn.
     * Its triggers, cast level included, go with it.
     */
    async function relocate(region, fields, { drawn = false, before = null } = {}) {
        const flag = region.flags?.wildpath?.area;
        const scene = region.parent;
        if (!flag || flag.attached || !scene)
            return [];
        // `before`: whom it covered before its creatures moved along with it (driftArea), else whom it covers now.
        before ??= new Set([...scene.tokens].filter(token => areaCovers(flag, token)).map(token => token.id));
        const offsets = fields.map(field => toOffset(field, { grid: scene.grid }).offset).filter(Boolean);
        await region.update({ ...(drawn ? {} : { shapes: [{ type: "grid", offsets }] }), "flags.wildpath.area.fields": fields }, { wildpath: { areaMove: true } });
        if (flag.persistence.walls === "open")
            await syncOpenedWalls(region);
        return rehome(region, before, { ...flag, fields });
    }
    /**
     * An area now covering what `flag` covers (moved, or resized by its clock): each creature newly inside (not among
     * `before`, the ids it covered) is entered, once per turn, unless removed from the scene (removedMarker, as a move into
     * it); a creature it no longer covers loses what it held only while in it. The entering states.
     */
    async function rehome(region, before, flag) {
        const tokens = [...(region.parent?.tokens ?? [])];
        const applied = [];
        for (const token of tokens.filter(token => !before.has(token.id) && !removedMarker(token) && areaCovers(flag, token))) {
            if (answers(flag, AREA_EVENTS.ENTERED))
                applied.push(...await apply(region, flag, token, AREA_EVENTS.ENTERED));
        }
        if (releases(flag)) {
            for (const token of tokens.filter(token => before.has(token.id) && !areaCovers(flag, token)))
                await release(region, token);
        }
        return applied;
    }
    /** After an Action that moves its caster's lasting area (`options.areaMove`: its Region and new fields). */
    async function move({ options }) {
        const moving = options?.areaMove;
        if (!moving || !isActiveGM())
            return [];
        const region = [...(game.scenes?.get(moving.sceneId)?.regions ?? [])].find(entry => entry.id === moving.regionId);
        return region ? relocate(region, moving.fields) : [];
    }
    /**
     * The GM dragged a lasting area's Region: its fields follow the cells now drawn. A blocking area (`persistence.blocks`)
     * is drawn back where it was instead, so its walls never drift from its fields, and the GM is told.
     */
    async function onRegionUpdated(region, changed, operation = {}) {
        if (!isActiveGM() || operation?.wildpath?.areaMove || !changed?.shapes || !region.parent)
            return [];
        const flag = region.flags?.wildpath?.area;
        if (flag?.persistence.blocks) {
            const offsets = flag.fields.map(field => toOffset(field, { grid: region.parent.grid }).offset).filter(Boolean);
            await region.update({ shapes: [{ type: "grid", offsets }] }, { wildpath: { areaMove: true } });
            gmNotice("WILDPATH.NOTICE.AreaFixed", { name: flag.label }, undefined, { game, logger });
            return [];
        }
        const offsets = region.shapes?.find(shape => shape.type === "grid")?.offsets ?? [];
        const fields = offsets.map(offset => foundryOffsetToGridField(offset, { scene: region.parent }).field).filter((field) => !!field);
        return fields.length ? relocate(region, fields, { drawn: true }) : [];
    }
    return { create, carry, end, endWithSource, apply, onTurn, entered, exited, moved, swept, pressed: pressedAreas, press, rammed,
        hasCrossingAreas, afterResolution, onEffectDeleted,
        onRegionDeleted, onTokenDeleted, move, onRegionUpdated, rollOpenings, openOpenings, onWorldTime };
}

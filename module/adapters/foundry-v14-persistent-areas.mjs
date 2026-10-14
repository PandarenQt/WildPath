import { createFoundryV14TacticalGridAdapter, gridFieldToFoundryOffset } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint, fieldKey } from "../helpers/grid-footprints.mjs";
import { AREA_SHAPES } from "../helpers/tactical-areas.mjs";
export const AREA_EVENTS = Object.freeze({ ENTERED: "area.entered", TURN_STARTED: "turn.started", TURN_ENDED: "turn.ended" });
const reachFootprint = createReachFootprint;
const keyOf = fieldKey;
const toOffset = gridFieldToFoundryOffset;
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
    const band = { bottom: bound(persistence.elevation?.bottom), top: bound(persistence.elevation?.top) };
    const attached = area.shape === AREA_SHAPES.EMANATION;
    const offsets = placement.footprint.fields.map(field => toOffset(field, { grid: scene.grid }).offset).filter(Boolean);
    const flag = {
        schemaVersion: 1,
        actionDefinitionId: definition.id ?? null, label: definition.label ?? "Area",
        sourceActorRef: sourceToken.actor?.uuid ?? "", sourceTokenId: sourceToken.id,
        topology: placement.footprint.topology, fields: placement.footprint.fields, shape: String(area.shape),
        size: Number(area.size?.value) || 0, attached, band,
        persistence: { oncePerTurn: persistence.oncePerTurn !== false, concentration: persistence.concentration === true,
            duration: persistence.duration ?? null, triggers: persistence.triggers ?? [] },
        createdAt: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : null,
        applied: {}
    };
    return {
        name: flag.label,
        ...(color === undefined ? {} : { color }),
        shapes: [{ type: "grid", offsets }],
        elevation: { bottom: band.bottom, top: band.top },
        ...(sourceToken.level ? { levels: [sourceToken.level] } : {}),
        attachment: { token: attached ? sourceToken.id : null },
        // Everyone sees a known hazard; V14's default would show it only on the Regions layer.
        visibility: globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
        highlightMode: "coverage",
        flags: { wildpath: { area: flag } }
    };
}
/** The fields an area covers now: an emanation is recomputed around its caster's current footprint. */
export function areaFields(flag, scene) {
    if (!flag.attached)
        return flag.fields;
    const caster = flag.sourceTokenId ? scene.tokens.get(flag.sourceTokenId) : null;
    if (!caster)
        return [];
    const footprint = createFoundryV14TacticalGridAdapter({ scene }).tokenToFootprint(caster);
    if (!footprint.ok || !footprint.footprint)
        return [];
    return reachFootprint({ source: footprint.footprint, reachDistance: flag.size, gridDistance: scene.grid.distance }).fields;
}
/** Whether a Token stands in an area: any of its fields is covered and its height overlaps the area's band. */
export function areaCovers(flag, token, { fields = null, position = null } = {}) {
    if (token.id === flag.sourceTokenId && flag.attached)
        return false; // an emanation surrounds its caster
    const scene = token.parent;
    const covered = new Set((fields ?? areaFields(flag, scene)).map(field => keyOf(field, flag.topology)));
    if (!covered.size)
        return false;
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const footprint = adapter.tokenToFootprint(token, position ? { position } : {});
    if (!footprint.ok || !footprint.footprint?.fields.some(field => covered.has(keyOf(field, flag.topology))))
        return false;
    const feet = Number(position?.elevation ?? token.elevation ?? 0);
    const head = feet + ((Number(token.depth) || 0) * scene.grid.distance);
    return ((flag.band.bottom === null) || (head >= flag.band.bottom)) && ((flag.band.top === null) || (feet <= flag.band.top));
}
/** Every lasting area on a Scene, with its Region. */
export function sceneAreas(scene) {
    return [...scene.regions].flatMap(region => region.flags?.wildpath?.area ? [{ region, flag: region.flags.wildpath.area }] : []);
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
export function createFoundryPersistentAreas({ game, coordinator, resolveAction, logger = globalThis.console }) {
    let sequence = 0;
    async function create({ options }) {
        const placement = options.persistentArea;
        if (!placement)
            return null;
        const token = game.scenes?.get(placement.sceneId)?.tokens.get(placement.sourceTokenId) ?? null;
        if (!token)
            return null;
        const data = persistentAreaRegionData({ placement, sourceToken: token, combat: game.combat ?? null, color: game.user.color });
        const [region] = await token.parent.createEmbeddedDocuments("Region", [data]);
        return region ?? null;
    }
    async function apply(region, flag, token, event) {
        const triggers = flag.persistence.triggers.filter(trigger => trigger.on.includes(event));
        if (!triggers.length || !token.actor)
            return [];
        const key = turnKey(game.combat);
        if (flag.persistence.oncePerTurn && key && (flag.applied[token.id] === key))
            return [];
        // Recorded before resolving: an effect that moves the creature must not re-enter the same area this turn.
        if (key)
            await region.update({ [`flags.wildpath.area.applied.${token.id}`]: key });
        const results = [];
        for (const trigger of triggers) {
            const action = { id: String(trigger.action.id), uuid: null, type: "action", name: String(trigger.action.label ?? flag.label),
                system: { definition: { ...trigger.action, targeting: { type: "single", required: true, count: 1 } } } };
            const resolved = await resolveAction({ intent: { actorRef: flag.sourceActorRef,
                    source: flag.sourceTokenId ? { tokenId: flag.sourceTokenId, sceneId: token.parent.id } : {},
                    targetRefs: [{ actorRef: token.actor.uuid, tokenId: token.id, sceneId: token.parent.id }] },
                senderUserId: game.user.id, action });
            if (!resolved.ok) {
                logger.warn("Wild Path | A lasting area could not resolve its effect", resolved.reason ?? resolved);
                continue;
            }
            let finish = () => { };
            const finished = new Promise(resolve => { finish = resolve; });
            const hosted = await coordinator.resolveAuthorityAction({ resolutionId: `area:${region.id}:${token.id}:${++sequence}`,
                resolved, onComplete: ({ state }) => finish(state) });
            const terminal = ["completed", "failed", "cancelled"].includes(String(hosted.state?.status));
            results.push((hosted.ok || terminal) ? await finished : hosted.state ?? { status: "failed" });
        }
        return results;
    }
    /** A combatant's turn starts or ends: every area it stands in answers that event. */
    async function onTurn(event, { combatant }) {
        const token = combatant?.token ?? null;
        if (!token?.parent?.regions)
            return [];
        const applied = [];
        for (const { region, flag } of sceneAreas(token.parent)) {
            if (areaCovers(flag, token))
                applied.push(...await apply(region, flag, token, event));
        }
        return applied;
    }
    /** Areas a Token enters by standing on `position` after `previous`: covered now, not covered before. */
    function entered(token, { previous, position }) {
        return sceneAreas(token.parent).filter(({ flag }) => flag.persistence.triggers.some(trigger => trigger.on.includes(AREA_EVENTS.ENTERED))
            && areaCovers(flag, token, { position }) && !areaCovers(flag, token, { position: previous }));
    }
    return { create, apply, onTurn, entered };
}

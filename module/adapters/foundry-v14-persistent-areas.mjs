import { createFoundryV14TacticalGridAdapter, gridFieldToFoundryCenterPoint, gridFieldToFoundryOffset } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint, fieldKey } from "../helpers/grid-footprints.mjs";
import { AREA_SHAPES } from "../helpers/tactical-areas.mjs";
import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
/** The Token an attached area surrounds and follows: the object it was cast on, else its caster. */
const anchorOf = (flag) => flag.anchorTokenId ?? flag.sourceTokenId;
export const AREA_EVENTS = Object.freeze({ ENTERED: "area.entered", EXITED: "area.exited", TURN_STARTED: "turn.started",
    TURN_ENDED: "turn.ended" });
const answers = (flag, event) => flag.persistence.triggers.some(trigger => trigger.on.includes(event));
const reachFootprint = createReachFootprint;
const keyOf = fieldKey;
const toOffset = gridFieldToFoundryOffset;
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
            duration: persistence.duration ?? null, triggers: persistence.triggers ?? [], light: persistence.light ?? null },
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
    return reachFootprint({ source: footprint.footprint, reachDistance: flag.size, gridDistance: scene.grid.distance }).fields;
}
/** Whether a Token stands in an area: any of its fields is covered and its height overlaps the area's band. */
export function areaCovers(flag, token, { fields = null, position = null } = {}) {
    if ((token.id === anchorOf(flag)) && flag.attached)
        return false; // an emanation surrounds its caster (or object)
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
export function sceneAreas(scene) {
    return [...(scene.regions ?? [])].flatMap(region => region.flags?.wildpath?.area ? [{ region, flag: region.flags.wildpath.area }] : []);
}
/**
 * Whether an area's duration has run out at the start of this combat turn: N rounds after the turn it was
 * created on. Outside combat, or in another combat, rounds do not pass.
 */
export function areaExpired(flag, combat) {
    const rounds = Number(flag.persistence.duration?.value);
    const created = flag.createdAt;
    if (!combat || !created || (created.combatId !== combat.id) || !(rounds > 0))
        return false;
    const end = created.round + rounds;
    return (combat.round > end) || ((combat.round === end) && ((combat.turn ?? 0) >= (created.turn ?? 0)));
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
export function createFoundryPersistentAreas({ game, coordinator, resolveAction, logger = globalThis.console, fromUuid = null }) {
    let sequence = 0;
    async function create({ options, state }) {
        const placement = options.persistentArea;
        if (!placement)
            return null;
        const token = game.scenes?.get(placement.sceneId)?.tokens.get(placement.sourceTokenId) ?? null;
        if (!token)
            return null;
        const data = persistentAreaRegionData({ placement, sourceToken: token, combat: game.combat ?? null, color: game.user.color });
        const flag = data.flags.wildpath.area;
        const persistence = (placement.definition.area?.persistence ?? {});
        flag.castLevel = state?.configuration?.castingLevel ?? flag.persistence.light?.spellLevel ?? null;
        // Cast on an object (Daylight, Darkness): the area surrounds the Token at its center and goes where it goes.
        const chosen = persistence.onObject && (state?.configuration?.choices ?? []).some(choice => (choice.id === persistence.onObject)
            && (choice.value === true));
        const object = chosen ? tokenAt(token.parent, areaCenter(flag, token.parent)) : null;
        if (object)
            Object.assign(flag, { attached: true, anchorTokenId: object.id }), data.attachment = { token: object.id };
        await dispelOpposed(token.parent, flag);
        const [region] = await token.parent.createEmbeddedDocuments("Region", [data]);
        if (region && data.flags.wildpath.area.persistence.concentration)
            await markConcentration(region, token, data.name);
        const light = data.flags.wildpath.area.persistence.light;
        if (region && light)
            await shedLight(region, token.parent, data.flags.wildpath.area, light);
        return region ?? null;
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
     * 2024 Daylight and Darkness: an area whose light `dispels` ends each overlapping area of the opposite kind (darkness
     * for light, light for darkness) whose spell was cast at that level or lower.
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
            if (areaFields(other.flag, scene).some(field => covered.has(keyOf(field, other.flag.topology))))
                await other.region.delete();
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
    async function afterResolution({ state }) {
        const broken = new Set((state?.results?.concentrationResolution?.checks?.breakEvents ?? [])
            .map(event => event.sourceRef ?? event.ref).filter(Boolean));
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
        const uuid = region.flags?.wildpath?.area?.concentrationEffect;
        if (!uuid)
            return;
        const effect = await fromUuid?.(uuid);
        await effect?.delete();
    }
    function isActiveGM() {
        return game.users?.activeGM?.id === game.user.id;
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
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `area:${region.id}:${token.id}:${++sequence}`, definition: trigger.action, label: flag.label,
                actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? { tokenId: flag.sourceTokenId, sceneId: token.parent.id } : {},
                target: { actorRef: token.actor.uuid, tokenId: token.id, sceneId: token.parent.id } });
            if (state)
                results.push(state);
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
            // An area whose rounds have run out is gone before anyone starts a turn in it.
            if ((event === AREA_EVENTS.TURN_STARTED) && areaExpired(flag, game.combat)) {
                await region.delete();
                continue;
            }
            if (areaCovers(flag, token))
                applied.push(...await apply(region, flag, token, event));
        }
        return applied;
    }
    /**
     * Areas a Token enters by stepping from `previous` to `position` (covered after, not before), or with
     * `area.exited` leaves (covered before, not after). Only areas that answer that event count.
     */
    function crossed(token, { previous, position }, event) {
        const [inside, outside] = event === AREA_EVENTS.EXITED ? [previous, position] : [position, previous];
        return sceneAreas(token.parent).filter(({ flag }) => answers(flag, event)
            && areaCovers(flag, token, { position: inside }) && !areaCovers(flag, token, { position: outside }));
    }
    const entered = (token, step) => crossed(token, step, AREA_EVENTS.ENTERED);
    const exited = (token, step) => crossed(token, step, AREA_EVENTS.EXITED);
    /**
     * Creatures an aura newly covers as its caster steps from `previous` to `position` (the aura enters them),
     * and creatures it stops covering (they exit it), each with that event.
     */
    function swept(owner, { previous, position }) {
        const scene = owner.parent;
        return sceneAreas(scene).filter(({ flag }) => flag.attached && (anchorOf(flag) === owner.id))
            .flatMap(({ region, flag }) => {
            const before = areaFields(flag, scene, { position: previous });
            const after = areaFields(flag, scene, { position });
            return [AREA_EVENTS.ENTERED, AREA_EVENTS.EXITED].filter(event => answers(flag, event)).map(event => {
                const [inside, outside] = event === AREA_EVENTS.EXITED ? [before, after] : [after, before];
                const tokens = [...scene.tokens].filter(token => (token.id !== owner.id)
                    && areaCovers(flag, token, { fields: inside }) && !areaCovers(flag, token, { fields: outside }));
                return { region, flag, tokens, event };
            });
        }).filter(entry => entry.tokens.length);
    }
    /** Whether any lasting area on the Scene answers entering or leaving it; moves there are then checkpointed per step. */
    function hasCrossingAreas(scene) {
        return sceneAreas(scene).some(({ flag }) => answers(flag, AREA_EVENTS.ENTERED) || answers(flag, AREA_EVENTS.EXITED));
    }
    return { create, apply, onTurn, entered, exited, swept, hasCrossingAreas, afterResolution, onEffectDeleted, onRegionDeleted };
}

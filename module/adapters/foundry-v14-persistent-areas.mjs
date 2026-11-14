import { createFoundryV14TacticalGridAdapter, foundryOffsetToGridField, gridFieldToFoundryCenterPoint, gridFieldToFoundryOffset } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint, fieldDistance, fieldKey, footprintDistance } from "../helpers/grid-footprints.mjs";
import { AREA_SHAPES } from "../helpers/tactical-areas.mjs";
import { damageExpressionOf } from "../helpers/action-definitions.mjs";
import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
import { difficultTerrainBehavior } from "./foundry-v14-terrain.mjs";
import { combatOf } from "./foundry-v14-creature-tokens.mjs";
import { damageTaken } from "../resolvers/action-pipeline-resolver.mjs";
/** The Token an attached area surrounds and follows: the object it was cast on, else its caster. */
const anchorOf = (flag) => flag.anchorTokenId ?? flag.sourceTokenId;
export const AREA_EVENTS = Object.freeze({ ENTERED: "area.entered", EXITED: "area.exited", MOVED: "area.moved",
    TURN_STARTED: "turn.started", TURN_ENDED: "turn.ended" });
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
const releases = (flag) => flag.persistence.triggers.some(trigger => (trigger.action.effects ?? []).some(leavesArea));
/** Whether an area answers `event`: a trigger on it, or for leaving, effects that end on leaving (release). */
const answers = (flag, event) => flag.persistence.triggers.some(trigger => trigger.on.includes(event))
    || ((event === AREA_EVENTS.EXITED) && releases(flag));
/**
 * Its trigger's Action, each effect that ends on leaving naming its Region (`metadata.regionId`), so release finds it.
 * Not when its creature already has that condition from elsewhere (a Net's Restrained): a condition is one effect, so
 * leaving the webs must not end the Net's hold too.
 */
const stamped = (action, region, actor) => {
    const heldElsewhere = (effect) => [...(actor.effects ?? [])].some(held => (held.system?.type === effect.conditionId)
        && (held.flags?.wildpath?.conditionEffect?.metadata?.regionId !== region.id));
    return (action.effects ?? []).some(leavesArea) ? { ...action, effects: action.effects.map(effect => ((leavesArea(effect) && !heldElsewhere(effect)) ? { ...effect, metadata: { ...effect.metadata, regionId: region.id } } : effect)) }
        : action;
};
const reachFootprint = createReachFootprint;
const keyOf = fieldKey;
const distanceOf = fieldDistance;
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
            duration: persistence.duration ?? null, triggers: persistence.triggers ?? [], light: persistence.light ?? null,
            ...(persistence.affects === "enemies" ? { affects: "enemies" } : {}),
            ...(persistence.obscures === "heavily" ? { obscures: "heavily" } : {}),
            ...(persistence.budget ? { budget: { damage: Number(persistence.budget.damage) || 0 } } : {}) },
        createdAt: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : null,
        applied: {},
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
/** Whether a Token stands in a Heavily Obscured lasting area (Fog Cloud, Cloudkill): no sight sees it, or out. */
export function heavilyObscuredAt(token) {
    return Boolean(token?.parent) && sceneAreas(token.parent).some(({ flag }) => (flag.persistence?.obscures === "heavily")
        && areaCovers(flag, token));
}
export function sceneAreas(scene) {
    return [...(scene.regions ?? [])].flatMap(region => region.flags?.wildpath?.area ? [{ region, flag: region.flags.wildpath.area }] : []);
}
/** The lasting area a creature (`actorRef`) left with the Action `of` (its definition id), on `scene`; null when none. */
export function ownArea(scene, { of, actorRef }) {
    return sceneAreas(scene).find(({ flag }) => (flag.actionDefinitionId === of) && (flag.sourceActorRef === actorRef)) ?? null;
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
export function createFoundryPersistentAreas({ game, coordinator, resolveAction, logger = globalThis.console, fromUuid = null, dismissSummon = null }) {
    let sequence = 0;
    // Each budget area's spend in flight (apply), so two never read its dealt damage at once.
    const spending = new Map();
    async function create({ options, state }, { anchor = null } = {}) {
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
            color: game.user.color });
        const flag = data.flags.wildpath.area;
        const persistence = (placement.definition.area?.persistence ?? {});
        // A spell's, so Dispel Magic can end it: the level it was cast at, else its own.
        const spellLevel = Number(placement.definition.metadata?.spellLevel);
        flag.castLevel = state?.configuration?.castingLevel ?? flag.persistence.light?.spellLevel
            ?? (Number.isFinite(spellLevel) ? spellLevel : null);
        // Cast on an object (Daylight, Darkness): the area surrounds the Token at its center and goes where it goes.
        const chosen = persistence.onObject && (state?.configuration?.choices ?? []).some(choice => (choice.id === persistence.onObject)
            && (choice.value === true));
        const object = anchor ?? (chosen ? tokenAt(token.parent, areaCenter(flag, token.parent)) : null);
        if (object)
            Object.assign(flag, { attached: true, anchorTokenId: object.id }), data.attachment = { token: object.id };
        // One a summon carries lasts as its summon does: no cast level of its own, so Dispel Magic does not end it alone (Q31:
        // ending its spell, the summon, with Dispel Magic is by hand).
        if (anchor)
            flag.castLevel = null;
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
     * After an Action that summons (`summon.area`: Flaming Sphere, Guardian of Faith, Conjure Animals): each summoned Token
     * carries a lasting area of its caster's, attached to it, so it goes where the Token goes and ends with it (V14 deletes
     * a Token's attached Regions). Its triggers resolve with the caster as source: its spell save DC, its slot's dice.
     */
    async function carry({ state }, tokens = []) {
        const configured = state?.configuration?.effectiveDefinition;
        const definition = (configured ?? state?.actionDefinition ?? null);
        const area = definition?.summon?.area;
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
            // Drawn as it is worked out: the fields within its size around the Token (areaFields), not the Token's own.
            const fields = areaFields({ attached: true, anchorTokenId: token.id, size: Number(area.size?.value) || 0 }, scene);
            const region = await create({ options: { persistentArea: { footprint: { topology: footprint.footprint.topology, fields },
                        definition: { ...definition, area }, sourceTokenId: casterId, sceneId: scene.id } } }, { anchor: token });
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
        // What it held only while in it ends with it (Web's Restrained once the webs are gone).
        if (region.flags?.wildpath?.area && releases(region.flags.wildpath.area)) {
            for (const token of region.parent?.tokens ?? [])
                await release(region, token);
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
    /** What the area gave `token`'s creature only while in it (stamped with its Region) ends: it left, or the area ended. */
    async function release(region, token) {
        const actor = token.actor;
        const ids = [...(actor?.effects ?? [])].filter(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId === region.id)
            .map(effect => effect.id);
        if (ids.length)
            await actor?.deleteEmbeddedDocuments?.("ActiveEffect", ids);
        return ids;
    }
    // Keyed on the creature's own combat, as onTurn is, not the one the GM's tracker shows. `feet`: for `area.moved`, how
    // far the creature moved in the area on that step (moved).
    async function apply(region, flag, token, event, { feet = 0, key = turnKey(combatOf(token, game) ?? game.combat) } = {}) {
        if (event === AREA_EVENTS.EXITED)
            await release(region, token);
        // Spent (a budget dealt in all): nothing more, though a sweep listed more creatures before it ended (its live flag).
        const budget = Number(flag.persistence.budget?.damage) || 0;
        if (budget && ((Number(region.flags?.wildpath?.area?.dealt) || 0) >= budget))
            return [];
        // A creature its rules leave untouched by the area's spell (`Unaffected`; its caster's own excepted) is left out.
        const unaffected = (trigger) => (token.actor?.uuid !== flag.sourceActorRef) && !!token.actor?.unaffectingRule?.(trigger.action);
        // How many times a trigger acts: once, or on a move once for every `per` feet of it (none for less).
        const times = (trigger) => (((event === AREA_EVENTS.MOVED) && trigger.per) ? Math.floor(feet / trigger.per) : 1);
        const triggers = flag.persistence.triggers.map((trigger, index) => ({ trigger, index }))
            .filter(({ trigger }) => trigger.on.includes(event) && !unaffected(trigger) && (times(trigger) > 0));
        if (!triggers.length || !token.actor)
            return [];
        // An area that affects only its caster's enemies (Spirit Guardians) leaves the caster and its side alone.
        if (flag.persistence.affects === "enemies") {
            const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
            if (!caster || (caster.id === token.id) || (caster.disposition === token.disposition))
                return [];
        }
        // Moving in an area acts on every step, whatever once per turn says, and spends none of it (Spike Growth).
        if (event === AREA_EVENTS.MOVED)
            key = null;
        // A trigger with `once: "turn"` keeps its own record (`<token id>-<index>`), spending and spent by no other trigger;
        // the rest share the area's (2026-11-14).
        const slot = ({ trigger, index }) => (trigger.once === "turn") ? `${token.id}-${index}` : token.id;
        const due = triggers.filter(entry => !(key && ((entry.trigger.once === "turn") || flag.persistence.oncePerTurn)
            && (flag.applied[slot(entry)] === key)));
        if (!due.length)
            return [];
        // Recorded before resolving: an effect that moves the creature must not re-enter the same area this turn.
        if (key)
            await region.update(Object.fromEntries(due.map(entry => [`flags.wildpath.area.applied.${slot(entry)}`, key])));
        // Cover from the Token it surrounds when that is not its caster (a summon's, an object's), not from its far-off caster.
        // shortcut: a placed area's cover is still from its caster, upgrade with its point of origin.
        const anchor = (flag.attached && (anchorOf(flag) !== flag.sourceTokenId)) ? token.parent.tokens.get(anchorOf(flag) ?? "") : null;
        const origin = anchor?.getCenterPoint?.() ?? null;
        const results = [];
        for (const { trigger } of due) {
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `area:${region.id}:${token.id}:${++sequence}`,
                definition: repeatedDamage(stamped(trigger.action, region, token.actor), times(trigger)), label: flag.label,
                actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? { tokenId: flag.sourceTokenId, sceneId: token.parent.id } : {},
                target: { actorRef: token.actor.uuid, tokenId: token.id, sceneId: token.parent.id }, origin });
            if (state)
                results.push(state);
        }
        if (budget) {
            // One after another per area: a spend whose update is still on its way to the server is never read stale by the next.
            const queued = (spending.get(region.id) ?? Promise.resolve()).then(() => spend(region, token.parent, results));
            spending.set(region.id, queued.catch(() => undefined));
            await queued;
        }
        return results;
    }
    /**
     * A budget's area adds the damage its completed runs dealt (Temporary Hit Points and overkill included, Q29; a failed or
     * cancelled run changed no Hit Points), queued per area (apply); at its budget it ends: a summon carrying it is dismissed
     * (its Region goes with its Token), any other area's Region is deleted. One already ended by an earlier spend is left alone.
     * shortcut: a concentration summon dismissed so keeps its caster's concentration marker, as one killed does today;
     * upgrade when a summon's dismissal ends that marker.
     */
    async function spend(region, scene, results) {
        const flag = region.flags.wildpath.area;
        const budget = Number(flag.persistence.budget?.damage) || 0;
        if ((Number(flag.dealt) || 0) >= budget)
            return;
        const dealt = (Number(flag.dealt) || 0) + results.filter(state => state?.status === "completed")
            .reduce((sum, state) => sum + damageTaken(state), 0);
        await region.update({ "flags.wildpath.area.dealt": dealt });
        if (dealt < budget)
            return;
        const carrier = flag.anchorTokenId ? scene.tokens.get(flag.anchorTokenId)
            : undefined;
        if (carrier?.flags?.wildpath?.summon && dismissSummon)
            await dismissSummon(scene, [carrier.id]);
        else
            await region.delete();
    }
    /**
     * A combatant's turn starts or ends: every area it stands in answers that event, once per turn counted in that turn.
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
        for (const { region, flag } of sceneAreas(token.parent)) {
            // An area whose rounds have run out is gone before anyone starts a turn in it.
            // The turn's own combat, not the one the GM's tracker shows.
            if ((event === AREA_EVENTS.TURN_STARTED) && areaExpired(flag, combatant?.combat)) {
                await region.delete();
                continue;
            }
            if (areaCovers(flag, token))
                applied.push(...await apply(region, flag, token, event, { key }));
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
     * Areas answering `area.moved` that a Token's step from `previous` to `position` moves it in, each with the feet moved
     * there: one grid distance for each space of the step that ends in the area, so a step in from outside counts only
     * its part inside and a step out counts nothing. Distance as movement measures it (any step to an adjacent space is
     * one grid distance, diagonals too); Difficult Terrain's extra cost is not distance moved.
     */
    function moved(token, { previous, position }) {
        const scene = token.parent;
        const areas = sceneAreas(scene).filter(({ flag }) => answers(flag, AREA_EVENTS.MOVED));
        if (!areas.length)
            return [];
        const adapter = createFoundryV14TacticalGridAdapter({ scene });
        const anchor = (at) => adapter.tokenToFootprint(token, { position: at });
        const [from, to] = [anchor(previous), anchor(position)];
        const spaces = (from.ok && to.ok && from.anchor && to.anchor) ? distanceOf(from.anchor, to.anchor, to.topology) : 0;
        // shortcut: a step of several spaces is cut into equal parts along a straight line; a checkpointed drag moves one
        // space a step, so this only matters for a step Foundry did not split.
        const along = Array.from({ length: spaces }, (_, index) => ({ ...position, ...Object.fromEntries(["x", "y", "elevation"]
                .filter(key => Number.isFinite(Number(position[key])) && Number.isFinite(Number(previous[key])))
                .map(key => [key, Number(previous[key]) + ((Number(position[key]) - Number(previous[key])) * (index + 1) / spaces)])) }));
        return areas.map(({ region, flag }) => ({ region, flag,
            feet: along.filter(at => areaCovers(flag, token, { position: at })).length * scene.grid.distance }))
            .filter(entry => entry.feet > 0);
    }
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
    /** Whether any lasting area on the Scene answers entering, leaving or moving in it; moves there are then checkpointed per step. */
    function hasCrossingAreas(scene) {
        return sceneAreas(scene).some(({ flag }) => [AREA_EVENTS.ENTERED, AREA_EVENTS.EXITED, AREA_EVENTS.MOVED]
            .some(event => answers(flag, event)));
    }
    /**
     * A placed lasting area now covers `fields` (moved by its caster's Action, or dragged by the GM). They become its
     * fields, and each creature newly inside it is entered ("when the Cylinder moves into its space"), once per turn.
     * Its triggers, cast level included, go with it.
     */
    async function relocate(region, fields, { drawn = false } = {}) {
        const flag = region.flags?.wildpath?.area;
        const scene = region.parent;
        if (!flag || flag.attached || !scene)
            return [];
        const before = new Set([...scene.tokens].filter(token => areaCovers(flag, token)).map(token => token.id));
        const offsets = fields.map(field => toOffset(field, { grid: scene.grid }).offset).filter(Boolean);
        await region.update({ ...(drawn ? {} : { shapes: [{ type: "grid", offsets }] }), "flags.wildpath.area.fields": fields }, { wildpath: { areaMove: true } });
        const moved = { ...flag, fields };
        const applied = [];
        for (const token of [...scene.tokens].filter(token => !before.has(token.id) && areaCovers(moved, token))) {
            if (answers(moved, AREA_EVENTS.ENTERED))
                applied.push(...await apply(region, moved, token, AREA_EVENTS.ENTERED));
        }
        // A creature the area moved off is no longer in it: what it held only while in it ends.
        if (releases(moved)) {
            for (const token of [...scene.tokens].filter(token => before.has(token.id) && !areaCovers(moved, token)))
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
    /** The GM dragged a lasting area's Region: its fields follow the cells now drawn. */
    async function onRegionUpdated(region, changed, operation = {}) {
        if (!isActiveGM() || operation?.wildpath?.areaMove || !changed?.shapes || !region.parent)
            return [];
        const offsets = region.shapes?.find(shape => shape.type === "grid")?.offsets ?? [];
        const fields = offsets.map(offset => foundryOffsetToGridField(offset, { scene: region.parent }).field).filter((field) => !!field);
        return fields.length ? relocate(region, fields, { drawn: true }) : [];
    }
    return { create, carry, apply, onTurn, entered, exited, moved, swept, hasCrossingAreas, afterResolution, onEffectDeleted, onRegionDeleted,
        move, onRegionUpdated };
}

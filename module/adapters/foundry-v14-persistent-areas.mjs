import { createFoundryV14TacticalGridAdapter, foundryOffsetToGridField, gridFieldToFoundryCenterPoint, gridFieldToFoundryOffset } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint, fieldDistance, fieldKey, footprintDistance } from "../helpers/grid-footprints.mjs";
import { AREA_SHAPES } from "../helpers/tactical-areas.mjs";
import { customEffectId, damageExpressionOf } from "../helpers/action-definitions.mjs";
import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
import { difficultTerrainBehavior } from "./foundry-v14-terrain.mjs";
import { combatOf, combatStart, deadCreature, roundsPassed } from "./foundry-v14-creature-tokens.mjs";
import { damageTaken } from "../resolvers/action-pipeline-resolver.mjs";
import { ineligibleTarget } from "./foundry-v14-senses.mjs";
import { AUTOMATION_EVENT_TYPES } from "../helpers/automation-events.mjs";
import { parseEntityRef } from "../helpers/entity-refs.mjs";
import { sharingSpace } from "./foundry-v14-occupancy.mjs";
import { brokenConcentrationTargets } from "../helpers/forced-movement.mjs";
/** The Token an attached area surrounds and follows: the object it was cast on, else its caster. */
const anchorOf = (flag) => flag.anchorTokenId ?? flag.sourceTokenId;
export const AREA_EVENTS = Object.freeze({ ENTERED: "area.entered", EXITED: "area.exited", MOVED: "area.moved",
    RAMMED: "area.rammed", TURN_STARTED: "turn.started", TURN_ENDED: "turn.ended" });
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
    const gated = (effect) => (effect.saveOutcomePolicy ?? effect.savePolicy ?? effect.checkOutcomePolicy
        ?? effect.application?.saveOutcomePolicy) != null;
    const effects = (action.effects ?? []).filter(effect => leavesArea(effect) && !gated(effect));
    return (effects.length && !action.attack) ? { schemaVersion: action.schemaVersion, id: action.id, label: action.label,
        costs: { allOf: [] }, ...(action.tags ? { tags: action.tags } : {}), effects } : null;
};
const releases = (flag) => flag.persistence.triggers.some(trigger => (trigger.action.effects ?? []).some(leavesArea));
/** Whether an area answers `event`: a trigger on it, or for leaving, effects that end on leaving (release). */
const answers = (flag, event) => flag.persistence.triggers.some(trigger => trigger.on.includes(event))
    || ((event === AREA_EVENTS.EXITED) && releases(flag));
/**
 * Its trigger's Action, each effect that ends on leaving naming its Region (`metadata.regionId`), so release finds it.
 * A condition is its own instance per source (Q19), so the webs' Restrained is stamped beside a Net's and leaving ends only
 * the webs'. A custom effect is still one effect (Q93 (d)): not stamped when its creature already has it from elsewhere,
 * known by its status, its custom id (it has no condition type, so any other custom effect would otherwise look like it).
 */
const stamped = (action, region, actor) => {
    const heldElsewhere = (effect) => (effect.type === "effect") && [...(actor.effects ?? [])].some(held => [...(held.statuses ?? [])].includes(customEffectId(String(action.id), effect))
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
            ...(OBSCURITIES.includes(persistence.obscures) ? { obscures: persistence.obscures } : {}),
            ...(persistence.budget ? { budget: { damage: Number(persistence.budget.damage) || 0 } } : {}) },
        createdAt: combatStart(combat),
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
        await dispelOpposed(token.parent, flag);
        const [region] = await token.parent.createEmbeddedDocuments("Region", [data]);
        if (region && data.flags.wildpath.area.persistence.concentration)
            await markConcentration(region, token, data.name);
        const light = data.flags.wildpath.area.persistence.light;
        if (region && light)
            await shedLight(region, token.parent, data.flags.wildpath.area, light);
        // What it holds while in it whatever the save is on each creature it appears around (heldOnly: Spirit Guardians' Half Speed).
        if (region && flag.persistence.triggers.some(trigger => trigger.on.includes(AREA_EVENTS.ENTERED) && heldOnly(trigger.action))) {
            for (const covered of [...token.parent.tokens].filter(entry => areaCovers(flag, entry))) {
                await apply(region, region.flags?.wildpath?.area ?? flag, covered, AREA_EVENTS.ENTERED, { key: null, appearing: true });
            }
        }
        // A caster with no combat turn to wait for (outside combat, or no Combatant): what its area does once on that turn
        // (`once: "area"`) it does now; a repeating caster-turn trigger waits for combat, as other turn triggers do.
        if (region && !combatOf(token, game) && flag.persistence.triggers.some(trigger => (trigger.turnOf === "source") && (trigger.once === "area"))) {
            for (const event of TURN_EVENTS)
                await runSourceTriggers(event, token, null, { region, creating: true });
        }
        return region ?? null;
    }
    /**
     * After an Action that summons (`summon.area`: Flaming Sphere, Guardian of Faith, Conjure Animals): each summoned Token
     * carries a lasting area of its caster's, attached to it, so it goes where the Token goes and ends with it (V14 deletes
     * a Token's attached Regions). Its triggers resolve with the caster as source: its spell save DC, its slot's dice. It
     * has its spell's cast level (none with `persistence.dispellable: false`), so Dispel Magic (or 2024 Darkness over its
     * light) ends it, and with it the spell (end, Q31); Dispel Magic on the summoned Token still dismisses it and its area.
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
        const carrier = (flag?.anchorTokenId && scene) ? scene.tokens.get(flag.anchorTokenId) : undefined;
        const summon = carrier?.flags?.wildpath?.summon;
        if (scene && summon && (summon.actionId === flag?.actionDefinitionId) && dismissSummon)
            await dismissSummon(scene, [carrier.id]);
        else
            await region.delete();
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
    async function apply(region, flag, token, event, { feet = 0, key = turnKey(combatOf(token, game) ?? game.combat), appearing = false } = {}) {
        if (event === AREA_EVENTS.EXITED)
            await release(region, token);
        const runs = await dueRuns(region, flag, [token], event, { feet, key, appearing });
        const results = [];
        for (const run of runs) {
            const state = await runOne(region, flag, run);
            if (state)
                results.push(state);
        }
        if (runs.length)
            await charge(region, flag, results);
        return results;
    }
    /**
     * The runs `event` makes in an area for each of `tokens`, after the area's creature filters and once records; the
     * records are written (one update) before anything resolves, as an effect that moves a creature must not re-enter the
     * same area this turn. `sourceTurn`: its caster's turn (runSourceTriggers), so only its `turnOf: "source"` triggers
     * answer a turn event, a self-targeted one on its caster and any other on each creature the area covers; on any other
     * turn only the rest do. `creating`: only its `once: "area"` triggers (create).
     */
    async function dueRuns(region, flag, tokens, event, { feet = 0, key = null, appearing = false, sourceTurn = false, creating = false } = {}) {
        // Spent (a budget dealt in all): nothing more, though a sweep listed more creatures before it ended (its live flag).
        const budget = Number(flag.persistence.budget?.damage) || 0;
        if (budget && ((Number(region.flags?.wildpath?.area?.dealt) || 0) >= budget))
            return [];
        // Moving in an area acts on every step, whatever once per turn says, and spends none of it (Spike Growth).
        if (event === AREA_EVENTS.MOVED)
            key = null;
        const runs = [];
        const records = {};
        for (const token of tokens) {
            // A creature its rules leave untouched by the area's spell (`Unaffected`; its caster's own excepted) is left out.
            const unaffected = (trigger) => (token.actor?.uuid !== flag.sourceActorRef) && !!token.actor?.unaffectingRule?.(trigger.action);
            // How many times a trigger acts: once, or on a move once for every `per` feet of it (none for less).
            const times = (trigger) => (((event === AREA_EVENTS.MOVED) && trigger.per) ? Math.floor(feet / trigger.per) : 1);
            // One its trigger's `targeting.eligible` leaves out (2024 Conjure Animals' "a creature you can see": `seenBySource`,
            // Q30) is left alone by that trigger, on every event, and spends none of its once per turn.
            const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
            const eligible = (trigger) => !ineligibleTarget(trigger.action.targeting?.eligible, token, caster);
            // On its caster's turn a self-targeted trigger acts on its caster, wherever it stands, as the area's own act.
            const self = (trigger) => sourceTurn && selfTargeted(trigger.action);
            const whose = (trigger) => !TURN_EVENTS.includes(event) || ((trigger.turnOf === "source") === sourceTurn);
            const here = (trigger) => !sourceTurn || (self(trigger) ? (token.id === flag.sourceTokenId) : areaCovers(flag, token));
            // An area that affects only its caster's enemies (Spirit Guardians) leaves the caster and its side alone.
            const spared = (flag.persistence.affects === "enemies")
                && (!caster || (caster.id === token.id) || (caster.disposition === token.disposition));
            const triggers = flag.persistence.triggers.map((trigger, index) => ({ trigger, index }))
                .filter(({ trigger }) => trigger.on.includes(event) && whose(trigger) && (!creating || (trigger.once === "area"))
                && (self(trigger) || !spared) && !unaffected(trigger) && (times(trigger) > 0) && eligible(trigger) && here(trigger));
            // A dead creature is an object: its area passes it by (an exit still releases it).
            if (!triggers.length || !token.actor || deadCreature(token.actor))
                continue;
            // A trigger with `once: "turn"` (or a self-targeted one on its caster's turn) keeps its own record
            // (`<token id>-<index>`), spending and spent by no other trigger; `once: "area"` keeps one for the whole area
            // (`area-<index>`), spent at its first run even outside combat; the rest share the area's (2026-11-14).
            const slot = ({ trigger, index }) => ((trigger.once === "area") ? `area-${index}`
                : ((trigger.once === "turn") || self(trigger)) ? `${token.id}-${index}` : token.id);
            const spent = (entry) => ((entry.trigger.once === "area") ? !!flag.applied[slot(entry)]
                : !!(key && ((entry.trigger.once === "turn") || self(entry.trigger) || flag.persistence.oncePerTurn)
                    && (flag.applied[slot(entry)] === key)));
            const due = triggers.filter(entry => !spent(entry));
            // Spent this turn, an entering still gives what it holds while in it whatever the save (heldOnly); `appearing`, only that.
            const held = triggers.map(entry => ({ ...entry, token: token, count: times(entry.trigger),
                action: (due.includes(entry) && !appearing) ? entry.trigger.action : ((event === AREA_EVENTS.ENTERED) ? heldOnly(entry.trigger.action) : null) }))
                .filter((run) => !!run.action);
            if (!held.length)
                continue;
            runs.push(...held);
            if (!appearing)
                for (const entry of due)
                    if (key || (entry.trigger.once === "area"))
                        records[slot(entry)] = key ?? "area";
        }
        if (Object.keys(records).length) {
            await region.update(Object.fromEntries(Object.entries(records).map(([slot, value]) => [`flags.wildpath.area.applied.${slot}`, value])));
        }
        return runs;
    }
    /** One trigger's Action on one creature, with the caster as source. */
    function runOne(region, flag, { token, action, count }) {
        return runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
            resolutionId: `area:${region.id}:${token.id}:${++sequence}`,
            definition: repeatedDamage(stamped(action, region, token.actor), count), label: flag.label,
            actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? { tokenId: flag.sourceTokenId, sceneId: token.parent.id } : {},
            // A lasting area's own trigger (placed, carried or an emanation): no cover against it (Q37).
            target: { actorRef: token.actor.uuid, tokenId: token.id, sceneId: token.parent.id }, noCover: true });
    }
    /** A budget's area adds what its runs dealt (spend). */
    async function charge(region, flag, results) {
        if (!(Number(flag.persistence.budget?.damage) || 0))
            return;
        // One after another per area: a spend whose update is still on its way to the server is never read stale by the next.
        const queued = (spending.get(region.id) ?? Promise.resolve()).then(() => spend(region, results));
        spending.set(region.id, queued.catch(() => undefined));
        await queued;
    }
    /**
     * Its caster's turn starts or ends (`caster`, its Token): each of its areas on the Scene answers with its
     * `turnOf: "source"` triggers, in their order. A self-targeted one acts once, on its caster; any other is one Action for
     * every creature the area covers (an aura's: one damage roll), or one per creature when it gives what it holds only
     * while in the area (`stamped` is per creature). An area an earlier trigger ended (its caster's concentration broken)
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
            const runs = await dueRuns(region, flag, [...scene.tokens], event, { key, sourceTurn: true, creating });
            const states = [];
            for (const [index, trigger] of flag.persistence.triggers.entries()) {
                const group = runs.filter(run => run.index === index);
                if (!group.length)
                    continue;
                if (ended(region, flag))
                    break;
                if ((trigger.action.effects ?? []).some(leavesArea)) {
                    for (const run of group)
                        states.push(await runOne(region, flag, run));
                }
                else {
                    states.push(await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                        resolutionId: `area:${region.id}:source-${index}:${++sequence}`, definition: trigger.action, label: flag.label,
                        actorRef: flag.sourceActorRef, source: { tokenId: caster.id, sceneId: scene.id },
                        targets: group.map(({ token }) => ({ actorRef: token.actor.uuid, tokenId: token.id, sceneId: scene.id })), noCover: true }));
                }
                // Only a completed Action's follow-ups end anything (afterCompleted); a failed or cancelled one broke nothing.
                broken ||= states.some(state => (state?.status === "completed")
                    && (brokenConcentration(state).has(`token:${caster.id}`)
                        || brokenConcentrationTargets(state).some(target => target?.tokenId === caster.id)));
            }
            const done = states.filter(Boolean);
            if (runs.length && !ended(region, flag))
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
        applied.push(...await runSourceTriggers(event, token, key));
        return applied;
    }
    /**
     * Areas a Token enters by stepping from `previous` to `position` (covered after, not before), or with
     * `area.exited` leaves (covered before, not after). Only areas that answer that event count.
     * A Token removed from the scene (removedMarker) enters nothing, but still leaves.
     */
    function crossed(token, { previous, position }, event) {
        if ((event !== AREA_EVENTS.EXITED) && removedMarker(token))
            return [];
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
     * one grid distance, diagonals too); Difficult Terrain's extra cost is not distance moved. A Token removed from the
     * scene (removedMarker) moves in none.
     */
    function moved(token, { previous, position }) {
        if (removedMarker(token))
            return [];
        const scene = token.parent;
        const areas = sceneAreas(scene).filter(({ flag }) => answers(flag, AREA_EVENTS.MOVED));
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
    return { create, carry, end, apply, onTurn, entered, exited, moved, swept, rammed, hasCrossingAreas, afterResolution, onEffectDeleted,
        onRegionDeleted, move, onRegionUpdated };
}

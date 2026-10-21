import { effectsFrom } from "../helpers/effect-sources.mjs";
import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint, footprintDistance } from "../helpers/grid-footprints.mjs";
import { WILDPATH } from "../config.mjs";
import { areaCovers } from "./foundry-v14-persistent-areas.mjs";
const reachFootprint = createReachFootprint;
/** Whether an aura of `affects` from `bearer` reaches the creature standing at `token`, by their dispositions. */
function affectsToken(affects, bearer, token) {
    if (affects === "all")
        return true;
    const relation = (bearer.disposition ?? 0) * (token.disposition ?? 0);
    return affects === "enemies" ? relation < 0 : ((relation > 0) && (bearer.disposition === token.disposition));
}
/**
 * Whether an ally of `attacker` (its disposition), other than the attacker and not Incapacitated, stands within 5 ft
 * of `target` (Pack Tactics). `footprint` is where the target stands; its Token's own when omitted.
 */
export function allyNearTarget(attacker, target, footprint = null) {
    const scene = target?.parent;
    if (!attacker || !scene)
        return false;
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const footprintOf = (token) => adapter.tokenToFootprint(token).footprint ?? null;
    const at = footprint ?? footprintOf(target);
    if (!at)
        return false;
    const conditions = WILDPATH.CONDITIONS ?? {};
    return [...scene.tokens].some(token => {
        if ((token.id === attacker.id) || (token.id === target.id) || !affectsToken("allies", attacker, token))
            return false;
        const statuses = [...(token.actor?.statuses ?? [])];
        if (!token.actor || statuses.some(status => conditions[status]?.endsConcentration))
            return false;
        const ally = footprintOf(token);
        return !!ally && (footprintDistance(ally, at) * scene.grid.distance <= 5);
    });
}
/** Whether `other` is an ally of `token` by disposition (not `token` itself). */
export function alliedTokens(token, other) {
    return !!(token && other) && (token.id !== other.id) && affectsToken("allies", token, other);
}
/**
 * The Token on `scene` that gave `effect` to its creature (the effect names its source: effect-sources.mjs), or null.
 */
export function effectGiver(effect, holder, scene) {
    return [...(scene?.tokens ?? [])].find(token => token.actor
        && effectsFrom(holder, token.actor)
            .some(entry => entry.id === effect.id)) ?? null;
}
/**
 * 2024 Help with an attack: whether `target` has a Distracted effect whose helper is an ally of `attacker` (and not the
 * attacker): that ally's attack roll against it has Advantage (`attack.helpedByAlly`).
 */
export function helpedByAlly(attacker, target) {
    const scene = attacker?.parent;
    if (!attacker || !scene || !target)
        return false;
    return [...(target.effects ?? [])].some(effect => !effect.disabled && new Set(effect.statuses ?? []).has("distracted")
        && alliedTokens(attacker, effectGiver(effect, target, scene)));
}
/** How far `other` stands from `token`, in feet, when it is `token` itself (0) or its ally by disposition; else null. */
export function allyDistance(token, other) {
    if (!token || !other)
        return null;
    if (token.id === other.id)
        return 0;
    const scene = token.parent;
    if (!scene || !affectsToken("allies", token, other))
        return null;
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const footprintOf = (each) => adapter.tokenToFootprint(each).footprint ?? null;
    const [from, to] = [footprintOf(token), footprintOf(other)];
    return (from && to) ? footprintDistance(from, to) * scene.grid.distance : null;
}
/** Whether `token` stands within `radius` feet of `bearer` (its footprint's reach; the lasting-area coverage test). */
function within(adapter, topology, scene, bearer, token, radius) {
    const footprint = adapter.tokenToFootprint(bearer);
    if (!footprint.ok || !footprint.footprint)
        return false;
    const fields = reachFootprint({ source: footprint.footprint, reachDistance: radius, gridDistance: scene.grid.distance }).fields;
    const flag = { attached: false, sourceTokenId: bearer.id, topology, size: radius, band: { bottom: null, top: null }, fields };
    return areaCovers(flag, token, { fields });
}
/**
 * The other Tokens within `radius` feet of `bearer` on its Scene (a creature's own Emanation, 2024): all of them, or
 * only its enemies (the opposite disposition: "each creature of its choice").
 */
export function tokensAround(bearer, { radius, affects = "others" }) {
    const scene = bearer?.parent;
    if (!bearer || !scene || !(Number(radius) > 0))
        return [];
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const context = adapter.getSceneContext();
    if (!context.ok || !context.context)
        return [];
    const topology = context.context.grid.topology;
    return [...scene.tokens].filter(token => (token.id !== bearer.id) && token.actor
        && ((affects !== "enemies") || affectsToken("enemies", bearer, token)) && within(adapter, topology, scene, bearer, token, Number(radius)));
}
export function createFoundryAuras() {
    /** Rule owners (`{ruleElements, source}`) the auras around `actor`'s Tokens grant it. */
    function ownersFor(actor) {
        const tokens = actor.isToken ? [actor.token].filter(Boolean) : (actor.getActiveTokens?.(false, true) ?? []);
        const owners = [];
        for (const token of tokens) {
            const scene = token.parent;
            if (!scene)
                continue;
            const adapter = createFoundryV14TacticalGridAdapter({ scene });
            const context = adapter.getSceneContext();
            if (!context.ok || !context.context)
                continue;
            for (const bearer of scene.tokens) {
                for (const aura of bearer.actor?.getAuras?.() ?? []) {
                    if (!affectsToken(aura.affects, bearer, token))
                        continue;
                    if (bearer.id === token.id) {
                        if (aura.affects === "enemies")
                            continue;
                    }
                    else if (!within(adapter, context.context.grid.topology, scene, bearer, token, aura.radius))
                        continue;
                    owners.push({ ruleElements: aura.ruleElements, source: { ...(aura.source ?? {}), aura: aura.id, bearerTokenId: bearer.id } });
                }
            }
        }
        return owners;
    }
    return { ownersFor };
}

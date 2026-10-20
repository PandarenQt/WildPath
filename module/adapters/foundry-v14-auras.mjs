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
                    else {
                        const footprint = adapter.tokenToFootprint(bearer);
                        if (!footprint.ok || !footprint.footprint)
                            continue;
                        const fields = reachFootprint({ source: footprint.footprint, reachDistance: aura.radius, gridDistance: scene.grid.distance }).fields;
                        const flag = { attached: false, sourceTokenId: bearer.id, topology: context.context.grid.topology, size: aura.radius,
                            band: { bottom: null, top: null }, fields };
                        if (!areaCovers(flag, token, { fields }))
                            continue;
                    }
                    owners.push({ ruleElements: aura.ruleElements, source: { ...(aura.source ?? {}), aura: aura.id, bearerTokenId: bearer.id } });
                }
            }
        }
        return owners;
    }
    return { ownersFor };
}

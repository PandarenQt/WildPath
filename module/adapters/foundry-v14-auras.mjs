import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { createReachFootprint } from "../helpers/grid-footprints.mjs";
import { areaCovers } from "./foundry-v14-persistent-areas.mjs";
const reachFootprint = createReachFootprint;
/** Whether an aura of `affects` from `bearer` reaches the creature standing at `token`, by their dispositions. */
function affectsToken(affects, bearer, token) {
    if (affects === "all")
        return true;
    const relation = (bearer.disposition ?? 0) * (token.disposition ?? 0);
    return affects === "enemies" ? relation < 0 : ((relation > 0) && (bearer.disposition === token.disposition));
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

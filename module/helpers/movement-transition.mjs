import { footprintDistance } from "./grid-footprints.mjs";
import { clonePlainData } from "./multiplayer-authority.mjs";
/** Observer-relative facts only. Predicates own hostility, movement kind and reaction eligibility. */
export function movementTransitionRelations(previous, proposed, observers) {
    if (new Set(observers.map(observer => observer.id)).size !== observers.length) {
        throw new Error("Movement observer identities must be unique.");
    }
    return Object.fromEntries(observers.map(observer => {
        if (!observer.id || !Number.isFinite(observer.reachFields) || observer.reachFields < 0
            || observer.footprint.topology !== previous.topology || proposed.topology !== previous.topology) {
            throw new Error("Movement observer requires an identity, matching topology and non-negative reach in fields.");
        }
        const before = footprintDistance(observer.footprint, previous);
        const after = footprintDistance(observer.footprint, proposed);
        return [observer.id, { before, after, reachFields: observer.reachFields,
                withinBefore: before <= observer.reachFields, withinAfter: after <= observer.reachFields,
                leavesReach: before <= observer.reachFields && after > observer.reachFields,
                entersReach: before > observer.reachFields && after <= observer.reachFields,
                context: clonePlainData(observer.context ?? {}) }];
    }));
}

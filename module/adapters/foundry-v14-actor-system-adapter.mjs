import { clonePlainData } from "../helpers/multiplayer-authority.mjs";
/** Snapshot the supplied Actor, including synthetic deltas, without retaining runtime handles. */
export function foundryActorSystemSnapshot(actor) {
    try {
        if (typeof actor?.toObject !== "function")
            throw new TypeError("Actor.toObject(true) is required.");
        // V14's source serialization excludes DataModel prototypes and prepared runtime values.
        const source = actor.toObject(true);
        if (typeof source !== "object" || source === null || !("system" in source)
            || typeof source.system !== "object" || source.system === null || Array.isArray(source.system)) {
            throw new TypeError("Actor.toObject(true).system must be a plain system object.");
        }
        const snapshot = clonePlainData(source.system, "Foundry Actor system snapshot");
        projectEffectiveResources(snapshot, actor.system);
        return snapshot;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Cannot snapshot Foundry Actor ${actor?.uuid ?? "(unknown)"} system: ${reason}`, { cause: error });
    }
}
/** Only canonical resource outputs cross from prepared data; authored fields stay source-based. */
function projectEffectiveResources(snapshot, system) {
    if (snapshot.resources === undefined && snapshot.pools === undefined)
        return;
    const prepared = requireRecord(system, "Actor.system");
    if (snapshot.resources !== undefined) {
        const resources = requireRecord(snapshot.resources, "source resources");
        const effective = requireRecord(prepared.resources, "prepared resources");
        for (const [id, resource] of Object.entries(resources)) {
            projectResource(resource, effective[id], `resources.${id}`);
        }
    }
    if (snapshot.pools !== undefined) {
        if (!Array.isArray(snapshot.pools) || !Array.isArray(prepared.pools)) {
            throw new TypeError("Source and prepared pools must be arrays.");
        }
        const effectivePools = new Map();
        for (const entry of prepared.pools) {
            const pool = requireRecord(entry, "prepared pool");
            if (typeof pool.id !== "string" || !pool.id || effectivePools.has(pool.id)) {
                throw new TypeError("Prepared pool IDs must be non-empty, unique strings.");
            }
            effectivePools.set(pool.id, pool);
        }
        // Keep source ordering: durability and payment update paths address persisted pool indices.
        for (const entry of snapshot.pools) {
            const pool = requireRecord(entry, "source pool");
            if (typeof pool.id !== "string" || !pool.id)
                throw new TypeError("Source pool ID is required.");
            projectResource(pool, effectivePools.get(pool.id), `pools.${pool.id}`);
        }
    }
}
function projectResource(source, prepared, path) {
    const resource = requireRecord(source, `source ${path}`);
    const effective = requireRecord(prepared, `prepared ${path}`);
    for (const key of ["value", "max"]) {
        // Absent fields stay absent; a present source field must not fall back to a stale value.
        if (!(key in resource) && !(key in effective))
            continue;
        const value = effective[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new TypeError(`Prepared ${path}.${key} must be a finite non-negative number.`);
        }
        resource[key] = value;
    }
}
function requireRecord(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object.`);
    }
    // Runtime DataModels are readable here, but only validated numeric outputs leave this adapter.
    return value;
}

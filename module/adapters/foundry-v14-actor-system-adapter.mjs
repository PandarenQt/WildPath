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
        return clonePlainData(source.system, "Foundry Actor system snapshot");
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Cannot snapshot Foundry Actor ${actor?.uuid ?? "(unknown)"} system: ${reason}`, { cause: error });
    }
}

// Foundry cleans Token `x`/`y` as integer NumberFields, and hex field-to-pixel conversion carries
// IEEE-754 noise, so a planned 260.00000000000006 persists as 260. Positional finite numbers may
// therefore differ only by floating-point noise relative to their magnitude. A material coordinate
// difference, every other key, and every non-number still require strict equality, so this cannot
// authorize or accept a different tactical position.
const MOVEMENT_NUMERIC_KEYS = new Set(["x", "y", "elevation"]);
const MOVEMENT_NOISE_ULPS = 32;
export function movementValueEquals(key, actual, expected) {
    if (MOVEMENT_NUMERIC_KEYS.has(key) && typeof actual === "number" && typeof expected === "number"
        && Number.isFinite(actual) && Number.isFinite(expected)) {
        const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
        return Math.abs(actual - expected) <= Number.EPSILON * MOVEMENT_NOISE_ULPS * scale;
    }
    return actual === expected;
}
/** Every planned update key must be present in `source`, exactly or within positional noise. */
export function movementUpdatesMatch(source, updates) {
    return Object.entries(updates).every(([key, expected]) => movementValueEquals(key, source[key], expected));
}
// A client-supplied option is never enough to bypass movement approval. The authorizing
// process must be executing this exact document write on the current active GM.
const writes = new WeakMap();
export function isStagedMovementWrite(token, operation, destination) {
    const pending = writes.get(token);
    return !!pending && operation.wildpathStagedMovement === pending.id
        && (!destination || movementUpdatesMatch(destination, pending.updates));
}
export function stagedMovementPersistence(base, token, id, canCommit) {
    return { ...base, async updateActor(input) {
            if (!canCommit())
                throw new Error("Staged movement payment requires current GM authority.");
            return base.updateActor(input);
        }, async updateDocument(input) {
            if (input.document !== token || !canCommit())
                throw new Error("Staged movement position requires current GM authority.");
            if (writes.has(token))
                throw new Error("A staged position write is already in flight.");
            const updates = input.updates;
            const before = Object.fromEntries(Object.keys(updates).map(key => [key, token.toObject(true)[key]]));
            const operationId = `${id}:${input.metadata?.rollback === true ? "rollback" : "commit"}`;
            writes.set(token, { id: operationId, updates });
            try {
                // V14.367 CONFIG.Token.movement.actions.displace is unmeasured and has no wall constraint.
                // This renders an already-resolved tactical result; it is not another traversal intent.
                const write = (values) => base.updateDocument({ ...input, updates: values, operation: { animate: false,
                        wildpathStagedMovement: operationId,
                        movement: { [token.id]: { waypoints: [{ ...values, action: "displace" }], showRuler: false } } } });
                const result = await write(updates);
                if (!movementUpdatesMatch(token.toObject(true), updates)) {
                    // V14 hooks may strip individual movement fields without rejecting the whole Document update.
                    // Compensate partial application here: the transaction has not marked this operation committed.
                    if (!movementUpdatesMatch(token.toObject(true), before)) {
                        writes.set(token, { id: operationId, updates: before });
                        await write(before);
                        if (!movementUpdatesMatch(token.toObject(true), before)) {
                            throw new Error("Foundry movement position verification and restoration failed; inspect the Token.");
                        }
                    }
                    throw new Error("Foundry did not persist the planned movement position.");
                }
                return result;
            }
            finally {
                writes.delete(token);
            }
        } };
}

// A client-supplied option is never enough to bypass movement approval. The authorizing
// process must be executing this exact document write on the current active GM.
const writes = new WeakMap();
export function isStagedMovementWrite(token, operation, destination) {
    const pending = writes.get(token);
    return !!pending && operation.wildpathStagedMovement === pending.id
        && (!destination || Object.entries(pending.updates).every(([key, value]) => destination[key] === value));
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
                if (!Object.entries(updates).every(([key, value]) => token.toObject(true)[key] === value)) {
                    // V14 hooks may strip individual movement fields without rejecting the whole Document update.
                    // Compensate partial application here: the transaction has not marked this operation committed.
                    if (!Object.entries(before).every(([key, value]) => token.toObject(true)[key] === value)) {
                        writes.set(token, { id: operationId, updates: before });
                        await write(before);
                        if (!Object.entries(before).every(([key, value]) => token.toObject(true)[key] === value)) {
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

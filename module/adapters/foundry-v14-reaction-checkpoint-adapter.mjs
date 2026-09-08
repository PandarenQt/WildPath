import { buildFoundryMovementIntent, classifyFoundryTokenOperation } from "./foundry-v14-movement-adapter.mjs";
/** V14 _preUpdate is before the private path split; _preUpdateMovement is too late. */
export async function prepareFoundryReactionCheckpoints(token, changed, operation, user, runtime, movementId) {
    const configured = operation.movement?.[token.id];
    const origin = token.toObject(true);
    const waypoints = configured?.waypoints ?? (("x" in changed || "y" in changed || "elevation" in changed)
        ? [{ ...Object.fromEntries(["x", "y", "elevation", "width", "height", "depth", "shape", "level"]
                    .map(key => [key, changed[key] ?? origin[key]]).filter(([, value]) => value !== undefined)) }] : null);
    if (!waypoints?.length)
        return;
    // Footprint resize keeps its existing V14 path and zero-cost approval behavior.
    if (classifyFoundryTokenOperation({ origin, destination: waypoints.at(-1), waypoints }).type !== "translation")
        return;
    const built = buildFoundryMovementIntent({ tokenDocument: token,
        movement: { id: movementId, origin, waypoints }, operation, user });
    if (!built.ok || !built.intent)
        throw new Error(built.reason);
    const approval = await runtime.requestMovementApproval({ ...built.intent,
        metadata: { reactionPreparation: true } });
    if (!approval.approved)
        throw new Error(approval.reason ?? "Movement preparation was rejected.");
    if (!approval.reactionCheckpoints)
        return;
    const teleport = "movementKind" in built.intent && built.intent.movementKind === "teleport";
    const full = teleport ? [origin, ...waypoints] : token.getCompleteMovementPath([origin, ...waypoints]);
    operation.movement ??= {};
    operation.movement[token.id] = { ...configured, id: movementId,
        waypoints: full.slice(1).map(point => ({ ...point, intermediate: false, checkpoint: true })) };
}

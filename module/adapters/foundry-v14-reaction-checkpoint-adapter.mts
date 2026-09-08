import {buildFoundryMovementIntent, classifyFoundryTokenOperation} from "./foundry-v14-movement-adapter.mjs";

type Waypoint = Record<string, unknown>;
interface CheckpointToken {
  readonly id: string;
  toObject(source: boolean): Waypoint;
  getCompleteMovementPath(points: Waypoint[]): Waypoint[];
}
interface CheckpointOperation extends Record<string, unknown> {
  movement?: Record<string, {id?: string; waypoints?: Waypoint[]; [key: string]: unknown}>;
}
interface PreparationRuntime {
  requestMovementApproval(intent: unknown): Promise<{approved?: boolean; reason?: string; reactionCheckpoints?: boolean}>;
}

/** V14 _preUpdate is before the private path split; _preUpdateMovement is too late. */
export async function prepareFoundryReactionCheckpoints(token: CheckpointToken, changed: Waypoint,
  operation: CheckpointOperation, user: unknown, runtime: PreparationRuntime, movementId: string) {
  const configured = operation.movement?.[token.id];
  const origin = token.toObject(true);
  const waypoints = configured?.waypoints ?? (("x" in changed || "y" in changed || "elevation" in changed)
    ? [{...Object.fromEntries(["x", "y", "elevation", "width", "height", "depth", "shape", "level"]
      .map(key => [key, changed[key] ?? origin[key]]).filter(([, value]) => value !== undefined))}] : null);
  if ( !waypoints?.length ) return;
  // Footprint resize keeps its existing V14 path and zero-cost approval behavior.
  if ( classifyFoundryTokenOperation({origin, destination: waypoints.at(-1), waypoints}).type !== "translation" ) return;
  const built = buildFoundryMovementIntent({tokenDocument: token,
    movement: {id: movementId, origin, waypoints}, operation, user});
  if ( !built.ok || !built.intent ) throw new Error(built.reason);
  const approval = await runtime.requestMovementApproval({...built.intent,
    metadata: {reactionPreparation: true}});
  if ( !approval.approved ) throw new Error(approval.reason ?? "Movement preparation was rejected.");
  if ( !approval.reactionCheckpoints ) return;
  const teleport = "movementKind" in built.intent && built.intent.movementKind === "teleport";
  const full = teleport ? [origin, ...waypoints] : token.getCompleteMovementPath([origin, ...waypoints]);
  operation.movement ??= {};
  operation.movement[token.id] = {...configured, id: movementId,
    waypoints: full.slice(1).map(point => ({...point, intermediate: false, checkpoint: true}))};
}

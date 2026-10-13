import { createMovementResolutionHost } from "../resolvers/movement-pipeline-resolver.mjs";
import { resolveFoundryMovementDocuments, foundryMovementIntentToMovementPath } from "./foundry-v14-movement-adapter.mjs";
import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { foundryActorSystemSnapshot } from "./foundry-v14-actor-system-adapter.mjs";
import { stagedMovementPersistence } from "./foundry-v14-staged-movement-commit.mjs";
import { clonePlainData } from "../helpers/multiplayer-authority.mjs";
import { foundryMovementReactionServices, footprintPositionUpdates } from "./foundry-v14-movement-reaction-services.mjs";
/** The socket carries route intent only. Documents, rules, resources and spatial facts come from authority. */
export async function foundryMovementIntentToStagedOptions({ intent, resolutionId, senderUserId, game, persistencePort }) {
    const canCommit = () => game.user.isGM === true && game.users.activeGM?.id === game.user.id;
    if (!canCommit())
        throw new Error("Staged movement requires an active GM.");
    // These assertions are isolated at the legacy JS adapter boundary; the adapter validates references and geometry.
    const documents = await resolveFoundryMovementDocuments({ intent, game });
    if (!documents.ok)
        throw new Error(documents.reason ?? "Movement documents could not be resolved.");
    const { token, scene, actor } = documents;
    const sender = game.users.get(senderUserId);
    if (!actor || !sender?.active || !(sender.isGM || (token.testUserPermission(sender, "OWNER") && actor.testUserPermission(sender, "OWNER")))) {
        throw new Error("Movement sender must own the exact Token and its Actor.");
    }
    // This entry point currently accepts explicit voluntary translation. Native movement keeps its own other modes.
    if ((intent.movementKind ?? "voluntary") !== "voluntary")
        throw new Error("Staged Foundry movement currently requires voluntary translation.");
    const translated = foundryMovementIntentToMovementPath({ intent, tokenDocument: token, scene });
    if (!translated.ok)
        throw new Error(translated.reason ?? "Movement route could not be translated.");
    const supplied = game.wildpath?.reactionServices?.({ intent: clonePlainData(intent), resolutionKind: "movement" }) ?? {};
    if (!(supplied.movement?.allowedModes ?? ["walk"]).includes(String(intent.movementMode ?? "walk"))) {
        throw new Error("Movement mode has no configured staged traversal policy.");
    }
    const observers = supplied.movement?.observers ?? [];
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const original = translated.originState;
    const grid = translated.sceneContext.grid;
    const measurementMode = game.settings?.get("wildpath", "movementMeasurementMode") === "fields" ? "fields" : "distance";
    const source = { actorId: actor.id, actorRef: actor.uuid, tokenId: token.id, tokenRef: token.uuid };
    const { services, actorDocuments, controllers } = foundryMovementReactionServices({ game, actor, token, supplied, adapter,
        sceneContext: translated.sceneContext, targetPosition: footprint => ({ ...original, ...positionUpdates(footprint) }) });
    const ownerIds = controllers[actor.uuid] ?? [];
    const host = createMovementResolutionHost({ id: resolutionId, path: translated.path, source,
        evaluationOptions: { measurementMode, grid, ...supplied.movement?.evaluationOptions },
        payment: supplied.movement?.payment ?? { capability: "movement", unit: "movement",
            scale: measurementMode === "fields" ? grid.distance : 1 } }, {
        actor, document: token, documentRef: token.uuid,
        persistencePort: stagedMovementPersistence(persistencePort, token, resolutionId, canCommit),
        readActorSystem: () => foundryActorSystemSnapshot(actor), positionUpdates,
        originalPosition: { x: original.x, y: original.y },
        observers: () => observers.map(observer => {
            if (observer.token.parent !== scene)
                throw new Error("Movement observer must remain on the same Scene.");
            const result = adapter.tokenToFootprint(observer.token, { position: observer.token.toObject(true) });
            if (!result.ok || !("footprint" in result) || !result.footprint)
                throw new Error("Movement observer footprint is invalid.");
            // Legacy JS widens the canonical footprint's literal type; success was checked above.
            return { id: observer.id, footprint: result.footprint, reachFields: observer.reachFields, context: observer.context ?? {} };
        }),
        validate: (state, traversal) => {
            if (!canCommit())
                return { decision: "invalid", reason: "Movement authority changed." };
            if (!sender.isGM && (!token.testUserPermission(sender, "OWNER") || !actor.testUserPermission(sender, "OWNER"))) {
                return { decision: "invalid", reason: "Movement ownership changed." };
            }
            if (scene.tokens.get(token.id) !== token || token.actor !== actor || token.parent !== scene
                || !Object.entries(original).every(([key, value]) => token.toObject(true)[key] === value)) {
                return { decision: "invalid", reason: "Movement source position or footprint changed." };
            }
            const currentScene = adapter.getSceneContext();
            if (!currentScene.ok || !("context" in currentScene)
                || JSON.stringify(currentScene.context.grid) !== JSON.stringify(grid)) {
                return { decision: "invalid", reason: "Movement grid configuration changed." };
            }
            const current = adapter.tokenToFootprint(token, { position: original });
            if (!current.ok || !("footprint" in current) || JSON.stringify(current.footprint?.fields) !== JSON.stringify(translated.tokenFootprint.fields)) {
                return { decision: "invalid", reason: "Movement footprint changed." };
            }
            return supplied.movement?.validate?.({ state, traversal, token }) ?? { decision: "continue" };
        }
    });
    return { ok: true, host, options: { actor, source, persistencePort, targetActors: actorDocuments }, services,
        requestContext: { sourceControllerUserIds: ownerIds, sourceControllerUserIdsBySourceRef: controllers } };
    function positionUpdates(footprint) {
        return footprintPositionUpdates({ adapter, token, origin: original, originAnchor: translated.tokenFootprint.anchor, footprint });
    }
}

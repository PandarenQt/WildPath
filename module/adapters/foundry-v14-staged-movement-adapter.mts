import type {DocumentPersistencePort, ResolutionState, TokenGridFootprint, ActionDefinition} from "../types/contracts.js";
import {createMovementResolutionHost, type MovementContinuation, type MovementPipelineOptions, type MovementTraversal} from "../resolvers/movement-pipeline-resolver.mjs";
import {resolveFoundryMovementDocuments, foundryMovementIntentToMovementPath} from "./foundry-v14-movement-adapter.mjs";
import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {foundryActorSystemSnapshot} from "./foundry-v14-actor-system-adapter.mjs";
import {stagedMovementPersistence} from "./foundry-v14-staged-movement-commit.mjs";
import {createActionResolutionState, createActionReactionChildState} from "../resolvers/action-pipeline-resolver.mjs";
import {resolveActorAttackStatistic, resolveActorDefense} from "../helpers/combat-statistics.mjs";
import {economyResourcesFromActorResources} from "../helpers/action-economy.mjs";
import {clonePlainData} from "../helpers/multiplayer-authority.mjs";

type Data = Record<string, unknown>;
interface User {id: string; isGM?: boolean; active?: boolean}
interface Actor {id: string; uuid: string; system: Data; toObject(source: boolean): Data; testUserPermission(user: User, level: string): boolean}
interface Token {id: string; uuid: string; actor: Actor; parent: object; toObject(source: boolean): Data;
  testUserPermission(user: User, level: string): boolean}
interface Scene {tokens: {get(id: string): Token | undefined}}
interface Observer {id: string; token: Token; reachFields: number; context?: Data}
export interface StagedMovementRuleServices {
  reactions?: Data;
  movement?: {
    observers?: readonly Observer[];
    allowedModes?: readonly string[];
    evaluationOptions?: MovementPipelineOptions["evaluationOptions"];
    payment?: MovementPipelineOptions["payment"];
    validate?: (context: {state: ResolutionState; traversal: MovementTraversal; token: Token}) => MovementContinuation;
  };
  [key: string]: unknown;
}
interface Game {
  user: User;
  users: {get(id: string): User | undefined; values(): IterableIterator<User>; activeGM?: User | null};
  settings?: {get(namespace: string, key: string): unknown};
  wildpath?: {reactionServices?: (context: Data) => StagedMovementRuleServices};
}
interface Translation {ok: boolean; reason?: string; path: MovementPipelineOptions["path"];
  originState: Data; tokenFootprint: TokenGridFootprint; sceneContext: {grid: {distance: number; units: string}}}
interface ChildContext {
  parentState: ResolutionState; baseChildState: ResolutionState;
  candidate: {reactor: {actorId: string; tokenId?: string}; actionDefinition?: ActionDefinition; action?: ActionDefinition;
    selectedPaymentOption?: {id: string}};
}

/** The socket carries route intent only. Documents, rules, resources and spatial facts come from authority. */
export async function foundryMovementIntentToStagedOptions({intent, resolutionId, senderUserId, game, persistencePort}: {
  intent: Data; resolutionId: string; senderUserId: string; game: Game; persistencePort: DocumentPersistencePort;
}) {
  const canCommit = () => game.user.isGM === true && game.users.activeGM?.id === game.user.id;
  if (!canCommit()) throw new Error("Staged movement requires an active GM.");
  // These assertions are isolated at the legacy JS adapter boundary; the adapter validates references and geometry.
  const documents = await resolveFoundryMovementDocuments({intent, game}) as {
    ok: boolean; reason?: string; token: Token; scene: Scene; actor: Actor;
  };
  if (!documents.ok) throw new Error(documents.reason ?? "Movement documents could not be resolved.");
  const {token, scene, actor} = documents;
  const sender = game.users.get(senderUserId);
  if (!actor || !sender?.active || !(sender.isGM || (token.testUserPermission(sender, "OWNER") && actor.testUserPermission(sender, "OWNER")))) {
    throw new Error("Movement sender must own the exact Token and its Actor.");
  }
  // This entry point currently accepts explicit voluntary translation. Native movement keeps its own other modes.
  if ((intent.movementKind ?? "voluntary") !== "voluntary") throw new Error("Staged Foundry movement currently requires voluntary translation.");
  const translated = foundryMovementIntentToMovementPath({intent, tokenDocument: token, scene}) as Translation;
  if (!translated.ok) throw new Error(translated.reason ?? "Movement route could not be translated.");
  const supplied = game.wildpath?.reactionServices?.({intent: clonePlainData(intent), resolutionKind: "movement"}) ?? {};
  if (!(supplied.movement?.allowedModes ?? ["walk"]).includes(String(intent.movementMode ?? "walk"))) {
    throw new Error("Movement mode has no configured staged traversal policy.");
  }
  const observers = supplied.movement?.observers ?? [];
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const original = translated.originState;
  const grid = translated.sceneContext.grid;
  const measurementMode = game.settings?.get("wildpath", "movementMeasurementMode") === "fields" ? "fields" : "distance";
  const source = {actorId: actor.id, actorRef: actor.uuid, tokenId: token.id, tokenRef: token.uuid};
  const actors = [...new Set([actor, ...observers.map(o => o.token.actor)])];
  const actorDocuments = Object.fromEntries(actors.flatMap(a => {
    const aliases: Array<[string, Actor]> = [[a.uuid, a]];
    if (actors.filter(other => other.id === a.id).length === 1) aliases.push([a.id,a],[`actor:${a.id}`,a]);
    return aliases;
  }));
  for (const t of [token, ...observers.map(o => o.token)]) {
    for (const ref of [t.uuid, `uuid:${t.uuid}`, `token:${t.id}`]) actorDocuments[ref] = t.actor;
  }
  // Ambiguous base Actor IDs are omitted. Distinct synthetic Actors must use UUIDs in reaction definitions.
  const controllers = Object.fromEntries(Object.entries(actorDocuments).map(([key, value]) =>
    [key, [...game.users.values()].filter(user => user.active && !user.isGM && value.testUserPermission(user, "OWNER")).map(user => user.id)]));
  for (const ids of Object.values(controllers)) if (!ids.length) ids.push(game.user.id);
  const ownerIds = controllers[actor.uuid] ?? [];
  const snapshotResources = () => {
    const snapshots = new Map(actors.map(value => [value, economyResourcesFromActorResources(foundryActorSystemSnapshot(value))]));
    return Object.fromEntries(Object.entries(actorDocuments).map(([key, value]) => [key, snapshots.get(value)]));
  };
  const services = {...supplied, targetActors: {...actorDocuments}, reactions: {...supplied.reactions,
    resourcesByActor: snapshotResources, actorDocumentsByActor: actorDocuments, controllerUserIdsByActor: controllers,
    createChildState: (args: ChildContext) => {
      // Nested reactions to the child use the normal configured factory; only a movement parent supplies a logical target.
      if (args.parentState.metadata.host !== "movement") return createActionReactionChildState({...args,
        services: {...supplied, reactions: supplied.reactions ?? {}}});
      const candidate = args.candidate;
      const matches = observers.filter(o => candidate.reactor.tokenId ? o.token.id === candidate.reactor.tokenId
        : [o.token.actor.id, o.token.actor.uuid].includes(candidate.reactor.actorId));
      if (matches.length !== 1) throw new Error("Reaction must resolve to exactly one configured observer Token.");
      const reactor = matches[0]!.token;
      const definition = candidate.actionDefinition ?? candidate.action;
      if (!definition) throw new Error("Movement reaction requires an ActionDefinition.");
      const proposed = args.parentState.results.proposedMovement as {data: {previous: TokenGridFootprint}};
      const position = positionUpdates(proposed.data.previous);
      const targetResult = adapter.tokenToTargetFootprint(token, {position: {...original, ...position}});
      if (!targetResult.ok || !("tokenFootprint" in targetResult) || !targetResult.tokenFootprint) throw new Error("Logical movement target footprint is invalid.");
      const sourceResult = adapter.tokenToFootprint(reactor, {position: reactor.toObject(true)});
      if (!sourceResult.ok || !("footprint" in sourceResult) || !sourceResult.footprint) throw new Error("Reaction source footprint is invalid.");
      const defenseKey = definition.attack?.defenseKey ?? "ac";
      const defense = resolveActorDefense(actor, defenseKey);
      const target = {...targetResult.tokenFootprint, defense, defenses: {[defenseKey]: defense}};
      const statistic = definition.attack ? resolveActorAttackStatistic(reactor.actor, definition.attack) : null;
      const targetSystem = foundryActorSystemSnapshot(actor);
      const base = args.baseChildState;
      return createActionResolutionState({id: base.id, parentId: base.parentId, relationship: base.relationship,
        sourceEvent: base.sourceEvent, depth: base.depth, maxDepth: base.maxDepth, ancestry: base.ancestry,
        triggerIdentities: base.triggerIdentities, metadata: base.metadata,
        actorSystem: foundryActorSystemSnapshot(reactor.actor),
        action: {id: definition.id, type: "action", name: definition.label, system: {definition}},
        source: {actorId: reactor.actor.id, actorRef: reactor.actor.uuid, tokenId: reactor.id, tokenRef: reactor.uuid},
        targets: [{id: actor.id, actorId: actor.id, actorRef: actor.uuid, tokenId: token.id, defense}],
        targeting: {candidates: [target]},
        context: {spatial: {sceneContext: translated.sceneContext, gridDistance: grid.distance,
          sourceFootprint: sourceResult.footprint, targetFootprints: [target]}},
        attack: statistic ? {statistic, modifierTotal: statistic.totalModifier} : null,
        selectedPaymentOptionId: candidate.selectedPaymentOption?.id ?? null,
        durability: {targetSystems: Object.fromEntries([actor.id, actor.uuid, `actor:${actor.id}`]
          .map(key => [key, targetSystem]))}});
    }}};
  const host = createMovementResolutionHost({id: resolutionId, path: translated.path, source,
    evaluationOptions: {measurementMode, grid, ...supplied.movement?.evaluationOptions},
    payment: supplied.movement?.payment ?? {capability: "movement", unit: "movement",
      scale: measurementMode === "fields" ? grid.distance : 1}}, {
    actor, document: token, documentRef: token.uuid,
    persistencePort: stagedMovementPersistence(persistencePort, token, resolutionId, canCommit),
    readActorSystem: () => foundryActorSystemSnapshot(actor), positionUpdates,
    originalPosition: {x: original.x, y: original.y},
    observers: () => observers.map(observer => {
      if (observer.token.parent !== scene) throw new Error("Movement observer must remain on the same Scene.");
      const result = adapter.tokenToFootprint(observer.token, {position: observer.token.toObject(true)});
      if (!result.ok || !("footprint" in result) || !result.footprint) throw new Error("Movement observer footprint is invalid.");
      // Legacy JS widens the canonical footprint's literal type; success was checked above.
      return {id: observer.id, footprint: result.footprint as TokenGridFootprint, reachFields: observer.reachFields, context: observer.context ?? {}};
    }),
    validate: (state, traversal) => {
      if (!canCommit()) return {decision: "invalid", reason: "Movement authority changed."};
      if (!sender.isGM && (!token.testUserPermission(sender, "OWNER") || !actor.testUserPermission(sender, "OWNER"))) {
        return {decision: "invalid", reason: "Movement ownership changed."};
      }
      if (scene.tokens.get(token.id) !== token || token.actor !== actor || token.parent !== scene
        || !Object.entries(original).every(([key, value]) => token.toObject(true)[key] === value)) {
        return {decision: "invalid", reason: "Movement source position or footprint changed."};
      }
      const currentScene = adapter.getSceneContext();
      if (!currentScene.ok || !("context" in currentScene)
        || JSON.stringify(currentScene.context.grid) !== JSON.stringify(grid)) {
        return {decision: "invalid", reason: "Movement grid configuration changed."};
      }
      const current = adapter.tokenToFootprint(token, {position: original});
      if (!current.ok || !("footprint" in current) || JSON.stringify(current.footprint?.fields) !== JSON.stringify(translated.tokenFootprint.fields)) {
        return {decision: "invalid", reason: "Movement footprint changed."};
      }
      return supplied.movement?.validate?.({state, traversal, token}) ?? {decision: "continue"};
    }
  });
  return {ok: true, host, options: {actor, source, persistencePort, targetActors: actorDocuments}, services,
    requestContext: {sourceControllerUserIds: ownerIds, sourceControllerUserIdsBySourceRef: controllers}};

  function positionUpdates(footprint: TokenGridFootprint): Data {
    const from = adapter.fieldToCenterPoint(translated.tokenFootprint.anchor);
    const to = adapter.fieldToCenterPoint(footprint.anchor);
    if (!from.ok || !to.ok || !("point" in from) || !("point" in to)) throw new Error("Cannot translate tactical anchor to Foundry position.");
    const updates = {x: Number(original.x) + to.point.x - from.point.x, y: Number(original.y) + to.point.y - from.point.y};
    const verified = adapter.tokenToFootprint(token, {position: {...original, ...updates}});
    if (!verified.ok || !("footprint" in verified) || JSON.stringify(verified.footprint?.fields) !== JSON.stringify(footprint.fields)) {
      throw new Error("Foundry position does not represent the planned tactical footprint.");
    }
    return updates;
  }
}

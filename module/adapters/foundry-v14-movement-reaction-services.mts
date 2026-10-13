import type {ResolutionState, TokenGridFootprint, ActionDefinition} from "../types/contracts.js";
import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {foundryActorSystemSnapshot} from "./foundry-v14-actor-system-adapter.mjs";
import {createActionResolutionState, createActionReactionChildState} from "../resolvers/action-pipeline-resolver.mjs";
import {resolveActorAttackStatistic, resolveActorDefense} from "../helpers/combat-statistics.mjs";
import {economyResourcesFromActorResources} from "../helpers/action-economy.mjs";
import {createAutomationEvent} from "../helpers/automation-events.mjs";
import {movementTransitionRelations} from "../helpers/movement-transition.mjs";

type Data = Record<string, unknown>;
type GridAdapter = ReturnType<typeof createFoundryV14TacticalGridAdapter>;
export interface User {id: string; isGM?: boolean; active?: boolean}
export interface Actor {id: string; uuid: string; system: Data; toObject(source: boolean): Data; testUserPermission(user: User, level: string): boolean;
  items?: Iterable<{id?: string; type?: string; system?: {definition?: {id?: string}}}>}
export interface Token {id: string; uuid: string; actor: Actor; parent: object; toObject(source: boolean): Data;
  testUserPermission(user: User, level: string): boolean}
export interface Scene {tokens: {get(id: string): Token | undefined}}
export interface Observer {id: string; token: Token; reachFields: number; context?: Data}
export interface MovementReactionGame {
  user: User;
  users: {get(id: string): User | undefined; values(): IterableIterator<User>; activeGM?: User | null};
}
interface ChildContext {
  parentState: ResolutionState; baseChildState: ResolutionState;
  candidate: {reactor: {actorId: string; tokenId?: string}; actionDefinition?: ActionDefinition; action?: ActionDefinition;
    selectedPaymentOption?: {id: string}};
}
interface SuppliedServices {reactions?: Data; movement?: {observers?: readonly Observer[]}; [key: string]: unknown}

const PROPOSED_EVENT = "movement.transition-proposed";

/**
 * Reaction services for movement: Actor documents and controllers for the mover and every observer, live
 * resource snapshots, and a child-state factory that makes a reaction to a proposed step target the mover
 * where that step starts. Serves both the staged movement host and the native checkpoint path.
 */
export function foundryMovementReactionServices({game, actor, token, supplied, adapter, sceneContext, targetPosition}: {
  game: MovementReactionGame; actor: Actor; token: Token; supplied: SuppliedServices; adapter: GridAdapter;
  sceneContext: {grid: {distance: number}}; targetPosition: (footprint: TokenGridFootprint) => Data;
}) {
  const observers = supplied.movement?.observers ?? [];
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
  const snapshotResources = () => {
    const snapshots = new Map(actors.map(value => [value, economyResourcesFromActorResources(foundryActorSystemSnapshot(value))]));
    return Object.fromEntries(Object.entries(actorDocuments).map(([key, value]) => [key, snapshots.get(value)]));
  };
  const grid = sceneContext.grid;
  const services = {...supplied, targetActors: {...actorDocuments}, reactions: {...supplied.reactions,
    resourcesByActor: snapshotResources, actorDocumentsByActor: actorDocuments, controllerUserIdsByActor: controllers,
    createChildState: (args: ChildContext) => {
      // Nested reactions to the child use the normal configured factory; only a proposed step supplies a logical target.
      const previous = proposedStepStart(args.parentState);
      if (!previous) return createActionReactionChildState({...args,
        services: {...supplied, reactions: supplied.reactions ?? {}}});
      const candidate = args.candidate;
      const matches = observers.filter(o => candidate.reactor.tokenId ? o.token.id === candidate.reactor.tokenId
        : [o.token.actor.id, o.token.actor.uuid].includes(candidate.reactor.actorId));
      if (matches.length !== 1) throw new Error("Reaction must resolve to exactly one configured observer Token.");
      const reactor = matches[0]!.token;
      const definition = candidate.actionDefinition ?? candidate.action;
      if (!definition) throw new Error("Movement reaction requires an ActionDefinition.");
      const targetResult = adapter.tokenToTargetFootprint(token, {position: targetPosition(previous)});
      if (!targetResult.ok || !("tokenFootprint" in targetResult) || !targetResult.tokenFootprint) throw new Error("Logical movement target footprint is invalid.");
      const sourceResult = adapter.tokenToFootprint(reactor, {position: reactor.toObject(true)});
      if (!sourceResult.ok || !("footprint" in sourceResult) || !sourceResult.footprint) throw new Error("Reaction source footprint is invalid.");
      const defenseKey = definition.attack?.defenseKey ?? "ac";
      const defense = resolveActorDefense(actor, defenseKey);
      const target = {...targetResult.tokenFootprint, defense, defenses: {[defenseKey]: defense}};
      // The reacting Action's own modifiers count for its attack: find it on the reactor by definition id.
      const reactionItem = [...(reactor.actor.items ?? [])].find(entry => entry.type === "action"
        && entry.system?.definition?.id === definition.id) ?? null;
      const statistic = definition.attack
        ? resolveActorAttackStatistic(reactor.actor, definition.attack, {item: reactionItem, tags: [...(definition.tags ?? [])]})
        : null;
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
        context: {spatial: {sceneContext, gridDistance: grid.distance,
          sourceFootprint: sourceResult.footprint, targetFootprints: [target]}},
        attack: statistic ? {statistic, modifierTotal: statistic.totalModifier} : null,
        selectedPaymentOptionId: candidate.selectedPaymentOption?.id ?? null,
        durability: {targetSystems: Object.fromEntries([actor.id, actor.uuid, `actor:${actor.id}`]
          .map(key => [key, targetSystem]))}});
    }}};
  return {services, actorDocuments, controllers};
}

/** Where a proposed step starts: the staged movement host's proposal, or a hosted `movement.transition-proposed` event. */
function proposedStepStart(parent: ResolutionState): TokenGridFootprint | null {
  if (parent.metadata.host === "movement") {
    return (parent.results.proposedMovement as {data: {previous: TokenGridFootprint}}).data.previous;
  }
  const event = parent.sourceEvent as {type?: string; data?: {previous?: TokenGridFootprint}} | null;
  return (parent.metadata.host === "triggered-event") && (event?.type === PROPOSED_EVENT) ? event.data?.previous ?? null : null;
}

/** The Foundry position that places `token` on `footprint`, relative to a known origin position and anchor. */
export function footprintPositionUpdates({adapter, token, origin, originAnchor, footprint}: {
  adapter: GridAdapter; token: Token; origin: Data; originAnchor: TokenGridFootprint["anchor"]; footprint: TokenGridFootprint;
}): Data {
  const from = adapter.fieldToCenterPoint(originAnchor);
  const to = adapter.fieldToCenterPoint(footprint.anchor);
  if (!from.ok || !to.ok || !("point" in from) || !("point" in to)) throw new Error("Cannot translate tactical anchor to Foundry position.");
  const updates = {x: Number(origin.x) + to.point.x - from.point.x, y: Number(origin.y) + to.point.y - from.point.y};
  const verified = adapter.tokenToFootprint(token, {position: {...origin, ...updates}});
  if (!verified.ok || !("footprint" in verified) || JSON.stringify(verified.footprint?.fields) !== JSON.stringify(footprint.fields)) {
    throw new Error("Foundry position does not represent the planned tactical footprint.");
  }
  return updates;
}

/**
 * A native drag's before-step reaction window: the `movement.transition-proposed` event for one approved
 * step (relations to every observer's reach), and the services that resolve reactions to it. Foundry holds
 * the Token at the step's start while its segment approval is pending, so `previous` is where it stands.
 */
export function foundryBeforeStepReaction({game, scene, token, supplied, eventId, movement, step}: {
  game: MovementReactionGame; scene: Scene; token: Token; supplied: SuppliedServices; eventId: string;
  movement: {movementId: string; movementKind: string; movementMode: string};
  step: {transitionIndex: number; previous: TokenGridFootprint; proposed: TokenGridFootprint; transition: Data; cumulativeCost: number};
}) {
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const sceneContext = adapter.getSceneContext();
  if (!sceneContext.ok || !("context" in sceneContext)) throw new Error("Movement reactions require a tactical grid.");
  const origin = token.toObject(true);
  const current = adapter.tokenToFootprint(token, {position: origin});
  if (!current.ok || !("footprint" in current) || !current.footprint) throw new Error("Moving Token footprint is invalid.");
  const originAnchor = current.footprint.anchor;
  const observers = (supplied.movement?.observers ?? []).map(observer => {
    const result = adapter.tokenToFootprint(observer.token, {position: observer.token.toObject(true)});
    if (!result.ok || !("footprint" in result) || !result.footprint) throw new Error("Movement observer footprint is invalid.");
    // Legacy JS widens the canonical footprint's literal type; success was checked above.
    return {id: observer.id, footprint: result.footprint as TokenGridFootprint, reachFields: observer.reachFields, context: observer.context ?? {}};
  });
  const actor = token.actor;
  const source = {actorId: actor.id, actorRef: actor.uuid, tokenId: token.id, tokenRef: token.uuid};
  const event = createAutomationEvent({id: eventId, type: PROPOSED_EVENT, phase: "interrupt", source,
    data: {...movement, ...step, relations: movementTransitionRelations(step.previous, step.proposed, observers)}});
  const {services} = foundryMovementReactionServices({game, actor, token, supplied, adapter,
    sceneContext: sceneContext.context as {grid: {distance: number}},
    targetPosition: footprint => ({...origin, ...footprintPositionUpdates({adapter, token, origin, originAnchor, footprint})})});
  return {event, services};
}

import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { foundryActorSystemSnapshot } from "./foundry-v14-actor-system-adapter.mjs";
import { createActionResolutionState, createActionReactionChildState } from "../resolvers/action-pipeline-resolver.mjs";
import { actionCombatStatistics, attackForcesCritical, attackRollMode, resolveActorDefense } from "../helpers/combat-statistics.mjs";
import { conditionsFrom } from "../helpers/effect-sources.mjs";
import { footprintDistance } from "../helpers/grid-footprints.mjs";
import { turnKey } from "./foundry-v14-persistent-areas.mjs";
import { allyNearTarget } from "./foundry-v14-auras.mjs";
import { economyResourcesFromActorResources } from "../helpers/action-economy.mjs";
import { createAutomationEvent } from "../helpers/automation-events.mjs";
import { movementTransitionRelations } from "../helpers/movement-transition.mjs";
const PROPOSED_EVENT = "movement.transition-proposed";
const DISPOSITIONS = { "-1": "hostile", "0": "neutral", "1": "friendly", "-2": "secret" };
/**
 * Actor documents and controllers for every creature a reaction may involve, and live resource snapshots.
 * Each Actor is keyed by uuid and by its Tokens' refs; a base Actor id shared by several unlinked Tokens is
 * ambiguous and omitted, so reaction definitions name synthetic Actors by uuid.
 */
function reactionParticipants(game, tokens) {
    const actors = [...new Set(tokens.map(t => t.actor))];
    const actorDocuments = Object.fromEntries(actors.flatMap(a => {
        const aliases = [[a.uuid, a]];
        if (actors.filter(other => other.id === a.id).length === 1)
            aliases.push([a.id, a], [`actor:${a.id}`, a]);
        return aliases;
    }));
    for (const t of tokens) {
        for (const ref of [t.uuid, `uuid:${t.uuid}`, `token:${t.id}`])
            actorDocuments[ref] = t.actor;
    }
    const controllers = Object.fromEntries(Object.entries(actorDocuments).map(([key, value]) => [key, [...game.users.values()].filter(user => user.active && !user.isGM && value.testUserPermission(user, "OWNER")).map(user => user.id)]));
    for (const ids of Object.values(controllers))
        if (!ids.length)
            ids.push(game.user.id);
    const resourcesByActor = () => {
        const snapshots = new Map(actors.map(value => [value, economyResourcesFromActorResources(foundryActorSystemSnapshot(value))]));
        return Object.fromEntries(Object.entries(actorDocuments).map(([key, value]) => [key, snapshots.get(value)]));
    };
    return { actorDocuments, controllers, resourcesByActor };
}
function reactorFor(candidate, tokens) {
    const matches = tokens.filter(t => candidate.reactor.tokenId ? t.id === candidate.reactor.tokenId
        : [t.actor.id, t.actor.uuid].includes(candidate.reactor.actorId));
    if (matches.length !== 1)
        throw new Error("Reaction must resolve to exactly one reacting Token.");
    return matches[0];
}
/**
 * The reaction Action's child state: `reactor` acts on one target creature, standing on `targetFootprint`.
 * The reacting Action's own modifiers count for its attack (its Item is found on the reactor by definition id).
 */
function reactionChildState({ args, reactor, target, targetFootprint, sourceFootprint, sceneContext }) {
    const definition = args.candidate.actionDefinition ?? args.candidate.action;
    if (!definition)
        throw new Error("A reaction requires an ActionDefinition.");
    const actor = target.actor;
    const defenseKey = definition.attack?.defenseKey ?? "ac";
    const defense = resolveActorDefense(actor, defenseKey);
    const targetEntry = { ...targetFootprint, defense, defenses: { [defenseKey]: defense } };
    const reactionItem = [...(reactor.actor.items ?? [])].find(entry => entry.type === "action"
        && entry.system?.definition?.id === definition.id) ?? null;
    // The same attack and damage statistics as any Action: an opportunity attack adds the ability modifier and bonuses.
    const combat = globalThis.game?.combat;
    const statistics = actionCombatStatistics(reactor.actor, definition, { item: reactionItem,
        turn: combat?.started ? turnKey(combat) : null });
    // The same advantage, disadvantage and forced critical hits as any attack: a Prone target within 5 ft, a Paralyzed one.
    const type = definition.attack?.type ?? null;
    const fields = footprintDistance(sourceFootprint, targetFootprint.footprint);
    const context = { attack: { type, ...(Number.isFinite(fields) ? { adjacent: fields * sceneContext.grid.distance <= 5 } : {}),
            fromTarget: conditionsFrom(reactor.actor, actor),
            allyNearTarget: allyNearTarget(reactor, target, targetFootprint.footprint ?? null) } };
    const rollMode = definition.attack ? attackRollMode(reactor.actor, actor, { type, item: reactionItem, context }) : null;
    const critical = !!definition.attack && attackForcesCritical(actor, { type, context });
    const targetSystem = foundryActorSystemSnapshot(actor);
    const profile = actor.getDamageProfile?.() ?? null;
    const targetKeys = [actor.id, actor.uuid, `actor:${actor.id}`];
    const base = args.baseChildState;
    return createActionResolutionState({ id: base.id, parentId: base.parentId, relationship: base.relationship,
        sourceEvent: base.sourceEvent, depth: base.depth, maxDepth: base.maxDepth, ancestry: base.ancestry,
        triggerIdentities: base.triggerIdentities, metadata: base.metadata,
        actorSystem: foundryActorSystemSnapshot(reactor.actor),
        action: { id: definition.id, type: "action", name: definition.label, system: { definition } },
        source: { actorId: reactor.actor.id, actorRef: reactor.actor.uuid, tokenId: reactor.id, tokenRef: reactor.uuid },
        targets: [{ id: actor.id, actorId: actor.id, actorRef: actor.uuid, tokenId: target.id, defense }],
        targeting: { candidates: [targetEntry] },
        context: { spatial: { sceneContext, gridDistance: sceneContext.grid.distance, sourceFootprint, targetFootprints: [targetEntry] } },
        attack: (statistics.attack || rollMode) ? {
            ...(statistics.attack ? { statistic: statistics.attack.statistic, modifierTotal: statistics.attack.modifierTotal,
                ...(statistics.attack.dice ? { dice: statistics.attack.dice } : {}) } : {}),
            ...(rollMode ? { rollMode } : {}), ...(critical ? { outcomesByTarget: { [target.id]: "critical-on-hit" } } : {})
        } : null,
        damage: statistics.damage,
        selectedPaymentOptionId: args.candidate.selectedPaymentOption?.id ?? null,
        durability: { targetSystems: Object.fromEntries(targetKeys.map(key => [key, targetSystem])),
            ...(profile ? { adjustmentProfiles: Object.fromEntries(targetKeys.map(key => [key, structuredClone(profile)])) } : {}) } });
}
/**
 * Reaction services for movement: the mover and every observer as participants, and a child-state factory
 * that makes a reaction to a proposed step target the mover where that step starts. Serves both the staged
 * movement host and the native checkpoint path.
 */
export function foundryMovementReactionServices({ game, token, supplied, adapter, sceneContext, targetPosition }) {
    const observers = (supplied.movement?.observers ?? []).map(o => o.token);
    const { actorDocuments, controllers, resourcesByActor } = reactionParticipants(game, [token, ...observers]);
    const services = { ...supplied, targetActors: { ...actorDocuments }, reactions: { ...supplied.reactions,
            resourcesByActor, actorDocumentsByActor: actorDocuments, controllerUserIdsByActor: controllers,
            createChildState: (args) => {
                // Nested reactions to the child use the normal configured factory; only a proposed step supplies a logical target.
                const previous = proposedStepStart(args.parentState);
                if (!previous)
                    return createActionReactionChildState({ ...args,
                        services: { ...supplied, reactions: supplied.reactions ?? {} } });
                const reactor = reactorFor(args.candidate, observers);
                const targetResult = adapter.tokenToTargetFootprint(token, { position: targetPosition(previous) });
                if (!targetResult.ok || !("tokenFootprint" in targetResult) || !targetResult.tokenFootprint)
                    throw new Error("Logical movement target footprint is invalid.");
                const sourceResult = adapter.tokenToFootprint(reactor, { position: reactor.toObject(true) });
                if (!sourceResult.ok || !("footprint" in sourceResult) || !sourceResult.footprint)
                    throw new Error("Reaction source footprint is invalid.");
                return reactionChildState({ args, reactor, target: token,
                    targetFootprint: targetResult.tokenFootprint, sourceFootprint: sourceResult.footprint, sceneContext });
            } } };
    return { services, actorDocuments, controllers };
}
/**
 * Reaction services for an ordinary Action: the acting creature and every Token whose triggers subscribe to
 * Action events (`action.declared`, `attack.hit`, `attack.miss`). A reaction Action that targets `self`
 * acts on its own Token; any other acts on the creature whose Action triggered it, where it stands.
 * Returns null when no such trigger is on the Scene, so Actions without reactors keep their plain path.
 */
export function foundryActionReactionServices({ game, scene, token, supplied }) {
    const triggers = (supplied.reactions?.triggers ?? [])
        .filter(trigger => !String(trigger.event?.type ?? "").startsWith("movement."));
    const reactors = [...new Set(triggers.map(trigger => trigger.owner?.tokenId ? scene.tokens.get(trigger.owner.tokenId) : null))]
        .filter((reactor) => !!reactor && (reactor.id !== token.id));
    if (!reactors.length)
        return null;
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const sceneContext = adapter.getSceneContext();
    if (!sceneContext.ok || !("context" in sceneContext))
        return null;
    const grid = sceneContext.context;
    const participants = [token, ...reactors];
    const { actorDocuments, controllers, resourcesByActor } = reactionParticipants(game, participants);
    const services = { ...supplied, targetActors: { ...actorDocuments }, reactions: { ...supplied.reactions, triggers,
            resourcesByActor, actorDocumentsByActor: actorDocuments, controllerUserIdsByActor: controllers,
            createChildState: (args) => {
                const reactor = reactorFor(args.candidate, reactors);
                const definition = args.candidate.actionDefinition ?? args.candidate.action;
                const event = (args.baseChildState.sourceEvent ?? args.candidate.event);
                const target = definition?.targeting?.type === "self" ? reactor
                    : participants.find(t => t.id === event?.source?.tokenId) ?? null;
                if (!target)
                    throw new Error("A reaction's target must be a Token on this Scene.");
                const targetResult = adapter.tokenToTargetFootprint(target, { disposition: DISPOSITIONS[String(target.disposition ?? 0)] });
                if (!targetResult.ok || !("tokenFootprint" in targetResult) || !targetResult.tokenFootprint)
                    throw new Error("Reaction target footprint is invalid.");
                const sourceResult = adapter.tokenToFootprint(reactor);
                if (!sourceResult.ok || !("footprint" in sourceResult) || !sourceResult.footprint)
                    throw new Error("Reaction source footprint is invalid.");
                return reactionChildState({ args, reactor, target, targetFootprint: targetResult.tokenFootprint,
                    sourceFootprint: sourceResult.footprint, sceneContext: grid });
            } } };
    return { services, actorDocuments, controllers };
}
/** Where a proposed step starts: the staged movement host's proposal, or a hosted `movement.transition-proposed` event. */
function proposedStepStart(parent) {
    if (parent.metadata.host === "movement") {
        return parent.results.proposedMovement.data.previous;
    }
    const event = parent.sourceEvent;
    return (parent.metadata.host === "triggered-event") && (event?.type === PROPOSED_EVENT) ? event.data?.previous ?? null : null;
}
/** The Foundry position that places `token` on `footprint`, relative to a known origin position and anchor. */
export function footprintPositionUpdates({ adapter, token, origin, originAnchor, footprint }) {
    const from = adapter.fieldToCenterPoint(originAnchor);
    const to = adapter.fieldToCenterPoint(footprint.anchor);
    if (!from.ok || !to.ok || !("point" in from) || !("point" in to))
        throw new Error("Cannot translate tactical anchor to Foundry position.");
    const updates = { x: Number(origin.x) + to.point.x - from.point.x, y: Number(origin.y) + to.point.y - from.point.y };
    const verified = adapter.tokenToFootprint(token, { position: { ...origin, ...updates } });
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
export function foundryBeforeStepReaction({ game, scene, token, supplied, eventId, movement, step }) {
    const adapter = createFoundryV14TacticalGridAdapter({ scene });
    const sceneContext = adapter.getSceneContext();
    if (!sceneContext.ok || !("context" in sceneContext))
        throw new Error("Movement reactions require a tactical grid.");
    const origin = token.toObject(true);
    const current = adapter.tokenToFootprint(token, { position: origin });
    if (!current.ok || !("footprint" in current) || !current.footprint)
        throw new Error("Moving Token footprint is invalid.");
    const originAnchor = current.footprint.anchor;
    const observers = (supplied.movement?.observers ?? []).map(observer => {
        const result = adapter.tokenToFootprint(observer.token, { position: observer.token.toObject(true) });
        if (!result.ok || !("footprint" in result) || !result.footprint)
            throw new Error("Movement observer footprint is invalid.");
        // Legacy JS widens the canonical footprint's literal type; success was checked above.
        return { id: observer.id, footprint: result.footprint, reachFields: observer.reachFields, context: observer.context ?? {} };
    });
    const actor = token.actor;
    const source = { actorId: actor.id, actorRef: actor.uuid, tokenId: token.id, tokenRef: token.uuid };
    const event = createAutomationEvent({ id: eventId, type: PROPOSED_EVENT, phase: "interrupt", source,
        data: { ...movement, ...step, relations: movementTransitionRelations(step.previous, step.proposed, observers) } });
    const { services } = foundryMovementReactionServices({ game, token, supplied, adapter,
        sceneContext: sceneContext.context,
        targetPosition: footprint => ({ ...origin, ...footprintPositionUpdates({ adapter, token, origin, originAnchor, footprint }) }) });
    return { event, services };
}

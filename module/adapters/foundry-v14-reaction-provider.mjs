import { actionDefinitionFromAction } from "../helpers/action-definitions.mjs";
import { createReactionTrigger, reactionPolicyOf } from "../helpers/automation-events.mjs";
import { commonAction } from "../helpers/common-actions.mjs";
import { turnKey } from "./foundry-v14-persistent-areas.mjs";
const MOVEMENT_EVENT = "movement.transition-proposed";
// The JS builders are untyped; these are the only places their shapes are asserted.
const reactionTrigger = createReactionTrigger;
const policyOf = reactionPolicyOf;
const common = commonAction;
/** An Opportunity Attack's trigger: a hostile creature leaves this reactor's reach. */
// 2024: only a creature's own movement provokes; being pushed or teleported does not.
const OPPORTUNITY_PREDICATE = { all: [
        { equals: { path: "event.data.relations.{self}.leavesReach", value: true } },
        { equals: { path: "event.data.relations.{self}.context.hostile", value: true } },
        { not: { oneOf: { path: "event.data.movementKind", values: ["forced", "teleport"] } } }
    ] };
const definitionFor = actionDefinitionFromAction;
/**
 * Production reaction services, derived from the world: every other Token on the acting Token's Scene whose
 * Actor has an active Item with a `Trigger` RuleElement of kind `reaction` becomes a reactor, for any event
 * (movement steps, `action.declared`, `attack.hit`, ...). The trigger's Action is the Item itself (an Action
 * Item) or the Action named by `data.reaction.actionId`. Reactors to movement also become observers: reach
 * in fields from that Action's reach range, hostility from Token dispositions. `{self}` stands for this
 * reactor's Token id in predicate paths (`event.data.relations.{self}.leavesReach`) and in `match` values
 * (`match: {targetTokenId: "{self}"}`: "an attack on me").
 */
export function createFoundryReactionProvider({ resolve = defaultResolve } = {}) {
    return function reactionServices(context = {}) {
        const scene = context.scene ?? resolve(context.intent?.sceneRef);
        const mover = context.token ?? resolve(context.intent?.tokenRef);
        if (!scene?.tokens || !mover)
            return {};
        const triggers = [];
        const observers = [];
        // 2024 Disengage: the mover's movement provokes no Opportunity Attacks this turn; Flyby: none while it flies.
        const avoidance = mover.actor?.getOpportunityAttackAvoidance?.() ?? { always: false, movementModes: [] };
        const disengaged = (mover.actor?.statuses?.has("disengaged") === true) || avoidance.always;
        for (const token of scene.tokens) {
            if (!token.actor)
                continue;
            // Its own Action's outcome (2014 Divine Smite: "when you hit"): only its triggers bound to `sourceTokenId: "{self}"`.
            if (token.id === mover.id) {
                triggers.push(...ownActionReactions(token).map(entry => entry.trigger));
                continue;
            }
            const reactions = tokenReactions(token);
            // Every creature makes Opportunity Attacks (Baldur's Gate 3), unless an Item of its own reacts to movement,
            // even one switched off or set to Never.
            if (!disengaged && !ownsMovementReaction(token))
                reactions.push(...opportunityAttack(token, avoidance.movementModes));
            triggers.push(...reactions.map(entry => entry.trigger));
            const watching = reactions.filter(entry => entry.event === MOVEMENT_EVENT);
            if (watching.length)
                observers.push({
                    id: token.id,
                    token,
                    reachFields: Math.max(...watching.map(entry => reachFields(entry.definition, scene))),
                    context: { hostile: isHostile(token, mover) }
                });
        }
        return triggers.length ? { reactions: { triggers }, ...(observers.length ? { movement: { observers } } : {}) } : {};
    };
}
function tokenReactions(token) {
    const actor = token.actor;
    const items = [...(actor.items ?? [])];
    return items.flatMap(item => {
        if (item.system?.active === false)
            return [];
        return (item.system?.ruleElements ?? []).flatMap(element => {
            const data = (element.data ?? {});
            if ((element.type !== "Trigger") || (element.enabled === false))
                return [];
            const event = String(data.event ?? data.eventType ?? "");
            if (((data.kind ?? data.triggerKind) !== "reaction") || !event)
                return [];
            const actionItem = item.type === "action" ? item
                : items.find(entry => (entry.type === "action")
                    && (entry.system?.definition?.id === data.reaction?.actionId));
            const definition = actionItem ? definitionFor(actionItem) : null;
            if (!definition?.ok || !definition.definition)
                return [];
            // A reaction set to "Never" is not offered; one set to "Always" is used without asking.
            const policy = policyOf(actionItem);
            if (policy === "never")
                return [];
            const trigger = reactionTrigger({
                id: `reaction:${token.id}:${item.id}:${String(element.id ?? "trigger")}`,
                event,
                match: bindSelfValues(data.match ?? { phase: "interrupt" }, token.id),
                actorId: actor.uuid,
                tokenId: token.id,
                action: definition.definition,
                actionId: definition.definition.id ?? null,
                // Offered only when its Action's own costs can be paid (a Reaction, or none for a Divine Smite).
                cost: definition.definition.costs ?? null,
                // A reaction to its own Action comes after its targets' (a Parry may turn the hit into a miss first).
                ...((data.match?.sourceTokenId === "{self}") ? { priority: 200 } : {}),
                predicate: bindSelf(data.triggerPredicate ?? data.eventPredicate ?? null, token.id),
                ...(policy === "always" ? { metadata: { reactionPolicy: policy } } : {})
            });
            return [{ trigger, event, definition: definition.definition, data }];
        });
    });
}
/**
 * `token`'s reactions to its own Action (`sourceTokenId: "{self}"`). One marked `onlyWithoutOtherSlotSpell` (Paladin's
 * Smite's 2014 Divine Smite) is offered only while its creature has cast no spell with a slot this combat turn other
 * than a `smite` (`flags.wildpath.slotSpellTurn`, recordSlotSpell); while it is, its creature's other `smite` reactions
 * (the 2024 spell) are not.
 */
function ownActionReactions(token) {
    const own = tokenReactions(token).filter(entry => entry.trigger.event?.sourceTokenId === token.id);
    const combat = globalThis.game?.combat;
    const turn = combat?.started ? turnKey(combat) : null;
    const casting = (turn !== null) && (token.actor?.flags?.wildpath?.slotSpellTurn === turn);
    const free = own.filter(entry => entry.data.onlyWithoutOtherSlotSpell === true);
    if (casting || !free.length)
        return own.filter(entry => !free.includes(entry));
    return own.filter(entry => free.includes(entry) || !(entry.definition.tags ?? []).includes("smite"));
}
/** Whether any Item of `token`'s creature has a reaction to movement, active or not. */
function ownsMovementReaction(token) {
    return [...(token.actor?.items ?? [])].some(item => (item.system?.ruleElements ?? []).some(element => (element.type === "Trigger")
        && (element.data?.kind === "reaction") && (element.data?.event === MOVEMENT_EVENT)));
}
/** The common Opportunity Attack of `token`'s creature, unless it is set to Never; never against movement in `avoidedModes`. */
function opportunityAttack(token, avoidedModes = []) {
    const localize = (key) => globalThis.game?.i18n?.localize(key) ?? key;
    const action = common(token.actor, "opportunity", { localize });
    const definition = action ? definitionFor(action) : null;
    const policy = action ? policyOf(action) : "never";
    if ((policy === "never") || !definition?.ok || !definition.definition)
        return [];
    const trigger = reactionTrigger({
        id: `reaction:${token.id}:common-opportunity`,
        event: MOVEMENT_EVENT,
        match: { phase: "interrupt" },
        actorId: token.actor.uuid,
        tokenId: token.id,
        action: definition.definition,
        actionId: definition.definition.id ?? null,
        predicate: bindSelf(avoidedModes.length ? { all: [...OPPORTUNITY_PREDICATE.all,
                { not: { oneOf: { path: "event.data.movementMode", values: [...avoidedModes] } } }] } : OPPORTUNITY_PREDICATE, token.id),
        ...(policy === "always" ? { metadata: { reactionPolicy: policy } } : {})
    });
    return [{ trigger, event: MOVEMENT_EVENT, definition: definition.definition, data: {} }];
}
/** Reach in grid fields from the reaction Action's reach range (5 ft by default). */
function reachFields(definition, scene) {
    const range = (definition.range ?? {});
    const feet = (range.type === "reach") && Number.isFinite(range.distance?.value) ? range.distance.value : 5;
    const fieldSize = Number(scene.grid?.distance) || 5;
    return Math.max(1, Math.floor(feet / fieldSize));
}
/** Friendly and hostile Tokens are hostile to each other; neutral Tokens are hostile to no one. */
function isHostile(token, mover) {
    return ((token.disposition ?? 0) * (mover.disposition ?? 0)) < 0;
}
/** Replace `{self}` in predicate `path`s with this reactor's observer id. */
export function bindSelf(predicate, observerId) {
    if (Array.isArray(predicate))
        return predicate.map(entry => bindSelf(entry, observerId));
    if (!predicate || (typeof predicate !== "object"))
        return predicate;
    return Object.fromEntries(Object.entries(predicate).map(([key, value]) => [key,
        (key === "path") && (typeof value === "string") ? value.replaceAll("{self}", observerId) : bindSelf(value, observerId)]));
}
/** Replace a `match` value of exactly `{self}` with this reactor's Token id. */
function bindSelfValues(match, tokenId) {
    return Object.fromEntries(Object.entries(match).map(([key, value]) => [key, value === "{self}" ? tokenId : value]));
}
function defaultResolve(uuid) {
    const fromUuidSync = globalThis.fromUuidSync;
    return (typeof uuid === "string") && uuid && fromUuidSync ? fromUuidSync(uuid) : null;
}

import { actionDefinitionFromAction } from "../helpers/action-definitions.mjs";
import { createAutomationEvent, createTriggerDefinition, evaluateTrigger, reactionPolicyOf } from "../helpers/automation-events.mjs";
import { sunlightContext } from "./foundry-v14-sunlight.mjs";
import { tokensAround } from "./foundry-v14-auras.mjs";
import { conditionsFrom, effectsFrom } from "../helpers/effect-sources.mjs";
/**
 * The creatures a creature has swallowed (a Purple Worm's Swallow): on its scene, those with Total Cover it gave them,
 * as only a swallow does.
 */
const swallowedBy = (actor, token) => [...(token?.parent?.tokens ?? [])]
    .filter((other, index, all) => (other.id !== token?.id) && other.actor
    && conditionsFrom(other.actor, actor).coverTotal
    // A linked creature with two Tokens here is still one creature.
    && (all.findIndex(entry => entry.actor === other.actor) === index));
/** Whether a creature is immune to an Action for now (a success's "immune to this Fear Aura for 24 hours"). */
const immuneTo = (actor, actionId) => [...(actor?.effects ?? [])].some(effect => !effect.disabled && (effect.flags?.wildpath?.conditionEffect?.metadata
    ?.immuneTo === actionId));
/** The query a Player's client uses to report an event on an Actor it owns to the active GM. */
export const AUTOMATION_QUERY = "wildpath.automationEvent";
// Events a client may report, with the only data the GM takes from it. The GM raises turn and initiative events itself.
const REPORTED_EVENTS = {
    "rest.completed": data => ({ restType: ["shortRest", "longRest"].includes(String(data.restType)) ? data.restType : null })
};
const definitionFor = actionDefinitionFromAction;
const triggerDefinition = createTriggerDefinition;
const triggerMatches = evaluateTrigger;
const automationEvent = createAutomationEvent;
/**
 * Runs an Action the authority starts itself (a lasting area's effect, an automatic trigger) with one creature as
 * its only target, and waits for it to finish. Saves route to that creature's controller, as for any Action.
 * Returns the final state, or null when the Action could not start.
 */
export async function runAuthorityAction({ coordinator, resolveAction, senderUserId, resolutionId, definition, label, actorRef, source, target = null, targets = null, configuration = null, logger = globalThis.console }) {
    // Several creatures at once (an aura's): one Action, one damage roll for all of them (2024).
    const targetRefs = targets?.length ? targets : [target];
    const action = { id: String(definition.id), uuid: null, type: "action", name: String(definition.label ?? label),
        system: { definition: { ...definition, targeting: { type: (targetRefs.length > 1) ? "multiple" : "single", required: true,
                    count: targetRefs.length } } } };
    // Its choices, when already made (a "you can" set to Always); otherwise the authority asks for them.
    const resolved = await resolveAction({ intent: { actorRef, source, targetRefs, ...(configuration ? { configuration } : {}) },
        senderUserId, action });
    if (!resolved.ok) {
        logger.warn("Wild Path | An automatic effect could not resolve", resolved.reason ?? resolved);
        return null;
    }
    let finish = () => { };
    const finished = new Promise(resolve => { finish = resolve; });
    const hosted = await coordinator.resolveAuthorityAction({ resolutionId, resolved,
        onComplete: ({ state }) => finish(state) });
    // An id already used is never run again, so nothing would finish it: never wait on one.
    if (hosted.duplicate)
        return hosted.state ?? null;
    const terminal = ["completed", "failed", "cancelled"].includes(String(hosted.state?.status));
    return (hosted.ok || terminal) ? await finished : hosted.state ?? { status: "failed" };
}
/** The turn boundary each repeated save waits for. */
const REPEAT_SAVE_EVENTS = { "turn.ended": "turnEnd", "turn.started": "turnStart" };
/**
 * The saves a creature repeats at this turn boundary (2024 Hold Person: "At the end of each of its turns, the target
 * repeats the save, ending the spell on itself on a success"): one per Action and source, with every effect that
 * save ends. Each effect stored its save (`metadata.repeatSave`: timing, ability, DC) when it was applied.
 */
export function repeatSaveGroups(effects, eventType) {
    const timing = REPEAT_SAVE_EVENTS[eventType];
    const groups = new Map();
    if (!timing)
        return [];
    for (const effect of effects) {
        const flag = effect.flags?.wildpath?.conditionEffect;
        const repeat = flag?.metadata?.repeatSave;
        if (effect.disabled || (repeat?.timing !== timing) || !repeat.ability || !Number.isFinite(Number(repeat.dc)))
            continue;
        const key = `${String(flag?.metadata?.actionDefinitionId ?? effect.id)}|${String(flag?.sourceRef ?? "")}`;
        const group = groups.get(key) ?? { key, name: String(effect.name ?? ""), ability: repeat.ability, dc: Number(repeat.dc), effectIds: [] };
        group.effectIds.push(effect.id);
        groups.set(key, group);
    }
    return [...groups.values()];
}
/**
 * An Actor's automatic triggers that answer `event`: `Trigger` RuleElements of kind `automation` (the default) on
 * its active Items and enabled effects. Condition effects answer through their own lifecycle and are skipped. The
 * Action is the trigger's inline `action`, the Item itself when it is an Action, or the Action Item `actionId` names.
 */
export function automationTriggers(actor, event, context = {}) {
    const items = [...(actor.items ?? [])];
    const owners = [...items.filter(item => item.system?.active !== false),
        ...[...(actor.effects ?? [])].filter(effect => !effect.disabled && (effect.type !== "condition"))];
    return owners.flatMap(owner => (owner.system?.ruleElements ?? []).flatMap(element => {
        const data = element.data ?? {};
        if ((element.type !== "Trigger") || (element.enabled === false)
            || ((data.kind ?? data.triggerKind ?? "automation") !== "automation"))
            return [];
        const type = data.event ?? data.eventType ?? data.match?.type;
        if (!type)
            return [];
        const trigger = triggerDefinition({ id: `automation:${actor.id}:${owner.id}:${element.id ?? "trigger"}`, event: type,
            match: data.match ?? {}, predicate: data.triggerPredicate ?? data.eventPredicate ?? data.predicate ?? null });
        // Predicates also see the creature (`actor.system.resources.health.value`: Regeneration needs 1 Hit Point) and
        // whether it stands in sunlight (`inSunlight`: a Vampire's).
        if (!triggerMatches(trigger, event, { actor, ...context }).ok)
            return [];
        const actionItem = owner.type === "action" ? owner
            : items.find(entry => (entry.type === "action") && (entry.system?.definition?.id === data.actionId));
        const definition = data.action ?? (actionItem ? definitionFor(actionItem).definition : null);
        // Its Item's reaction setting (Always, Never, Ask) answers a "you can" (`use`) choice. `around` (`{radius, affects}`):
        // it acts on each creature in its creature's Emanation instead of on its creature.
        return definition ? [{ id: String(trigger.id), definition, label: owner.name ?? String(definition.label ?? ""),
                policy: reactionPolicyOf(owner), around: data.around ?? null }] : [];
    }));
}
/**
 * The general automation dispatcher: an event on a creature (its turn starts or ends, it rolls initiative, it
 * finishes a rest) runs each of its automatic triggers as an authority Action on that creature. Only the active
 * GM dispatches; another client reports a rest through a user query, which the GM accepts for an owned Actor.
 */
export function createFoundryAutomationDispatcher({ game, coordinator, resolveAction, logger = globalThis.console, fromUuid = null }) {
    let sequence = 0;
    // A swallower's Hit Points as each creature it swallowed starts its turn (`on: "swallowed"`), by swallower and creature.
    const swallowerHealth = new Map();
    const isActiveGM = () => game.users?.activeGM?.id === game.user.id;
    async function dispatch(type, { actor, token = null, data = {} }) {
        if (!actor || !isActiveGM())
            return [];
        const event = automationEvent({ id: `${type}:${actor.uuid}:${++sequence}`, type, actorId: actor.id,
            tokenId: token?.id ?? null, data });
        const self = { actorRef: actor.uuid, ...(token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}) };
        const states = [];
        // Predicates see its conditions too ("unless the azer has the Incapacitated condition").
        const context = { ...sunlightContext(token), conditions: [...(actor.statuses ?? [])] };
        for (const { id, definition, label, policy, around } of automationTriggers(actor, event, context)) {
            if (["others", "swallowed"].includes(String(around?.on)))
                continue;
            // A "you can" (Persistent Rage when initiative is rolled): Never skips it, Always uses it, Ask asks its controller.
            const optional = (definition.configuration ?? []).some(choice => choice.id === "use");
            if (optional && (policy === "never"))
                continue;
            // Everyone in the Emanation (or swallowed) at once: one Action, one damage roll (2024).
            const targets = around ? (around.swallowed ? swallowedBy(actor, token)
                : tokensAround(token, around)).filter(other => !immuneTo(other.actor, definition.id))
                .map(other => ({ actorRef: other.actor?.uuid ?? null, tokenId: other.id, sceneId: token?.parent?.id })) : [self];
            if (!targets.length)
                continue;
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `${id}:${sequence}`, definition, label, actorRef: actor.uuid,
                source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}, targets: targets,
                ...((optional && (policy === "always")) ? { configuration: { choices: { use: "use" } } } : {}) });
            if (state)
                states.push(state);
        }
        // Others' auras around it (a Pit Fiend's Fear Aura: "any enemy that starts its turn in the aura").
        const placed = token;
        for (const bearer of (["turn.started", "turn.ended"].includes(type) && placed?.parent?.tokens) ? [...placed.parent.tokens] : []) {
            if ((bearer.id === placed?.id) || !bearer.actor)
                continue;
            // Swallowed by it: its Hit Points as this turn starts, and its regurgitating save as it ends (regurgitate).
            if (conditionsFrom(actor, bearer.actor).coverTotal) {
                const key = `${bearer.actor.uuid}:${actor.uuid}`;
                const health = Number(bearer.actor.system?.resources?.health?.value) || 0;
                if (type === "turn.started")
                    swallowerHealth.set(key, health);
                else if (swallowerHealth.has(key)) {
                    const lost = (swallowerHealth.get(key) ?? 0) - health;
                    swallowerHealth.delete(key);
                    states.push(...await regurgitate(bearer, lost, `${sequence}:${bearer.id}:${placed?.id}`));
                }
            }
            const theirs = { ...sunlightContext(bearer), conditions: [...(bearer.actor.statuses ?? [])] };
            for (const { id, definition, label, around } of automationTriggers(bearer.actor, event, theirs)) {
                if ((around?.on !== "others") || immuneTo(actor, definition.id)
                    || !tokensAround(bearer, around).some(other => other.id === placed?.id))
                    continue;
                const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                    resolutionId: `${id}:${sequence}:${bearer.id}:${placed?.id}`, definition, label, actorRef: bearer.actor.uuid,
                    source: { tokenId: bearer.id, sceneId: placed?.parent?.id }, target: self });
                if (state)
                    states.push(state);
            }
        }
        // A table its effect draws as its turn starts (2024 Confusion's behavior), posted as its creature's.
        if (type === "turn.started")
            await drawTurnTables(actor);
        // Repeated saves: the creature rolls each again as its own Action; a success ends what that save let in.
        for (const group of repeatSaveGroups((actor.effects ?? []), type)) {
            const definition = { schemaVersion: 1, id: `action:repeat-save:${group.key}`, label: group.name, costs: { allOf: [] },
                save: { ability: group.ability, dc: { value: group.dc } } };
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `repeat-save:${actor.id}:${sequence}:${group.key}`, definition, label: group.name, actorRef: actor.uuid,
                source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}, target: self });
            if (state)
                states.push(state);
            if (state?.results?.saveResolution?.successes?.length) {
                const present = group.effectIds.filter(effectId => actor.effects?.get?.(effectId));
                if (present.length)
                    await actor
                        .deleteEmbeddedDocuments?.("ActiveEffect", present);
            }
        }
        return states;
    }
    /**
     * A swallower that lost `lost` Hit Points on a swallowed creature's turn (2024 Purple Worm: "takes 30 damage or more on
     * a single turn from a creature inside it"): at its threshold it saves (its `on: "swallowed"` Trigger's Action), and
     * on a failure every creature it swallowed comes out beside it, Prone, without what the swallow gave it.
     */
    async function regurgitate(bearer, lost, key) {
        const states = [];
        for (const { id, definition, label, around } of automationTriggers(bearer.actor, { type: "turn.ended" }, {})) {
            if ((around?.on !== "swallowed") || !(lost >= (Number(around.threshold) || Infinity)))
                continue;
            const self = { actorRef: bearer.actor?.uuid, tokenId: bearer.id, sceneId: bearer.parent?.id };
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `${id}:${key}`, definition, label, actorRef: String(bearer.actor?.uuid), source: { tokenId: bearer.id,
                    sceneId: bearer.parent?.id }, target: self });
            if (state)
                states.push(state);
            // Only a save it failed lets them out (not a save that never resolved).
            if (!state?.results?.saveResolution?.failures?.length)
                continue;
            const held = swallowedBy(bearer.actor, bearer);
            const size = Number(bearer.parent?.grid?.size) || 100;
            const at = bearer;
            for (const [index, other] of held.entries()) {
                const actor = other.actor;
                const ids = effectsFrom(actor, bearer.actor).map(effect => effect.id);
                if (ids.length)
                    await actor?.deleteEmbeddedDocuments?.("ActiveEffect", ids);
                if (!actor?.statuses?.has?.("prone"))
                    await actor?.toggleCondition?.("prone");
                // "falls in a space within 5 feet": the next free spaces down its right side.
                await other.move?.([{ x: (at.x ?? 0) + ((Number(at.width) || 1) * size),
                        y: (at.y ?? 0) + (index * size), action: "displace" }]);
            }
        }
        return states;
    }
    /** From any client: the active GM dispatches at once, another client reports the event to it. */
    async function report(type, { actor, data = {} }) {
        if (isActiveGM())
            return dispatch(type, { actor, data });
        try {
            await game.users?.activeGM?.query?.(AUTOMATION_QUERY, { type, actorUuid: actor.uuid, data }, { timeout: 15000 });
        }
        catch (error) {
            logger.warn(`Wild Path | The GM could not be told about ${type}`, error);
        }
        return [];
    }
    /** The GM's query handler: a reportable event, on an Actor the server-attested sender owns. */
    async function handleQuery(payload = {}, { user = null } = {}) {
        const sanitize = REPORTED_EVENTS[String(payload.type)];
        if (!sanitize || !user || (typeof payload.actorUuid !== "string"))
            return { ok: false };
        const actor = await fromUuid?.(payload.actorUuid);
        if (!actor?.testUserPermission?.(user, "OWNER"))
            return { ok: false };
        // Answer at once: the Actions may wait on prompts far longer than a query lives.
        void dispatch(String(payload.type), { actor, data: sanitize((payload.data ?? {})) })
            .catch(error => logger.warn(`Wild Path | ${String(payload.type)} automation failed`, error));
        return { ok: true };
    }
    /** Each table its creature's enabled effects draw as its turn starts (`drawsAtTurnStart`), to chat as its creature's. */
    async function drawTurnTables(actor) {
        const drawn = [];
        for (const effect of [...(actor.effects ?? [])]) {
            const uuid = effect.flags?.wildpath?.conditionEffect?.definition?.drawsAtTurnStart;
            if (effect.disabled || !uuid)
                continue;
            const table = await fromUuid?.(String(uuid));
            const result = await table?.draw?.({ displayChat: false });
            if (!result?.results?.length)
                continue;
            const speaker = globalThis.ChatMessage?.getSpeaker?.({ actor });
            await table?.toMessage?.(result.results, { roll: result.roll, messageData: { speaker } });
            drawn.push(result);
        }
        return drawn;
    }
    return { dispatch, report, handleQuery };
}

import { actionDefinitionActivationCost, actionDefinitionFromAction } from "../helpers/action-definitions.mjs";
import { actionTags } from "../helpers/rule-elements.mjs";
import { resolveActorResourcePayment } from "../resolvers/resource-resolver.mjs";
import { foundryActorSystemSnapshot } from "./foundry-v14-actor-system-adapter.mjs";
import { effectGroupKey } from "../helpers/common-actions.mjs";
import { AUTOMATION_EVENT_TYPES, createAutomationEvent, createTriggerDefinition, evaluateTrigger, reactionPolicyOf } from "../helpers/automation-events.mjs";
import { sunlightContext } from "./foundry-v14-sunlight.mjs";
import { environmentContext } from "./foundry-v14-environment.mjs";
import { tokensAround } from "./foundry-v14-auras.mjs";
import { conditionsFrom, effectsFrom } from "../helpers/effect-sources.mjs";
import { durationSeconds } from "../helpers/metamagic.mjs";
import { creatureToken } from "./foundry-v14-creature-tokens.mjs";
import { gmNotice } from "../helpers/gm-notice.mjs";
/**
 * The creatures a creature has swallowed (a Purple Worm's Swallow): on its scene, those with Total Cover it gave them,
 * as only a swallow does.
 */
const swallowedBy = (actor, token) => heldBy(actor, token, { condition: "coverTotal", from: "it" });
const fromSource = conditionsFrom;
/**
 * The creatures on its scene a condition binds to a creature (`around: {condition, from}`): those holding it from that
 * creature (`from: "it"`: grappled by it), those it holds it from (`"them"`: grappling it), or both (`"either"`). Only
 * an effect naming its source counts: a condition toggled by hand names nobody. Any other `from` (none, misspelled)
 * reaches nobody, never both ways.
 */
function heldBy(actor, token, { condition, from }) {
    const key = String(condition);
    const byIt = ["it", "either"].includes(String(from)), byThem = ["them", "either"].includes(String(from));
    return [...(token?.parent?.tokens ?? [])].filter((other, index, all) => (other.id !== token?.id) && other.actor
        && ((byIt && fromSource(other.actor, actor)[key]) || (byThem && fromSource(actor, other.actor)[key]))
        // A linked creature with two Tokens here is still one creature.
        && (all.findIndex(entry => entry.actor === other.actor) === index));
}
/**
 * Whether a creature is immune to an Action for now (a success's "immune to this Fear Aura for 24 hours"): its Unaffected
 * rule, or the `metadata.immuneTo` mark effects converted before that rule still carry.
 */
const immuneTo = (actor, definition) => Boolean(actor?.unaffectingRule?.(definition)) || [...(actor?.effects ?? [])].some(effect => !effect.disabled
    && (effect.flags?.wildpath?.conditionEffect?.metadata
        ?.immuneTo === definition.id));
/** The query a Player's client uses to report an event on an Actor it owns to the active GM. */
export const AUTOMATION_QUERY = "wildpath.automationEvent";
// Events a client may report, with the only data the GM takes from it. The GM raises turn and initiative events itself.
const REPORTED_EVENTS = {
    "rest.completed": data => ({ restType: ["shortRest", "longRest"].includes(String(data.restType)) ? data.restType : null })
};
const definitionFor = actionDefinitionFromAction;
const triggerDefinition = createTriggerDefinition;
const triggerMatches = evaluateTrigger;
/**
 * Whether its creature can pay for a Trigger's Action now (a pool spent until a Long Rest): the pipeline would only refuse
 * it, after asking its controller "you can" and its pick. A creature with no snapshot is left to the pipeline to refuse.
 */
function affordable(actor, definition) {
    const cost = actionDefinitionActivationCost(definition);
    if (!cost.anyOf && !cost.allOf?.length)
        return true;
    let actorSystem;
    try {
        actorSystem = foundryActorSystemSnapshot(actor);
    }
    catch {
        return true;
    }
    return resolveActorResourcePayment({ actorSystem, cost, action: { tags: actionTags(definition) } }).ok;
}
const automationEvent = createAutomationEvent;
const { EFFECT_ENDED, TIME_ELAPSED } = AUTOMATION_EVENT_TYPES;
// One time change runs an interval at most 24 times (that many chat cards); the rest of a larger jump is dropped.
const MAX_INTERVAL_RUNS = 24;
/**
 * The creatures world time passes for: every Token's creature (an unlinked Token's own synthetic Actor, a linked one's
 * world Actor) and every world Actor whose prototype is linked. A world Actor with an unlinked prototype is a template;
 * only its Tokens are in play, and they would inherit what it counted.
 */
export function worldCreatures(game) {
    const creatures = new Set([...(game.actors ?? [])].filter(actor => actor.prototypeToken?.actorLink !== false));
    for (const scene of game.scenes ?? [])
        for (const token of scene.tokens ?? [])
            if (token.actor)
                creatures.add(token.actor);
    return [...creatures];
}
/**
 * Runs an Action the authority starts itself (a lasting area's effect, an automatic trigger) with one creature as
 * its only target, and waits for it to finish. Saves route to that creature's controller, as for any Action.
 * Returns the final state, or null when the Action could not start.
 */
export async function runAuthorityAction({ coordinator, resolveAction, senderUserId, resolutionId, definition, label, actorRef, source, target = null, targets = null, configuration = null, sourceEvent = null, initiatorUserId = null, origin = null, logger = globalThis.console }) {
    // Several creatures at once (an aura's): one Action, one damage roll for all of them (2024). Or the creatures its
    // controller picks one of (`targetChoice`), each prepared as a target so the one picked rolls its own save.
    const targetRefs = targets?.length ? targets : [target];
    const one = (targetRefs.length === 1) || ["creatures", "around"].includes(String(definition.targetChoice?.from));
    const action = { id: String(definition.id), uuid: null, type: "action", name: String(definition.label ?? label),
        system: { definition: { ...definition, targeting: { type: one ? "single" : "multiple", required: true,
                    count: one ? 1 : targetRefs.length } } } };
    // Its choices, when already made (a "you can" set to Always); otherwise the authority asks for them.
    // `origin` beside the intent, never in it: only the authority's own callers give one, and the transport would strip it.
    const intended = await resolveAction({ intent: { actorRef, source, targetRefs, ...(configuration ? { configuration } : {}) },
        senderUserId, action, ...(origin ? { origin } : {}) });
    if (!intended.ok) {
        logger.warn("Wild Path | An automatic effect could not resolve", intended.reason ?? intended);
        return null;
    }
    // The event it answers (`sourceEvent`), which a pick of its target needs (the pipeline's chosenTarget).
    const resolved = sourceEvent ? { ...intended, options: { ...(intended.options ?? intended), sourceEvent } } : intended;
    let finish = () => { };
    const finished = new Promise(resolve => { finish = resolve; });
    // On behalf of the user whose Action it follows (`initiatorUserId`), who answers its choices; else the authority's own.
    const hosted = await coordinator.resolveAuthorityAction({ resolutionId, resolved, initiatorUserId,
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
 * repeats the save, ending the spell on itself on a success"), or as it takes damage (`damage.taken`, `onDamage`:
 * Dominate Person): one per Action and source, with every effect that save ends. Each effect stored its save
 * (`metadata.repeatSave`: timing, onDamage, ability, DC) when it was applied.
 */
export function repeatSaveGroups(effects, eventType) {
    const timing = REPEAT_SAVE_EVENTS[eventType];
    const damaged = eventType === "damage.taken";
    const groups = new Map();
    if (!timing && !damaged)
        return [];
    for (const effect of effects) {
        const flag = effect.flags?.wildpath?.conditionEffect;
        const repeat = flag?.metadata?.repeatSave;
        if (effect.disabled || !repeat || (damaged ? (repeat.onDamage !== true) : (repeat.timing !== timing)) || !repeat.ability
            || !Number.isFinite(Number(repeat.dc)))
            continue;
        const key = effectGroupKey(effect);
        // A save its creature's damage brought is tagged so (`repeat:damaged`: Hideous Laughter's Advantage on it).
        const group = groups.get(key) ?? { key, name: String(effect.name ?? ""), ability: repeat.ability, dc: Number(repeat.dc), effectIds: [],
            against: [], tags: [...(Array.isArray(repeat.tags) ? repeat.tags.filter(tag => typeof tag === "string") : []),
                ...(damaged ? ["repeat:damaged"] : [])] };
        group.effectIds.push(effect.id);
        // What a failure deals (Phantasmal Killer's Psychic damage again), from the first of its effects that says. Never on a
        // save its damage brought: that damage would bring the save again, and again on each failure.
        if (!damaged && Array.isArray(repeat.damage) && repeat.damage.length)
            group.damage ??= repeat.damage;
        // The conditions it ends, which the save is against (Antitoxin: Advantage on saves to end Poisoned).
        for (const status of effect.statuses ?? [])
            if (!group.against.includes(status))
                group.against.push(status);
        groups.set(key, group);
    }
    return [...groups.values()];
}
/** The cost-free Action a repeated save is rolled as (a repeatSaveGroups group); a success ends the group's effects. */
export function repeatSaveDefinition(group) {
    // Its Action's tags (`spell`), so the repeated save is against a spell too (Magic Resistance).
    return { schemaVersion: 1, id: `action:repeat-save:${group.key}`, label: group.name, costs: { allOf: [] },
        ...(group.tags.length ? { tags: group.tags } : {}), save: { ability: group.ability, dc: { value: group.dc }, ...(group.against.length ? { against: group.against } : {}) } };
}
/**
 * The damage a failed repeat deals (`repeatDamage`), as an Action of its own run after the save fails, or null. It is
 * untagged, as a condition's damage (Bleeding) or an effect's Trigger (Ensnaring Strike) is: it runs as the saving
 * creature, so its save's tags (`spell`, `school:evocation`) would give it that creature's own spell-damage rules
 * (Empowered Evocation, Elemental Adept) on damage it takes.
 */
export function repeatDamageDefinition(group) {
    return group.damage?.length ? { schemaVersion: 1, id: `action:repeat-damage:${group.key}`, label: group.name, costs: { allOf: [] },
        damage: group.damage.map(({ saveOutcomePolicy: _policy, ...component }) => component) } : null;
}
/** Its creature's Action Item whose definition has this id (a Trigger's `actionId`, an option's `useAction`). */
const actionItemOf = (items, id) => items.find(entry => (entry.type === "action") && (entry.system?.definition?.id === id));
/** A creature's Tokens on a scene as an authority Action's targets. */
const placedTargets = (list, sceneId) => list.map(other => ({ actorRef: other.actor?.uuid ?? null, tokenId: other.id, sceneId }));
/**
 * An Actor's automatic triggers that answer `event`: `Trigger` RuleElements of kind `automation` (the default) on
 * its active Items and enabled effects, or on `owners` alone when given (an effect that just ended: only its own).
 * Condition effects answer through their own lifecycle and are skipped. The Action is the trigger's inline `action`,
 * the Item itself when it is an Action, or the Action Item `actionId` names.
 */
export function automationTriggers(actor, event, context = {}, owners = null) {
    const items = [...(actor.items ?? [])];
    const answering = owners ?? [...items.filter(item => item.system?.active !== false),
        ...[...(actor.effects ?? [])].filter(effect => !effect.disabled && (effect.type !== "condition"))];
    const health = actor.system?.resources?.health;
    const damaged = Number(health?.value) < Number(health?.max);
    return answering.flatMap(owner => (owner.system?.ruleElements ?? []).flatMap((element, index) => {
        const data = element.data ?? {};
        if ((element.type !== "Trigger") || (element.enabled === false)
            || ((data.kind ?? data.triggerKind ?? "automation") !== "automation"))
            return [];
        const type = data.event ?? data.eventType ?? data.match?.type;
        if (!type)
            return [];
        // An id-less rule is told apart by its place, as normalizeRuleElementDefinition names it.
        const elementId = String(element.id ?? `Trigger:${index}`);
        const trigger = triggerDefinition({ id: `automation:${actor.id}:${owner.id}:${elementId}`, event: type,
            match: data.match ?? {}, predicate: data.triggerPredicate ?? data.eventPredicate ?? data.predicate ?? null });
        // Predicates also see the creature (`actor.system.resources.health.value`: Regeneration needs 1 Hit Point), the Item
        // or effect carrying the Trigger (`owner.system.attunement`: a ring that works only attuned), whether its creature
        // is missing Hit Points (`damaged`: an interval's healing stops once it is full), whether it stands in sunlight
        // (`inSunlight`: a Vampire's) and what place it stands in (`environment.runningWater`: a Vampire's Running Water).
        if (!triggerMatches(trigger, event, { actor, owner, damaged, ...context }).ok)
            return [];
        const actionItem = owner.type === "action" ? owner : actionItemOf(items, data.actionId);
        const definition = data.action ?? (actionItem ? definitionFor(actionItem).definition : null);
        // Its Item's reaction setting (Always, Never, Ask) answers a "you can" (`use`) choice. `around` (`{radius, affects}`):
        // it acts on each creature in its creature's Emanation instead of on its creature.
        // `every` (`{value, units}`): a `time.elapsed` Trigger's interval, in seconds, its carry kept under `carryKey` (no
        // dots: a flag path would nest at them).
        return definition ? [{ id: String(trigger.id), definition, label: owner.name ?? String(definition.label ?? ""),
                policy: reactionPolicyOf(owner), around: data.around ?? null,
                owner, carryKey: elementId.replaceAll(".", "-"), every: durationSeconds(data.every) }] : [];
    }));
}
/**
 * 2024 Suffocating: a creature holds its breath for 1 + its Constitution modifier minutes (30 seconds at least), counted
 * in its turns (`flags.wildpath.breathLeft` on its `suffocating` effect); out of breath, it gains a level of Exhaustion at
 * the end of each of its turns (`exhaustionGained`).
 */
export async function suffocate(actor) {
    const effect = [...(actor.effects ?? [])].find(entry => !entry.disabled
        && entry.statuses?.has?.("suffocating"));
    if (!effect?.setFlag)
        return false;
    const fortitude = Math.floor(((Number(actor.system?.abilities?.fortitude?.value) || 10) - 10) / 2);
    const breath = effect.flags?.wildpath?.breathLeft ?? Math.max(10 * (1 + fortitude), 3);
    if (breath > 0) {
        await effect.setFlag("wildpath", "breathLeft", breath - 1);
        return false;
    }
    await actor.toggleCondition?.("exhaustion", { levels: 1 });
    await effect.setFlag("wildpath", "exhaustionGained", (effect.flags?.wildpath?.exhaustionGained ?? 0) + 1);
    return true;
}
/** "When it can breathe again, it removes all levels of Exhaustion it gained from suffocating" (2024). */
export async function breatheAgain(effect) {
    const gained = Number(effect.flags?.wildpath?.exhaustionGained) || 0;
    const actor = effect.parent;
    if (gained && effect.statuses?.has?.("suffocating"))
        await actor?.toggleCondition?.("exhaustion", { levels: -gained });
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
    // An event the GM raises itself (a turn, an initiative) is a creature's: its Triggers' choices go to that creature's
    // first active non-GM owner, not to a GM the chooser finds first among the users (SOURCE_CONTROLLER takes the first
    // active one it may ask, and an Action with no initiator counts the authority as one).
    const playerOf = (actor) => [...(game.users?.values?.() ?? [])].find(user => user.active && !user.isGM
        && actor.testUserPermission?.(user, "OWNER"))?.id ?? null;
    /**
     * `tags` and `targets` are the event's (an `action.completed`'s Action: its tags, its targets), which a Trigger's
     * `match` (tagsAll, tagsAny, notTagsAny) reads. `key` names the event once and for all (the completed Action's
     * resolution id): each Trigger's run is keyed by it, so the same event never runs a Trigger twice. `initiatorUserId`:
     * the user whose Action it follows, who answers its Triggers' choices ("you can", a creature to pick).
     */
    async function dispatch(type, { actor, token = null, data = {}, owners = null, tags = [], targets = [], key = null, initiatorUserId = null }) {
        if (!actor || !isActiveGM())
            return [];
        initiatorUserId ??= playerOf(actor);
        const event = automationEvent({ id: `${type}:${actor.uuid}:${++sequence}`, type, actorId: actor.id,
            tokenId: token?.id ?? null, data, tags, targets });
        const self = { actorRef: actor.uuid, ...(token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}) };
        const states = [];
        // Predicates see its conditions too ("unless the azer has the Incapacitated condition").
        const contextOf = () => ({ ...sunlightContext(token), ...environmentContext(token), conditions: [...(actor.statuses ?? [])] });
        // Whether a trigger's predicate still holds on the creature as the Actions run so far left it.
        const stillHolds = (id) => automationTriggers(actor, event, contextOf(), owners).some(entry => entry.id === id);
        const eventSequence = key ?? sequence;
        for (const { id, definition, label, policy, around, owner, carryKey, every } of automationTriggers(actor, event, contextOf(), owners)) {
            if (["others", "swallowed"].includes(String(around?.on)))
                continue;
            // A "you can" (Persistent Rage when initiative is rolled): Never skips it, Always uses it, Ask asks its controller.
            const optional = (definition.configuration ?? []).some(choice => choice.id === "use");
            if ((optional && (policy === "never")) || !affordable(actor, definition))
                continue;
            // A creature its controller picks as it runs (`targetChoice: {from: "creatures", range, includeSelf}`: "a creature
            // you can see within 60 feet"): every creature in range, so the pipeline's pick (chosenTarget) finds the one picked
            // prepared like any target, its own save bonus and controller included. Not a hidden Token or a dead creature,
            // which the pick never offers (redirectCandidates). Or the first creature its event names (`trigger-target`: the
            // completed Action's target). Or one of those its `around` reaches (`from: "around"`: "one enemy within 5 feet of
            // it", "one creature Grappled by you"), each prepared the same way.
            const choice = definition.targetChoice;
            const picksAround = (choice?.from === "around") && Boolean(around);
            const choosing = ((choice?.from === "creatures") && !around) || picksAround;
            const placed = (list) => placedTargets(list, token?.parent?.id);
            const sceneTokens = [...(token?.parent?.tokens ?? [])];
            const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
            const pickable = (other) => (other.hidden !== true)
                && !new Set(other.actor?.statuses ?? []).has(defeated);
            const eventTarget = String(targets[0]?.tokenId ?? "");
            // Everyone in the Emanation (or swallowed, or held by a condition) at once: one Action, one damage roll (2024).
            const acted = around ? placed((around.swallowed ? swallowedBy(actor, token)
                : around.condition ? heldBy(actor, token, around)
                    : tokensAround(token, around))
                .filter(other => !immuneTo(other.actor, definition) && (!picksAround || pickable(other))))
                : choosing ? [...(choice?.includeSelf ? [self] : []), ...placed(tokensAround(token, { radius: Number(choice?.range) || 0 }).filter(pickable))]
                    : (choice?.from === "trigger-target") ? placed(sceneTokens.filter(other => (other.id === eventTarget) && other.actor))
                        : [self];
            if (!acted.length)
                continue;
            let runs = 1;
            if (type === TIME_ELAPSED) {
                // Once per interval the time covered, counting on from what earlier time changes left over (its owner's
                // `flags.wildpath.elapsed`). The rest is written before any run, so a failed or repeated run never runs twice.
                // An earlier interval's Actions may have changed the creature (healed it full): time counts only while it holds.
                if (!(every > 0) || (states.length && !stillHolds(id)))
                    continue;
                const carried = (Number(owner.flags?.wildpath?.elapsed?.[carryKey]) || 0) + Math.max(0, Number(data.seconds) || 0);
                runs = Math.min(Math.floor(carried / every), MAX_INTERVAL_RUNS);
                await owner.update?.({ [`flags.wildpath.elapsed.${carryKey}`]: carried % every });
            }
            for (let run = 0; run < runs; run++) {
                // Each further run only while its predicate still holds on the creature as the last one left it.
                if (run && !stillHolds(id))
                    break;
                const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                    resolutionId: run ? `${id}:${eventSequence}:${run}` : `${id}:${eventSequence}`, definition, label, actorRef: actor.uuid,
                    source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}, targets: acted,
                    ...(choosing ? { sourceEvent: event } : {}), initiatorUserId,
                    ...((optional && (policy === "always")) ? { configuration: { choices: { use: "use" } } } : {}) });
                if (state)
                    states.push(state);
            }
        }
        // Others' auras around it (a Pit Fiend's Fear Aura: "any enemy that starts its turn in the aura").
        const placed = token;
        for (const bearer of (["turn.started", "turn.ended"].includes(type) && placed?.parent?.tokens) ? [...placed.parent.tokens] : []) {
            if ((bearer.id === placed?.id) || !bearer.actor)
                continue;
            // Swallowed by it: its Hit Points as this turn starts, and its regurgitating save as it ends (regurgitate).
            if (fromSource(actor, bearer.actor).coverTotal) {
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
            const theirs = { ...sunlightContext(bearer), ...environmentContext(bearer), conditions: [...(bearer.actor.statuses ?? [])] };
            for (const { id, definition, label, policy, around } of automationTriggers(bearer.actor, event, theirs)) {
                // Its "can" (Stony Lethargy: "the spirit can target it") as its own triggers' "you can": Never, Always or Ask.
                const optional = (definition.configuration ?? []).some(choice => choice.id === "use");
                if ((around?.on !== "others") || (optional && (policy === "never")) || immuneTo(actor, definition)
                    || !tokensAround(bearer, around).some(other => other.id === placed?.id))
                    continue;
                const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                    resolutionId: `${id}:${sequence}:${bearer.id}:${placed?.id}`, definition, label, actorRef: bearer.actor.uuid,
                    source: { tokenId: bearer.id, sceneId: placed?.parent?.id }, target: self, initiatorUserId: playerOf(bearer.actor),
                    ...((optional && (policy === "always")) ? { configuration: { choices: { use: "use" } } } : {}) });
                if (state)
                    states.push(state);
            }
        }
        // A table its effect draws as its turn starts (2024 Confusion's behavior), posted as its creature's.
        if (type === "turn.started")
            await drawTurnTables(actor, token);
        // Suffocating, out of breath: a level of Exhaustion as its turn ends.
        if (type === "turn.ended")
            await suffocate(actor);
        // Repeated saves: the creature rolls each again as its own Action; a success ends what that save let in.
        for (const group of repeatSaveGroups((actor.effects ?? []), type)) {
            const definition = repeatSaveDefinition(group);
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `repeat-save:${actor.id}:${sequence}:${group.key}`, definition, label: group.name, actorRef: actor.uuid,
                source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}, target: self });
            if (state)
                states.push(state);
            const damage = ((state?.status === "completed") && state.results?.saveResolution?.failures?.length) ? repeatDamageDefinition(group) : null;
            if (damage) {
                const dealt = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                    resolutionId: `repeat-damage:${actor.id}:${sequence}:${group.key}`, definition: damage, label: group.name, actorRef: actor.uuid,
                    source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}, target: self });
                if (dealt)
                    states.push(dealt);
            }
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
    /**
     * The Actions a completed Action's drawn options use (`useAction`, read by usedOptionActions): each of its creature's
     * Action Items so named runs as part of that use, paying nothing, at the creatures that drew it (itself when it had
     * none, or when the used Action targets only itself), on behalf of `initiatorUserId`; keyed by `key` (the completed
     * resolution), so it never runs twice. One its creature lacks, whose creatures are no longer on the scene, or that
     * covers an area (placed by its user) is the GM's to use by hand. Active GM only.
     */
    async function useActions({ actor, token = null, uses = [], key, initiatorUserId = null }) {
        if (!actor || !isActiveGM())
            return [];
        const items = [...(actor.items ?? [])];
        const sceneTokens = [...(token?.parent?.tokens ?? [])];
        const self = { actorRef: actor.uuid, ...(token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}) };
        const states = [];
        for (const { actionId, label = null, targets } of uses) {
            const item = actionItemOf(items, actionId);
            const own = item ? definitionFor(item).definition : null;
            const targeting = String(own?.targeting?.type ?? "");
            const onSelf = ["self", "none"].includes(targeting);
            const ids = targets.map(target => target.tokenId);
            const placed = onSelf ? [] : placedTargets(sceneTokens.filter(other => ids.includes(other.id) && other.actor), token?.parent?.id);
            if (!own || (targeting === "area") || (!onSelf && ids.length && !placed.length)) {
                gmNotice("WILDPATH.NOTICE.UsedActionFailed", { name: actor.name ?? actor.id,
                    action: item?.name ?? label ?? actionId }, undefined, { game, logger });
                continue;
            }
            const { controllerCosts: _paid, ...definition } = own;
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `${key}:use:${actionId}`, definition: { ...definition, costs: { allOf: [] } }, label: String(item?.name ?? actionId),
                actorRef: actor.uuid, source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {},
                ...(placed.length ? { targets: placed } : { target: self }), initiatorUserId });
            if (state)
                states.push(state);
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
    async function drawTurnTables(actor, token) {
        const drawn = [];
        for (const effect of [...(actor.effects ?? [])]) {
            const uuid = effect.flags?.wildpath?.conditionEffect?.definition?.drawsAtTurnStart;
            if (effect.disabled || !uuid)
                continue;
            const table = await fromUuid?.(String(uuid));
            const result = await table?.draw?.({ displayChat: false });
            if (!result?.results?.length)
                continue;
            // Its turn's Token speaks (an Actor alone would get a linked Token on the GM's canvas).
            const speaker = globalThis.ChatMessage?.getSpeaker?.({ actor, token });
            await table?.toMessage?.(result.results, { roll: result.roll, messageData: { speaker } });
            drawn.push(result);
        }
        return drawn;
    }
    /**
     * An effect that ended (deleted, but not as a rollback or a replacement: `{wildpath: {ended: false}}`): its own
     * `effect.ended` Triggers run as authority Actions on its creature (Haste's lethargy). Only the active GM dispatches.
     */
    async function onEffectDeleted(effect, options = {}) {
        const actor = effect?.parent;
        if ((options?.wildpath?.ended === false) || (actor?.documentName !== "Actor")
            || !(effect.system?.ruleElements ?? []).some(rule => (rule.type === "Trigger") && (rule.data?.event === EFFECT_ENDED)))
            return [];
        return dispatch(EFFECT_ENDED, { actor, token: creatureToken(actor), data: { effectId: effect.id }, owners: [effect] });
    }
    /**
     * World time moved on by `seconds` (the updateWorldTime hook's dt): each creature's `time.elapsed` Triggers, with its
     * Token (an interval with `around` acts on those around it). Active GM only; one time change at a time, so two never
     * count the same carry.
     */
    let worldTimeQueue = Promise.resolve();
    function onWorldTime(seconds) {
        // Nothing to run: not the queue, which may still hold an earlier change's failure.
        if (!isActiveGM() || !(seconds > 0))
            return Promise.resolve();
        worldTimeQueue = worldTimeQueue.catch(() => { }).then(async () => {
            for (const actor of worldCreatures(game))
                await dispatch(TIME_ELAPSED, { actor, token: creatureToken(actor), data: { seconds } });
        });
        return worldTimeQueue;
    }
    return { dispatch, useActions, report, handleQuery, onEffectDeleted, onWorldTime };
}

import { actionDefinitionFromAction, usedDefinition } from "../helpers/action-definitions.mjs";
import { createReactionTrigger, reactionPolicyOf } from "../helpers/automation-events.mjs";
import { commonAction } from "../helpers/common-actions.mjs";
import { movementTracked, requiresContext } from "../helpers/combat.mjs";
import { turnKey } from "./foundry-v14-persistent-areas.mjs";
import { evaluateValueExpression } from "../helpers/value-expressions.mjs";
import { footprintDistance } from "../helpers/grid-footprints.mjs";
import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { ineligibleTarget, placeContext, tokenSees } from "./foundry-v14-senses.mjs";
import { tokensHostile } from "./foundry-v14-hostility.mjs";
import { deadCreature, planeOf } from "./foundry-v14-creature-tokens.mjs";
import { alliedTokens } from "./foundry-v14-auras.mjs";
import { piercesIllusion } from "../helpers/senses.mjs";
import { conditionsFrom, sourceRefDocument } from "../helpers/effect-sources.mjs";
import { evaluatePredicate } from "../helpers/predicates.mjs";
import { actionTags } from "../helpers/rule-elements.mjs";
import { replacedCosts } from "../helpers/action-configuration.mjs";
import { isUnprepared } from "../helpers/spellcasting.mjs";
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
 * Item) or the Action named by `data.reaction.actionId` (on an Action Item, another Action it answers with).
 * Reactors to movement also become observers: reach in fields from that Action's reach range, hostility from tokensHostile. `{self}` stands for this
 * reactor's Token id in predicate paths (`event.data.relations.{self}.leavesReach`) and in `match` values
 * (`match: {targetTokenId: "{self}"}`: "an attack on me"). Each event's predicates also see every reactor's relation to
 * its source (`toSource.{self}`: relationsToSource).
 */
export function createFoundryReactionProvider({ resolve = defaultResolve } = {}) {
    return function reactionServices(context = {}) {
        const scene = context.scene ?? resolve(context.intent?.sceneRef);
        const mover = context.token ?? resolve(context.intent?.tokenRef);
        if (!scene?.tokens || !mover)
            return {};
        const turns = context.turned ?? [];
        const triggers = [];
        const observers = [];
        const gates = [];
        // 2024 Disengage: the mover's movement provokes no Opportunity Attacks this turn; Flyby: none while it flies.
        const avoidance = mover.actor?.getOpportunityAttackAvoidance?.() ?? { always: false, movementModes: [] };
        const disengaged = (mover.actor?.statuses?.has("disengaged") === true) || avoidance.always;
        // Outside a started encounter movement is not tracked, and provokes nothing (no Opportunity Attacks).
        const tracked = movementTracked(mover.actor);
        for (const token of scene.tokens) {
            if (!token.actor)
                continue;
            // Its own Action's outcome (2014 Divine Smite: "when you hit"): only its triggers bound to `sourceTokenId: "{self}"`,
            // and those on itself (`targetTokenId: "{self}"`: Stone's Endurance when it falls or bleeds).
            if (token.id === mover.id) {
                const own = ownActionReactions(token);
                triggers.push(...own.map(entry => entry.trigger));
                gates.push(...own.flatMap(entry => entry.gate ?? []));
                continue;
            }
            // One on another plane than the acting creature (planeOf: an Ethereal one, a Banished one's hidden Token) reacts to
            // nothing it does, as neither can target the other.
            if (planeOf(token.actor) !== planeOf(mover.actor))
                continue;
            // A creature that can't make Opportunity Attacks (Staggering Blow) reacts to no movement.
            const staggered = token.actor.statuses?.has("no-opportunity-attacks") === true;
            // One made as an Opportunity Attack (`asOpportunity`: War Caster's spell) is gated as the common one, Disengage too.
            const reactions = tokenReactions(token, { avoidedModes: avoidance.movementModes, scene }).filter(entry => !((staggered || !tracked) && (entry.event === MOVEMENT_EVENT)) && !(disengaged && (entry.data.asOpportunity === true)));
            // Every creature makes Opportunity Attacks (Baldur's Gate 3), unless an Item of its own reacts to movement,
            // even one switched off or set to Never.
            if (tracked && !disengaged && !staggered && !ownsMovementReaction(token))
                reactions.push(...opportunityAttack(token, avoidance.movementModes));
            triggers.push(...reactions.map(entry => entry.trigger));
            gates.push(...reactions.flatMap(entry => entry.gate ?? []));
            const watching = reactions.filter(entry => entry.event === MOVEMENT_EVENT);
            // An `asOpportunity` reaction watches its creature's Opportunity Attack reach, not its own Action's range.
            const opportunityReach = watching.some(entry => entry.data.asOpportunity === true) ? opportunityDefinition(token)?.definition : null;
            if (watching.length)
                observers.push({
                    id: token.id,
                    token,
                    reachFields: Math.max(...watching.map(entry => reachFields(((entry.data.asOpportunity === true) ? opportunityReach : null)
                        ?? entry.definition, scene))),
                    context: { hostile: tokensHostile(token, mover) }
                });
        }
        // Each reactor's relation to the event's source (`toSource`), and to the first creature it damages or targets
        // (`toTarget`, that creature itself as `self`: Interception, Cloud Rune); and that creature's effects by name
        // (`targetEffects.<slug>`: Protective Bond's other bonded creature) and creature type (`targetType`: a Smite's
        // Undead or Fiend), and the source's (`sourceType`); and the statuses it has from each reactor
        // (`targetFrom.{self}.<status>`: Superior Hunter's Prey's own Hunter's Mark), worked out only when a predicate reads them.
        return triggers.length ? { reactions: { triggers, context: ({ event }) => {
                    const targetId = (event?.targets?.[0]?.tokenId ?? null);
                    const target = targetId ? [...scene.tokens].find(token => token.id === targetId) ?? null : null;
                    const targetFrom = {};
                    for (const token of scene.tokens) {
                        let memo = null;
                        if (token.actor)
                            Object.defineProperty(targetFrom, token.id, { enumerable: true, get: () => (memo ??= target?.actor
                                    ? conditionsFrom(target.actor, token.actor) : {}) });
                    }
                    // Each gated pick: whether a creature around it qualifies, other than the event's source, its first target and the
                    // reactor (redirectChoice's own exclusions). A retarget's is around the creature its child acts on: the event's
                    // target for a reaction to its own Action, else the event's source (createChildState).
                    const sourceId = event?.source?.tokenId;
                    const redirectable = {};
                    for (const { key, spec, token } of gates) {
                        let memo = null;
                        const around = (spec.aroundTarget ? ((sourceId === token.id) ? targetId : sourceId) : (spec.around ?? token.id)) ?? null;
                        Object.defineProperty(redirectable, key, { enumerable: true, get: () => (memo ??= redirectTokens(scene, { around, viewer: token.id,
                                range: Number(spec.range) || 5, notHostile: spec.notHostile === true, notAllied: spec.notAllied === true, eligible: spec.eligible ?? null, turns,
                                exclude: spec.exclude ?? [sourceId, targetId, token.id].filter((id) => !!id) }).length > 0) });
                    }
                    return { toSource: relationsToSource(scene, event, { turns }), toTarget: relationsToSource(scene, { source: { tokenId: targetId } }, { includeSource: true, turns }),
                        targetFrom, redirectable,
                        targetEffects: Object.fromEntries([...(target?.actor?.effects ?? [])].filter(effect => !effect.disabled && !effect.isSuppressed)
                            .map(effect => [slug(effect.name), true])),
                        targetType: target?.actor?.system?.details?.type || null,
                        // That creature's Hit Points as they stand now (`targetHealth.value`; on `attack.hit`, before its damage: "a creature
                        // that has fewer than 100 Hit Points"), null with no creature, so a number check on it fails.
                        targetHealth: healthOf(target?.actor?.system),
                        // The creature type of the event's source (`sourceType`: Holy Aura's Fiend or Undead attacker).
                        sourceType: [...scene.tokens].find(token => token.id === event?.source?.tokenId)?.actor?.system?.details?.type || null };
                } },
            ...(observers.length ? { movement: { observers } } : {}) } : {};
    };
}
/** A creature's Hit Points, `{value, max, temp}` from `system.resources.health`, or null when it has none. */
const healthOf = (system) => {
    const health = system?.resources?.health;
    return health ? { value: health.value ?? null, max: health.max ?? null, temp: health.temp ?? 0 } : null;
};
/** A name as a key: lower case, words joined by hyphens ("Bonded" → "bonded"). */
const slug = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/**
 * The reactions an effect on its creature gives it (a Trigger carrying its own Action, `data.action`: Protective Bond on
 * Emboldening Bond's "Bonded"), each as an Item of its own so it is offered like any other. One naming `giverItem` is
 * there only while the creature that gave the effect has that feature (its identifier: "protective-bond").
 */
export function effectReactionItems(actor, { fromUuidSync = globalThis.fromUuidSync } = {}) {
    return [...(actor.effects ?? [])].filter(effect => !effect.disabled && !effect.isSuppressed).flatMap(effect => (effect.system?.ruleElements ?? []).filter(element => (element.type === "Trigger") && element.data?.action)
        .flatMap(element => {
        const { action, giverItem, policy, ...data } = element.data;
        const sourceRef = effect.flags?.wildpath?.conditionEffect?.sourceRef;
        const giver = (sourceRef && (giverItem || action.save?.dc) ? sourceRefDocument(sourceRef, { fromUuidSync }) : null);
        if (giverItem) {
            const items = [...((giver?.items ?? giver?.actor?.items) ?? [])];
            if (!items.some(item => (item.system?.active !== false) && (item.flags?.wildpath?.source?.identifier === giverItem)))
                return [];
        }
        // A save at the DC of the creature that gave the effect (Sanctuary's: its caster's spell save DC), worked out now.
        const dc = (action.save?.dc ?? null);
        const source = (giver?.actor ?? giver);
        const fixed = (dc?.fromSource && dc.valueExpression && source)
            ? Number(evaluateValueExpression(dc.valueExpression, { actor: source, actorSystem: source.system }).value) : null;
        if (dc?.fromSource && !Number.isFinite(fixed))
            return [];
        const fixedDC = Number.isFinite(fixed) ? { ...action, save: { ...action.save, dc: { value: fixed } } } : action;
        // Its effect's level where the Action names it (`"{{level}}"`: Mirror Image's d6 for each duplicate left).
        const definition = JSON.parse(JSON.stringify(fixedDC).replaceAll("\"{{level}}\"", String(Number(effect.system?.level) || 1)));
        return [{ id: `${effect.id}-${String(element.id ?? "reaction")}`, type: "action", name: String(action.label ?? effect.name ?? ""),
                system: { active: true, definition: definition, ruleElements: [{ ...element, data }] },
                // One that is no choice (Sanctuary's ward) is used at once (`policy: "always"`).
                ...(policy ? { flags: { wildpath: { reactionPolicy: policy } } } : {}) }];
    }));
}
function tokenReactions(token, { avoidedModes = [], scene } = {}) {
    const actor = token.actor;
    const items = [...(actor.items ?? []), ...effectReactionItems(actor)];
    // A magic item's reaction needs its item equipped and, when it needs attunement, attuned (2024), as using it does; a
    // spell its creature has not prepared is not cast as a reaction either (Item#use refuses it by hand).
    const usable = (item) => {
        if ((item.system?.active === false) || isUnprepared(item))
            return false;
        const gear = item.flags?.wildpath?.grantedBy ? items.find(entry => entry.id === item.flags?.wildpath?.grantedBy) : null;
        return !(gear && ((gear.system?.active === false) || (gear.system?.attunement === "required")));
    };
    // An Action's own `requires`, read as the bar and the authority read it (its creature, and where its Token stands).
    let place = null;
    const requiresMet = (definition) => !definition.requires || evaluatePredicate(definition.requires, { ...requiresContext(actor), ...(place ??= placeContext(token)),
        actorSystem: actor.system ?? null, tags: definition.tags ?? [] }).ok;
    return items.flatMap(item => {
        if (!usable(item))
            return [];
        return (item.system?.ruleElements ?? []).flatMap(element => {
            const data = (element.data ?? {});
            if ((element.type !== "Trigger") || (element.enabled === false))
                return [];
            const event = String(data.event ?? data.eventType ?? "");
            if (((data.kind ?? data.triggerKind) !== "reaction") || !event)
                return [];
            // A common Action (Retaliation's `commonAction: "opportunity"`: its first melee attack or Unarmed Strike), else
            // the Action it carries (`data.action`: a feature's reaction that is no Action to use by hand, Fanatical Focus's refill),
            // the Item itself or the Action it names. `eachAction` (a predicate over each Action's `actionTags` and the Action
            // itself, `action.targeting.count`): one option for every usable Action Item of its creature that matches (War Caster's
            // one-action spells at one creature), each its own trigger.
            const localize = (key) => globalThis.game?.i18n?.localize(key) ?? key;
            const actionId = data.reaction?.actionId;
            const named = actionId ? items.find(entry => (entry.type === "action") && (entry.system?.definition?.id === actionId)) : undefined;
            // An Action Item whose Trigger names another Action of its creature answers with that one (Reflexive Antennae: its
            // Antennae attack), as its Item and at its Item's costs; naming none or itself, it is its own Action.
            const answers = !data.eachAction && !data.commonAction && !data.action && (item.type === "action") && Boolean(named) && (named !== item);
            const actionItems = data.eachAction ? items.filter(entry => (entry !== item) && (entry.type === "action") && usable(entry))
                : [data.commonAction ? common(actor, String(data.commonAction), { localize })
                        : data.action ? { id: item.id, type: "action", system: { active: true, definition: data.action },
                            ...(data.policy ? { flags: { wildpath: { reactionPolicy: String(data.policy) } } } : {}) }
                            : (item.type === "action") && !answers ? item : named];
            const carrying = answers ? definitionFor(item) : null;
            // Not while the answering Action's own Item could not be used (inactive, its gear unequipped).
            if (answers && (!carrying?.ok || !usable(named)))
                return [];
            return actionItems.flatMap(actionItem => {
                const definition = actionItem ? definitionFor(actionItem) : null;
                if (!definition?.ok || !definition.definition)
                    return [];
                // A target count its creature's level decides is read as it is now (Eldritch Blast: one beam below 5th level).
                const targeting = definition.definition.targeting;
                const count = (targeting?.count && (typeof targeting.count === "object"))
                    ? evaluateValueExpression(targeting.count, { actor, actorSystem: actor.system }).value : targeting?.count;
                if (data.eachAction && !evaluatePredicate(data.eachAction, { tags: actionTags(definition.definition),
                    action: targeting ? { ...definition.definition, targeting: { ...targeting, count } } : definition.definition }).ok)
                    return [];
                // Each such Action only while it could be used at all (Telekinesis (Again) only while its Telekinesis runs).
                if (data.eachAction && !requiresMet(definition.definition))
                    return [];
                // Offered under its feature's name: "War Caster (Fire Bolt)".
                if (data.eachAction)
                    definition.definition = { ...definition.definition,
                        label: `${String(item.name ?? "")} (${String(definition.definition.label ?? actionItem.name ?? "")})` };
                // The answering Action as another Action uses it (usedDefinition: its economy free, a limited pool's charge kept),
                // paid with its carrying Item's costs beside that charge, each way to pay with each of the carrying Item's, and
                // offered under both names: "Reflexive Antennae (Antennae)".
                if (answers) {
                    const used = usedDefinition(definition.definition, {});
                    const ways = (costs) => (costs?.anyOf
                        ?? [costs?.allOf ?? []]);
                    const joined = ways(used.costs).flatMap(kept => ways(carrying.definition.costs).map(own => [...kept, ...own]));
                    definition.definition = { ...used, costs: (joined.length === 1) ? { allOf: joined[0] } : { anyOf: joined },
                        label: `${String(item.name ?? "")} (${String(definition.definition.label ?? actionItem.name ?? "")})` };
                }
                // Its Action paid otherwise (`replaceCost: {from, to}`, as the `replace-cost` configuration effect): War Caster's
                // one-action spell cast with the Reaction instead. The spell's slot is still its own configuration's.
                if (data.replaceCost)
                    definition.definition = { ...definition.definition,
                        costs: replacedCosts(definition.definition.costs, data.replaceCost) };
                // Offered under its Item's name: "Retaliation (Dagger)", not "Opportunity Attack (Dagger)".
                if (data.commonAction)
                    definition.definition = { ...definition.definition,
                        label: String(actionItem.name ?? "")
                            .replace(localize("WILDPATH.COMMON.OpportunityAttack"), String(item.name ?? "")) };
                // A common Action a feature gives as part of something else costs nothing of its own (Grappler's Punch and Grab: the
                // Grapple a hit brings, beside its damage).
                if (data.commonAction && data.free)
                    definition.definition = { ...definition.definition, costs: { allOf: [] } };
                // Only one made as an Opportunity Attack (`opportunity`: Sentinel's) says it is one; Retaliation's melee attack doesn't.
                if (data.commonAction && (data.opportunity !== true))
                    definition.definition = { ...definition.definition,
                        tags: (definition.definition.tags ?? []).filter(tag => tag !== "opportunity") };
                // A reaction set to "Never" is not offered; one set to "Always" is used without asking (its Item's setting).
                const policy = policyOf((data.commonAction || data.eachAction || answers) ? item : actionItem);
                if (policy === "never")
                    return [];
                // Only while its creature has a status (Brutal Strike: Reckless Attack's "reckless").
                if (data.whileStatus && !actor.statuses?.has(String(data.whileStatus)))
                    return [];
                // Only on its creature's own turn in combat (`ownTurn`: "on each of your turns", Divine Fury), so not on an
                // Opportunity Attack's hit on another creature's turn. Outside combat, any time.
                const fight = globalThis.game?.combat;
                if (data.ownTurn && fight?.started && (fight.combatant?.tokenId !== token.id))
                    return [];
                // Only while its creature has a feature (Improved Blessed Strikes' heal: its Potent Spellcasting option), as `hasFeature`,
                // or any one of a list (Giants' Bane: a Belt of Giant Strength or Gauntlets of Ogre Power); an Item that needs
                // attunement counts only when attuned, as its own rules do.
                const features = [data.whileFeature].flat();
                if (data.whileFeature && !items.some(entry => (entry.system?.active !== false) && (entry.system?.attunement !== "required")
                    && features.includes(entry.flags?.wildpath?.source?.identifier)))
                    return [];
                // Not one its rules forbid it (`Forbid`: a Silenced wizard's Shield, a Spell Taxed caster's spells).
                if (actor.forbiddingRule?.(definition.definition))
                    return [];
                // Once a turn (Stunning Strike): not offered again this combat turn; its use records it (`metadata.once`).
                // Options sharing a key (`onceKey`: Cunning Strike's three) are one use between them. A key with no `once` only
                // lets its options be taken one after another in the same window, up to `uses` (Rend Mind's free and paid uses on one
                // hit), and records nothing (no turn).
                const once = (data.once === "turn") ? onceThisTurn(actor, String(data.onceKey ?? `${item.id}-${String(element.id ?? "trigger")}`))
                    : (data.onceKey ? { key: String(data.onceKey).replace(/\./g, "_"), turn: null, used: false } : null);
                if (once?.used)
                    return [];
                // `asOpportunity`: offered exactly when its creature's Opportunity Attack could be (a hostile creature's own movement
                // out of its reach, not under Disengage nor in a mode the mover avoids them in), its own predicate beside that; and
                // only while the mover, where it starts the step, is within its own Action's range (a touch spell from a glaive's reach).
                const limit = ((data.asOpportunity === true) && scene) ? rangeFields(definition.definition, scene) : null;
                const opportunity = (data.asOpportunity === true) ? (limit === null ? opportunityPredicate(avoidedModes)
                    : { all: [opportunityPredicate(avoidedModes), { atMost: { path: "event.data.relations.{self}.before", value: limit } }] }) : null;
                // A reaction picking a creature around it is offered only while one qualifies (Q47: `redirectable.<key>`, worked out
                // when read by redirectTokens, with the exclusions its pick uses).
                const spec = pickAround(definition.definition);
                const gate = spec ? { key: `${token.id}-${item.id}-${String(element.id ?? "trigger")}${data.eachAction ? `-${actionItem.id}` : ""}`
                        .replace(/\./g, "_"), spec } : null;
                const ownPredicate = (data.triggerPredicate ?? data.eventPredicate ?? null);
                const predicate = opportunity ? (ownPredicate ? { all: [opportunity, ownPredicate] } : opportunity) : ownPredicate;
                const trigger = reactionTrigger({
                    id: `reaction:${token.id}:${item.id}:${String(element.id ?? "trigger")}${data.eachAction ? `:${actionItem.id}` : ""}`,
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
                    predicate: bindSelf(gate ? { all: [...(predicate ? [predicate] : []), { equals: { path: `redirectable.${gate.key}`, value: true } }] }
                        : predicate, token.id),
                    ...(policy === "always" ? { metadata: { reactionPolicy: policy } } : {}),
                    // `uses`: how many of the options sharing its key its creature may take in one window (Improved Cunning Strike: 2).
                    ...(once ? { payload: { once: { key: once.key, turn: once.turn, uses: usesOf(data.uses, actor) } } } : {})
                });
                return [{ trigger, event, definition: definition.definition, data, ...(gate ? { gate: { ...gate, token } } : {}) }];
            });
        });
    });
}
/**
 * `token`'s reactions to its own Action (`sourceTokenId: "{self}"`). One marked `onlyWithoutOtherSlotSpell` (Paladin's
 * Smite's 2014 Divine Smite) is offered only while its creature has cast no spell with a slot this combat turn other
 * than a `smite` (`flags.wildpath.slotSpellTurn`, recordSlotSpell). Its creature's other `smite` reactions (the 2024
 * spell) are offered beside it, as options.
 */
function ownActionReactions(token) {
    const own = tokenReactions(token).filter(entry => [entry.trigger.event?.sourceTokenId,
        entry.trigger.event?.targetTokenId].includes(token.id));
    const combat = globalThis.game?.combat;
    const turn = combat?.started ? turnKey(combat) : null;
    const casting = (turn !== null) && (token.actor?.flags?.wildpath?.slotSpellTurn === turn);
    const free = own.filter(entry => entry.data.onlyWithoutOtherSlotSpell === true);
    return (casting && free.length) ? own.filter(entry => !free.includes(entry)) : own;
}
/**
 * A once-a-turn reaction's record key and the combat turn, and whether it was used this turn
 * (`flags.wildpath.onceUsed.<key>`, as a once-a-turn ExtraDamage). Outside combat it is never used up.
 */
function onceThisTurn(actor, id) {
    const combat = globalThis.game?.combat;
    const turn = combat?.started ? turnKey(combat) : null;
    const key = id.replace(/\./g, "_");
    return { key, turn, used: (turn !== null) && (actor.flags?.wildpath?.onceUsed?.[key] === turn) };
}
/** A Trigger's `uses`, a number or a ValueExpression for its creature (a table by class level), at least 1. */
function usesOf(uses, actor) {
    if (uses == null)
        return 1;
    const value = (typeof uses === "object")
        ? evaluateValueExpression(uses, { actor, actorSystem: actor.system }).value
        : Number(uses);
    return Math.max(Math.trunc(Number(value) || 1), 1);
}
/**
 * Whether any Item of `token`'s creature has a reaction to movement, active or not; one offered beside its Opportunity
 * Attack (`asOpportunity`) does not count.
 */
function ownsMovementReaction(token) {
    return [...(token.actor?.items ?? [])].some(item => (item.system?.ruleElements ?? []).some(element => (element.type === "Trigger")
        && (element.data?.kind === "reaction") && (element.data?.event === MOVEMENT_EVENT)
        && (element.data?.asOpportunity !== true)));
}
/** An Opportunity Attack's trigger, never against movement in `avoidedModes` (Flyby's flight). */
function opportunityPredicate(avoidedModes) {
    return avoidedModes.length ? { all: [...OPPORTUNITY_PREDICATE.all,
            { not: { oneOf: { path: "event.data.movementMode", values: [...avoidedModes] } } }] } : OPPORTUNITY_PREDICATE;
}
/** The common Opportunity Attack Action of `token`'s creature and that Action, or null. */
function opportunityDefinition(token) {
    const localize = (key) => globalThis.game?.i18n?.localize(key) ?? key;
    const action = common(token.actor, "opportunity", { localize });
    const definition = action ? definitionFor(action) : null;
    return action && definition?.ok && definition.definition ? { action, definition: definition.definition } : null;
}
/** The common Opportunity Attack of `token`'s creature, unless it is set to Never; never against movement in `avoidedModes`. */
function opportunityAttack(token, avoidedModes = []) {
    const found = opportunityDefinition(token);
    const policy = found ? policyOf(found.action) : "never";
    if (!found || (policy === "never"))
        return [];
    const { definition } = found;
    const trigger = reactionTrigger({
        id: `reaction:${token.id}:common-opportunity`,
        event: MOVEMENT_EVENT,
        match: { phase: "interrupt" },
        actorId: token.actor.uuid,
        tokenId: token.id,
        action: definition,
        actionId: definition.id ?? null,
        predicate: bindSelf(opportunityPredicate(avoidedModes), token.id),
        ...(policy === "always" ? { metadata: { reactionPolicy: policy } } : {})
    });
    return [{ trigger, event: MOVEMENT_EVENT, definition, data: {} }];
}
/** Reach in grid fields from the reaction Action's reach range (5 ft by default). */
/**
 * The farthest its Action reaches, in whole grid fields, as the pipeline's range stage measures it (touch or reach: its
 * distance; ranged: its long range, else normal); null for any other range (no limit here).
 */
function rangeFields(definition, scene) {
    const range = (definition.range ?? {});
    const feet = ["touch", "reach"].includes(range.type ?? "") ? ((range.distance ?? range.normal)?.value ?? 5)
        : (range.type === "ranged") ? (range.long ?? range.normal ?? range.distance)?.value : null;
    return Number.isFinite(feet) ? Math.floor(Number(feet) / (Number(scene.grid?.distance) || 5)) : null;
}
function reachFields(definition, scene) {
    const range = (definition.range ?? {});
    const feet = (range.type === "reach") && Number.isFinite(range.distance?.value) ? range.distance.value : 5;
    const fieldSize = Number(scene.grid?.distance) || 5;
    return Math.max(1, Math.floor(feet / fieldSize));
}
/**
 * Each Token's relation to `event`'s source, by Token id, worked out when a predicate reads it (`toSource.<id>`):
 * `hostile` (tokensHostile, with an Action's own `turns`), `distance` in feet between their spaces, and `sees`: it sees the source (tokenSees: Blinded,
 * Invisible, light, and a wall blocking sight hiding it entirely). Nothing for an event
 * without a source Token on the Scene, so a predicate reading it fails (no "creature you can see").
 */
export function relationsToSource(scene, event, { includeSource = false, turns = [] } = {}) {
    const sourceId = (event?.source?.tokenId ?? event?.tokenId);
    const tokens = [...(scene.tokens ?? [])];
    const source = sourceId ? tokens.find(token => token.id === sourceId) : null;
    const relations = {};
    if (!source?.actor)
        return relations;
    if (includeSource)
        relations[source.id] = { hostile: false, distance: 0, sees: true, self: true };
    const grid = createFoundryV14TacticalGridAdapter({ scene: scene });
    const footprintOf = (token) => { const result = grid.tokenToFootprint(token); return result.ok ? result.footprint : null; };
    const from = footprintOf(source);
    const fieldDistance = Number(scene.grid?.distance) || 5;
    for (const token of tokens) {
        if (!token.actor || (token.id === source.id))
            continue;
        let memo = null;
        Object.defineProperty(relations, token.id, { enumerable: true, get() {
                if (memo)
                    return memo;
                const to = footprintOf(token);
                const fields = (from && to) ? footprintDistance(from, to) : NaN;
                const distance = Number.isFinite(fields) ? fields * fieldDistance : null;
                const sees = tokenSees(scene, token, source, { distance });
                // The source is not fooled by an illusion around this one (Mirror Image): Blinded, or its Blindsight or Truesight reach it.
                memo = { hostile: tokensHostile(token, source, null, turns), distance, sees, undeceived: piercesIllusion(source.actor, { distance }) };
                return memo;
            } });
    }
    return relations;
}
/**
 * The creatures on `scene` a reaction may pick (Cloud Rune, Redirect Attack, Superior Hunter's Prey): those within `range`
 * feet of the Token `around`, by the distance between their spaces, other than it and `exclude`, never a Token the GM hides
 * (its player mustn't learn of it, even by name) or a dead creature; with `notHostile`, none hostile to its own creature
 * `viewer` (`around` when not given; tokensHostile with an Action's own `turns`: "an ally", a neutral creature counting
 * until it turns hostile); with `notAllied`, none of its allies (alliedTokens, by disposition: a used Action's "pick", Q148
 * default); with `eligible`, only those its predicate admits (ineligibleTarget, `viewer` as its source: "a
 * Small or Medium ally" is `{oneOf: {path: "size", values: [...]}}`, "that you can see" `seenBySource`). The runtime's
 * redirectCandidates and a pick's offer gate (`redirectable`) both read it, so the prompt and the pick agree.
 */
export function redirectTokens(scene, { around, viewer = null, range = 5, exclude = [], notHostile = false, notAllied = false, eligible = null, turns = [] } = {}) {
    const tokens = [...(scene?.tokens ?? [])];
    const from = around ? tokens.find(token => token.id === around) ?? null : null;
    if (!scene || !from)
        return [];
    const own = (viewer ? tokens.find(token => token.id === viewer) : null) ?? from;
    const grid = createFoundryV14TacticalGridAdapter({ scene: scene });
    const footprintOf = (token) => { const result = grid.tokenToFootprint(token); return result.ok ? result.footprint : null; };
    const origin = footprintOf(from);
    const within = (token) => {
        const to = origin ? footprintOf(token) : null;
        return !!to && (footprintDistance(origin, to) * (Number(scene.grid?.distance) || 5) <= Number(range));
    };
    return tokens.filter(token => token.actor && (token.id !== from.id) && !exclude.includes(token.id) && (token.hidden !== true)
        && !deadCreature(token.actor) && !(notHostile && tokensHostile(own, token, null, turns))
        && !(notAllied && alliedTokens(own, token)) && within(token)
        && !ineligibleTarget(eligible, token, own));
}
/**
 * What a reaction picks from the creatures around it (redirectChoice), when it needs one there to be offered: a redirect
 * to a creature it chooses (not its own, nor given Tokens), a retarget, or a reaction's target among creatures in range
 * (not with itself among them). Null otherwise.
 */
const pickAround = (definition) => {
    const redirect = definition.rider?.redirectDamage;
    if (redirect)
        return ((redirect.to !== "self") && !redirect.tokenIds && !redirect.includeSelf) ? redirect : null;
    const retarget = definition.retarget;
    if (retarget)
        return { range: retarget.range, eligible: retarget.eligible, aroundTarget: true };
    const choice = definition.targetChoice;
    return ((choice?.from === "creatures") && !choice.includeSelf) ? { range: choice.range, eligible: choice.eligible, exclude: [],
        notAllied: choice.notAllied === true } : null;
};
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

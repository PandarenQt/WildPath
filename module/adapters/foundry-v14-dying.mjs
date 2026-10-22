import { mutationTargetIdentity } from "../helpers/mutation-target.mjs";
import { resolveTargetLookupValue, targetLookupRefs } from "../helpers/target-actor-refs.mjs";
import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
import { zeroHpFor } from "./foundry-v14-zero-hp.mjs";
import { foundryActorSystemSnapshot } from "./foundry-v14-actor-system-adapter.mjs";
import { commitActorResourceMutationPlan } from "../resolvers/resource-resolver.mjs";
export const DEATH_SAVE_DC = 10;
const RESET = Object.freeze({ successes: 0, failures: 0 });
const STABLE = Object.freeze({ successes: 3, failures: 0 });
const DAMAGE = new Set(["damage", "durabilityDamage"]);
// The untyped lookup helpers; these are the only places their shapes are asserted.
const lookupActor = resolveTargetLookupValue;
const refsOf = targetLookupRefs;
const HEALING = new Set(["healing", "durabilityHealing"]);
/**
 * Whether a creature makes death saves at 0 health (else it dies): its own `dyingMode` setting, or under
 * `auto` a character, or a companion or sidekick a Player controls (it follows its character).
 */
export function makesDeathSaves({ type, dyingMode = "auto", companion = null, playerControlled = false }) {
    if (dyingMode === "deathSaves")
        return true;
    if (dyingMode === "dies")
        return false;
    return (type === "character") || (!!companion?.controllers?.length && playerControlled);
}
/** What a change to a creature's health means under the dying rules, or null when nothing follows. */
export function dyingAfterChange({ change, critical = false, character = true, deathSaves = RESET }) {
    const from = Number(change.from) || 0;
    const to = Number(change.to) || 0;
    const max = Number(change.max) || 0;
    const amount = Number(change.amount) || 0;
    if (DAMAGE.has(String(change.type)) && (amount > 0)) {
        if ((from > 0) && (to === 0)) {
            // Massive damage: what is left after reaching 0 is at least the maximum.
            if (!character || ((Number(change.overflow) || 0) >= max))
                return { die: true };
            return { unconscious: true, deathSaves: { ...RESET } };
        }
        if (from === 0) {
            if (!character || (amount >= max))
                return { die: true };
            // 2024: a stable creature that takes damage stops being stable, and its death saves start over.
            const counted = deathSaves.successes >= 3 ? RESET : deathSaves;
            const failures = counted.failures + (critical ? 2 : 1);
            return failures >= 3 ? { die: true } : { deathSaves: { ...counted, failures } };
        }
    }
    if (HEALING.has(String(change.type)) && (from === 0) && (to > 0))
        return { wake: true, deathSaves: { ...RESET } };
    return null;
}
/** 2024: a stable creature regains 1 health after 1d4 hours. World time counts, and so do the hours of its rests. */
export function stableRecovered(since, worldTime) {
    if (!since)
        return false;
    const waited = ((Number(worldTime) || 0) - (Number(since.worldTime) || 0)) + ((Number(since.restHours) || 0) * 3600);
    return waited >= (Math.max(1, Number(since.hours) || 1) * 3600);
}
/** A death save: 10 or higher succeeds; a natural 1 is two failures; a natural 20 brings the creature back with 1. */
export function deathSaveResult({ natural, total, deathSaves = RESET }) {
    if (natural === 20)
        return { heal: 1, wake: true, deathSaves: { ...RESET } };
    // The third success makes the creature stable (successes 3), and its failures reset (2024).
    if ((natural !== 1) && (total >= DEATH_SAVE_DC))
        return { deathSaves: deathSaves.successes >= 2 ? { ...STABLE }
                : { ...deathSaves, successes: deathSaves.successes + 1 } };
    const failures = deathSaves.failures + (natural === 1 ? 2 : 1);
    return failures >= 3 ? { die: true } : { deathSaves: { ...deathSaves, failures } };
}
/**
 * A creature's Regeneration: `turn.started` Triggers on its active features that name the damage that stops them
 * (`stoppedBy`) or put off its death at 0 health until its turn starts (`deferDeath`).
 */
const regenerationsOf = (actor) => [...(actor.items ?? [])].filter(item => item.system?.active !== false)
    .flatMap(item => item.system?.ruleElements ?? [])
    .filter(rule => (rule.type === "Trigger") && (rule.enabled !== false) && (rule.data?.stoppedBy?.length || rule.data?.deferDeath));
const hasCondition = (actor, id) => [...actor.effects].some(effect => effect.system?.type === id);
const deathSavesOf = (actor) => ({ successes: Number(actor.system.deathSaves?.successes) || 0,
    failures: Number(actor.system.deathSaves?.failures) || 0 });
const savesForDeath = (actor) => makesDeathSaves({ type: actor.type, dyingMode: actor.system.dyingMode,
    companion: actor.system.companion ?? null, playerControlled: actor.hasPlayerOwner === true });
/** 1d4 hours, rolled with Foundry's dice. */
async function rollStableHours() {
    const Roll = globalThis.Roll;
    return Roll ? (await new Roll("1d4").evaluate()).total : 1 + Math.floor(Math.random() * 4);
}
export function createFoundryDying({ game, coordinator, resolveAction, logger = globalThis.console, rollHours = rollStableHours }) {
    let sequence = 0;
    const isActiveGM = () => game.users?.activeGM?.id === game.user.id;
    const isDead = (actor) => hasCondition(actor, "dead") || (deathSavesOf(actor).failures >= 3);
    const worldTime = () => Number(game.time?.worldTime) || 0;
    /** A creature just became stable: it starts waiting 1d4 hours to regain 1 health. */
    async function markStable(actor) {
        if (actor.flags?.wildpath?.stableSince)
            return;
        await actor.setFlag("wildpath", "stableSince", { worldTime: worldTime(), hours: await rollHours() });
    }
    async function clearStable(actor) {
        if (actor.flags?.wildpath?.stableSince)
            await actor.unsetFlag("wildpath", "stableSince");
    }
    /** Dead: 0 health, three failed death saves, and Defeated (the Token's dead overlay and every Combatant). */
    async function die(actor) {
        await actor.update({ "system.resources.health.value": 0, "system.deathSaves": { successes: 0, failures: 3 } });
        await clearStable(actor);
        const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
        if (!hasCondition(actor, defeated))
            await actor.toggleStatusEffect(defeated, { active: true, overlay: true });
        for (const combat of game.combats ?? []) {
            for (const combatant of combat.combatants) {
                if ((combatant.actor?.uuid === actor.uuid) && !combatant.defeated)
                    await combatant.update({ defeated: true });
            }
        }
        // What it does as it dies (a mephit's Death Burst): its automatic triggers on `creature.died`.
        const token = actor.isToken ? actor.token : (actor.getActiveTokens?.(false, true)?.[0] ?? null);
        try {
            await globalThis.game?.wildpath
                ?.automation?.dispatch?.("creature.died", { actor, token });
        }
        catch (error) {
            logger.warn("Wild Path | A death trigger failed", error);
        }
    }
    async function apply(actor, consequence) {
        if (!consequence || isDead(actor))
            return;
        if (consequence.die)
            return die(actor);
        const update = {};
        if (consequence.deathSaves)
            update["system.deathSaves"] = consequence.deathSaves;
        if (consequence.heal)
            update["system.resources.health.value"] = consequence.heal;
        if (Object.keys(update).length)
            await actor.update(update);
        // Stability starts the wait for 1 health; healing, waking or a death save starting over ends it.
        if ((consequence.deathSaves?.successes ?? 0) >= 3)
            await markStable(actor);
        else if (consequence.deathSaves || consequence.heal || consequence.wake)
            await clearStable(actor);
        if (consequence.unconscious && !hasCondition(actor, "unconscious"))
            await actor.toggleCondition("unconscious");
        if (consequence.wake && hasCondition(actor, "unconscious"))
            await actor.toggleCondition("unconscious", { levels: -1 });
    }
    /**
     * The damage types that stop a creature's Regeneration, recorded when it takes them (more than 0); they count until
     * its next turn starts.
     */
    async function recordStoppingDamage(actor, entry) {
        const stopping = new Set(regenerationsOf(actor).flatMap(rule => rule.data?.stoppedBy ?? []));
        const taken = (entry.plan
            ?.metadata?.damageResult?.byDamageType) ?? {};
        const types = Object.entries(taken).filter(([type, amount]) => stopping.has(type) && (Number(amount) > 0)
            && !actor.flags?.wildpath?.damageTaken?.[type]).map(([type]) => type);
        if (types.length)
            await actor.update(Object.fromEntries(types.map(type => [`flags.wildpath.damageTaken.${type}`, true])));
    }
    /**
     * The health changes `plans` committed on `actor` (a condition's damage at turn start). With `rescue`, damage outside
     * an Action that dropped it to 0 may keep it up first (rescueAtZero); an Action's own damage was checked before
     * commit, so `afterResolution` never rescues.
     */
    async function afterPlans(actor, plans = [], { critical = false, rescue = false } = {}) {
        if (!actor || !isActiveGM())
            return;
        for (const entry of plans) {
            const change = (entry.plan ?? entry);
            const type = String((entry.plan ? (change.type ?? entry.type) : entry.type) ?? "");
            if (rescue && DAMAGE.has(type) && await rescueAtZero(actor, change))
                continue;
            if (DAMAGE.has(type))
                await recordStoppingDamage(actor, entry);
            let consequence = dyingAfterChange({ change: { ...change, type }, critical, character: savesForDeath(actor),
                deathSaves: deathSavesOf(actor) });
            // A creature whose Regeneration puts off its death lies at 0 until its turn starts.
            if (consequence?.die && !savesForDeath(actor) && regenerationsOf(actor).some(rule => rule.data?.deferDeath)) {
                consequence = { unconscious: true };
            }
            await apply(actor, consequence);
        }
    }
    /**
     * Damage outside an Action that dropped `actor` from above 0 to 0, not by massive damage: its drop-to-0 rule
     * (Relentless Endurance, Relentless Rage, Undead Fortitude; zeroHpFor) may keep it up. Its use is paid; a save is a
     * save-only authority Action on it, so the dice policy prompts its controller or rolls. True when it stayed up.
     */
    async function rescueAtZero(actor, change) {
        if (!((Number(change.from) || 0) > 0) || ((Number(change.to) || 0) !== 0)
            || ((Number(change.overflow) || 0) >= (Number(change.max) || 0)))
            return false;
        let system;
        try {
            system = foundryActorSystemSnapshot(actor);
        }
        catch {
            return false;
        }
        const rule = zeroHpFor(actor, system);
        if (!rule)
            return false;
        const metadata = (change.metadata ?? {});
        const byType = metadata.damageResult?.byDamageType ?? {};
        if ((rule.notOn ?? []).some((reason) => (reason === metadata.damageType) || (Number(byType[reason]) > 0)))
            return false;
        if (rule.payment?.plan)
            await commitActorResourceMutationPlan(actor, rule.payment.plan);
        let kept = rule.mode !== "save";
        if (!kept) {
            const dc = rule.dc ?? ((Number(rule.dcPlusDamage) || 0) + (Number(change.amount) || 0));
            const self = actor;
            const token = self.isToken ? (self.token ?? null) : (self.getActiveTokens?.(false, true)?.[0] ?? null);
            const where = token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {};
            const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
                resolutionId: `zero-hp:${actor.uuid}:${++sequence}`, label: String(rule.name ?? ""), actorRef: actor.uuid, source: where,
                target: { actorRef: actor.uuid, ...where }, definition: { schemaVersion: 1, id: "action:zero-hp-save", label: String(rule.name ?? ""),
                    costs: { allOf: [] }, save: { ability: rule.ability, dc: { value: dc } } } });
            kept = (state?.results?.saveResolution?.successes?.length ?? 0) > 0;
        }
        // Kept up at 1 is no healing: "can't regain Hit Points" (Chill Touch) doesn't stop it.
        if (kept)
            await actor.update.call(actor, { "system.resources.health.value": rule.hitPoints }, { wildpath: { notHealing: true } });
        return kept;
    }
    /** After an Action: each target whose health it changed, a critical hit counting as two failed saves at 0. */
    async function afterResolution({ options, state }) {
        if (!isActiveGM())
            return;
        await stabilizeTargets({ options, state });
        const hits = state?.results?.attackResolution?.hits ?? [];
        const criticalRefs = new Set(hits.filter(hit => hit.outcome === "criticalHit").flatMap(hit => refsOf(hit.target ?? {})));
        for (const entry of state?.mutationPlans ?? []) {
            if (!DAMAGE.has(String(entry.type)) && !HEALING.has(String(entry.type)))
                continue;
            const target = mutationTargetIdentity((entry.target ?? entry.plan?.target ?? {}));
            const actor = lookupActor(options?.targetActors, target, entry, { selectValue: value => value?.actor ?? value });
            await afterPlans(actor, [entry], { critical: refsOf(target).some(ref => criticalRefs.has(ref)) });
        }
    }
    /**
     * A `stabilize` Action (2024: Spare the Dying, or an ally's DC 10 Medicine check) makes each dying target stable:
     * three successes, no failures. A failed check withholds it, as it withholds the Action's effects.
     */
    async function stabilizeTargets({ options, state }) {
        const definition = state?.actionDefinition;
        const results = state?.results;
        if ((definition?.stabilize !== true) || (results?.checkResolution?.success === false))
            return;
        for (const target of results?.actionResult?.context?.targets ?? []) {
            const actor = lookupActor(options?.targetActors, mutationTargetIdentity(target), target, { selectValue: value => value?.actor ?? value });
            if (!actor || !savesForDeath(actor) || isDead(actor) || ((Number(actor.system.resources?.health?.value) || 0) > 0))
                continue;
            await actor.update({ "system.deathSaves": { ...STABLE } });
            await markStable(actor);
        }
    }
    /** At the start of its turn a dying character (0 health, not stable, not dead) rolls its death save. */
    async function onTurnStart({ combatant }) {
        const actor = combatant?.actor ?? null;
        if (!actor || !isActiveGM())
            return null;
        const regenerations = regenerationsOf(actor);
        if (regenerations.length) {
            // "It dies only if it starts its turn with 0 Hit Points and doesn't regenerate": its Regeneration has run by now.
            if (regenerations.some(rule => rule.data?.deferDeath) && !savesForDeath(actor) && !isDead(actor)
                && ((Number(actor.system.resources?.health?.value) || 0) === 0))
                await die(actor);
            // The damage that stopped it counted for this turn only.
            if (actor.flags?.wildpath?.damageTaken)
                await actor.unsetFlag("wildpath", "damageTaken");
        }
        if (!savesForDeath(actor) || isDead(actor))
            return null;
        if ((Number(actor.system.resources?.health?.value) || 0) > 0 || (deathSavesOf(actor).successes >= 3))
            return null;
        const token = combatant?.token ?? null;
        const label = game.i18n?.localize("WILDPATH.DYING.DeathSave") ?? "Death Saving Throw";
        const self = { actorRef: actor.uuid, ...(token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}) };
        const state = await runAuthorityAction({ coordinator, resolveAction, logger, senderUserId: game.user.id,
            resolutionId: `death-save:${actor.uuid}:${++sequence}`, label, actorRef: actor.uuid,
            source: token?.parent ? { tokenId: token.id, sceneId: token.parent.id } : {}, target: self,
            definition: { schemaVersion: 1, id: "action:death-saving-throw", label, costs: { allOf: [] }, tags: ["death-save"],
                save: { ability: "death", dc: { value: DEATH_SAVE_DC } } } });
        const roll = (state?.results?.saveResolution?.results?.[0]?.roll) ?? null;
        if (!roll || !Number.isFinite(Number(roll.total)))
            return null;
        const consequence = deathSaveResult({ natural: Number(roll.die ?? roll.natural), total: Number(roll.total), deathSaves: deathSavesOf(actor) });
        await apply(actor, consequence);
        return consequence;
    }
    /** A stable creature that has waited long enough regains 1 health and wakes (2024); one no longer dying stops waiting. */
    async function recoverIfDue(actor, now = worldTime()) {
        const since = actor.flags?.wildpath?.stableSince;
        if (!since)
            return false;
        if (isDead(actor) || ((Number(actor.system.resources?.health?.value) || 0) > 0)) {
            await clearStable(actor);
            return false;
        }
        if (!stableRecovered(since, now))
            return false;
        await apply(actor, { heal: 1, wake: true, deathSaves: { ...RESET } });
        return true;
    }
    /** A rest's hours count toward a stable creature's wait (tables that do not advance world time still recover). */
    async function restHours(actor, hours) {
        const since = actor.flags?.wildpath?.stableSince;
        if (!since)
            return false;
        await actor.setFlag("wildpath", "stableSince", { ...since, restHours: (Number(since.restHours) || 0) + hours });
        return recoverIfDue(actor);
    }
    /** World time moved on (the active GM): every stable creature that has waited long enough regains 1 health. */
    async function onWorldTime(now = worldTime()) {
        if (!isActiveGM())
            return;
        const actors = new Set([...(game.actors ?? [])]);
        for (const scene of game.scenes ?? []) {
            for (const token of scene.tokens)
                if (!token.actorLink && token.actor)
                    actors.add(token.actor);
        }
        for (const actor of actors)
            if (actor.flags?.wildpath?.stableSince)
                await recoverIfDue(actor, now);
    }
    /** Exhaustion's sixth level is death. */
    async function onEffectChanged(effect) {
        if (!isActiveGM() || (effect.system?.type !== "exhaustion") || ((Number(effect.system.level) || 0) < 6))
            return;
        await apply(effect.parent, { die: true });
    }
    return { afterResolution, afterPlans, onTurnStart, onEffectChanged, die, restHours, onWorldTime };
}

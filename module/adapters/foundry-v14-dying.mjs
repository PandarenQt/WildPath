import { mutationTargetIdentity } from "../helpers/mutation-target.mjs";
import { resolveTargetLookupValue, targetLookupRefs } from "../helpers/target-actor-refs.mjs";
import { runAuthorityAction } from "./foundry-v14-automation-dispatcher.mjs";
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
const hasCondition = (actor, id) => [...actor.effects].some(effect => effect.system?.type === id);
const deathSavesOf = (actor) => ({ successes: Number(actor.system.deathSaves?.successes) || 0,
    failures: Number(actor.system.deathSaves?.failures) || 0 });
const savesForDeath = (actor) => makesDeathSaves({ type: actor.type, dyingMode: actor.system.dyingMode,
    companion: actor.system.companion ?? null, playerControlled: actor.hasPlayerOwner === true });
export function createFoundryDying({ game, coordinator, resolveAction, logger = globalThis.console }) {
    let sequence = 0;
    const isActiveGM = () => game.users?.activeGM?.id === game.user.id;
    const isDead = (actor) => hasCondition(actor, "dead") || (deathSavesOf(actor).failures >= 3);
    /** Dead: 0 health, three failed death saves, and Defeated (the Token's dead overlay and every Combatant). */
    async function die(actor) {
        await actor.update({ "system.resources.health.value": 0, "system.deathSaves": { successes: 0, failures: 3 } });
        const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
        if (!hasCondition(actor, defeated))
            await actor.toggleStatusEffect(defeated, { active: true, overlay: true });
        for (const combat of game.combats ?? []) {
            for (const combatant of combat.combatants) {
                if ((combatant.actor?.uuid === actor.uuid) && !combatant.defeated)
                    await combatant.update({ defeated: true });
            }
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
        if (consequence.unconscious && !hasCondition(actor, "unconscious"))
            await actor.toggleCondition("unconscious");
        if (consequence.wake && hasCondition(actor, "unconscious"))
            await actor.toggleCondition("unconscious", { levels: -1 });
    }
    /** The health changes `plans` committed on `actor` (a condition's damage at turn start). */
    async function afterPlans(actor, plans = [], { critical = false } = {}) {
        if (!actor || !isActiveGM())
            return;
        for (const entry of plans) {
            const change = (entry.plan ?? entry);
            const type = String((entry.plan ? (change.type ?? entry.type) : entry.type) ?? "");
            await apply(actor, dyingAfterChange({ change: { ...change, type }, critical, character: savesForDeath(actor),
                deathSaves: deathSavesOf(actor) }));
        }
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
        }
    }
    /** At the start of its turn a dying character (0 health, not stable, not dead) rolls its death save. */
    async function onTurnStart({ combatant }) {
        const actor = combatant?.actor ?? null;
        if (!actor || !isActiveGM() || !savesForDeath(actor) || isDead(actor))
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
    /** Exhaustion's sixth level is death. */
    async function onEffectChanged(effect) {
        if (!isActiveGM() || (effect.system?.type !== "exhaustion") || ((Number(effect.system.level) || 0) < 6))
            return;
        await apply(effect.parent, { die: true });
    }
    return { afterResolution, afterPlans, onTurnStart, onEffectChanged, die };
}

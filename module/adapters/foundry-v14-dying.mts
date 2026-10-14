import {mutationTargetIdentity} from "../helpers/mutation-target.mjs";
import {resolveTargetLookupValue, targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";

/**
 * Dying and death (maintainer decision, 2026-10-14: the 2024 rules, with Pathfinder 2e's conventions where they
 * leave room). Dead is 0 health, Defeated, and three failed death saves. A character dropped to 0 falls
 * Unconscious and makes a death save at the start of each of its turns; an NPC dies at 0, the common 2024 table
 * practice and PF2e's default. Damage at 0 is a failed save (two on a critical hit), damage of at least the
 * creature's maximum health kills outright, healing wakes it, and Exhaustion 6 kills.
 */

type Data = Record<string, unknown>;
export interface DeathSaves {successes: number; failures: number}
export interface DurabilityChange {type?: string; from?: number; to?: number; max?: number; amount?: number; overflow?: number}
export interface DyingConsequence {die?: boolean; unconscious?: boolean; wake?: boolean; heal?: number; deathSaves?: DeathSaves}

export const DEATH_SAVE_DC = 10;
const RESET: DeathSaves = Object.freeze({successes: 0, failures: 0});
const DAMAGE = new Set(["damage", "durabilityDamage"]);
// The untyped lookup helpers; these are the only places their shapes are asserted.
const lookupActor = resolveTargetLookupValue as unknown as (lookup: unknown, target: Data, payload: unknown,
  options: {selectValue(value: unknown): unknown}) => unknown;
const refsOf = targetLookupRefs as unknown as (target: Data) => string[];
const HEALING = new Set(["healing", "durabilityHealing"]);

/**
 * Whether a creature makes death saves at 0 health (else it dies): its own `dyingMode` setting, or under
 * `auto` a character, or a companion or sidekick a Player controls (it follows its character).
 */
export function makesDeathSaves({type, dyingMode="auto", companion=null, playerControlled=false}: {type?: string | undefined;
  dyingMode?: string | undefined; companion?: {controllers?: readonly string[]} | null; playerControlled?: boolean}) {
  if ( dyingMode === "deathSaves" ) return true;
  if ( dyingMode === "dies" ) return false;
  return (type === "character") || (!!companion?.controllers?.length && playerControlled);
}

/** What a change to a creature's health means under the dying rules, or null when nothing follows. */
export function dyingAfterChange({change, critical=false, character=true, deathSaves=RESET}: {
  change: DurabilityChange; critical?: boolean; character?: boolean; deathSaves?: DeathSaves;
}): DyingConsequence | null {
  const from = Number(change.from) || 0;
  const to = Number(change.to) || 0;
  const max = Number(change.max) || 0;
  const amount = Number(change.amount) || 0;
  if ( DAMAGE.has(String(change.type)) && (amount > 0) ) {
    if ( (from > 0) && (to === 0) ) {
      // Massive damage: what is left after reaching 0 is at least the maximum.
      if ( !character || ((Number(change.overflow) || 0) >= max) ) return {die: true};
      return {unconscious: true, deathSaves: {...RESET}};
    }
    if ( from === 0 ) {
      if ( !character || (amount >= max) ) return {die: true};
      const failures = deathSaves.failures + (critical ? 2 : 1);
      return failures >= 3 ? {die: true} : {deathSaves: {...deathSaves, failures}};
    }
  }
  if ( HEALING.has(String(change.type)) && (from === 0) && (to > 0) ) return {wake: true, deathSaves: {...RESET}};
  return null;
}

/** A death save: 10 or higher succeeds; a natural 1 is two failures; a natural 20 brings the creature back with 1. */
export function deathSaveResult({natural, total, deathSaves=RESET}: {natural: number; total: number; deathSaves?: DeathSaves}):
  DyingConsequence {
  if ( natural === 20 ) return {heal: 1, wake: true, deathSaves: {...RESET}};
  if ( (natural !== 1) && (total >= DEATH_SAVE_DC) ) return {deathSaves: {...deathSaves, successes: Math.min(deathSaves.successes + 1, 3)}};
  const failures = deathSaves.failures + (natural === 1 ? 2 : 1);
  return failures >= 3 ? {die: true} : {deathSaves: {...deathSaves, failures}};
}

interface DyingActor {
  uuid: string; id: string; type?: string; name?: string; hasPlayerOwner?: boolean;
  system: {resources?: {health?: {value?: number}}; deathSaves?: DeathSaves; dyingMode?: string;
    companion?: {controllers?: string[]}};
  effects: Iterable<{system?: {type?: string; level?: number}; parent?: unknown}>;
  update(data: Data): Promise<unknown>;
  toggleCondition(type: string, options?: {levels?: number}): Promise<unknown>;
  toggleStatusEffect(id: string, options?: Data): Promise<unknown>;
}
interface Combatant {actor?: DyingActor | null; token?: {id: string; parent?: {id: string} | null} | null; defeated?: boolean;
  update(data: Data): Promise<unknown>}

const hasCondition = (actor: DyingActor, id: string) => [...actor.effects].some(effect => effect.system?.type === id);
const deathSavesOf = (actor: DyingActor): DeathSaves => ({successes: Number(actor.system.deathSaves?.successes) || 0,
  failures: Number(actor.system.deathSaves?.failures) || 0});
const savesForDeath = (actor: DyingActor) => makesDeathSaves({type: actor.type, dyingMode: actor.system.dyingMode,
  companion: actor.system.companion ?? null, playerControlled: actor.hasPlayerOwner === true});

export function createFoundryDying({game, coordinator, resolveAction, logger=globalThis.console}: {
  game: {user: {id: string}; users?: {activeGM?: {id: string} | null}; combats?: Iterable<{combatants: Iterable<Combatant>}>;
    i18n?: {localize(key: string): string}};
  coordinator: {resolveAuthorityAction(options: Data): Promise<{ok: boolean; state?: {status?: string}}>};
  resolveAction(options: Data): Promise<Data & {ok: boolean; reason?: string}>;
  logger?: {warn(...args: unknown[]): void};
}) {
  let sequence = 0;
  const isActiveGM = () => game.users?.activeGM?.id === game.user.id;
  const isDead = (actor: DyingActor) => hasCondition(actor, "dead") || (deathSavesOf(actor).failures >= 3);

  /** Dead: 0 health, three failed death saves, and Defeated (the Token's dead overlay and every Combatant). */
  async function die(actor: DyingActor) {
    await actor.update({"system.resources.health.value": 0, "system.deathSaves": {successes: 0, failures: 3}});
    const defeated = (globalThis as {CONFIG?: {specialStatusEffects?: {DEFEATED?: string}}}).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
    if ( !hasCondition(actor, defeated) ) await actor.toggleStatusEffect(defeated, {active: true, overlay: true});
    for ( const combat of game.combats ?? [] ) {
      for ( const combatant of combat.combatants ) {
        if ( (combatant.actor?.uuid === actor.uuid) && !combatant.defeated ) await combatant.update({defeated: true});
      }
    }
  }

  async function apply(actor: DyingActor, consequence: DyingConsequence | null) {
    if ( !consequence || isDead(actor) ) return;
    if ( consequence.die ) return die(actor);
    const update: Data = {};
    if ( consequence.deathSaves ) update["system.deathSaves"] = consequence.deathSaves;
    if ( consequence.heal ) update["system.resources.health.value"] = consequence.heal;
    if ( Object.keys(update).length ) await actor.update(update);
    if ( consequence.unconscious && !hasCondition(actor, "unconscious") ) await actor.toggleCondition("unconscious");
    if ( consequence.wake && hasCondition(actor, "unconscious") ) await actor.toggleCondition("unconscious", {levels: -1});
  }

  /** The health changes `plans` committed on `actor` (a condition's damage at turn start). */
  async function afterPlans(actor: DyingActor | null, plans: readonly Data[] = [], {critical=false}={}) {
    if ( !actor || !isActiveGM() ) return;
    for ( const entry of plans ) {
      const change = ((entry.plan as DurabilityChange | undefined) ?? entry) as DurabilityChange & {type?: string};
      const type = String((entry.plan ? (change.type ?? entry.type) : entry.type) ?? "");
      await apply(actor, dyingAfterChange({change: {...change, type}, critical, character: savesForDeath(actor),
        deathSaves: deathSavesOf(actor)}));
    }
  }

  /** After an Action: each target whose health it changed, a critical hit counting as two failed saves at 0. */
  async function afterResolution({options, state}: {options?: {targetActors?: unknown}; state?: Data}) {
    if ( !isActiveGM() ) return;
    const hits = ((state?.results as Data | undefined)?.attackResolution as {hits?: Array<{outcome?: string; target?: Data}>} | undefined)?.hits ?? [];
    const criticalRefs = new Set(hits.filter(hit => hit.outcome === "criticalHit").flatMap(hit => refsOf(hit.target ?? {})));
    for ( const entry of (state?.mutationPlans as Data[] | undefined) ?? [] ) {
      if ( !DAMAGE.has(String(entry.type)) && !HEALING.has(String(entry.type)) ) continue;
      const target = mutationTargetIdentity((entry.target ?? (entry.plan as Data | undefined)?.target ?? {}) as Data);
      const actor = lookupActor(options?.targetActors, target, entry,
        {selectValue: value => (value as {actor?: DyingActor} | null)?.actor ?? value}) as DyingActor | null;
      await afterPlans(actor, [entry], {critical: refsOf(target).some(ref => criticalRefs.has(ref))});
    }
  }

  /** At the start of its turn a dying character (0 health, not stable, not dead) rolls its death save. */
  async function onTurnStart({combatant}: {combatant?: Combatant | null}) {
    const actor = combatant?.actor ?? null;
    if ( !actor || !isActiveGM() || !savesForDeath(actor) || isDead(actor) ) return null;
    if ( (Number(actor.system.resources?.health?.value) || 0) > 0 || (deathSavesOf(actor).successes >= 3) ) return null;
    const token = combatant?.token ?? null;
    const label = game.i18n?.localize("WILDPATH.DYING.DeathSave") ?? "Death Saving Throw";
    const self = {actorRef: actor.uuid, ...(token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {})};
    const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
      resolutionId: `death-save:${actor.uuid}:${++sequence}`, label, actorRef: actor.uuid,
      source: token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {}, target: self,
      definition: {schemaVersion: 1, id: "action:death-saving-throw", label, costs: {allOf: []}, tags: ["death-save"],
        save: {ability: "death", dc: {value: DEATH_SAVE_DC}}}}) as Data | null;
    const roll = (((state?.results as Data | undefined)?.saveResolution as {results?: Array<{roll?: {die?: number; natural?: number;
      total?: number}}>} | undefined)?.results?.[0]?.roll) ?? null;
    if ( !roll || !Number.isFinite(Number(roll.total)) ) return null;
    const consequence = deathSaveResult({natural: Number(roll.die ?? roll.natural), total: Number(roll.total), deathSaves: deathSavesOf(actor)});
    await apply(actor, consequence);
    return consequence;
  }

  /** Exhaustion's sixth level is death. */
  async function onEffectChanged(effect: {system?: {type?: string; level?: number}; parent?: unknown}) {
    if ( !isActiveGM() || (effect.system?.type !== "exhaustion") || ((Number(effect.system.level) || 0) < 6) ) return;
    await apply(effect.parent as DyingActor, {die: true});
  }

  return {afterResolution, afterPlans, onTurnStart, onEffectChanged, die};
}

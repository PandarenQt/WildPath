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
const STABLE: DeathSaves = Object.freeze({successes: 3, failures: 0});
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
      // 2024: a stable creature that takes damage stops being stable, and its death saves start over.
      const counted = deathSaves.successes >= 3 ? RESET : deathSaves;
      const failures = counted.failures + (critical ? 2 : 1);
      return failures >= 3 ? {die: true} : {deathSaves: {...counted, failures}};
    }
  }
  if ( HEALING.has(String(change.type)) && (from === 0) && (to > 0) ) return {wake: true, deathSaves: {...RESET}};
  return null;
}

/** When a creature became stable and how long it waits to regain 1 health: `hours` (1d4), counting rests' hours. */
export interface StableSince {worldTime: number; hours: number; restHours?: number}

/** 2024: a stable creature regains 1 health after 1d4 hours. World time counts, and so do the hours of its rests. */
export function stableRecovered(since: StableSince | null | undefined, worldTime: number) {
  if ( !since ) return false;
  const waited = ((Number(worldTime) || 0) - (Number(since.worldTime) || 0)) + ((Number(since.restHours) || 0) * 3600);
  return waited >= (Math.max(1, Number(since.hours) || 1) * 3600);
}

/** A death save: 10 or higher succeeds; a natural 1 is two failures; a natural 20 brings the creature back with 1. */
export function deathSaveResult({natural, total, deathSaves=RESET}: {natural: number; total: number; deathSaves?: DeathSaves}):
  DyingConsequence {
  if ( natural === 20 ) return {heal: 1, wake: true, deathSaves: {...RESET}};
  // The third success makes the creature stable (successes 3), and its failures reset (2024).
  if ( (natural !== 1) && (total >= DEATH_SAVE_DC) ) return {deathSaves: deathSaves.successes >= 2 ? {...STABLE}
    : {...deathSaves, successes: deathSaves.successes + 1}};
  const failures = deathSaves.failures + (natural === 1 ? 2 : 1);
  return failures >= 3 ? {die: true} : {deathSaves: {...deathSaves, failures}};
}

interface DyingActor {
  uuid: string; id: string; type?: string; name?: string; hasPlayerOwner?: boolean;
  flags?: {wildpath?: {stableSince?: StableSince}};
  setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
  unsetFlag(scope: string, key: string): Promise<unknown>;
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

/** 1d4 hours, rolled with Foundry's dice. */
async function rollStableHours() {
  const Roll = (globalThis as {Roll?: new (formula: string) => {evaluate(): Promise<{total: number}>}}).Roll;
  return Roll ? (await new Roll("1d4").evaluate()).total : 1 + Math.floor(Math.random() * 4);
}

export function createFoundryDying({game, coordinator, resolveAction, logger=globalThis.console, rollHours=rollStableHours}: {
  game: {user: {id: string}; users?: {activeGM?: {id: string} | null}; combats?: Iterable<{combatants: Iterable<Combatant>}>;
    i18n?: {localize(key: string): string}; time?: {worldTime?: number}; actors?: Iterable<DyingActor>;
    scenes?: Iterable<{tokens: Iterable<{actorLink?: boolean; actor?: DyingActor | null}>}>};
  coordinator: {resolveAuthorityAction(options: Data): Promise<{ok: boolean; state?: {status?: string}}>};
  resolveAction(options: Data): Promise<Data & {ok: boolean; reason?: string}>;
  logger?: {warn(...args: unknown[]): void};
  rollHours?: () => Promise<number>;
}) {
  let sequence = 0;
  const isActiveGM = () => game.users?.activeGM?.id === game.user.id;
  const isDead = (actor: DyingActor) => hasCondition(actor, "dead") || (deathSavesOf(actor).failures >= 3);
  const worldTime = () => Number(game.time?.worldTime) || 0;

  /** A creature just became stable: it starts waiting 1d4 hours to regain 1 health. */
  async function markStable(actor: DyingActor) {
    if ( actor.flags?.wildpath?.stableSince ) return;
    await actor.setFlag("wildpath", "stableSince", {worldTime: worldTime(), hours: await rollHours()});
  }

  async function clearStable(actor: DyingActor) {
    if ( actor.flags?.wildpath?.stableSince ) await actor.unsetFlag("wildpath", "stableSince");
  }

  /** Dead: 0 health, three failed death saves, and Defeated (the Token's dead overlay and every Combatant). */
  async function die(actor: DyingActor) {
    await actor.update({"system.resources.health.value": 0, "system.deathSaves": {successes: 0, failures: 3}});
    await clearStable(actor);
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
    // Stability starts the wait for 1 health; healing, waking or a death save starting over ends it.
    if ( (consequence.deathSaves?.successes ?? 0) >= 3 ) await markStable(actor);
    else if ( consequence.deathSaves || consequence.heal || consequence.wake ) await clearStable(actor);
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
    await stabilizeTargets({options, state});
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

  /**
   * A `stabilize` Action (2024: Spare the Dying, or an ally's DC 10 Medicine check) makes each dying target stable:
   * three successes, no failures. A failed check withholds it, as it withholds the Action's effects.
   */
  async function stabilizeTargets({options, state}: {options?: {targetActors?: unknown} | undefined; state?: Data | undefined}) {
    const definition = state?.actionDefinition as {stabilize?: boolean} | undefined;
    const results = state?.results as {checkResolution?: {success?: boolean}; actionResult?: {context?: {targets?: Data[]}}} | undefined;
    if ( (definition?.stabilize !== true) || (results?.checkResolution?.success === false) ) return;
    for ( const target of results?.actionResult?.context?.targets ?? [] ) {
      const actor = lookupActor(options?.targetActors, mutationTargetIdentity(target), target,
        {selectValue: value => (value as {actor?: DyingActor} | null)?.actor ?? value}) as DyingActor | null;
      if ( !actor || !savesForDeath(actor) || isDead(actor) || ((Number(actor.system.resources?.health?.value) || 0) > 0) ) continue;
      await actor.update({"system.deathSaves": {...STABLE}});
      await markStable(actor);
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

  /** A stable creature that has waited long enough regains 1 health and wakes (2024); one no longer dying stops waiting. */
  async function recoverIfDue(actor: DyingActor, now=worldTime()) {
    const since = actor.flags?.wildpath?.stableSince;
    if ( !since ) return false;
    if ( isDead(actor) || ((Number(actor.system.resources?.health?.value) || 0) > 0) ) {
      await clearStable(actor);
      return false;
    }
    if ( !stableRecovered(since, now) ) return false;
    await apply(actor, {heal: 1, wake: true, deathSaves: {...RESET}});
    return true;
  }

  /** A rest's hours count toward a stable creature's wait (tables that do not advance world time still recover). */
  async function restHours(actor: DyingActor, hours: number) {
    const since = actor.flags?.wildpath?.stableSince;
    if ( !since ) return false;
    await actor.setFlag("wildpath", "stableSince", {...since, restHours: (Number(since.restHours) || 0) + hours});
    return recoverIfDue(actor);
  }

  /** World time moved on (the active GM): every stable creature that has waited long enough regains 1 health. */
  async function onWorldTime(now=worldTime()) {
    if ( !isActiveGM() ) return;
    const actors = new Set<DyingActor>([...(game.actors ?? [])]);
    for ( const scene of game.scenes ?? [] ) {
      for ( const token of scene.tokens ) if ( !token.actorLink && token.actor ) actors.add(token.actor);
    }
    for ( const actor of actors ) if ( actor.flags?.wildpath?.stableSince ) await recoverIfDue(actor, now);
  }

  /** Exhaustion's sixth level is death. */
  async function onEffectChanged(effect: {system?: {type?: string; level?: number}; parent?: unknown}) {
    if ( !isActiveGM() || (effect.system?.type !== "exhaustion") || ((Number(effect.system.level) || 0) < 6) ) return;
    await apply(effect.parent as DyingActor, {die: true});
  }

  return {afterResolution, afterPlans, onTurnStart, onEffectChanged, die, restHours, onWorldTime};
}

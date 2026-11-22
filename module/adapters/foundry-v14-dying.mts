import {mutationTargetIdentity} from "../helpers/mutation-target.mjs";
import {resolveTargetLookupValue, sameTargetRefs, targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {runAuthorityAction, worldCreatures} from "./foundry-v14-automation-dispatcher.mjs";
import {zeroHpFor, beginPhase} from "./foundry-v14-zero-hp.mjs";
import {foundryActorSystemSnapshot} from "./foundry-v14-actor-system-adapter.mjs";
import {commitActorResourceMutationPlan} from "../resolvers/resource-resolver.mjs";
import {creatureToken, creatureTokens} from "./foundry-v14-creature-tokens.mjs";
import {effectsFrom, itemCounts} from "../helpers/effect-sources.mjs";

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

interface RegenerationRule {type?: string; enabled?: boolean; data?: {stoppedBy?: string[]; deferDeath?: boolean}}
interface RepeatingEffect {disabled?: boolean; flags?: {wildpath?: {conditionEffect?: {metadata?: {repeatSave?: {onDamage?: boolean}}}}}}

interface DyingToken {id: string; parent?: {id: string} | null; flags?: {wildpath?: {leavesAtDeath?: boolean}}}
interface SourceEffect {id: string; flags?: {wildpath?: {conditionEffect?: {metadata?: {endsWhen?: string}}}}}
const ofDeadSource = effectsFrom as unknown as (holder: unknown, source: unknown, game: unknown) => SourceEffect[];
const endsWithSource = (effect: SourceEffect) => effect.flags?.wildpath?.conditionEffect?.metadata?.endsWhen === "sourceDies";
interface DyingActor {
  deleteEmbeddedDocuments?(type: string, ids: string[]): Promise<unknown>;
  uuid: string; id: string; type?: string; name?: string; hasPlayerOwner?: boolean; isToken?: boolean; token?: DyingToken | null;
  getDependentTokens?(options: {linked?: boolean; concreteOnly?: boolean}): DyingToken[];
  flags?: {wildpath?: {stableSince?: StableSince; damageTaken?: Record<string, boolean>}};
  items?: Iterable<{system?: {active?: boolean; ruleElements?: RegenerationRule[]}}>;
  setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
  unsetFlag(scope: string, key: string): Promise<unknown>;
  system: {resources?: {health?: {value?: number}}; deathSaves?: DeathSaves; dyingMode?: string;
    companion?: {controllers?: string[]}};
  effects: Iterable<{system?: {type?: string; level?: number}; parent?: unknown}>;
  /** WildPathActor's: a `hitPoints: "form"` transformation makes its Hit Points its form's (dropForm). */
  transformation?: {policy?: {formRef?: string; hitPoints?: unknown}} | null;
  revertTransformation?(): Promise<unknown>;
  update(data: Data): Promise<unknown>;
  toggleCondition(type: string, options?: {levels?: number}): Promise<unknown>;
  toggleStatusEffect(id: string, options?: Data): Promise<unknown>;
}
interface Combatant {actor?: DyingActor | null; token?: DyingToken | null; tokenId?: string | null; sceneId?: string | null; defeated?: boolean;
  update(data: Data): Promise<unknown>}

/**
 * A creature's Regeneration: `turn.started` Triggers on its active features that name the damage that stops them
 * (`stoppedBy`) or put off its death at 0 health until its turn starts (`deferDeath`). Not a suppressed one (itemCounts).
 */
const regenerationsOf = (actor: DyingActor) => [...(actor.items ?? [])].filter(item => itemCounts(item, actor))
  .flatMap(item => item.system?.ruleElements ?? [])
  .filter(rule => (rule.type === "Trigger") && (rule.enabled !== false) && (rule.data?.stoppedBy?.length || rule.data?.deferDeath));

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

export function createFoundryDying({game, coordinator, resolveAction, logger=globalThis.console, rollHours=rollStableHours,
  fromUuid=uuid => (globalThis as {fromUuid?(uuid: string): Promise<unknown>}).fromUuid?.(uuid), removeTokens=async () => {},
  endWithSource=async () => {}}: {
  game: {user: {id: string}; users?: {activeGM?: {id: string} | null}; combats?: Iterable<{started?: boolean; combatants: Iterable<Combatant>}>;
    i18n?: {localize(key: string): string}; time?: {worldTime?: number}; actors?: Iterable<DyingActor>;
    scenes?: Iterable<{tokens?: Iterable<{actor?: DyingActor | null}>}>};
  coordinator: {resolveAuthorityAction(options: Data): Promise<{ok: boolean; state?: {status?: string}}>};
  resolveAction(options: Data): Promise<Data & {ok: boolean; reason?: string}>;
  logger?: {warn(...args: unknown[]): void};
  rollHours?: () => Promise<number>;
  fromUuid?: (uuid: string) => Promise<unknown> | unknown;
  /** The summons adapter's `dismiss`: Tokens leave the Scene with their Combatants (a summon's caster's marker too). */
  removeTokens?: (scene: NonNullable<DyingToken["parent"]>, tokenIds: string[]) => Promise<unknown>;
  /** Ends the dead creature's lasting areas that end with it (the runtime wires the areas adapter's `endWithSource`). */
  endWithSource?: (actor: DyingActor) => Promise<unknown>;
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
    // What it does as it dies (a mephit's Death Burst): its automatic triggers on `creature.died`.
    await raise("creature.died", actor, undefined, "Wild Path | A death trigger failed");
  }

  /** `actor`'s automatic triggers on `type`; a failing trigger is logged, not thrown, so the dying rules still finish. */
  async function raise(type: string, actor: DyingActor, data: Data | undefined, failure: string) {
    try {
      await (globalThis as {game?: {wildpath?: {automation?: {dispatch?(type: string, data: Data): Promise<unknown>}}}}).game?.wildpath
        ?.automation?.dispatch?.(type, {actor, token: creatureToken(actor, game), ...(data ? {data} : {})});
    } catch (error) {
      logger.warn(failure, error);
    }
  }

  /**
   * What ends with a creature's death, settled once nothing still runs on it: its lasting areas that end with it
   * (`endWithSource`), first so nobody is saved against again; the effects it gave whose row says
   * `metadata.endsWhen: "sourceDies"`, on any creature; then its Tokens flagged `flags.wildpath.leavesAtDeath: true`,
   * removed with their Combatants (`removeTokens`).
   */
  async function settle(actor: DyingActor) {
    try {
      await endWithSource(actor);
      // Before its Tokens go, as effectsFrom knows the giver by them.
      // shortcut: effectsFrom skips disabled effects, so one suppressed as its giver dies stays; include them if a
      // suppressed sourceDies effect turns up.
      for ( const holder of worldCreatures(game) ) {
        if ( ![...holder.effects].some(effect => endsWithSource(effect as SourceEffect)) ) continue;
        const ended = ofDeadSource(holder, actor, game).filter(endsWithSource).map(effect => effect.id);
        if ( ended.length ) await holder.deleteEmbeddedDocuments?.("ActiveEffect", ended);
      }
      for ( const token of creatureTokens(actor).filter(token => token.flags?.wildpath?.leavesAtDeath === true) ) {
        if ( token.parent ) await removeTokens(token.parent, [token.id]);
      }
    } catch (error) {
      logger.warn("Wild Path | Settling a death failed", error);
    }
  }

  /**
   * A death its condition damage brought in a turn start ends its creature's lasting areas at once (Combat, right after
   * `afterPlans`), so none of them answers that turn start; the rest of its settling waits for `onTurnStart`, whose
   * settle finds those areas gone.
   */
  async function endAreas(actor: DyingActor) {
    if ( !isActiveGM() ) return;
    try {
      await endWithSource(actor);
    } catch (error) {
      logger.warn("Wild Path | Settling a death failed", error);
    }
  }

  /**
   * The creatures an Action killed (its `killed`), settled last in the runtime's afterCompleted, before the follow-ups
   * it starts and does not await (the active GM).
   */
  async function settleDeaths(actorUuids: readonly string[]) {
    if ( !isActiveGM() ) return;
    for ( const uuid of new Set(actorUuids) ) {
      const actor = await fromUuid(uuid) as DyingActor | null;
      if ( actor ) await settle(actor);
    }
  }

  /** True when it killed `actor`: one already dead (a corpse, even one healed since) is never killed again. */
  async function apply(actor: DyingActor, given: DyingConsequence | null): Promise<boolean> {
    if ( !given || isDead(actor) ) return false;
    // A creature that can't regain Hit Points (Chill Touch) neither heals nor wakes, and its death saves don't start over.
    const blocked = ((actor as unknown as {system?: {resourceCaps?: {healing?: number}}}).system?.resourceCaps?.healing === 0)
      && Boolean(given.heal || given.wake);
    const {deathSaves: _reset, ...kept} = given;
    const consequence: DyingConsequence = blocked ? {...kept, heal: 0, wake: false} : given;
    if ( consequence.die ) {
      await die(actor);
      return true;
    }
    const update: Data = {};
    if ( consequence.deathSaves ) update["system.deathSaves"] = consequence.deathSaves;
    if ( consequence.heal ) update["system.resources.health.value"] = consequence.heal;
    if ( Object.keys(update).length ) await actor.update(update);
    // Stability starts the wait for 1 health; healing, waking or a death save starting over ends it.
    if ( (consequence.deathSaves?.successes ?? 0) >= 3 ) await markStable(actor);
    else if ( consequence.deathSaves || consequence.heal || consequence.wake ) await clearStable(actor);
    if ( consequence.unconscious && !hasCondition(actor, "unconscious") ) await actor.toggleCondition("unconscious");
    if ( consequence.wake && hasCondition(actor, "unconscious") ) await actor.toggleCondition("unconscious", {levels: -1});
    return false;
  }

  /**
   * The damage types that stop a creature's Regeneration, recorded when it takes them (more than 0); they count until
   * its next turn starts.
   */
  async function recordStoppingDamage(actor: DyingActor, entry: Data) {
    const stopping = new Set(regenerationsOf(actor).flatMap(rule => rule.data?.stoppedBy ?? []));
    const taken = ((entry.plan as {metadata?: {damageResult?: {byDamageType?: Record<string, number>}}} | undefined)
      ?.metadata?.damageResult?.byDamageType) ?? {};
    const types = Object.entries(taken).filter(([type, amount]) => stopping.has(type) && (Number(amount) > 0)
      && !actor.flags?.wildpath?.damageTaken?.[type]).map(([type]) => type);
    if ( types.length ) await actor.update(Object.fromEntries(types.map(type => [`flags.wildpath.damageTaken.${type}`, true])));
  }

  /**
   * What a creature took, by type, for its own `damage.taken` automation triggers (a Flesh Golem's Aversion to Fire):
   * `event.data.damageTaken.<type>` is true for each type it took more than 0 of. Only a creature that has such a trigger,
   * or an effect whose save its damage repeats, is dispatched for, so every other hit costs nothing.
   */
  async function dispatchDamageTaken(actor: DyingActor, entry: Data) {
    const listens = [...((actor as unknown as {items?: Iterable<{system?: {active?: boolean; ruleElements?: Data[]}}>}).items ?? [])]
      .some(item => (item.system?.active !== false) && (item.system?.ruleElements ?? [])
        .some(rule => (rule.type === "Trigger") && ((rule.data as Data | undefined)?.event === "damage.taken")))
      // An effect whose save its creature repeats as it takes damage (Dominate Person: the automation dispatcher).
      || [...((actor as unknown as {effects?: Iterable<RepeatingEffect>}).effects ?? [])]
        .some(effect => !effect.disabled && (effect.flags?.wildpath?.conditionEffect?.metadata?.repeatSave?.onDamage === true));
    if ( !listens ) return;
    const taken = ((entry.plan as {metadata?: {damageResult?: {byDamageType?: Record<string, number>}}} | undefined)
      ?.metadata?.damageResult?.byDamageType) ?? {};
    const types = Object.entries(taken).filter(([, amount]) => Number(amount) > 0).map(([type]) => type);
    if ( !types.length ) return;
    await raise("damage.taken", actor, {damageTaken: Object.fromEntries(types.map(type => [type, true]))},
      "Wild Path | A damage trigger failed");
  }

  /**
   * The health changes `plans` committed on `actor` (a condition's damage at turn start). With `rescue`, damage outside
   * an Action that dropped it to 0 may keep it up first (rescueAtZero); an Action's own damage was checked before
   * commit, so `afterResolution` rescues only a drop its commit's rebase newly made (`zeroHpUnchecked`). True when they killed it.
   * A creature in a `hitPoints: "form"` form that drops to 0 drops its form instead (dropForm): `killed` collects a form
   * that died (an Action's), and `dropped` (shared across one Action's plans) skips its later plans.
   */
  async function afterPlans(actor: DyingActor | null, plans: readonly Data[] = [], {critical=false, rescue=false, killed=null,
    dropped=new Set<string>()}: {critical?: boolean; rescue?: boolean; killed?: string[] | null; dropped?: Set<string>}={}) {
    if ( !actor || !isActiveGM() ) return false;
    let died = false;
    for ( const entry of plans ) {
      // shortcut: its later plans were its form's Hit Points, which dropForm left the form at 0, so they are dropped (a
      // second ray's failed death save on a body that makes them); carry them to the form if a table needs it.
      if ( dropped.has(actor.uuid) ) break;
      const change = ((entry.plan as DurabilityChange | undefined) ?? entry) as DurabilityChange & {type?: string};
      const type = String((entry.plan ? (change.type ?? entry.type) : entry.type) ?? "");
      const rescued = rescue && DAMAGE.has(type) && await rescueAtZero(actor, change as DurabilityChange & Data, critical);
      // Kept up at 1, it still took the damage (a dominated Zombie's repeated save).
      if ( DAMAGE.has(type) ) await recordStoppingDamage(actor, entry);
      if ( DAMAGE.has(type) ) await dispatchDamageTaken(actor, entry);
      if ( rescued ) continue;
      if ( DAMAGE.has(type) && actor.transformation?.policy?.hitPoints && ((Number(change.amount) || 0) > 0)
        && ((Number(change.to) || 0) === 0) ) {
        dropped.add(actor.uuid);
        await dropForm(actor, entry, {...change, type}, critical, killed);
        continue;
      }
      died = await apply(actor, consequenceOf(actor, {...change, type}, critical)) || died;
    }
    return died;
  }

  /** What a health change means for `actor` under its own dying rule. */
  function consequenceOf(actor: DyingActor, change: DurabilityChange, critical: boolean) {
    const consequence = dyingAfterChange({change, critical, character: savesForDeath(actor), deathSaves: deathSavesOf(actor)});
    // A creature whose Regeneration puts off its death lies at 0 until its turn starts.
    if ( consequence?.die && !savesForDeath(actor) && regenerationsOf(actor).some(rule => rule.data?.deferDeath) ) {
      return {unconscious: true};
    }
    return consequence;
  }

  /**
   * A creature whose Hit Points are its form's (`transform.hitPoints: "form"`: a possession) dropped to 0: not its own
   * dying rule but its form's. It reverts first, so it has its own Hit Points back and the form is given the 0 left (the
   * damage past 0 stays with the form); the form records the damage that stops its own Regeneration, then takes the
   * drop under its own rule (an NPC dies, one that makes death saves falls Unconscious, massive damage against the
   * maximum it lent kills either); last, the creature's `form.dropped` Triggers run with `{formRef, died}`, `died` true
   * when the form is dead (also when its own Token was killed earlier in the Action). A form this drop killed counts
   * among an Action's `killed`, settled with them; outside an Action (a condition's damage at the creature's turn start)
   * it settles at once, as it is not the creature whose turn it is.
   */
  async function dropForm(actor: DyingActor, entry: Data, change: DurabilityChange, critical: boolean, killed: string[] | null) {
    const formRef = String(actor.transformation?.policy?.formRef ?? "");
    await actor.revertTransformation?.();
    const form = (formRef ? await fromUuid(formRef) : null) as DyingActor | null;
    // shortcut: only the dropping hit is recorded on the form, not stopping damage the creature took earlier that turn
    // while in it; record each hit on the form if a regenerating host turns up.
    if ( form ) await recordStoppingDamage(form, entry);
    if ( form && await apply(form, consequenceOf(form, change, critical)) ) {
      if ( killed ) killed.push(form.uuid);
      else await settle(form);
    }
    await raise("form.dropped", actor, {formRef, died: !!form && isDead(form)}, "Wild Path | A form trigger failed");
  }

  /**
   * Damage outside an Action that dropped `actor` from above 0 to 0, not by massive damage: its drop-to-0 rule
   * (Relentless Endurance, Relentless Rage, Undead Fortitude; zeroHpFor) may keep it up. Its use is paid; a save is a
   * save-only authority Action on it, so the dice policy prompts its controller or rolls. True when it stayed up.
   */
  async function rescueAtZero(actor: DyingActor, change: DurabilityChange & Data, critical = false): Promise<boolean> {
    if ( !((Number(change.from) || 0) > 0) || ((Number(change.to) || 0) !== 0)
      || ((Number(change.overflow) || 0) >= (Number(change.max) || 0)) ) return false;
    let system: Data;
    try { system = foundryActorSystemSnapshot(actor as never) as Data; } catch { return false; }
    const rule = zeroHpFor(actor as unknown as Data, system);
    if ( !rule ) return false;
    const metadata = (change.metadata ?? {}) as {damageType?: string; damageResult?: {byDamageType?: Record<string, number>}};
    const byType = metadata.damageResult?.byDamageType ?? {};
    if ( (rule.notOn ?? []).some((reason: string) => ((reason === "critical") ? critical
      : ((reason === metadata.damageType) || (Number(byType[reason]) > 0)))) ) return false;
    if ( rule.payment?.plan ) await commitActorResourceMutationPlan(actor, rule.payment.plan);
    let kept = rule.mode !== "save";
    if ( !kept ) {
      const dc = rule.dc ?? ((Number(rule.dcPlusDamage) || 0) + (Number(change.amount) || 0));
      const token = creatureToken(actor, game);
      const where = token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {};
      const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
        resolutionId: `zero-hp:${actor.uuid}:${++sequence}`, label: String(rule.name ?? ""), actorRef: actor.uuid, source: where,
        target: {actorRef: actor.uuid, ...where}, definition: {schemaVersion: 1, id: "action:zero-hp-save", label: String(rule.name ?? ""),
          costs: {allOf: []}, save: {ability: rule.ability, dc: {value: dc}}}}) as Data | null;
      kept = ((state?.results as {saveResolution?: {successes?: unknown[]}} | undefined)?.saveResolution?.successes?.length ?? 0) > 0;
    }
    // Kept up at 1 is no healing: "can't regain Hit Points" (Chill Touch) doesn't stop it.
    if ( kept ) await (actor.update as (data: Data, options?: Data) => Promise<unknown>).call(actor, {"system.resources.health.value": rule.hitPoints},
      {wildpath: {notHealing: true}});
    // A ward from an effect (Death Ward) ends once it has kept its creature up.
    if ( kept && rule.effectUuid ) await ((await (globalThis as unknown as {fromUuid?(uuid: string): Promise<unknown>}).fromUuid?.(String(rule.effectUuid))) as {delete?(): Promise<unknown>} | null)?.delete?.();
    // A phase that kept it up (a mythic creature's) begins.
    if ( kept && rule.flag ) await beginPhase(actor as unknown as Data, rule);
    return kept;
  }

  /**
   * After an Action: each target whose health it changed, a critical hit counting as two failed saves at 0, and each it
   * gave the Dead condition (Divine Word; a Dead the GM toggles from the HUD is no Action's and stays a status). The uuids
   * of the creatures it killed (a `summon.fromKilled` Action raises them). Run once the Action has committed, so a
   * rolled-back Action kills no one.
   */
  async function afterResolution({options, state}: {options?: {targetActors?: unknown}; state?: Data}): Promise<string[]> {
    const killed: string[] = [];
    if ( !isActiveGM() ) return killed;
    await stabilizeTargets({options, state});
    const hits = ((state?.results as Data | undefined)?.attackResolution as {hits?: Array<{outcome?: string; target?: Data}>} | undefined)?.hits ?? [];
    const criticalRefs = hits.filter(hit => hit.outcome === "criticalHit").map(hit => refsOf(hit.target ?? {}));
    const dropped = new Set<string>();
    for ( const entry of (state?.mutationPlans as Data[] | undefined) ?? [] ) {
      const givesDead = (entry.type === "conditionEffect") && (entry.conditionId === "dead") && ((Number(entry.levels) || 0) > 0);
      if ( !givesDead && !DAMAGE.has(String(entry.type)) && !HEALING.has(String(entry.type)) ) continue;
      const target = mutationTargetIdentity((entry.target ?? (entry.plan as Data | undefined)?.target ?? {}) as Data);
      const actor = lookupActor(options?.targetActors, target, entry,
        {selectValue: value => (value as {actor?: DyingActor} | null)?.actor ?? value}) as DyingActor | null;
      if ( givesDead ) {
        // isDead already counts the committed status, so not `apply`; three failures mean it was dead already.
        if ( actor && (deathSavesOf(actor).failures < 3) ) {
          await die(actor);
          killed.push(actor.uuid);
        }
        continue;
      }
      if ( await afterPlans(actor, [entry], {critical: criticalRefs.some(refs => sameTargetRefs(refsOf(target), refs)),
        rescue: (entry.plan as Data | undefined)?.zeroHpUnchecked === true, killed, dropped}) && actor ) killed.push(actor.uuid);
    }
    return killed;
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

  /**
   * Last in Combat's turn start: what follows from it for the dying (below), then a death in it settled, `died` being
   * one its condition damage brought earlier in it (`afterPlans`). Last, as removing a leaving Token and its Combatant
   * starts the next turn in Foundry, which must not happen while this one's steps still run on it.
   */
  async function onTurnStart({combatant, died=false}: {combatant?: Combatant | null; died?: boolean}) {
    const actor = combatant?.actor ?? null;
    const alive = !!actor && !isDead(actor);
    try {
      return await turnStart(combatant);
    } finally {
      if ( actor && isActiveGM() && (died || (alive && isDead(actor))) ) await settle(actor);
    }
  }

  /** At the start of its turn a dying character (0 health, not stable, not dead) rolls its death save. */
  async function turnStart(combatant: Combatant | null | undefined) {
    const actor = combatant?.actor ?? null;
    if ( !actor || !isActiveGM() ) return null;
    const regenerations = regenerationsOf(actor);
    if ( regenerations.length ) {
      // "It dies only if it starts its turn with 0 Hit Points and doesn't regenerate": its Regeneration has run by now.
      if ( regenerations.some(rule => rule.data?.deferDeath) && !savesForDeath(actor) && !isDead(actor)
        && ((Number(actor.system.resources?.health?.value) || 0) === 0) ) await die(actor);
      // The damage that stopped it counted for this turn only.
      if ( actor.flags?.wildpath?.damageTaken ) await actor.unsetFlag("wildpath", "damageTaken");
    }
    // One lying Unconscious at 0 that no longer makes death saves (a swayed swarm its piper's Player no longer controls)
    // dies as its turn starts, as it would have dropping to 0 then.
    if ( !savesForDeath(actor) && !isDead(actor) && hasCondition(actor, "unconscious")
      && ((Number(actor.system.resources?.health?.value) || 0) === 0) ) await die(actor);
    if ( !savesForDeath(actor) || isDead(actor) ) return null;
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
    for ( const actor of worldCreatures(game) ) if ( actor.flags?.wildpath?.stableSince ) await recoverIfDue(actor, now);
  }

  /** Exhaustion's sixth level is death. */
  async function onEffectChanged(effect: {system?: {type?: string; level?: number}; parent?: unknown}) {
    if ( !isActiveGM() || (effect.system?.type !== "exhaustion") || ((Number(effect.system.level) || 0) < 6) ) return;
    // shortcut: an Action's Exhaustion 6 settles here too, from its effect hook, not with the Action's killed; fold it
    // into afterResolution if a leavesAtDeath creature reaches Exhaustion 6 mid-Action.
    if ( await apply(effect.parent as DyingActor, {die: true}) ) await settle(effect.parent as DyingActor);
  }

  return {afterResolution, afterPlans, onTurnStart, onEffectChanged, die, endAreas, settleDeaths, restHours, onWorldTime};
}

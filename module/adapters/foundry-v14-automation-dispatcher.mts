import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {createAutomationEvent, createTriggerDefinition, evaluateTrigger, reactionPolicyOf} from "../helpers/automation-events.mjs";
import {sunlightContext} from "./foundry-v14-sunlight.mjs";
import {tokensAround} from "./foundry-v14-auras.mjs";
import {conditionsFrom, effectsFrom} from "../helpers/effect-sources.mjs";

type Data = Record<string, unknown>;
interface RuleElement {id?: string; type?: string; enabled?: boolean; data?: Data}
interface Owner {id: string; type?: string; name?: string; disabled?: boolean;
  system?: {active?: boolean; ruleElements?: readonly RuleElement[]; definition?: {id?: string}}}
interface AutomationActor {id: string; uuid: string; items?: Iterable<Owner>; effects?: Iterable<Owner>;
  testUserPermission?(user: unknown, level: string): boolean}
interface AutomationToken {id: string; parent?: {id: string} | null}
interface QueryUser {id: string; query?(name: string, data: Data, options: {timeout: number}): Promise<unknown>}
interface Coordinator {resolveAuthorityAction(options: Data): Promise<{ok: boolean; duplicate?: boolean; state?: {status?: string}}>}
type ResolveAction = (options: Data) => Promise<Data & {ok: boolean; reason?: string}>;
interface Logger {warn(...args: unknown[]): void}
/** A trigger acting around its creature: on each creature within `radius` feet, or (`on: "others"`) on another creature
 * whose own turn starts or ends there; or (`swallowed`) on each creature it has swallowed; or (`on: "swallowed"`, with
 * `threshold`) its regurgitating save after a swallowed creature's turn that cost it that many Hit Points. */
interface Around {radius?: number; affects?: string; on?: string; swallowed?: boolean; threshold?: number}
interface Placed {id: string; parent?: {id: string; tokens?: Iterable<Placed>} | null; actor?: (AutomationActor & {statuses?: Iterable<string>}) | null}

/**
 * The creatures a creature has swallowed (a Purple Worm's Swallow): on its scene, those with Total Cover it gave them,
 * as only a swallow does.
 */
const swallowedBy = (actor: AutomationActor, token: Placed | null): Placed[] => [...(token?.parent?.tokens ?? [])]
  .filter((other, index, all) => (other.id !== token?.id) && other.actor
    && (conditionsFrom as (holder: unknown, source: unknown) => Record<string, boolean>)(other.actor, actor).coverTotal
    // A linked creature with two Tokens here is still one creature.
    && (all.findIndex(entry => entry.actor === other.actor) === index));

/** Whether a creature is immune to an Action for now (a success's "immune to this Fear Aura for 24 hours"). */
const immuneTo = (actor: AutomationActor | null | undefined, actionId: unknown) => [...(actor?.effects ?? [])].some(effect =>
  !effect.disabled && ((effect as {flags?: {wildpath?: {conditionEffect?: {metadata?: Data}}}}).flags?.wildpath?.conditionEffect?.metadata
    ?.immuneTo === actionId));

/** The query a Player's client uses to report an event on an Actor it owns to the active GM. */
export const AUTOMATION_QUERY = "wildpath.automationEvent";
// Events a client may report, with the only data the GM takes from it. The GM raises turn and initiative events itself.
const REPORTED_EVENTS: Record<string, (data: Data) => Data> = {
  "rest.completed": data => ({restType: ["shortRest", "longRest"].includes(String(data.restType)) ? data.restType : null})
};

const definitionFor = actionDefinitionFromAction as (item: Owner) => {ok: boolean; definition?: Data | null};
const triggerDefinition = createTriggerDefinition as (options: Data) => Data;
const triggerMatches = evaluateTrigger as (trigger: Data, event: Data, context?: Data) => {ok: boolean};
const automationEvent = createAutomationEvent as unknown as (options: Data) => Data;

/**
 * Runs an Action the authority starts itself (a lasting area's effect, an automatic trigger) with one creature as
 * its only target, and waits for it to finish. Saves route to that creature's controller, as for any Action.
 * Returns the final state, or null when the Action could not start.
 */
export async function runAuthorityAction({coordinator, resolveAction, senderUserId, resolutionId, definition, label,
  actorRef, source, target=null, targets=null, configuration=null, logger=globalThis.console}: {
  coordinator: Coordinator; resolveAction: ResolveAction; senderUserId: string; resolutionId: string;
  definition: Data; label: string; actorRef: string; source: Data; target?: Data | null; targets?: Data[] | null;
  configuration?: Data | null; logger?: Logger;
}) {
  // Several creatures at once (an aura's): one Action, one damage roll for all of them (2024).
  const targetRefs = targets?.length ? targets : [target];
  const action = {id: String(definition.id), uuid: null, type: "action", name: String(definition.label ?? label),
    system: {definition: {...definition, targeting: {type: (targetRefs.length > 1) ? "multiple" : "single", required: true,
      count: targetRefs.length}}}};
  // Its choices, when already made (a "you can" set to Always); otherwise the authority asks for them.
  const resolved = await resolveAction({intent: {actorRef, source, targetRefs, ...(configuration ? {configuration} : {})},
    senderUserId, action});
  if ( !resolved.ok ) {
    logger.warn("Wild Path | An automatic effect could not resolve", resolved.reason ?? resolved);
    return null;
  }
  let finish: (state: unknown) => void = () => {};
  const finished = new Promise(resolve => { finish = resolve; });
  const hosted = await coordinator.resolveAuthorityAction({resolutionId, resolved,
    onComplete: ({state}: {state: unknown}) => finish(state)});
  // An id already used is never run again, so nothing would finish it: never wait on one.
  if ( hosted.duplicate ) return hosted.state ?? null;
  const terminal = ["completed", "failed", "cancelled"].includes(String(hosted.state?.status));
  return (hosted.ok || terminal) ? await finished : hosted.state ?? {status: "failed"};
}

/** The turn boundary each repeated save waits for. */
const REPEAT_SAVE_EVENTS: Record<string, string> = {"turn.ended": "turnEnd", "turn.started": "turnStart"};

interface RepeatSaveEffect {id: string; name?: string; disabled?: boolean;
  flags?: {wildpath?: {conditionEffect?: {sourceRef?: string | null; metadata?: Data}}}}

/**
 * The saves a creature repeats at this turn boundary (2024 Hold Person: "At the end of each of its turns, the target
 * repeats the save, ending the spell on itself on a success"): one per Action and source, with every effect that
 * save ends. Each effect stored its save (`metadata.repeatSave`: timing, ability, DC) when it was applied.
 */
export function repeatSaveGroups(effects: Iterable<RepeatSaveEffect>, eventType: string) {
  const timing = REPEAT_SAVE_EVENTS[eventType];
  const groups = new Map<string, {key: string; name: string; ability: string; dc: number; effectIds: string[]}>();
  if ( !timing ) return [];
  for ( const effect of effects ) {
    const flag = effect.flags?.wildpath?.conditionEffect;
    const repeat = flag?.metadata?.repeatSave as {timing?: string; ability?: string; dc?: number} | undefined;
    if ( effect.disabled || (repeat?.timing !== timing) || !repeat.ability || !Number.isFinite(Number(repeat.dc)) ) continue;
    const key = `${String(flag?.metadata?.actionDefinitionId ?? effect.id)}|${String(flag?.sourceRef ?? "")}`;
    const group = groups.get(key) ?? {key, name: String(effect.name ?? ""), ability: repeat.ability, dc: Number(repeat.dc), effectIds: []};
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
export function automationTriggers(actor: AutomationActor, event: Data, context: Data = {}) {
  const items = [...(actor.items ?? [])];
  const owners = [...items.filter(item => item.system?.active !== false),
    ...[...(actor.effects ?? [])].filter(effect => !effect.disabled && (effect.type !== "condition"))];
  return owners.flatMap(owner => (owner.system?.ruleElements ?? []).flatMap(element => {
    const data = element.data ?? {};
    if ( (element.type !== "Trigger") || (element.enabled === false)
      || ((data.kind ?? data.triggerKind ?? "automation") !== "automation") ) return [];
    const type = data.event ?? data.eventType ?? (data.match as Data | undefined)?.type;
    if ( !type ) return [];
    const trigger = triggerDefinition({id: `automation:${actor.id}:${owner.id}:${element.id ?? "trigger"}`, event: type,
      match: data.match ?? {}, predicate: data.triggerPredicate ?? data.eventPredicate ?? data.predicate ?? null});
    // Predicates also see the creature (`actor.system.resources.health.value`: Regeneration needs 1 Hit Point) and
    // whether it stands in sunlight (`inSunlight`: a Vampire's).
    if ( !triggerMatches(trigger, event, {actor, ...context}).ok ) return [];
    const actionItem = owner.type === "action" ? owner
      : items.find(entry => (entry.type === "action") && (entry.system?.definition?.id === data.actionId));
    const definition = (data.action as Data | undefined) ?? (actionItem ? definitionFor(actionItem).definition : null);
    // Its Item's reaction setting (Always, Never, Ask) answers a "you can" (`use`) choice. `around` (`{radius, affects}`):
    // it acts on each creature in its creature's Emanation instead of on its creature.
    return definition ? [{id: String(trigger.id), definition, label: owner.name ?? String(definition.label ?? ""),
      policy: (reactionPolicyOf as (item: unknown) => string)(owner), around: (data.around as Around | undefined) ?? null}] : [];
  }));
}

/**
 * The general automation dispatcher: an event on a creature (its turn starts or ends, it rolls initiative, it
 * finishes a rest) runs each of its automatic triggers as an authority Action on that creature. Only the active
 * GM dispatches; another client reports a rest through a user query, which the GM accepts for an owned Actor.
 */
export function createFoundryAutomationDispatcher({game, coordinator, resolveAction, logger=globalThis.console,
  fromUuid=null}: {
  game: {user: {id: string}; users?: {activeGM?: QueryUser | null}};
  coordinator: Coordinator; resolveAction: ResolveAction; logger?: Logger;
  fromUuid?: ((uuid: string) => Promise<unknown> | unknown) | null;
}) {
  let sequence = 0;
  // A swallower's Hit Points as each creature it swallowed starts its turn (`on: "swallowed"`), by swallower and creature.
  const swallowerHealth = new Map<string, number>();
  const isActiveGM = () => game.users?.activeGM?.id === game.user.id;

  async function dispatch(type: string, {actor, token=null, data={}}: {actor: AutomationActor | null; token?: AutomationToken | null;
    data?: Data}) {
    if ( !actor || !isActiveGM() ) return [];
    const event = automationEvent({id: `${type}:${actor.uuid}:${++sequence}`, type, actorId: actor.id,
      tokenId: token?.id ?? null, data});
    const self = {actorRef: actor.uuid, ...(token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {})};
    const states = [];
    // Predicates see its conditions too ("unless the azer has the Incapacitated condition").
    const context = {...sunlightContext(token as never), conditions: [...((actor as {statuses?: Iterable<string>}).statuses ?? [])]};
    for ( const {id, definition, label, policy, around} of automationTriggers(actor, event, context) ) {
      if ( ["others", "swallowed"].includes(String(around?.on)) ) continue;
      // A "you can" (Persistent Rage when initiative is rolled): Never skips it, Always uses it, Ask asks its controller.
      const optional = ((definition.configuration ?? []) as Data[]).some(choice => choice.id === "use");
      if ( optional && (policy === "never") ) continue;
      // Everyone in the Emanation (or swallowed) at once: one Action, one damage roll (2024).
      const targets = around ? (around.swallowed ? swallowedBy(actor, token as Placed | null)
        : tokensAround(token as never, around as never) as Placed[]).filter(other => !immuneTo(other.actor as never, definition.id))
        .map(other => ({actorRef: other.actor?.uuid ?? null, tokenId: other.id, sceneId: token?.parent?.id})) : [self];
      if ( !targets.length ) continue;
      const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
        resolutionId: `${id}:${sequence}`, definition, label, actorRef: actor.uuid,
        source: token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {}, targets: targets as Data[],
        ...((optional && (policy === "always")) ? {configuration: {choices: {use: "use"}}} : {})});
      if ( state ) states.push(state);
    }
    // Others' auras around it (a Pit Fiend's Fear Aura: "any enemy that starts its turn in the aura").
    const placed = token as Placed | null;
    for ( const bearer of (["turn.started", "turn.ended"].includes(type) && placed?.parent?.tokens) ? [...placed.parent.tokens] : [] ) {
      if ( (bearer.id === placed?.id) || !bearer.actor ) continue;
      // Swallowed by it: its Hit Points as this turn starts, and its regurgitating save as it ends (regurgitate).
      if ( (conditionsFrom as (holder: unknown, source: unknown) => Record<string, boolean>)(actor, bearer.actor).coverTotal ) {
        const key = `${bearer.actor.uuid}:${actor.uuid}`;
        const health = Number((bearer.actor as {system?: {resources?: {health?: {value?: number}}}}).system?.resources?.health?.value) || 0;
        if ( type === "turn.started" ) swallowerHealth.set(key, health);
        else if ( swallowerHealth.has(key) ) {
          const lost = (swallowerHealth.get(key) ?? 0) - health;
          swallowerHealth.delete(key);
          states.push(...await regurgitate(bearer, lost, `${sequence}:${bearer.id}:${placed?.id}`));
        }
      }
      const theirs = {...sunlightContext(bearer as never), conditions: [...(bearer.actor.statuses ?? [])]};
      for ( const {id, definition, label, around} of automationTriggers(bearer.actor, event, theirs) ) {
        if ( (around?.on !== "others") || immuneTo(actor, definition.id)
          || !tokensAround(bearer as never, around as never).some(other => other.id === placed?.id) ) continue;
        const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
          resolutionId: `${id}:${sequence}:${bearer.id}:${placed?.id}`, definition, label, actorRef: bearer.actor.uuid,
          source: {tokenId: bearer.id, sceneId: placed?.parent?.id}, target: self});
        if ( state ) states.push(state);
      }
    }
    // Repeated saves: the creature rolls each again as its own Action; a success ends what that save let in.
    for ( const group of repeatSaveGroups((actor.effects ?? []) as Iterable<RepeatSaveEffect>, type) ) {
      const definition = {schemaVersion: 1, id: `action:repeat-save:${group.key}`, label: group.name, costs: {allOf: []},
        save: {ability: group.ability, dc: {value: group.dc}}};
      const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
        resolutionId: `repeat-save:${actor.id}:${sequence}:${group.key}`, definition, label: group.name, actorRef: actor.uuid,
        source: token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {}, target: self}) as
        {results?: {saveResolution?: {successes?: unknown[]}}} | null;
      if ( state ) states.push(state);
      if ( state?.results?.saveResolution?.successes?.length ) {
        const present = group.effectIds.filter(effectId => (actor as {effects?: {get?(id: string): unknown}}).effects?.get?.(effectId));
        if ( present.length ) await (actor as {deleteEmbeddedDocuments?(type: string, ids: string[]): Promise<unknown>})
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
  async function regurgitate(bearer: Placed, lost: number, key: string) {
    const states: unknown[] = [];
    for ( const {id, definition, label, around} of automationTriggers(bearer.actor as AutomationActor, {type: "turn.ended"}, {}) ) {
      if ( (around?.on !== "swallowed") || !(lost >= (Number(around.threshold) || Infinity)) ) continue;
      const self = {actorRef: bearer.actor?.uuid, tokenId: bearer.id, sceneId: bearer.parent?.id};
      const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
        resolutionId: `${id}:${key}`, definition, label, actorRef: String(bearer.actor?.uuid), source: {tokenId: bearer.id,
          sceneId: bearer.parent?.id}, target: self}) as {results?: {saveResolution?: {successes?: unknown[]}}} | null;
      if ( state ) states.push(state);
      if ( !state || state.results?.saveResolution?.successes?.length ) continue;
      const held = swallowedBy(bearer.actor as AutomationActor, bearer);
      const size = Number((bearer.parent as {grid?: {size?: number}} | null)?.grid?.size) || 100;
      const at = bearer as Placed & {x?: number; y?: number; width?: number};
      for ( const [index, other] of held.entries() ) {
        const actor = other.actor as (AutomationActor & {deleteEmbeddedDocuments?(type: string, ids: string[]): Promise<unknown>;
          toggleCondition?(id: string): Promise<unknown>; statuses?: Set<string>}) | null;
        const ids = (effectsFrom as (holder: unknown, source: unknown) => {id: string}[])(actor, bearer.actor).map(effect => effect.id);
        if ( ids.length ) await actor?.deleteEmbeddedDocuments?.("ActiveEffect", ids);
        if ( !actor?.statuses?.has?.("prone") ) await actor?.toggleCondition?.("prone");
        // "falls in a space within 5 feet": the next free spaces down its right side.
        await (other as {move?(waypoints: Data[]): Promise<unknown>}).move?.([{x: (at.x ?? 0) + ((Number(at.width) || 1) * size),
          y: (at.y ?? 0) + (index * size), action: "displace"}]);
      }
    }
    return states;
  }

  /** From any client: the active GM dispatches at once, another client reports the event to it. */
  async function report(type: string, {actor, data={}}: {actor: AutomationActor; data?: Data}) {
    if ( isActiveGM() ) return dispatch(type, {actor, data});
    try {
      await game.users?.activeGM?.query?.(AUTOMATION_QUERY, {type, actorUuid: actor.uuid, data}, {timeout: 15000});
    } catch (error) {
      logger.warn(`Wild Path | The GM could not be told about ${type}`, error);
    }
    return [];
  }

  /** The GM's query handler: a reportable event, on an Actor the server-attested sender owns. */
  async function handleQuery(payload: Data = {}, {user=null}: {user?: unknown} = {}) {
    const sanitize = REPORTED_EVENTS[String(payload.type)];
    if ( !sanitize || !user || (typeof payload.actorUuid !== "string") ) return {ok: false};
    const actor = await fromUuid?.(payload.actorUuid) as AutomationActor | null;
    if ( !actor?.testUserPermission?.(user, "OWNER") ) return {ok: false};
    // Answer at once: the Actions may wait on prompts far longer than a query lives.
    void dispatch(String(payload.type), {actor, data: sanitize((payload.data ?? {}) as Data)})
      .catch(error => logger.warn(`Wild Path | ${String(payload.type)} automation failed`, error));
    return {ok: true};
  }

  return {dispatch, report, handleQuery};
}

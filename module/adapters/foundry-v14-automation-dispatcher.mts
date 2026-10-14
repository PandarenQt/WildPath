import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {createAutomationEvent, createTriggerDefinition, evaluateTrigger} from "../helpers/automation-events.mjs";

type Data = Record<string, unknown>;
interface RuleElement {id?: string; type?: string; enabled?: boolean; data?: Data}
interface Owner {id: string; type?: string; name?: string; disabled?: boolean;
  system?: {active?: boolean; ruleElements?: readonly RuleElement[]; definition?: {id?: string}}}
interface AutomationActor {id: string; uuid: string; items?: Iterable<Owner>; effects?: Iterable<Owner>;
  testUserPermission?(user: unknown, level: string): boolean}
interface AutomationToken {id: string; parent?: {id: string} | null}
interface QueryUser {id: string; query?(name: string, data: Data, options: {timeout: number}): Promise<unknown>}
interface Coordinator {resolveAuthorityAction(options: Data): Promise<{ok: boolean; state?: {status?: string}}>}
type ResolveAction = (options: Data) => Promise<Data & {ok: boolean; reason?: string}>;
interface Logger {warn(...args: unknown[]): void}

/** The query a Player's client uses to report an event on an Actor it owns to the active GM. */
export const AUTOMATION_QUERY = "wildpath.automationEvent";
// Events a client may report, with the only data the GM takes from it. The GM raises turn and initiative events itself.
const REPORTED_EVENTS: Record<string, (data: Data) => Data> = {
  "rest.completed": data => ({restType: ["shortRest", "longRest"].includes(String(data.restType)) ? data.restType : null})
};

const definitionFor = actionDefinitionFromAction as (item: Owner) => {ok: boolean; definition?: Data | null};
const triggerDefinition = createTriggerDefinition as (options: Data) => Data;
const triggerMatches = evaluateTrigger as (trigger: Data, event: Data) => {ok: boolean};
const automationEvent = createAutomationEvent as unknown as (options: Data) => Data;

/**
 * Runs an Action the authority starts itself (a lasting area's effect, an automatic trigger) with one creature as
 * its only target, and waits for it to finish. Saves route to that creature's controller, as for any Action.
 * Returns the final state, or null when the Action could not start.
 */
export async function runAuthorityAction({coordinator, resolveAction, senderUserId, resolutionId, definition, label,
  actorRef, source, target, logger=globalThis.console}: {
  coordinator: Coordinator; resolveAction: ResolveAction; senderUserId: string; resolutionId: string;
  definition: Data; label: string; actorRef: string; source: Data; target: Data; logger?: Logger;
}) {
  const action = {id: String(definition.id), uuid: null, type: "action", name: String(definition.label ?? label),
    system: {definition: {...definition, targeting: {type: "single", required: true, count: 1}}}};
  const resolved = await resolveAction({intent: {actorRef, source, targetRefs: [target]}, senderUserId, action});
  if ( !resolved.ok ) {
    logger.warn("Wild Path | An automatic effect could not resolve", resolved.reason ?? resolved);
    return null;
  }
  let finish: (state: unknown) => void = () => {};
  const finished = new Promise(resolve => { finish = resolve; });
  const hosted = await coordinator.resolveAuthorityAction({resolutionId, resolved,
    onComplete: ({state}: {state: unknown}) => finish(state)});
  const terminal = ["completed", "failed", "cancelled"].includes(String(hosted.state?.status));
  return (hosted.ok || terminal) ? await finished : hosted.state ?? {status: "failed"};
}

/**
 * An Actor's automatic triggers that answer `event`: `Trigger` RuleElements of kind `automation` (the default) on
 * its active Items and enabled effects. Condition effects answer through their own lifecycle and are skipped. The
 * Action is the trigger's inline `action`, the Item itself when it is an Action, or the Action Item `actionId` names.
 */
export function automationTriggers(actor: AutomationActor, event: Data) {
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
    if ( !triggerMatches(trigger, event).ok ) return [];
    const actionItem = owner.type === "action" ? owner
      : items.find(entry => (entry.type === "action") && (entry.system?.definition?.id === data.actionId));
    const definition = (data.action as Data | undefined) ?? (actionItem ? definitionFor(actionItem).definition : null);
    return definition ? [{id: String(trigger.id), definition, label: owner.name ?? String(definition.label ?? "")}] : [];
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
  const isActiveGM = () => game.users?.activeGM?.id === game.user.id;

  async function dispatch(type: string, {actor, token=null, data={}}: {actor: AutomationActor | null; token?: AutomationToken | null;
    data?: Data}) {
    if ( !actor || !isActiveGM() ) return [];
    const event = automationEvent({id: `${type}:${actor.uuid}:${++sequence}`, type, actorId: actor.id,
      tokenId: token?.id ?? null, data});
    const self = {actorRef: actor.uuid, ...(token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {})};
    const states = [];
    for ( const {id, definition, label} of automationTriggers(actor, event) ) {
      const state = await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
        resolutionId: `${id}:${sequence}`, definition, label, actorRef: actor.uuid,
        source: token?.parent ? {tokenId: token.id, sceneId: token.parent.id} : {}, target: self});
      if ( state ) states.push(state);
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

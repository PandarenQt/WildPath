import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {createReactionTrigger, reactionPolicyOf} from "../helpers/automation-events.mjs";

type Data = Record<string, unknown>;

interface ItemLike {
  readonly id: string;
  readonly type?: string;
  readonly system?: {active?: boolean; ruleElements?: readonly Data[]; definition?: {id?: string}};
  readonly flags?: {wildpath?: {reactionPolicy?: string}};
}

interface ActorLike {
  readonly id: string;
  readonly uuid: string;
  readonly items?: Iterable<ItemLike>;
}

interface TokenLike {
  readonly id: string;
  readonly uuid?: string;
  readonly actor?: ActorLike | null;
  readonly disposition?: number;
  readonly hidden?: boolean;
}

interface SceneLike {
  readonly tokens?: Iterable<TokenLike>;
  readonly grid?: {distance?: number};
}

interface ProviderContext {
  readonly intent?: {sceneRef?: unknown; tokenRef?: unknown} | null;
  /** Resolved documents win over the intent's refs (the native path's refs are not plain UUIDs). */
  readonly scene?: SceneLike | null;
  readonly token?: TokenLike | null;
}

const MOVEMENT_EVENT = "movement.transition-proposed";
// The JS builders are untyped; these are the only places their shapes are asserted.
const reactionTrigger = createReactionTrigger as (options: Data) => Data;
const policyOf = reactionPolicyOf as (item: ItemLike) => string;
const definitionFor = actionDefinitionFromAction as (item: ItemLike) => {ok: boolean; definition?: Data | null};

/**
 * Production reaction services, derived from the world: every other Token on the acting Token's Scene whose
 * Actor has an active Item with a `Trigger` RuleElement of kind `reaction` becomes a reactor, for any event
 * (movement steps, `action.declared`, `attack.hit`, ...). The trigger's Action is the Item itself (an Action
 * Item) or the Action named by `data.reaction.actionId`. Reactors to movement also become observers: reach
 * in fields from that Action's reach range, hostility from Token dispositions. `{self}` stands for this
 * reactor's Token id in predicate paths (`event.data.relations.{self}.leavesReach`) and in `match` values
 * (`match: {targetTokenId: "{self}"}`: "an attack on me").
 */
export function createFoundryReactionProvider({resolve = defaultResolve} = {}) {
  return function reactionServices(context: ProviderContext = {}) {
    const scene = context.scene ?? resolve(context.intent?.sceneRef) as SceneLike | null;
    const mover = context.token ?? resolve(context.intent?.tokenRef) as TokenLike | null;
    if ( !scene?.tokens || !mover ) return {};
    const triggers: Data[] = [];
    const observers: Data[] = [];
    for ( const token of scene.tokens ) {
      if ( (token.id === mover.id) || !token.actor ) continue;
      const reactions = tokenReactions(token);
      triggers.push(...reactions.map(entry => entry.trigger));
      const watching = reactions.filter(entry => entry.event === MOVEMENT_EVENT);
      if ( watching.length ) observers.push({
        id: token.id,
        token,
        reachFields: Math.max(...watching.map(entry => reachFields(entry.definition, scene))),
        context: {hostile: isHostile(token, mover)}
      });
    }
    return triggers.length ? {reactions: {triggers}, ...(observers.length ? {movement: {observers}} : {})} : {};
  };
}

function tokenReactions(token: TokenLike) {
  const actor = token.actor!;
  const items = [...(actor.items ?? [])];
  return items.flatMap(item => {
    if ( item.system?.active === false ) return [];
    return (item.system?.ruleElements ?? []).flatMap(element => {
      const data = (element.data ?? {}) as Data;
      if ( (element.type !== "Trigger") || (element.enabled === false) ) return [];
      const event = String(data.event ?? data.eventType ?? "");
      if ( ((data.kind ?? data.triggerKind) !== "reaction") || !event ) return [];
      const actionItem = item.type === "action" ? item
        : items.find(entry => (entry.type === "action")
          && (entry.system?.definition?.id === (data.reaction as Data | undefined)?.actionId));
      const definition = actionItem ? definitionFor(actionItem) : null;
      if ( !definition?.ok || !definition.definition ) return [];
      // A reaction set to "Never" is not offered; one set to "Always" is used without asking.
      const policy = policyOf(actionItem!);
      if ( policy === "never" ) return [];
      const trigger = reactionTrigger({
        id: `reaction:${token.id}:${item.id}:${String(element.id ?? "trigger")}`,
        event,
        match: bindSelfValues((data.match as Data | undefined) ?? {phase: "interrupt"}, token.id),
        actorId: actor.uuid,
        tokenId: token.id,
        action: definition.definition,
        actionId: definition.definition.id ?? null,
        predicate: bindSelf(data.triggerPredicate ?? data.eventPredicate ?? null, token.id),
        ...(policy === "always" ? {metadata: {reactionPolicy: policy}} : {})
      });
      return [{trigger, event, definition: definition.definition}];
    });
  });
}

/** Reach in grid fields from the reaction Action's reach range (5 ft by default). */
function reachFields(definition: Data, scene: SceneLike) {
  const range = (definition.range ?? {}) as {type?: string; distance?: {value?: number}};
  const feet = (range.type === "reach") && Number.isFinite(range.distance?.value) ? range.distance!.value! : 5;
  const fieldSize = Number(scene.grid?.distance) || 5;
  return Math.max(1, Math.floor(feet / fieldSize));
}

/** Friendly and hostile Tokens are hostile to each other; neutral Tokens are hostile to no one. */
function isHostile(token: TokenLike, mover: TokenLike) {
  return ((token.disposition ?? 0) * (mover.disposition ?? 0)) < 0;
}

/** Replace `{self}` in predicate `path`s with this reactor's observer id. */
export function bindSelf(predicate: unknown, observerId: string): unknown {
  if ( Array.isArray(predicate) ) return predicate.map(entry => bindSelf(entry, observerId));
  if ( !predicate || (typeof predicate !== "object") ) return predicate;
  return Object.fromEntries(Object.entries(predicate).map(([key, value]) => [key,
    (key === "path") && (typeof value === "string") ? value.replaceAll("{self}", observerId) : bindSelf(value, observerId)]));
}

/** Replace a `match` value of exactly `{self}` with this reactor's Token id. */
function bindSelfValues(match: Data, tokenId: string): Data {
  return Object.fromEntries(Object.entries(match).map(([key, value]) => [key, value === "{self}" ? tokenId : value]));
}

function defaultResolve(uuid: unknown): unknown {
  const fromUuidSync = (globalThis as {fromUuidSync?: (uuid: string) => unknown}).fromUuidSync;
  return (typeof uuid === "string") && uuid && fromUuidSync ? fromUuidSync(uuid) : null;
}

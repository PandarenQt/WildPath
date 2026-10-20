import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {createReactionTrigger, reactionPolicyOf} from "../helpers/automation-events.mjs";
import {commonAction} from "../helpers/common-actions.mjs";
import {movementTracked} from "../helpers/combat.mjs";
import {turnKey} from "./foundry-v14-persistent-areas.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {attackSight} from "./foundry-v14-senses.mjs";
import {coverBetween, foundrySightCollision} from "./foundry-v14-cover.mjs";

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
  readonly statuses?: Set<string>;
  readonly flags?: {wildpath?: {slotSpellTurn?: string | null; onceUsed?: Record<string, string | null>}};
  readonly system?: unknown;
  getOpportunityAttackAvoidance?(): {always: boolean; movementModes: string[]};
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
const common = commonAction as unknown as (actor: unknown, id: string, options?: {localize?: (key: string) => string}) => ItemLike | null;
/** An Opportunity Attack's trigger: a hostile creature leaves this reactor's reach. */
// 2024: only a creature's own movement provokes; being pushed or teleported does not.
const OPPORTUNITY_PREDICATE = {all: [
  {equals: {path: "event.data.relations.{self}.leavesReach", value: true}},
  {equals: {path: "event.data.relations.{self}.context.hostile", value: true}},
  {not: {oneOf: {path: "event.data.movementKind", values: ["forced", "teleport"]}}}
]};
const definitionFor = actionDefinitionFromAction as (item: ItemLike) => {ok: boolean; definition?: Data | null};

/**
 * Production reaction services, derived from the world: every other Token on the acting Token's Scene whose
 * Actor has an active Item with a `Trigger` RuleElement of kind `reaction` becomes a reactor, for any event
 * (movement steps, `action.declared`, `attack.hit`, ...). The trigger's Action is the Item itself (an Action
 * Item) or the Action named by `data.reaction.actionId`. Reactors to movement also become observers: reach
 * in fields from that Action's reach range, hostility from Token dispositions. `{self}` stands for this
 * reactor's Token id in predicate paths (`event.data.relations.{self}.leavesReach`) and in `match` values
 * (`match: {targetTokenId: "{self}"}`: "an attack on me"). Each event's predicates also see every reactor's relation to
 * its source (`toSource.{self}`: relationsToSource).
 */
export function createFoundryReactionProvider({resolve = defaultResolve} = {}) {
  return function reactionServices(context: ProviderContext = {}) {
    const scene = context.scene ?? resolve(context.intent?.sceneRef) as SceneLike | null;
    const mover = context.token ?? resolve(context.intent?.tokenRef) as TokenLike | null;
    if ( !scene?.tokens || !mover ) return {};
    const triggers: Data[] = [];
    const observers: Data[] = [];
    // 2024 Disengage: the mover's movement provokes no Opportunity Attacks this turn; Flyby: none while it flies.
    const avoidance = mover.actor?.getOpportunityAttackAvoidance?.() ?? {always: false, movementModes: []};
    const disengaged = (mover.actor?.statuses?.has("disengaged") === true) || avoidance.always;
    // Outside a started encounter movement is not tracked, and provokes nothing (no Opportunity Attacks).
    const tracked = movementTracked(mover.actor);
    for ( const token of scene.tokens ) {
      if ( !token.actor ) continue;
      // Its own Action's outcome (2014 Divine Smite: "when you hit"): only its triggers bound to `sourceTokenId: "{self}"`,
      // and those on itself (`targetTokenId: "{self}"`: Stone's Endurance when it falls or bleeds).
      if ( token.id === mover.id ) {
        triggers.push(...ownActionReactions(token).map(entry => entry.trigger));
        continue;
      }
      // A creature that can't make Opportunity Attacks (Staggering Blow) reacts to no movement.
      const staggered = token.actor.statuses?.has("no-opportunity-attacks") === true;
      const reactions = tokenReactions(token).filter(entry => !((staggered || !tracked) && (entry.event === MOVEMENT_EVENT)));
      // Every creature makes Opportunity Attacks (Baldur's Gate 3), unless an Item of its own reacts to movement,
      // even one switched off or set to Never.
      if ( tracked && !disengaged && !staggered && !ownsMovementReaction(token) ) reactions.push(...opportunityAttack(token, avoidance.movementModes));
      triggers.push(...reactions.map(entry => entry.trigger));
      const watching = reactions.filter(entry => entry.event === MOVEMENT_EVENT);
      if ( watching.length ) observers.push({
        id: token.id,
        token,
        reachFields: Math.max(...watching.map(entry => reachFields(entry.definition, scene))),
        context: {hostile: isHostile(token, mover)}
      });
    }
    return triggers.length ? {reactions: {triggers, context: ({event}: {event?: Data}) => ({toSource: relationsToSource(scene, event)})},
      ...(observers.length ? {movement: {observers}} : {})} : {};
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
      // A common Action (Retaliation's `commonAction: "opportunity"`: its first melee attack or Unarmed Strike), else
      // the Item itself or the Action it names.
      const localize = (key: string) => (globalThis as {game?: {i18n?: {localize(key: string): string}}}).game?.i18n?.localize(key) ?? key;
      const actionItem = data.commonAction ? common(actor, String(data.commonAction), {localize})
        : item.type === "action" ? item
          : items.find(entry => (entry.type === "action")
            && (entry.system?.definition?.id === (data.reaction as Data | undefined)?.actionId));
      const definition = actionItem ? definitionFor(actionItem) : null;
      if ( !definition?.ok || !definition.definition ) return [];
      // Offered under its Item's name: "Retaliation (Dagger)", not "Opportunity Attack (Dagger)".
      if ( data.commonAction ) definition.definition = {...definition.definition,
        label: String((actionItem as {name?: string}).name ?? "")
          .replace(localize("WILDPATH.COMMON.OpportunityAttack"), String((item as {name?: string}).name ?? ""))};
      // A reaction set to "Never" is not offered; one set to "Always" is used without asking (its Item's setting).
      const policy = policyOf(data.commonAction ? item : actionItem!);
      if ( policy === "never" ) return [];
      // Only while its creature has a status (Brutal Strike: Reckless Attack's "reckless").
      if ( data.whileStatus && !actor.statuses?.has(String(data.whileStatus)) ) return [];
      // Once a turn (Stunning Strike): not offered again this combat turn; its use records it (`metadata.once`).
      // Options sharing a key (`onceKey`: Cunning Strike's three) are one use between them.
      const once = (data.once === "turn") ? onceThisTurn(actor, String(data.onceKey ?? `${item.id}-${String(element.id ?? "trigger")}`)) : null;
      if ( once?.used ) return [];
      const trigger = reactionTrigger({
        id: `reaction:${token.id}:${item.id}:${String(element.id ?? "trigger")}`,
        event,
        match: bindSelfValues((data.match as Data | undefined) ?? {phase: "interrupt"}, token.id),
        actorId: actor.uuid,
        tokenId: token.id,
        action: definition.definition,
        actionId: definition.definition.id ?? null,
        // Offered only when its Action's own costs can be paid (a Reaction, or none for a Divine Smite).
        cost: definition.definition.costs ?? null,
        // A reaction to its own Action comes after its targets' (a Parry may turn the hit into a miss first).
        ...(((data.match as Data | undefined)?.sourceTokenId === "{self}") ? {priority: 200} : {}),
        predicate: bindSelf(data.triggerPredicate ?? data.eventPredicate ?? null, token.id),
        ...(policy === "always" ? {metadata: {reactionPolicy: policy}} : {}),
        // `uses`: how many of the options sharing its key its creature may take in one window (Improved Cunning Strike: 2).
        ...(once ? {payload: {once: {key: once.key, turn: once.turn, uses: usesOf(data.uses, actor)}}} : {})
      });
      return [{trigger, event, definition: definition.definition, data}];
    });
  });
}

/**
 * `token`'s reactions to its own Action (`sourceTokenId: "{self}"`). One marked `onlyWithoutOtherSlotSpell` (Paladin's
 * Smite's 2014 Divine Smite) is offered only while its creature has cast no spell with a slot this combat turn other
 * than a `smite` (`flags.wildpath.slotSpellTurn`, recordSlotSpell). Its creature's other `smite` reactions (the 2024
 * spell) are offered beside it, as options.
 */
function ownActionReactions(token: TokenLike) {
  const own = tokenReactions(token).filter(entry => [(entry.trigger.event as Data | undefined)?.sourceTokenId,
    (entry.trigger.event as Data | undefined)?.targetTokenId].includes(token.id));
  const combat = (globalThis as {game?: {combat?: {id: string; round: number; turn: number | null; started?: boolean} | null}}).game?.combat;
  const turn = combat?.started ? turnKey(combat as never) : null;
  const casting = (turn !== null) && (token.actor?.flags?.wildpath?.slotSpellTurn === turn);
  const free = own.filter(entry => entry.data.onlyWithoutOtherSlotSpell === true);
  return (casting && free.length) ? own.filter(entry => !free.includes(entry)) : own;
}

/**
 * A once-a-turn reaction's record key and the combat turn, and whether it was used this turn
 * (`flags.wildpath.onceUsed.<key>`, as a once-a-turn ExtraDamage). Outside combat it is never used up.
 */
function onceThisTurn(actor: ActorLike, id: string) {
  const combat = (globalThis as {game?: {combat?: {id: string; round: number; turn: number | null; started?: boolean} | null}}).game?.combat;
  const turn = combat?.started ? turnKey(combat as never) : null;
  const key = id.replace(/\./g, "_");
  return {key, turn, used: (turn !== null) && (actor.flags?.wildpath?.onceUsed?.[key] === turn)};
}

/** A Trigger's `uses`, a number or a ValueExpression for its creature (a table by class level), at least 1. */
function usesOf(uses: unknown, actor: ActorLike) {
  if ( uses == null ) return 1;
  const value = (typeof uses === "object")
    ? (evaluateValueExpression as unknown as (expression: unknown, context: Data) => {ok: boolean; value?: number})(uses,
      {actor, actorSystem: actor.system}).value
    : Number(uses);
  return Math.max(Math.trunc(Number(value) || 1), 1);
}

/** Whether any Item of `token`'s creature has a reaction to movement, active or not. */
function ownsMovementReaction(token: TokenLike) {
  return [...(token.actor?.items ?? [])].some(item => (item.system?.ruleElements ?? []).some(element => (element.type === "Trigger")
    && ((element.data as Data | undefined)?.kind === "reaction") && ((element.data as Data | undefined)?.event === MOVEMENT_EVENT)));
}

/** The common Opportunity Attack of `token`'s creature, unless it is set to Never; never against movement in `avoidedModes`. */
function opportunityAttack(token: TokenLike, avoidedModes: readonly string[] = []) {
  const localize = (key: string) => (globalThis as {game?: {i18n?: {localize(key: string): string}}}).game?.i18n?.localize(key) ?? key;
  const action = common(token.actor, "opportunity", {localize});
  const definition = action ? definitionFor(action) : null;
  const policy = action ? policyOf(action) : "never";
  if ( (policy === "never") || !definition?.ok || !definition.definition ) return [];
  const trigger = reactionTrigger({
    id: `reaction:${token.id}:common-opportunity`,
    event: MOVEMENT_EVENT,
    match: {phase: "interrupt"},
    actorId: token.actor!.uuid,
    tokenId: token.id,
    action: definition.definition,
    actionId: definition.definition.id ?? null,
    predicate: bindSelf(avoidedModes.length ? {all: [...OPPORTUNITY_PREDICATE.all,
      {not: {oneOf: {path: "event.data.movementMode", values: [...avoidedModes]}}}]} : OPPORTUNITY_PREDICATE, token.id),
    ...(policy === "always" ? {metadata: {reactionPolicy: policy}} : {})
  });
  return [{trigger, event: MOVEMENT_EVENT, definition: definition.definition, data: {} as Data}];
}

/** Reach in grid fields from the reaction Action's reach range (5 ft by default). */
function reachFields(definition: Data, scene: SceneLike) {
  const range = (definition.range ?? {}) as {type?: string; distance?: {value?: number}};
  const feet = (range.type === "reach") && Number.isFinite(range.distance?.value) ? range.distance!.value! : 5;
  const fieldSize = Number(scene.grid?.distance) || 5;
  return Math.max(1, Math.floor(feet / fieldSize));
}

/**
 * Each Token's relation to `event`'s source, by Token id, worked out when a predicate reads it (`toSource.<id>`):
 * `hostile` (dispositions), `distance` in feet between their spaces, and `sees`: it perceives the source (Blinded,
 * Invisible, light: attackSight) and a wall blocking sight doesn't hide it entirely (Total Cover). Nothing for an event
 * without a source Token on the Scene, so a predicate reading it fails (no "creature you can see").
 */
export function relationsToSource(scene: SceneLike, event: Data | undefined): Record<string, {hostile: boolean;
  distance: number | null; sees: boolean}> {
  const sourceId = ((event?.source as Data | undefined)?.tokenId ?? event?.tokenId) as string | undefined;
  const tokens = [...(scene.tokens ?? [])];
  const source = sourceId ? tokens.find(token => token.id === sourceId) : null;
  const relations = {};
  if ( !source?.actor ) return relations;
  const grid = createFoundryV14TacticalGridAdapter({scene: scene as never}) as {tokenToFootprint(token: unknown): {ok: boolean; footprint?: unknown}};
  const footprintOf = (token: TokenLike) => { const result = grid.tokenToFootprint(token); return result.ok ? result.footprint : null; };
  const from = footprintOf(source);
  const fieldDistance = Number(scene.grid?.distance) || 5;
  for ( const token of tokens ) {
    if ( !token.actor || (token.id === source.id) ) continue;
    let memo: {hostile: boolean; distance: number | null; sees: boolean} | null = null;
    Object.defineProperty(relations, token.id, {enumerable: true, get() {
      if ( memo ) return memo;
      const to = footprintOf(token);
      const fields = (from && to) ? (footprintDistance as unknown as (a: unknown, b: unknown) => number)(from, to) : NaN;
      const distance = Number.isFinite(fields) ? fields * fieldDistance : null;
      const collides = foundrySightCollision();
      const walled = collides ? coverBetween({source: token as never, target: source as never, collides}) === "total" : false;
      const sees = !walled && attackSight({attacker: token.actor as never, target: source.actor as never, attackerToken: token as never,
        targetToken: source as never, distance}).seesTarget;
      memo = {hostile: isHostile(token, source), distance, sees};
      return memo;
    }});
  }
  return relations;
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

import {
  CHAT_OUTCOME_KEYS,
  chatVisibilityForMode,
  createResolutionCardViewModel,
  type PublicResolutionResult,
  type RollLabel
} from "../helpers/chat-card-view-model.mjs";
import {damageTypeLabel} from "../helpers/damage-type-label.mjs";

export const RESOLUTION_CARD_TEMPLATE = "systems/wildpath/templates/chat/resolution-card.hbs";

interface FoundryRoll {
  render(options?: {flavor?: string | undefined}): Promise<string>;
  toJSON(): unknown;
}

interface ChatMessageClass {
  create(data: Record<string, unknown>): Promise<unknown>;
  getSpeaker(options: {actor?: unknown; token?: unknown}): unknown;
}

interface RollClass {
  fromData(data: unknown): FoundryRoll;
}

type RenderTemplate = (path: string, data: object) => Promise<string>;

interface GameLike {
  readonly users?: Iterable<{readonly id?: string | null; readonly isGM?: boolean}> | null;
  readonly i18n?: {has(key: string): boolean; localize(key: string): string; format(key: string, data: Record<string, string>): string} | null;
}

/**
 * A roll's label in words ("Fire damage", "Less damage", "Attack", "Precision Attack (new total 12)"), or undefined
 * (Foundry then shows none). The card's roll flavour, and the physical-dice prompt's title.
 */
export function rollFlavor(label: RollLabel | null | undefined, i18n: GameLike["i18n"]) {
  if ( !label || !i18n ) return undefined;
  if ( label.name ) return Number.isFinite(label.total) ? i18n.format(label.key, {name: label.name, total: String(label.total)})
    : label.name;
  if ( !label.damageType ) return i18n.localize(label.key);
  return i18n.format("WILDPATH.CHAT.Roll.TypedDamage", {type: damageTypeLabel(label.damageType, i18n)});
}

/** What the action coordinator passes to its `publishResult` port. */
export interface PublishedResolution {
  readonly resolutionId: string;
  readonly initiatorUserId: string | null;
  readonly messageMode: string | null;
  readonly actor: unknown;
  readonly action: unknown;
  readonly result: PublicResolutionResult;
}

/**
 * Posts one chat card per completed Action, from the authority's client. The content comes only from
 * the public result projection; `author` is the initiator (a GM may author for another user), and the
 * initiator's message mode decides the whisper recipients. Public Foundry rolls are rendered into the
 * card and attached as `rolls`, so dice animation modules see them.
 */
export function createFoundryV14ChatCardAdapter({
  ChatMessage=null,
  Roll=null,
  renderTemplate=null,
  game=null
}: {
  ChatMessage?: ChatMessageClass | null;
  Roll?: RollClass | null;
  renderTemplate?: RenderTemplate | null;
  game?: GameLike | null;
}={}) {
  return async function publishResult({resolutionId, initiatorUserId, messageMode, actor, action, result}: PublishedResolution) {
    if ( !action || result?.status !== "completed" ) return {ok: true, posted: false};
    const foundry = foundryGlobals({ChatMessage, Roll, renderTemplate, game});
    const conditions = (globalThis as {CONFIG?: {WILDPATH?: {CONDITIONS?: Record<string, {name?: string}>}}}).CONFIG?.WILDPATH?.CONDITIONS ?? {};
    const shown = createResolutionCardViewModel(result, {conditionNames: Object.fromEntries(Object.entries(conditions)
      .flatMap(([id, condition]) => (condition?.name ? [[id, condition.name]] : [])))});
    // A condition its target is immune to was never given ("Immune" floats over it instead).
    const view = {...shown, targets: shown.targets.map(target => {
      if ( !target.uuid || !target.effects?.length ) return target;
      const document = (globalThis as {fromUuidSync?(uuid: string): unknown}).fromUuidSync?.(target.uuid) as {actor?: ImmuneActor} | null;
      const immune = new Set(((document?.actor ?? document) as ImmuneActor | null)?.getConditionImmunities?.() ?? []);
      return {...target, effects: target.effects.filter(effect => effect.removed || !effect.conditionId || !immune.has(effect.conditionId))};
    })};
    const rolls = view.rolls.map(data => foundry.Roll.fromData(data));
    const rollHtml = (await Promise.all(rolls.map((roll, index) => roll.render({flavor: rollFlavor(view.rollLabels[index], foundry.game?.i18n)}))))
      .join("");
    const actionImg = typeof (action as {img?: unknown}).img === "string" ? (action as {img: string}).img : null;
    // A roll entered by hand says what it is as a Foundry roll does ("Concentration save").
    const enteredRolls = view.enteredRolls.map(entry => ({...entry, flavor: rollFlavor(entry.label, foundry.game?.i18n)}));
    const content = await foundry.renderTemplate(RESOLUTION_CARD_TEMPLATE, {...view, enteredRolls, actionImg, rollHtml});
    const gmUserIds = [...(foundry.game?.users ?? [])].flatMap(user => (user.isGM && user.id ? [user.id] : []));
    const visibility = chatVisibilityForMode(messageMode, {initiatorUserId, gmUserIds});
    // The Token it acted from speaks: given only the Actor, Foundry picks a linked one on this (the authority's) canvas.
    const tokenRef = result.source?.tokenRef;
    const token = tokenRef ? (globalThis as {fromUuidSync?(uuid: string): unknown}).fromUuidSync?.(tokenRef) ?? undefined : undefined;
    const message = await foundry.ChatMessage.create({
      ...(initiatorUserId ? {author: initiatorUserId} : {}),
      speaker: foundry.ChatMessage.getSpeaker({actor, token}),
      content,
      rolls: rolls.map(roll => roll.toJSON()),
      whisper: [...visibility.whisper],
      blind: visibility.blind,
      // Each named target's Miss, Critical hit, Saved or Immune floats over its Tokens (floating-text.mts).
      flags: {wildpath: {resolutionId, floating: [...floatingOutcomes(view), ...immuneOutcomes(view, action, uuid => {
        // A card names its targets by Token; the Token's Actor holds the immunities.
        const document = (globalThis as {fromUuidSync?(uuid: string): unknown}).fromUuidSync?.(uuid) as {actor?: ImmuneActor} | null;
        return (document?.actor ?? document) as ImmuneActor | null;
      })]}}
    });
    return {ok: true, posted: true, message};
  };
}

const FLOATED = new Set<string>([CHAT_OUTCOME_KEYS.miss, CHAT_OUTCOME_KEYS.critical, CHAT_OUTCOME_KEYS.saveSuccess,
  CHAT_OUTCOME_KEYS.legendaryResistance]);

/**
 * The outcomes that float over targets: a named target's Miss, Critical hit or Saved (hidden targets have no uuid). A save
 * an item turned (Ring of Evasion) floats as Saved: a floating label has no name to fill.
 */
export function floatingOutcomes(view: ReturnType<typeof createResolutionCardViewModel>) {
  return view.targets.flatMap(target => (target.uuid ? [target.attack, target.save] : [])
    .map(outcome => ((outcome?.label === CHAT_OUTCOME_KEYS.succeededInstead) ? {...outcome, label: CHAT_OUTCOME_KEYS.saveSuccess} : outcome))
    .flatMap(outcome => (outcome && FLOATED.has(outcome.label) ? [{uuid: target.uuid!, label: outcome.label}] : [])));
}

interface ImmuneActor {getConditionImmunities?(): readonly string[]}
interface ConditionEffect {type?: string; conditionId?: string; levels?: number; saveOutcomePolicy?: unknown;
  application?: {saveOutcomePolicy?: unknown}}

/**
 * "Immune" over each named target the Action gives a condition it is immune to (`ConditionImmunity`): a condition that
 * reaches it, so not after a miss, and a "only on a failed save" one not after a success.
 */
export function immuneOutcomes(view: ReturnType<typeof createResolutionCardViewModel>, action: unknown,
  resolve: (uuid: string) => ImmuneActor | null | undefined) {
  const effects = (((action as {system?: {definition?: {effects?: ConditionEffect[]}}} | null)?.system?.definition?.effects) ?? [])
    .filter(effect => (effect.type === "condition") && effect.conditionId && ((effect.levels ?? 1) > 0));
  if ( !effects.length ) return [];
  return view.targets.flatMap(target => {
    if ( !target.uuid || (target.attack?.label === CHAT_OUTCOME_KEYS.miss) ) return [];
    const saved = target.save?.label === CHAT_OUTCOME_KEYS.saveSuccess;
    const reaching = effects.filter(effect => !(saved && ((effect.saveOutcomePolicy ?? effect.application?.saveOutcomePolicy) === "failure")));
    const immunities = resolve(target.uuid)?.getConditionImmunities?.() ?? [];
    return reaching.some(effect => immunities.includes(effect.conditionId!)) ? [{uuid: target.uuid, label: CHAT_OUTCOME_KEYS.immune}] : [];
  });
}

// Foundry globals are untyped here; this is the only place they are read.
function foundryGlobals({ChatMessage, Roll, renderTemplate, game}: {
  ChatMessage: ChatMessageClass | null;
  Roll: RollClass | null;
  renderTemplate: RenderTemplate | null;
  game: GameLike | null;
}) {
  const globals = globalThis as {
    ChatMessage?: ChatMessageClass;
    Roll?: RollClass;
    foundry?: {applications?: {handlebars?: {renderTemplate?: RenderTemplate}}};
    game?: GameLike;
  };
  const chat = ChatMessage ?? globals.ChatMessage;
  const roll = Roll ?? globals.Roll;
  const render = renderTemplate ?? globals.foundry?.applications?.handlebars?.renderTemplate;
  if ( !chat || !roll || !render ) throw new Error("Foundry ChatMessage, Roll and renderTemplate are required to post a chat card.");
  return {ChatMessage: chat, Roll: roll, renderTemplate: render, game: game ?? globals.game ?? null};
}

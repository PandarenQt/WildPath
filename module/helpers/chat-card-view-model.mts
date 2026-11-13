/**
 * Chat card data for a completed resolution. The input is the BROADCAST_SAFE result projection
 * (`projectResolutionResultForDisclosure`), because every ChatMessage reaches every connected
 * client whether or not it is whispered. This view model is an allow-list over that projection.
 */

interface PublicRef {
  readonly id?: string | null;
  readonly tokenId?: string | null;
  readonly tokenRef?: string | null;
  readonly uuid?: string | null;
  readonly actorRef?: string | null;
  readonly name?: string | null;
  readonly label?: string | null;
}

interface ContestEntry {
  readonly target?: PublicRef | null;
  readonly hit?: boolean | null;
  /** A hit that landed on a duplicate instead (Mirror Image). */
  readonly decoy?: boolean | null;
  readonly critical?: boolean | null;
  readonly success?: boolean | null;
  /** A failure the creature chose to turn into a success (Legendary Resistance). */
  readonly succeededInstead?: boolean | null;
}

/** What a roll is (multiplayer-authority's `rollLabel`): a card key, and a damage type for damage. */
export interface RollLabel {
  readonly key: string;
  readonly damageType?: string;
}

interface PublicRoll {
  readonly foundryRoll?: Readonly<Record<string, unknown>> | null;
  readonly label?: RollLabel | null;
  readonly formula?: string | null;
  readonly total?: number | null;
}

export interface PublicResolutionResult {
  readonly resolutionId?: string | null;
  readonly status?: string | null;
  readonly action?: PublicRef | null;
  /** The acting creature; its `tokenRef` is the Token the authority resolved it from. */
  readonly source?: PublicRef | null;
  readonly targets?: readonly PublicRef[];
  readonly outcomes?: {
    readonly attack?: {readonly results?: readonly ContestEntry[]} | null;
    readonly save?: {readonly results?: readonly ContestEntry[]} | null;
    readonly check?: {readonly success?: boolean} | null;
    readonly zeroHp?: readonly {readonly target?: PublicRef | null; readonly name?: string | null}[];
    /** Each concentration check's creature and whether it kept its concentration. */
    readonly concentration?: readonly {readonly target?: PublicRef | null; readonly kept?: boolean}[];
    readonly cover?: readonly {readonly target?: PublicRef | null; readonly degree?: string | null}[];
    /** The targets the Action did nothing to (`Unaffected`). */
    readonly unaffected?: readonly PublicRef[];
    readonly effects?: readonly {readonly target?: PublicRef | null; readonly conditionId?: string | null; readonly name?: string | null;
      readonly removed?: boolean | null}[];
  };
  readonly rolls?: readonly PublicRoll[];
}

export const CHAT_OUTCOME_KEYS = Object.freeze({
  hit: "WILDPATH.CHAT.Outcome.Hit",
  critical: "WILDPATH.CHAT.Outcome.Critical",
  miss: "WILDPATH.CHAT.Outcome.Miss",
  decoy: "WILDPATH.CHAT.Outcome.Decoy",
  saveSuccess: "WILDPATH.CHAT.Outcome.SaveSuccess",
  saveFailure: "WILDPATH.CHAT.Outcome.SaveFailure",
  legendaryResistance: "WILDPATH.CHAT.Outcome.LegendaryResistance",
  staysUp: "WILDPATH.CHAT.Outcome.StaysUp",
  concentrationKept: "WILDPATH.CHAT.Outcome.ConcentrationKept",
  concentrationLost: "WILDPATH.CHAT.Outcome.ConcentrationLost",
  half: "WILDPATH.COVER.half",
  threeQuarters: "WILDPATH.COVER.threeQuarters",
  immune: "WILDPATH.CHAT.Outcome.Immune",
  unaffected: "WILDPATH.CHAT.Outcome.Unaffected",
  checkSuccess: "WILDPATH.CHAT.Outcome.CheckSuccess",
  checkFailure: "WILDPATH.CHAT.Outcome.CheckFailure"
});

/** A lang key plus a tone: whether the roll behind the outcome succeeded. */
export interface CardOutcome {
  readonly label: string;
  readonly tone: "success" | "failure";
}

export interface ResolutionCardTarget {
  readonly name: string | null;
  /** For hover/click to the Token; only named (not hidden) targets are linked. */
  readonly uuid: string | null;
  readonly attack: CardOutcome | null;
  readonly save: CardOutcome | null;
  /** What kept it up at 0 Hit Points (Relentless Endurance), by name. */
  readonly staysUp?: {readonly label: string; readonly name: string} | null;
  /** Whether its concentration check kept its concentration; lost if any of its checks (one per hit) failed. */
  readonly concentration?: CardOutcome | null;
  /** Its cover against the Action ("Half cover"). */
  readonly cover?: {readonly label: string} | null;
  /** The Action did nothing to it (`Unaffected`): it was targeted, and the Action spent. */
  readonly unaffected?: {readonly label: string} | null;
  /** The conditions and effects the Action gave it (or ended): a condition's lang key, an effect's own name. */
  readonly effects?: readonly {readonly label: string; readonly conditionId: string | null; readonly removed: boolean}[];
}

export interface ResolutionCardView {
  readonly resolutionId: string | null;
  readonly actionName: string | null;
  /** The acting creature's own check, if the Action has one. */
  readonly check: CardOutcome | null;
  readonly targets: readonly ResolutionCardTarget[];
  readonly rolls: readonly Readonly<Record<string, unknown>>[];
  /** Each of `rolls`' label, in the same order (null for one without). */
  readonly rollLabels: readonly (RollLabel | null)[];
  /** Public rolls entered by hand (physical or manual dice): no Foundry Roll exists to render. */
  readonly enteredRolls: readonly {readonly formula: string | null; readonly total: number; readonly label: RollLabel | null}[];
}

export function createResolutionCardViewModel(result: PublicResolutionResult,
  {conditionNames = {}}: {conditionNames?: Readonly<Record<string, string>>} = {}): ResolutionCardView {
  const attack = result.outcomes?.attack?.results ?? [];
  const save = result.outcomes?.save?.results ?? [];
  return {
    resolutionId: result.resolutionId ?? null,
    actionName: textOrNull(result.action?.name ?? result.action?.label),
    check: !result.outcomes?.check ? null : result.outcomes.check.success
      ? {label: CHAT_OUTCOME_KEYS.checkSuccess, tone: "success"} : {label: CHAT_OUTCOME_KEYS.checkFailure, tone: "failure"},
    // A target the Action did nothing to is no longer among its targets, but is still named.
    targets: [...(result.targets ?? []), ...(result.outcomes?.unaffected ?? [])
      .filter(spared => !(result.targets ?? []).some(target => sameTarget(spared, target)))].map(target => {
      // Several attacks at one creature (Scorching Ray's rays): its best, so a creature any of them hit shows the hit.
      const attackEntry = attack.filter(entry => sameTarget(entry.target, target))
        .reduce<ContestEntry | undefined>((best, entry) => ((!best || (attackRank(entry) > attackRank(best))) ? entry : best), undefined);
      const saveEntry = save.find(entry => sameTarget(entry.target, target));
      const kept = (result.outcomes?.zeroHp ?? []).find(entry => sameTarget(entry.target, target));
      const checks = (result.outcomes?.concentration ?? []).filter(entry => sameTarget(entry.target, target));
      const covered = (result.outcomes?.cover ?? []).find(entry => sameTarget(entry.target, target));
      const coverKey = covered?.degree ? (CHAT_OUTCOME_KEYS as Record<string, string>)[covered.degree] : null;
      const effects = (result.outcomes?.effects ?? []).filter(entry => sameTarget(entry.target, target)).flatMap(entry => {
        const label = textOrNull(entry.name) ?? (entry.conditionId ? (conditionNames[entry.conditionId] ?? entry.conditionId) : null);
        return label ? [{label, conditionId: textOrNull(entry.conditionId), removed: entry.removed === true}] : [];
      });
      const name = textOrNull(target.name);
      return {
        name,
        uuid: name ? textOrNull(target.uuid ?? target.actorRef) : null,
        attack: attackEntry ? attackOutcome(attackEntry) : null,
        save: saveEntry ? saveOutcome(saveEntry) : null,
        ...(kept ? {staysUp: {label: CHAT_OUTCOME_KEYS.staysUp, name: textOrNull(kept.name) ?? ""}} : {}),
        ...(checks.length ? {concentration: checks.every(entry => entry.kept === true)
          ? {label: CHAT_OUTCOME_KEYS.concentrationKept, tone: "success"} : {label: CHAT_OUTCOME_KEYS.concentrationLost, tone: "failure"}} : {}),
        ...(coverKey ? {cover: {label: coverKey}} : {}),
        ...((result.outcomes?.unaffected ?? []).some(spared => sameTarget(spared, target))
          ? {unaffected: {label: CHAT_OUTCOME_KEYS.unaffected}} : {}),
        ...(effects.length ? {effects} : {})
      };
    }),
    rolls: (result.rolls ?? []).flatMap(roll => (roll.foundryRoll ? [roll.foundryRoll] : [])),
    rollLabels: (result.rolls ?? []).flatMap(roll => (roll.foundryRoll ? [roll.label ?? null] : [])),
    enteredRolls: (result.rolls ?? []).flatMap(roll => (!roll.foundryRoll && Number.isFinite(roll.total)
      ? [{formula: textOrNull(roll.formula), total: roll.total as number, label: roll.label ?? null}] : []))
  };
}

export type ChatMessageMode = "public" | "ic" | "gm" | "blind" | "self";

export interface ChatVisibility {
  readonly whisper: readonly string[];
  readonly blind: boolean;
}

/**
 * Whisper recipients for a message mode (`CONFIG.ChatMessage.modes`). The authority creates the
 * card, so `self` must name the initiator: `ChatMessage.applyMode` would whisper to the GM.
 * Unknown modes fall back to public, as Foundry does for an unrecognized mode.
 */
export function chatVisibilityForMode(mode: unknown,
  {initiatorUserId=null, gmUserIds=[]}: {initiatorUserId?: string | null; gmUserIds?: readonly string[]}={}): ChatVisibility {
  switch ( mode ) {
    case "gm": return {whisper: [...gmUserIds], blind: false};
    case "blind": return {whisper: [...gmUserIds], blind: true};
    case "self": return {whisper: initiatorUserId ? [initiatorUserId] : [...gmUserIds], blind: false};
    default: return {whisper: [], blind: false};
  }
}

function attackOutcome(entry: ContestEntry): CardOutcome {
  if ( entry.decoy ) return {label: CHAT_OUTCOME_KEYS.decoy, tone: "failure"};
  if ( !entry.hit ) return {label: CHAT_OUTCOME_KEYS.miss, tone: "failure"};
  return {label: entry.critical ? CHAT_OUTCOME_KEYS.critical : CHAT_OUTCOME_KEYS.hit, tone: "success"};
}

const attackRank = (entry: ContestEntry) => (entry.hit ? (entry.critical ? 3 : 2) : (entry.decoy ? 1 : 0));

function saveOutcome(entry: ContestEntry): CardOutcome {
  if ( entry.success && entry.succeededInstead ) return {label: CHAT_OUTCOME_KEYS.legendaryResistance, tone: "success"};
  return entry.success
    ? {label: CHAT_OUTCOME_KEYS.saveSuccess, tone: "success"}
    : {label: CHAT_OUTCOME_KEYS.saveFailure, tone: "failure"};
}

function sameTarget(left: PublicRef | null | undefined, right: PublicRef): boolean {
  if ( !left ) return false;
  // Its Token first: a Token's synthetic Actor and the Token itself are refs to the same creature.
  if ( left.tokenId && right.tokenId ) return left.tokenId === right.tokenId;
  if ( left.actorRef && right.actorRef ) return left.actorRef === right.actorRef;
  return !!left.id && left.id === right.id;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A roll stays open to a reroll (Portent, Heroic Inspiration) for ten minutes: older cards in the log get no buttons. */
export const RECENT_ROLL_MS = 10 * 60 * 1000;
export function isRecentRoll(message: {timestamp?: number}, now = Date.now()): boolean {
  return (now - (Number(message?.timestamp) || 0)) < RECENT_ROLL_MS;
}

/** Cards a claim is under way for on this client: a card's own flags change only once its update returns. */
const claimingCards = new Set<string>();

/**
 * Run `claim` as the only claim of the roll card `message` on this client (any spender: Portent, Heroic Inspiration),
 * or resolve null without running it while another claim of that card is under way. `claim` reads the card's flags
 * itself, so a claim that ran before it is seen.
 */
export async function claimCard<T>(message: {id: string}, claim: () => Promise<T>): Promise<T | null> {
  if ( claimingCards.has(message.id) ) return null;
  claimingCards.add(message.id);
  try {
    return await claim();
  } finally {
    claimingCards.delete(message.id);
  }
}

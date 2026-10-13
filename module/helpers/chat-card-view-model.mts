/**
 * Chat card data for a completed resolution. The input is the BROADCAST_SAFE result projection
 * (`projectResolutionResultForDisclosure`), because every ChatMessage reaches every connected
 * client whether or not it is whispered. This view model is an allow-list over that projection.
 */

interface PublicRef {
  readonly id?: string | null;
  readonly actorRef?: string | null;
  readonly name?: string | null;
  readonly label?: string | null;
}

interface ContestEntry {
  readonly target?: PublicRef | null;
  readonly hit?: boolean | null;
  readonly critical?: boolean | null;
  readonly success?: boolean | null;
}

interface PublicRoll {
  readonly foundryRoll?: Readonly<Record<string, unknown>> | null;
}

export interface PublicResolutionResult {
  readonly resolutionId?: string | null;
  readonly status?: string | null;
  readonly action?: PublicRef | null;
  readonly targets?: readonly PublicRef[];
  readonly outcomes?: {
    readonly attack?: {readonly results?: readonly ContestEntry[]} | null;
    readonly save?: {readonly results?: readonly ContestEntry[]} | null;
  };
  readonly rolls?: readonly PublicRoll[];
}

export const CHAT_OUTCOME_KEYS = Object.freeze({
  hit: "WILDPATH.CHAT.Outcome.Hit",
  critical: "WILDPATH.CHAT.Outcome.Critical",
  miss: "WILDPATH.CHAT.Outcome.Miss",
  saveSuccess: "WILDPATH.CHAT.Outcome.SaveSuccess",
  saveFailure: "WILDPATH.CHAT.Outcome.SaveFailure"
});

export interface ResolutionCardTarget {
  readonly name: string | null;
  readonly attack: string | null;
  readonly save: string | null;
}

export interface ResolutionCardView {
  readonly resolutionId: string | null;
  readonly actionName: string | null;
  readonly targets: readonly ResolutionCardTarget[];
  readonly rolls: readonly Readonly<Record<string, unknown>>[];
}

export function createResolutionCardViewModel(result: PublicResolutionResult): ResolutionCardView {
  const attack = result.outcomes?.attack?.results ?? [];
  const save = result.outcomes?.save?.results ?? [];
  return {
    resolutionId: result.resolutionId ?? null,
    actionName: textOrNull(result.action?.name ?? result.action?.label),
    targets: (result.targets ?? []).map(target => {
      const attackEntry = attack.find(entry => sameTarget(entry.target, target));
      const saveEntry = save.find(entry => sameTarget(entry.target, target));
      return {
        name: textOrNull(target.name),
        attack: attackEntry ? attackOutcomeKey(attackEntry) : null,
        save: saveEntry ? (saveEntry.success ? CHAT_OUTCOME_KEYS.saveSuccess : CHAT_OUTCOME_KEYS.saveFailure) : null
      };
    }),
    // shortcut: rolls without Foundry Roll JSON (manual/physical) are not shown; add a total row with the dice policy work.
    rolls: (result.rolls ?? []).flatMap(roll => (roll.foundryRoll ? [roll.foundryRoll] : []))
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

function attackOutcomeKey(entry: ContestEntry): string {
  if ( !entry.hit ) return CHAT_OUTCOME_KEYS.miss;
  return entry.critical ? CHAT_OUTCOME_KEYS.critical : CHAT_OUTCOME_KEYS.hit;
}

function sameTarget(left: PublicRef | null | undefined, right: PublicRef): boolean {
  if ( !left ) return false;
  if ( left.actorRef && right.actorRef ) return left.actorRef === right.actorRef;
  return !!left.id && left.id === right.id;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

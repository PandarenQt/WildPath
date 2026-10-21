import {MULTIPLAYER_AUTHORITY_CODES} from "./multiplayer-authority.mjs";

/**
 * What a player is told when an Action or a move fails. A refusal meant for them (`ACTION_REFUSED`, the authority's own
 * rules checks) is shown as it is; a known lower-level reason in words; anything else, to a player, as a plain sentence,
 * while the GM sees the reason itself. Pure: `game` supplies the user and i18n.
 */

const ROLL_REJECTION_CODES = new Set(["INVALID_MANUAL_RESULT", "INVALID_ROLL_RESULT"]);

/** Lower-level reasons a player may meet with an Action (configuration, targeting, payment), by their text or code. */
const ACTION_PATTERNS = Object.freeze([
  [/^Option is not available/i, "WILDPATH.REFUSAL.OptionUnavailable"],
  [/has \d+ but needs \d+|PAYMENT_UNAVAILABLE|INSUFFICIENT_RESOURCE/, "WILDPATH.NOTIFY.PaymentUnavailable"],
  [/not enough target choices|requires? (?:a |at least )?target/i, "WILDPATH.REFUSAL.NeedsTarget"],
  [/too many target choices/i, "WILDPATH.REFUSAL.TooManyTargets"],
  [/target is not willing/i, "WILDPATH.REFUSAL.NotWilling"],
  [/out of range|beyond (?:its )?range/i, "WILDPATH.REFUSAL.OutOfRange"],
  [/^Dependency .* was not satisfied|is required\.?$/i, "WILDPATH.REFUSAL.ChoiceMissing"]
]);

/** The same for a move: out of movement, a mode it lacks, stopped or displaced by a reaction, blocked. */
const MOVEMENT_PATTERNS = Object.freeze([
  [/MOVEMENT_BUDGET_EXCEEDED|MOVEMENT_UNAFFORDABLE|not enough movement|budget/i, "WILDPATH.REFUSAL.NoMovement"],
  [/MOVEMENT_MODE_NOT_SUPPORTED/, "WILDPATH.REFUSAL.MovementMode"],
  [/reaction stopped|reaction-stopped/i, "WILDPATH.REFUSAL.ReactionStopped"],
  [/displaced during a reaction/i, "WILDPATH.REFUSAL.Displaced"],
  [/blocked|occupied|wall/i, "WILDPATH.REFUSAL.Blocked"]
]);

function message(error, game, patterns, failedKey, genericKey) {
  const i18n = game?.i18n;
  const reason = String(error?.reason ?? error?.code ?? "");
  if ( error?.code === MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED ) return reason;
  if ( ROLL_REJECTION_CODES.has(error?.code) ) return i18n?.localize?.("WILDPATH.NOTIFY.RollRejected") ?? reason;
  const known = patterns.find(([pattern]) => pattern.test(reason) || pattern.test(String(error?.code ?? "")));
  if ( known ) return i18n?.localize?.(known[1]) ?? reason;
  return game?.user?.isGM ? (i18n?.format?.(failedKey, {reason}) ?? reason) : (i18n?.localize?.(genericKey) ?? reason);
}

/** An Action's failure, in its user's words. */
export function refusalMessage(error, game=globalThis.game) {
  return message(error, game, ACTION_PATTERNS, "WILDPATH.NOTIFY.ActionFailed", "WILDPATH.REFUSAL.Generic");
}

/** A move's failure, in its user's words. */
export function movementMessage(error, game=globalThis.game) {
  return message(error, game, MOVEMENT_PATTERNS, "WILDPATH.NOTIFY.MovementFailed", "WILDPATH.REFUSAL.MovementGeneric");
}

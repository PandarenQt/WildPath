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

/**
 * A resolver's failure code its user can act on, which the pipeline passes on as the failure's reason, in words. Checked
 * after the patterns, so a wrapper code they know (PAYMENT_UNAVAILABLE) wins over the code it wraps; a fault the user
 * can't fix stays unmapped, so the GM sees the code itself.
 */
const ACTION_FAILURE_KEYS = Object.freeze(Object.fromEntries(Object.entries({
  "WILDPATH.REFUSAL.NoSaveDC": ["MISSING_DC"],
  "WILDPATH.REFUSAL.NoArmorClass": ["MISSING_DEFENSE"],
  "WILDPATH.REFUSAL.MissingRoll": ["MISSING_ATTACK_TOTAL", "MISSING_SAVE_TOTAL", "MISSING_CHECK_RESULT", "NO_CHECK_RESULTS",
    "INVALID_CHECK_RESULT", "NO_CHECK_REQUESTS"],
  "WILDPATH.REFUSAL.NeedsTarget": ["NO_TARGETS"],
  "WILDPATH.REFUSAL.NoValidTargets": ["NO_VALID_TARGETS", "NO_ATTACKABLE_TARGETS", "NO_SAVEABLE_TARGETS", "NO_DAMAGEABLE_TARGETS",
    "NO_HEALABLE_TARGETS", "TARGETING_FAILED"],
  "WILDPATH.REFUSAL.OutOfRange": ["TARGET_OUT_OF_RANGE"],
  "WILDPATH.REFUSAL.NoRange": ["RANGE_UNAVAILABLE"],
  "WILDPATH.NOTIFY.PaymentUnavailable": ["PAYMENT_UNAVAILABLE", "INSUFFICIENT_RESOURCE", "RESOURCE_UNAVAILABLE",
    "PAYMENT_OPTION_NOT_FOUND", "RESOURCE_NOT_FOUND"],
  "WILDPATH.REFUSAL.OptionUnavailable": ["OPTION_NOT_AVAILABLE"],
  "WILDPATH.REFUSAL.ChoiceMissing": ["MISSING_REQUIRED_CHOICE", "REQUIRED_REQUEST_CANCELLED", "PROMPT_CANCELLED"],
  "WILDPATH.REFUSAL.InvalidChoice": ["INVALID_CHOICE", "CONFLICTING_SELECTIONS", "EXCEEDED_CHOICE_LIMIT"],
  "WILDPATH.REFUSAL.NoDice": ["NO_PROVIDER_AVAILABLE", "UNSUPPORTED_ROLL_TYPE", "PROVIDER_FAILURE"],
  "WILDPATH.REFUSAL.NotAllowed": ["COMMIT_NOT_AUTHORIZED", "REMOTE_AUTHORITY_REQUIRED"],
  "WILDPATH.REFUSAL.Gone": ["TARGET_ACTOR_NOT_FOUND", "TARGET_ACTOR_SYSTEM_NOT_FOUND", "EFFECT_NOT_FOUND", "MISSING_ACTION",
    "MISSING_SOURCE", "INVALID_ACTOR_SYSTEM"],
  "WILDPATH.REFUSAL.Stale": ["STALE_CONFIGURATION_STATE", "STALE_REQUEST"],
  "WILDPATH.REFUSAL.Cancelled": ["CANCELLED", "PARENT_CANCELLED"]
}).flatMap(([key, codes]) => codes.map(code => [code, key]))));

/** The same for a move: out of movement, a mode it lacks, stopped or displaced by a reaction, blocked. */
const MOVEMENT_PATTERNS = Object.freeze([
  [/MOVEMENT_BUDGET_EXCEEDED|MOVEMENT_UNAFFORDABLE|not enough movement|budget/i, "WILDPATH.REFUSAL.NoMovement"],
  [/MOVEMENT_MODE_NOT_SUPPORTED/, "WILDPATH.REFUSAL.MovementMode"],
  [/reaction stopped|reaction-stopped/i, "WILDPATH.REFUSAL.ReactionStopped"],
  [/displaced during a reaction/i, "WILDPATH.REFUSAL.Displaced"],
  // Creatures' spaces (foundry-v14-occupancy): said as such, before any other block.
  [/hostile creature's space/i, "WILDPATH.REFUSAL.CreatureInWay"],
  [/end in an occupied space/i, "WILDPATH.REFUSAL.OccupiedSpace"],
  [/blocked|occupied|wall/i, "WILDPATH.REFUSAL.Blocked"]
]);

function message(error, game, patterns, failedKey, genericKey, codes={}) {
  const i18n = game?.i18n;
  const reason = String(error?.reason ?? error?.code ?? "");
  if ( error?.code === MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED ) return reason;
  if ( ROLL_REJECTION_CODES.has(error?.code) ) return i18n?.localize?.("WILDPATH.NOTIFY.RollRejected") ?? reason;
  const known = patterns.find(([pattern]) => pattern.test(reason) || pattern.test(String(error?.code ?? "")));
  if ( known ) return i18n?.localize?.(known[1]) ?? reason;
  if ( Object.hasOwn(codes, reason) ) return i18n?.localize?.(codes[reason]) ?? reason;
  return game?.user?.isGM ? (i18n?.format?.(failedKey, {reason}) ?? reason) : (i18n?.localize?.(genericKey) ?? reason);
}

/** An Action's failure, in its user's words. */
export function refusalMessage(error, game=globalThis.game) {
  return message(error, game, ACTION_PATTERNS, "WILDPATH.NOTIFY.ActionFailed", "WILDPATH.REFUSAL.Generic", ACTION_FAILURE_KEYS);
}

/** A move's failure, in its user's words. */
export function movementMessage(error, game=globalThis.game) {
  return message(error, game, MOVEMENT_PATTERNS, "WILDPATH.NOTIFY.MovementFailed", "WILDPATH.REFUSAL.MovementGeneric");
}

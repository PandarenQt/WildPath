import {ruleIssues} from "./rule-builder.mjs";

/** One problem in words: "Rule 2: …" (a list that is no list has no rule number). */
function describe({index, text}, i18n) {
  return (index < 0) ? text : (i18n?.format?.("WILDPATH.RULES.Issue", {n: index + 1, text}) ?? `${index + 1}: ${text}`);
}

/**
 * A RuleElement list's problems in words, one per rule, for the sheets and the GM. `ruleIssues` finds them: the shape,
 * an unknown type, and a rule that needs no context but cannot be worked out.
 * @param {unknown} ruleElements
 * @param {{format?(key: string, data: object): string}} [i18n]
 * @returns {string[]}
 */
export function ruleProblems(ruleElements, i18n=globalThis.game?.i18n) {
  return ruleIssues(ruleElements).map(issue => describe(issue, i18n));
}

/**
 * Whether an edit storing `next` as `document`'s RuleElements must be refused: it adds problems the stored list lacks
 * (a list already broken can still be edited). The GM or author is told which. A document being created is not
 * checked here: an import with a broken rule still arrives, and its creature's sheet flags it.
 * @param {{name?: string, toObject(source?: boolean): {system?: {ruleElements?: unknown}}}} document
 * @param {unknown} next
 * @param {{game?: any, ui?: any}} [options]
 * @returns {boolean}
 */
export function refuseBrokenRules(document, next, {game=globalThis.game, ui=globalThis.ui}={}) {
  if ( next === undefined ) return false;
  const before = new Set(ruleIssues(document.toObject(true).system?.ruleElements ?? []).map(issue => issue.text));
  const added = ruleIssues(next).filter(issue => !before.has(issue.text));
  if ( !added.length ) return false;
  const problems = added.map(issue => describe(issue, game?.i18n)).join(" ");
  ui?.notifications?.warn?.(game?.i18n?.format?.("WILDPATH.RULES.Refused", {name: document.name ?? "", problems}) ?? problems);
  return true;
}

/** The fields that say what a document does: an Action's definition, and its RuleElements. */
const MECHANICS = Object.freeze(["system.definition", "system.ruleElements"]);

/** Whether `changes` (nested, dotted or both, as Foundry takes them) write under `path`. */
function writes(changes, path) {
  return Object.entries(changes ?? {}).some(([key, value]) => (key === path) || key.startsWith(`${path}.`)
    || (path.startsWith(`${key}.`) && value && (typeof value === "object") && writes(value, path.slice(key.length + 1))));
}

/**
 * Whether `user`'s edit of what `document` does (its Action definition, its RuleElements) must be refused: only a GM
 * changes them (owner's decision, 2026-10-30). The player is told so. Creating a document (a compendium drop, a level-up)
 * is not an edit. Edits from the browser console are not designed against.
 * @param {{name?: string}} document
 * @param {object} changes
 * @param {{isGM?: boolean}|null} user
 * @param {{game?: any, ui?: any}} [options]
 * @returns {boolean}
 */
export function refusePlayerMechanics(document, changes, user, {game=globalThis.game, ui=globalThis.ui}={}) {
  if ( !user || user.isGM || !MECHANICS.some(path => writes(changes, path)) ) return false;
  ui?.notifications?.warn?.(game?.i18n?.format?.("WILDPATH.RULES.GmOnly", {name: document.name ?? ""}) ?? "Only the GM can change that.");
  return true;
}

import {collectionContents} from "./collections.mjs";
import {ENTITY_REF_KINDS, parseEntityRef} from "./entity-refs.mjs";
import {collectRuleElementContributions} from "./rule-elements.mjs";
import {evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpression} from "./value-expressions.mjs";

/**
 * Where a creature's effects came from. A condition or custom effect names its source by Actor or Token ref, or by
 * the uuid of the Item (an Action) that applied it, in `flags.wildpath.conditionEffect.sourceRef` (else its
 * `originRef` or `origin`). Grappled and Charmed depend on it, and so does a `Reveal` effect.
 */

/** Every ref a creature's effects may name it by: its Actor and each of its Tokens on any Scene. */
export function creatureRefs(actor, game=globalThis.game) {
  const tokens = collectionContents(game?.scenes).flatMap(scene => collectionContents(scene.tokens))
    .filter(token => (token.actor?.uuid === actor.uuid) || (token.actorLink && (token.actorId === actor.id)));
  return new Set([actor.uuid, `actor:${actor.id}`, ...tokens.flatMap(token => [token.uuid, `token:${token.id}`,
    `token:${token.parent?.id}.${token.id}`])]);
}

/** The enabled effects on `holder` that came from `source`: its Actor, one of its Tokens, or one of its Items. */
export function effectsFrom(holder, source, game=globalThis.game) {
  if ( !holder?.effects || !source?.uuid ) return [];
  const refs = creatureRefs(source, game);
  return collectionContents(holder.effects).filter(effect => {
    const flag = effect?.flags?.wildpath?.conditionEffect ?? {};
    const ref = String(flag.sourceRef ?? flag.originRef ?? effect?.origin ?? "").replace(/^uuid:/, "");
    return ref && !effect.disabled && (refs.has(ref) || [...refs].some(owner => ref.startsWith(`${owner}.`)));
  });
}

/**
 * What an effect's source ref names, or null: an Actor for a WildPath creature ref (`actor:<id>`, or `token:<id>` /
 * `token:<scene>.<id>` on any Scene, an unlinked Token's own Actor), else the document its uuid names (`uuid:` optional).
 */
export function sourceRefDocument(ref, {fromUuidSync=globalThis.fromUuidSync, game=globalThis.game}={}) {
  const parsed = parseEntityRef(String(ref ?? ""));
  if ( parsed.kind === ENTITY_REF_KINDS.ACTOR ) return collectionContents(game?.actors).find(actor => actor?.id === parsed.id) ?? null;
  if ( parsed.kind === ENTITY_REF_KINDS.TOKEN ) return collectionContents(game?.scenes)
    .filter(scene => !parsed.scope || (scene.id === parsed.scope))
    .flatMap(scene => collectionContents(scene.tokens)).find(token => token?.id === parsed.id)?.actor ?? null;
  const uuid = (parsed.kind === ENTITY_REF_KINDS.UUID) ? parsed.key : String(ref ?? "").trim();
  return uuid ? (fromUuidSync?.(uuid) ?? null) : null;
}

/**
 * The Actor that gave `effect` (its `sourceRef`: an Actor, or a Token or Item of one), or null: what an effect's values
 * are worked out from when they are its giver's (Bardic Inspiration's die by its bard's level).
 */
export function effectGiverActor(effect, fromUuidSync=globalThis.fromUuidSync) {
  const giver = sourceRefDocument(effect?.flags?.wildpath?.conditionEffect?.sourceRef, {fromUuidSync});
  return (giver?.documentName === "Actor") ? giver : giver?.actor ?? giver?.parent ?? null;
}

/**
 * The dice `effect` lets its creature add to a d20 test (`metadata.addDie: {faces, number?, tests?, predicate?}`), worked
 * out from its giver (a bard's or sidekick's level), as `{number, faces}`. Null when it has none, it names other `tests`
 * ("attack", "check", "save"), or its `predicate` doesn't fit the roll's `context` (Inspiring Help's attack: an ally
 * beside the target).
 */
export function effectAddedDice(effect, roller, {test=null, context={}}={}) {
  const die = effect?.flags?.wildpath?.conditionEffect?.metadata?.addDie;
  if ( effect?.disabled || !die ) return null;
  if ( Array.isArray(die.tests) && !die.tests.includes(test) ) return null;
  if ( !evaluatePredicate(die.predicate ?? null, context).ok ) return null;
  const giver = effectGiverActor(effect) ?? roller;
  const faces = evaluateValueExpression(die.faces, {actor: giver, actorSystem: giver?.system});
  const number = (die.number == null) ? {ok: true, value: 1} : evaluateValueExpression(die.number, {actor: giver, actorSystem: giver?.system});
  if ( !faces.ok || !(faces.value > 0) || !number.ok || !(number.value >= 1) ) return null;
  return {number: Math.trunc(number.value), faces: faces.value};
}

/**
 * The conditions `holder` has from `source`, as `{grappled: true}`: those whose effect names `source` (by Actor or
 * Token ref) or one of its Items (an Action it used) as where the effect came from.
 */
export function conditionsFrom(holder, source, game=globalThis.game) {
  const from = {};
  for ( const effect of effectsFrom(holder, source, game) ) for ( const id of effect.statuses ?? [] ) from[id] = true;
  return from;
}

/** Whether `target` reveals `detail` (`defenses`) to `viewer`: a `Reveal` rule on an effect `viewer` applied to it. */
export function revealedTo(target, viewer, detail="defenses", game=globalThis.game) {
  return effectsFrom(target, viewer, game).some(effect => collectRuleElementContributions({ruleElements: effect.system?.ruleElements ?? [],
    context: {actor: target, actorSystem: target.system}}).contributions.reveals.includes(detail));
}


/** Rules already bound to their host Item, by their rules array (so each read doesn't bind them again). */
const HOSTED = new WeakMap();

/**
 * An effect's rules, `{{host}}` in them bound to the Item holding the effect (an infusion's `weapon:{{host}}`: that
 * weapon's attacks), so they follow the Item wherever it goes.
 */
export function hostedRules(effect) {
  const rules = effect?.system?.ruleElements ?? [];
  const host = (effect?.parent?.documentName === "Item") ? effect.parent.id : null;
  if ( !host || !rules.length ) return rules;
  const cached = HOSTED.get(rules);
  if ( cached?.host === host ) return cached.rules;
  const bound = JSON.parse(JSON.stringify(rules).replaceAll("{{host}}", host));
  HOSTED.set(rules, {host, rules: bound});
  return bound;
}

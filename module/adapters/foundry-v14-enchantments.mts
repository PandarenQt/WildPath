/**
 * Item enchantments (an Artificer's infusions, Tasha's): an Action with `enchant` puts an effect on the Item its creature
 * picked (`enchant.choiceId`). The effect transfers to whoever holds the Item: its rules count while the Item is
 * equipped (and attuned when it needs it: WildPathActiveEffect#isSuppressed), and `{{host}}` in them is that Item
 * (`hostedRules`: an infused weapon's `weapon:{{host}}` attacks). Each names its creator and key
 * (`flags.wildpath.enchantment`); the same key on that Item is replaced, and past `limit` with that key the creator's
 * oldest ends, wherever its Item now is.
 */

import {evaluateValueExpression} from "../helpers/value-expressions.mjs";

type Data = Record<string, any>;

/** One of an enchantment's effects, for a range of its creator's class level (Enhanced Weapon +1, then +2 from 10). */
export interface EnchantEffect {name: string; img?: string; level?: {min?: number | null; max?: number | null; class?: string}; ruleElements: Data[]}

/** The effect whose level range holds `level` (the first with none when nothing matches). */
export function enchantEffectFor(effects: readonly EnchantEffect[], level: number): EnchantEffect | null {
  const inRange = (effect: EnchantEffect) => !effect.level || (((effect.level.min ?? 0) <= level) && (level <= (effect.level.max ?? Infinity)));
  return effects.find(inRange) ?? null;
}

/** Which of a creator's enchantments with one key end so a new one fits `limit`: the oldest first. */
export function enchantmentsPastLimit(existing: ReadonlyArray<{at: number}>, limit: number): number {
  return Math.max(existing.length + 1 - Math.max(Math.trunc(limit), 1), 0);
}

/**
 * Every Item effect in the world with `key` made by `creatorRef`: its Item and when it was made. An unlinked Token's
 * creature counts only the Items its base Actor doesn't have (the rest it inherits, and they are counted there).
 */
function enchantmentsOf(game: Data, key: string, creatorRef: string) {
  const holders: Array<{actor: Data; skip?: Data}> = [...(game.actors ?? [])].map((actor: Data) => ({actor}));
  for ( const scene of game.scenes ?? [] ) for ( const token of scene.tokens ?? [] ) {
    if ( token.actor && !token.actorLink ) holders.push({actor: token.actor, skip: game.actors?.get?.(token.actorId)?.items});
  }
  return holders.flatMap(({actor, skip}) => [...(actor.items ?? [])].filter((item: Data) => !skip?.has?.(item.id)).flatMap((item: Data) => [...(item.effects ?? [])]
    .filter((effect: Data) => (effect.flags?.wildpath?.enchantment?.key === key) && (effect.flags.wildpath.enchantment.creatorRef === creatorRef))
    .map((effect: Data) => ({effect, item, at: Number(effect.flags.wildpath.enchantment.at) || 0}))));
}

export function createFoundryEnchantments({game, logger=console}: {game: Data; logger?: {warn(...args: unknown[]): void}}) {
  /** After an Action that enchants, on the active GM: the chosen Item gets its effect. */
  async function afterResolution({options, state}: {options?: {actor?: Data}; state?: Data}) {
    const spec = state?.actionDefinition?.enchant as {choiceId: string; optionChoiceId?: string; key?: string; limit?: unknown;
      effects: EnchantEffect[]} | undefined;
    const actor = options?.actor;
    if ( !spec || !actor || (game.users?.activeGM?.id !== game.user?.id) ) return null;
    const choices = state?.configuration?.choices;
    const chosen = Array.isArray(choices) ? choices.find((entry: Data) => entry?.id === spec.choiceId) : null;
    const item = actor.items?.get?.(String(chosen?.value ?? chosen?.optionId ?? ""));
    if ( !item ) {
      logger.warn("Wild Path | The Item an enchantment picked is not its creature's", spec);
      return null;
    }
    const levelOf = (effect: EnchantEffect) => (effect.level?.class
      ? Number(evaluateValueExpression({type: "class-level", class: effect.level.class}, {actor, actorSystem: actor.system}).value) || 0
      : Number(actor.system?.details?.level) || 0);
    // The one its user chose (`optionChoiceId`: its index), else the one for its creator's level.
    const option = (spec.optionChoiceId && Array.isArray(choices)) ? choices.find((entry: Data) => entry?.id === spec.optionChoiceId) : null;
    const effect = option ? (spec.effects[Number(option.value ?? option.optionId)] ?? null)
      : (spec.effects.find(entry => enchantEffectFor([entry], levelOf(entry)) === entry) ?? null);
    if ( !effect ) return null;
    const key = String(spec.key ?? state?.actionDefinition?.id ?? "enchantment");
    // One with its key per Item: a new one replaces it.
    const same = [...(item.effects ?? [])].filter((entry: Data) => entry.flags?.wildpath?.enchantment?.key === key).map((entry: Data) => entry.id);
    if ( same.length ) await item.deleteEmbeddedDocuments("ActiveEffect", same);
    if ( spec.limit != null ) {
      const limit = Number(evaluateValueExpression(spec.limit, {actor, actorSystem: actor.system}).value) || 1;
      const existing = enchantmentsOf(game, key, actor.uuid).sort((a, b) => a.at - b.at);
      for ( const {effect: old} of existing.slice(0, enchantmentsPastLimit(existing, limit)) ) {
        try { await old.delete(); } catch (error) { logger.warn("Wild Path | An ended enchantment was already gone", error); }
      }
    }
    const [created] = await item.createEmbeddedDocuments("ActiveEffect", [{name: effect.name, ...(effect.img ? {img: effect.img} : {}),
      type: "effect", transfer: true, origin: state?.action?.uuid ?? null, system: {ruleElements: effect.ruleElements},
      flags: {wildpath: {enchantment: {key, creatorRef: actor.uuid, at: Date.now()}}}}]);
    return created ?? null;
  }
  return {afterResolution};
}

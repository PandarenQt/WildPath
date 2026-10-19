import {combineRollModes} from "./rolls.mjs";
import {WILDPATH} from "../config.mjs";

/**
 * Snapshot actor combat statistics into plain data for staged action resolution.
 * Persisted Actor data provides the base value; `WildPathActor#getStatistic(domain)` contributes
 * derived modifiers and provenance without letting pure resolvers read live Foundry Documents.
 */

/**
 * Resolve an Actor defense such as Armor Class.
 * @param {object} actor
 * @param {string} [defenseKey="ac"]
 * @returns {{value: number, slug: string, source: object}|null}
 */
export function resolveActorDefense(actor, defenseKey="ac") {
  if ( !actor ) return null;
  const key = stringOrDefault(defenseKey, "ac");
  const base = firstFiniteNumber([
    actor.defenses?.[key]?.value,
    actor.defenses?.[key]?.base,
    actor.defenses?.[key]?.total,
    actor.defense?.value,
    actor.system?.defenses?.[key]?.value,
    actor.system?.defenses?.[key]?.base,
    actor.system?.defenses?.[key]?.total,
    actor.system?.defenses?.[key],
    actor.system?.attributes?.[key]?.value,
    actor.system?.attributes?.[key],
    key === "ac" ? actor.system?.attributes?.ac?.value : null,
    key === "ac" ? actor.system?.ac?.value : null,
    key === "ac" ? actor.system?.ac : null
  ]);
  // A typed AC wins (maintainer, 2026-10-15); a blank one is the creature's best way of working it out (2024).
  const ac = ((key === "ac") && (base == null)) ? bestArmorClass(actor) : base;
  const statistic = resolveActorStatisticModifier(actor, [`defense.${key}`, key]);
  const modifier = statistic.known ? statistic.value : null;
  const value = ac == null && modifier == null ? null : (ac ?? 0) + (modifier ?? 0);
  if ( value == null ) return null;
  return {
    value,
    slug: key,
    source: {
      type: "actor-combat-statistic",
      actorId: actor.id ?? actor.actorId ?? null,
      actorRef: actor.uuid ?? (actor.id ? `Actor.${actor.id}` : null),
      statisticKey: key,
      base: ac,
      modifier,
      statistic: statistic.trace ?? null
    }
  };
}

/** The best of a creature's ways to work out its AC: the armor it wears, else its unarmored ways. */
function bestArmorClass(actor) {
  const formulas = actor.getArmorClasses?.() ?? [];
  const worn = formulas.filter(formula => formula.armor);
  const counted = worn.length ? worn : formulas;
  return counted.length ? Math.max(...counted.map(formula => formula.value)) : null;
}

/* -------------------------------------------- */

/**
 * Whether a creature is proficient with an attack: the attack's own `proficient`, and for a weapon (`attack.weapon`,
 * G8) of a creature with weapon training, that training naming its category (`martial`) or the weapon itself. A
 * creature without weapon training (a stat block) keeps what the attack says.
 */
export function attackProficient(actor, attack) {
  if ( attack?.proficient !== true ) return false;
  const trained = actor?.system?.training?.weapons ?? [];
  const weapon = attack.weapon;
  return !weapon || !trained.length || trained.includes(weapon.category) || (!!weapon.base && trained.includes(weapon.base));
}

/**
 * Resolve the attack statistic declared by an ActionDefinition into a roll modifier snapshot.
 * Every matching domain stacks (`attack.weapon` + `attack.melee` + `attack`); which modifiers apply is
 * decided by their source and predicate (see `WildPathActor#getStatistic`).
 * @param {object} actor
 * @param {object} attack
 * @param {object} [options]
 * @param {object|null} [options.item]  The Action Item making the attack (its own modifiers apply).
 * @param {string[]} [options.tags]     The Action's tags; the attack type is added.
 * @returns {{key: string, domain: string, modifier: number, totalModifier: number, source: object}|null}
 */
export function resolveActorAttackStatistic(actor, attack={}, {item=null, tags=[]}={}) {
  if ( !actor || !attack ) return null;
  const key = stringOrNull(attack.statistic ?? attack.statisticKey ?? attack.selector ?? attack.domain);
  if ( !key && !attack.ability ) return null;
  const domains = uniqueStrings([
    key?.includes(".") ? key : null,
    key ? `attack.${key}` : null,
    key,
    attack.type ? `attack.${attack.type}` : null,
    "attack"
  ]);
  const statistic = resolveActorStatisticModifier(actor, domains, {item, tags: uniqueStrings([attack.type, ...tags])});
  const ability = attackAbility(actor, attack, {tags});
  const abilityModifier = actorAbilityModifier(actor, ability);
  if ( !statistic.known && (abilityModifier == null) ) return null;
  // 2024: the proficiency bonus joins only an attack the creature is proficient with (maintainer decision).
  const proficiency = attackProficient(actor, attack) ? actorProficiencyBonus(actor) : 0;
  const total = (statistic.value ?? 0) + (abilityModifier ?? 0) + proficiency;
  return {
    key,
    domain: statistic.domain ?? domains[0] ?? null,
    modifier: total,
    totalModifier: total,
    dice: statistic.dice ?? [],
    ability,
    abilityModifier,
    proficiency,
    spell: isSpellAttack(attack, tags),
    source: {
      type: "actor-combat-statistic",
      actorId: actor.id ?? actor.actorId ?? null,
      actorRef: actor.uuid ?? (actor.id ? `Actor.${actor.id}` : null),
      statisticKey: key,
      statistic: statistic.trace ?? null
    }
  };
}

/* -------------------------------------------- */

/**
 * A creature's damage bonus for an Action: every Modifier on `damage.<weapon|spell>`, `damage.<melee|ranged>` and
 * `damage` (all stack, as attack domains do). Its predicates see the attack type, the Action's tags and the attack's
 * ability (`{tagsAny: ["might"]}` is "attacks using Might").
 */
export function resolveActorDamageStatistic(actor, attack=null, {item=null, tags=[]}={}) {
  const statistic = resolveActorStatisticModifier(actor, damageDomains(attack, tags), {item, tags: uniqueStrings([attack?.type, ...tags])});
  return statistic.known ? {domain: statistic.domain, totalModifier: statistic.value, trace: statistic.trace} : null;
}

/** The damage domains of an Action: `damage.<weapon|spell>`, `damage.<melee|ranged>` and `damage`. */
function damageDomains(attack, tags=[]) {
  const kind = attack?.statistic ?? (tags.includes("spell") ? "spell" : null);
  return [kind ? `damage.${kind}` : null, attack?.type ? `damage.${attack.type}` : null, "damage"].filter(Boolean);
}

/** The key a once-per-turn rule is recorded under: its owner and its own id (no dots: Foundry would nest them). */
function onceKey(entry) {
  const owner = entry.source?.parent ?? entry.source ?? {};
  return `${owner.id ?? owner.uuid ?? "owner"}-${entry.id}`.replace(/\./g, "_");
}

/**
 * 2024 advantage and disadvantage on an attack roll: the attacker's own (`attack`, `attack.<type>`, `attack.<ability>`
 * for the ability it uses, the Action's `item` included) and the target's on attacks against it (`attacked`,
 * `attacked.<type>`), combined so any of each cancel. `context` is what their predicates see:
 * `{attack: {type, adjacent, fromTarget}}`.
 */
export function attackRollMode(attacker, target, {type=null, item=null, ability=null, context={}}={}) {
  return combineRollModes([
    ...(attacker?.getRollModes?.(["attack", `attack.${type}`, ...(ability ? [`attack.${ability}`] : [])], {item, context}) ?? []),
    ...(target?.getRollModes?.(["attacked", `attacked.${type}`], {context}) ?? [])
  ]);
}

/** Whether every hit on `target` is a critical hit (`critical-on-hit`: Paralyzed or Unconscious, within 5 ft). */
/** `{policy: {criticalHitThreshold}}` when a rule widens the attacker's critical range for this attack, else nothing. */
function criticalRange(actor, attackDefinition, tags) {
  const ranges = (actor?.getRollOutcomes?.(["attack", `attack.${attackDefinition?.statistic ?? "weapon"}`], {context: {tags}}) ?? [])
    .filter(outcome => outcome.outcome === "critical-range").map(outcome => Number(outcome.threshold)).filter(Number.isFinite);
  return ranges.length ? {policy: {criticalHitThreshold: Math.min(...ranges)}} : {};
}

export function attackForcesCritical(target, {type=null, context={}}={}) {
  return (target?.getRollOutcomes?.(["attacked", `attacked.${type}`], {context}) ?? [])
    .some(outcome => outcome.outcome === "critical-on-hit");
}

/**
 * An Action's attack and damage statistics for its creature: the attack bonus, and the flat modifier its damage
 * adds. Weapon damage (a weapon-base component, not a spell attack) adds the attack's ability modifier (2024), and
 * any damage adds the creature's damage bonuses. The runtime and reaction Actions share this.
 * @param {object|null} actor
 * @param {object|null} definition
 * @param {{item?: object|null, turn?: string|null, context?: object, target?: object|null}} [options] `turn` identifies the current combat turn, for
 *   once-per-turn rules; `context` is what extra damage predicates see of the attack (`attack.rollMode`, `attack.allyNearTarget`).
 *   `target`, an attack's one target: its own extra damage on attacks against it counts too (Hunter's Mark).
 */
export function actionCombatStatistics(actor, definition, {item=null, turn=null, context={}, target=null}={}) {
  const attackDefinition = definition?.attack ?? null;
  const tags = [...(definition?.tags ?? [])];
  const statistic = attackDefinition ? resolveActorAttackStatistic(actor, attackDefinition, {item, tags}) : null;
  const components = definition?.damage ?? [];
  const weapon = !statistic?.spell && Number.isFinite(statistic?.abilityModifier)
    && components.some(component => component.provenance === "weapon-base");
  const bonus = components.length
    ? (resolveActorDamageStatistic(actor, attackDefinition, {item, tags: [...tags, statistic?.ability].filter(Boolean)})?.totalModifier ?? 0) : 0;
  const modifierTotal = (weapon ? statistic.abilityModifier : 0) + bonus;
  // Extra damage rules ("+1d6 fire on a melee hit"), less any once-per-turn rule already used this turn.
  // Its tags include the weapon's properties (`finesse`), so a predicate can ask for them.
  const extraTags = [attackDefinition?.type, ...tags, statistic?.ability, ...(attackDefinition?.properties ?? [])].filter(Boolean);
  // The target's own (`attacked`: Hunter's Mark, Hex) count on an attack; its predicates see this attack
  // (`attack.fromAttacker`: the marks it bears from this attacker).
  const marked = (components.length && attackDefinition && (typeof target?.getExtraDamage === "function"))
    ? target.getExtraDamage(["attacked", `attacked.${attackDefinition.type}`], {tags: extraTags, context}) : [];
  const extra = [...((components.length && (typeof actor?.getExtraDamage === "function"))
    ? actor.getExtraDamage(damageDomains(attackDefinition, tags), {item, tags: extraTags, context}) : []), ...marked]
    .filter(entry => !((entry.once === "turn") && turn && (actor.flags?.wildpath?.onceUsed?.[onceKey(entry)] === turn)));
  // Extra damage with no type of its own is the Action's (Sneak Attack deals the weapon's).
  const extraComponents = extra.map(entry => ({id: `extra:${onceKey(entry)}`, expression: entry.expression,
    damageType: entry.damageType ?? components[0]?.damageType ?? "untyped", provenance: "additional",
    ...(((entry.once === "turn") && turn) ? {once: {key: onceKey(entry), turn}} : {})}));
  return {
    defenseKey: attackDefinition ? (attackDefinition.defenseKey ?? "ac") : null,
    damage: (components.length && (weapon || bonus || extraComponents.length))
      ? {modifierTotal, ...(extraComponents.length ? {extraComponents} : {})} : null,
    attack: statistic ? {
      statistic,
      modifierTotal: statistic.totalModifier,
      // Its own critical range (Improved Critical: 19-20), the lowest that applies.
      ...criticalRange(actor, attackDefinition, extraTags),
      ...(statistic.dice?.length ? {dice: statistic.dice} : {}),
      modifiers: [{id: `statistic:${statistic.domain}`, value: statistic.totalModifier, source: statistic.source}]
    } : null
  };
}

const isSpellAttack = (attack, tags=[]) => (attack?.statistic === "spell") || tags.includes("spell");

/**
 * The ability an attack adds (2024): the attack's own `ability` if it names one; a spell attack's spellcasting
 * ability; for a weapon with the `finesse` property the better of Might and Agility; else Might in melee and
 * Agility at range.
 */
export function attackAbility(actor, attack={}, {tags=[]}={}) {
  if ( attack.ability ) return String(attack.ability);
  if ( isSpellAttack(attack, tags) ) return actor?.system?.spellcasting?.ability ?? null;
  if ( (attack.properties ?? []).includes("finesse") ) {
    return (actorAbilityModifier(actor, "agility") ?? 0) > (actorAbilityModifier(actor, "might") ?? 0) ? "agility" : "might";
  }
  return attack.type === "ranged" ? "agility" : "might";
}

/**
 * An ability's modifier from the creature's prepared score: floor((score - 10) / 2). Null when the creature has
 * no such ability (a death save's "death"), so nothing is added. A transformation's form score counts.
 */
export function actorAbilityModifier(actor, ability) {
  const score = ability ? finiteNumber(actor?.system?.abilities?.[ability]?.value) : null;
  return score == null ? null : Math.floor((score - 10) / 2);
}

/** 2024 proficiency bonus at a level or Challenge Rating: 2 + floor((n - 1) / 4), at least 2. */
export const proficiencyForLevel = level => 2 + Math.floor((Math.max(Number(level) || 0, 1) - 1) / 4);

/**
 * A creature's proficiency bonus: by its character level, or a creature's threat (its Challenge Rating), plus every
 * Modifier on `proficiency`, so a feature or house rule changes it like any other statistic.
 */
export function actorProficiencyBonus(actor) {
  const details = actor?.system?.details ?? {};
  return proficiencyForLevel(details.level ?? details.threat) + (resolveActorStatisticModifier(actor, ["proficiency"]).value ?? 0);
}

/**
 * A creature's save bonus: its ability modifier, every Modifier on `save.<ability>` and `save`, and its proficiency
 * bonus when it is proficient in that save (`abilities.<ability>.saveProficient`).
 */
export function resolveActorSaveStatistic(actor, ability=null) {
  const save = withAbilityModifier(resolveActorStatisticModifier(actor, [ability ? `save.${ability}` : null, "save"].filter(Boolean),
    {tags: ability ? [ability] : []}), actor, ability);
  if ( !save || (actor?.system?.abilities?.[ability]?.saveProficient !== true) ) return save;
  const proficiency = actorProficiencyBonus(actor);
  return {...save, totalModifier: save.totalModifier + proficiency, proficiency};
}

/**
 * A creature's check bonus: its ability modifier (the skill's own ability when the check names none), every Modifier
 * on `check.<skill>`, `check.<ability>` and `check`, and its proficiency bonus once for a proficient skill or twice
 * for expertise (`skills.<skill>.proficiency`).
 */
export function resolveActorCheckStatistic(actor, {ability=null, skill=null}={}) {
  const used = ability ?? WILDPATH.SKILLS?.[skill]?.ability ?? null;
  const level = Math.min(Number(actor?.system?.skills?.[skill]?.proficiency) || 0, 2);
  // A skill check without its proficiency also reads `check.unproficient` (Jack of All Trades: half the Proficiency Bonus).
  const check = withAbilityModifier(resolveActorStatisticModifier(actor, [skill ? `check.${skill}` : null,
    used ? `check.${used}` : null, (skill && !level) ? "check.unproficient" : null, "check"].filter(Boolean),
  {tags: [used, skill].filter(Boolean)}), actor, used);
  if ( !check || !level ) return check;
  const proficiency = actorProficiencyBonus(actor) * level;
  // A check with its proficiency reads `check.proficient` minimums (Reliable Talent: a d20 of 9 or lower counts as 10).
  const naturalMinimum = Math.max(0, ...(actor?.getRollOutcomes?.(["check.proficient"]) ?? [])
    .filter(outcome => outcome.outcome === "minimum-natural").map(outcome => Number(outcome.threshold) || 0));
  return {...check, totalModifier: check.totalModifier + proficiency, proficiency, ...(naturalMinimum > 1 ? {naturalMinimum} : {})};
}

function withAbilityModifier(statistic, actor, ability) {
  const abilityModifier = actorAbilityModifier(actor, ability);
  if ( !statistic.known && (abilityModifier == null) ) return null;
  return {domain: statistic.domain, totalModifier: (statistic.value ?? 0) + (abilityModifier ?? 0), abilityModifier,
    dice: statistic.dice ?? [], trace: statistic.trace};
}

function resolveActorStatisticModifier(actor, domains, options={}) {
  if ( typeof actor?.getStatistic !== "function" ) return {known: false, value: null, trace: null, domain: null};
  const list = uniqueStrings(domains);
  const statistic = actor.getStatistic(list, {...options, auras: true});
  const value = finiteNumber(statistic?.totalModifier ?? statistic?.total ?? statistic?.value ?? statistic?.modifier);
  if ( value == null ) return {known: false, value: null, trace: null, domain: null};
  return {known: true, value, dice: clonePlain(statistic?.dice ?? []) ?? [], trace: clonePlain(statistic?.trace ?? {domain: list[0]}),
    domain: list[0] ?? null};
}

function firstFiniteNumber(values) {
  for ( const value of values ) {
    const number = finiteNumber(value);
    if ( number != null ) return number;
  }
  return null;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function stringOrDefault(value, fallback) {
  return stringOrNull(value) ?? fallback;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}

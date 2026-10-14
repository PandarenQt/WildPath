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
  const statistic = resolveActorStatisticModifier(actor, [`defense.${key}`, key]);
  const modifier = statistic.known ? statistic.value : null;
  const value = base == null && modifier == null ? null : (base ?? 0) + (modifier ?? 0);
  if ( value == null ) return null;
  return {
    value,
    slug: key,
    source: {
      type: "actor-combat-statistic",
      actorId: actor.id ?? actor.actorId ?? null,
      actorRef: actor.uuid ?? (actor.id ? `Actor.${actor.id}` : null),
      statisticKey: key,
      base,
      modifier,
      statistic: statistic.trace ?? null
    }
  };
}

/* -------------------------------------------- */

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
  const total = (statistic.value ?? 0) + (abilityModifier ?? 0);
  return {
    key,
    domain: statistic.domain ?? domains[0] ?? null,
    modifier: total,
    totalModifier: total,
    ability,
    abilityModifier,
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

/** A creature's save bonus: its ability modifier, plus every Modifier on `save.<ability>` and `save`. */
export function resolveActorSaveStatistic(actor, ability=null) {
  return withAbilityModifier(resolveActorStatisticModifier(actor, [ability ? `save.${ability}` : null, "save"].filter(Boolean),
    {tags: ability ? [ability] : []}), actor, ability);
}

/** A creature's check bonus: its ability modifier, plus every Modifier on `check.<skill>`, `check.<ability>` and `check`. */
export function resolveActorCheckStatistic(actor, {ability=null, skill=null}={}) {
  return withAbilityModifier(resolveActorStatisticModifier(actor, [skill ? `check.${skill}` : null,
    ability ? `check.${ability}` : null, "check"].filter(Boolean), {tags: [ability, skill].filter(Boolean)}), actor, ability);
}

function withAbilityModifier(statistic, actor, ability) {
  const abilityModifier = actorAbilityModifier(actor, ability);
  if ( !statistic.known && (abilityModifier == null) ) return null;
  return {domain: statistic.domain, totalModifier: (statistic.value ?? 0) + (abilityModifier ?? 0), abilityModifier,
    trace: statistic.trace};
}

function resolveActorStatisticModifier(actor, domains, options={}) {
  if ( typeof actor?.getStatistic !== "function" ) return {known: false, value: null, trace: null, domain: null};
  const list = uniqueStrings(domains);
  const statistic = actor.getStatistic(list, options);
  const value = finiteNumber(statistic?.totalModifier ?? statistic?.total ?? statistic?.value ?? statistic?.modifier);
  if ( value == null ) return {known: false, value: null, trace: null, domain: null};
  return {known: true, value, trace: clonePlain(statistic?.trace ?? {domain: list[0]}), domain: list[0] ?? null};
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

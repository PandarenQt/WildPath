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
 * @param {object} actor
 * @param {object} attack
 * @returns {{key: string, domain: string, modifier: number, totalModifier: number, source: object}|null}
 */
export function resolveActorAttackStatistic(actor, attack={}) {
  if ( !actor || !attack ) return null;
  const key = stringOrNull(attack.statistic ?? attack.statisticKey ?? attack.selector ?? attack.domain);
  if ( !key ) return null;
  const domains = uniqueStrings([
    key.includes(".") ? key : null,
    `attack.${key}`,
    key,
    attack.type ? `attack.${attack.type}` : null,
    "attack"
  ]);
  const statistic = resolveActorStatisticModifier(actor, domains);
  if ( !statistic.known ) return null;
  return {
    key,
    domain: statistic.domain,
    modifier: statistic.value,
    totalModifier: statistic.value,
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

function resolveActorStatisticModifier(actor, domains) {
  if ( typeof actor?.getStatistic !== "function" ) return {known: false, value: null, trace: null, domain: null};
  for ( const domain of uniqueStrings(domains) ) {
    const statistic = actor.getStatistic(domain);
    const value = finiteNumber(statistic?.totalModifier ?? statistic?.total ?? statistic?.value ?? statistic?.modifier);
    if ( value != null ) return {
      known: true,
      value,
      trace: clonePlain(statistic?.trace ?? {domain}),
      domain
    };
  }
  return {known: false, value: null, trace: null, domain: null};
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

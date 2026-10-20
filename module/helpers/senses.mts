/**
 * A creature's senses (2024): Darkvision, Blindsight, Tremorsense, Truesight and Devil's Sight (it sees normally in
 * magical and nonmagical Darkness), each with a range in feet, from its
 * grants (`GrantSense` RuleElements on its species, features, gear and effects). Its Token's vision follows them
 * (documents/token.mjs), and the rules read them: Truesight sees the Invisible, Blindsight sees without sight.
 */

export const SENSES = Object.freeze(["darkvision", "blindsight", "tremorsense", "truesight", "devilsSight"] as const);
export type Sense = typeof SENSES[number];
export type Senses = Record<Sense, number>;

/** Each sense's best range among `grants` (`{sense, range}`); 0 where none grants it. */
export function bestSenses(grants: ReadonlyArray<{sense?: string; range?: number}> = []): Senses {
  const senses = Object.fromEntries(SENSES.map(sense => [sense, 0])) as Senses;
  for ( const grant of grants ) {
    const sense = String(grant?.sense ?? "") as Sense;
    if ( SENSES.includes(sense) ) senses[sense] = Math.max(senses[sense], Number(grant.range) || 0);
  }
  return senses;
}

interface GroundToken {elevation?: number | null; level?: unknown; parent?: {levels?: {get?(id: string): {elevation?: {bottom?: number}} | undefined}} | null}

/** Whether a Token stands on its Level's floor (Tremorsense feels only what touches the ground); unknown counts as on it. */
export function onGround(token: GroundToken | null | undefined): boolean {
  if ( !token ) return true;
  const floor = Number(token.parent?.levels?.get?.(String(token.level))?.elevation?.bottom) || 0;
  return (Number(token.elevation) || 0) <= floor;
}

interface Perceiver {statuses?: Iterable<string> | null; system?: {senses?: Partial<Senses> | null} | null}

/**
 * Whether `observer` perceives `observed` despite Blinded and Invisible: a Blinded creature perceives only by
 * Blindsight (or Tremorsense, a creature on the ground) within range; an Invisible creature is perceived by Truesight,
 * Blindsight or Tremorsense within range. `distance` in feet (unknown counts as within range); `grounded`: the observed
 * creature touches the ground (Tremorsense; unknown counts as grounded).
 */
export function perceives(observer: Perceiver | null | undefined, observed: Perceiver | null | undefined,
  {distance = null, grounded = true}: {distance?: number | null; grounded?: boolean} = {}): boolean {
  const blinded = new Set(observer?.statuses ?? []).has("blinded");
  const invisible = new Set(observed?.statuses ?? []).has("invisible");
  if ( !blinded && !invisible ) return true;
  const senses = observer?.system?.senses ?? {};
  const reaches = (sense: Sense) => ((Number(senses[sense]) || 0) > 0) && ((distance === null) || (distance <= Number(senses[sense])));
  if ( reaches("blindsight") || (grounded && reaches("tremorsense")) ) return true;
  return !blinded && reaches("truesight");
}

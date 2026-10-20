/**
 * A creature's senses (2024): Darkvision, Blindsight, Tremorsense, Truesight and Devil's Sight (it sees normally in
 * magical and nonmagical Darkness), each with a range in feet, from its
 * grants (`GrantSense` RuleElements on its species, features, gear and effects). Its Token's vision follows them
 * (documents/token.mjs), and the rules read them: Truesight sees the Invisible, Blindsight sees without sight.
 */
export const SENSES = Object.freeze(["darkvision", "blindsight", "tremorsense", "truesight", "devilsSight"]);
/** Each sense's best range among `grants` (`{sense, range}`); 0 where none grants it. */
export function bestSenses(grants = []) {
    const senses = Object.fromEntries(SENSES.map(sense => [sense, 0]));
    for (const grant of grants) {
        const sense = String(grant?.sense ?? "");
        if (SENSES.includes(sense))
            senses[sense] = Math.max(senses[sense], Number(grant.range) || 0);
    }
    return senses;
}
/** Whether a Token stands on its Level's floor (Tremorsense feels only what touches the ground); unknown counts as on it. */
export function onGround(token) {
    if (!token)
        return true;
    const floor = Number(token.parent?.levels?.get?.(String(token.level))?.elevation?.bottom) || 0;
    return (Number(token.elevation) || 0) <= floor;
}
/**
 * Whether `observer` perceives `observed` despite Blinded and Invisible: a Blinded creature perceives only by
 * Blindsight (or Tremorsense, a creature on the ground) within range; an Invisible creature is perceived by Truesight,
 * Blindsight or Tremorsense within range. `distance` in feet (unknown counts as within range); `grounded`: the observed
 * creature touches the ground (Tremorsense; unknown counts as grounded).
 */
export function perceives(observer, observed, { distance = null, grounded = true } = {}) {
    const blinded = new Set(observer?.statuses ?? []).has("blinded");
    const invisible = new Set(observed?.statuses ?? []).has("invisible");
    if (!blinded && !invisible)
        return true;
    const senses = observer?.system?.senses ?? {};
    const reaches = (sense) => ((Number(senses[sense]) || 0) > 0) && ((distance === null) || (distance <= Number(senses[sense])));
    if (reaches("blindsight") || (grounded && reaches("tremorsense")))
        return true;
    return !blinded && reaches("truesight");
}

/**
 * 2024 Metamagic: a sorcerer's spell Actions offer a "Metamagic" choice of the options it knows (features flagged
 * `flags.wildpath.metamagic`), each paid from its Sorcery Points (`font-of-magic`). One option a casting.
 * Seeking Spell is a reroll offer on a missed spell attack instead, and Empowered Spell an Action of its own.
 * - Quickened: not after a level 1+ spell this turn, and no level 1+ spell after it (`flags.wildpath.quickenedTurn`).
 * - Extended: a duration of 1 minute or more doubles, to 24 hours at most, with Advantage on its Concentration saves.
 * - Subtle: cast without Verbal, Somatic or Material components (a costly one stays), so Counterspell doesn't see it.
 * shortcuts: Heightened's target and Careful's creatures are by hand (cost only).
 */
export const METAMAGIC_POOL = "font-of-magic";
const SIX_TYPES = Object.freeze(["acid", "cold", "fire", "lightning", "poison", "thunder"]);
const COSTS = Object.freeze({ quickened: 2, heightened: 2 });
const BY_HAND = Object.freeze(["heightened", "careful"]);
const SECONDS = Object.freeze({ seconds: 1, second: 1, rounds: 6, round: 6, turns: 6, minutes: 60, minute: 60, hours: 3600, hour: 3600,
    days: 86400, day: 86400 });
/** A duration's length in seconds (rounds are 6), or 0 when it has none or none known. */
export function durationSeconds(duration) {
    return (Number(duration?.value) || 0) * (SECONDS[String(duration?.units ?? "")] ?? 0);
}
const ORDER = Object.freeze(["quickened", "twinned", "transmuted", "distant", "extended", "heightened", "careful", "subtle"]);
/** The Metamagic options its creature knows. */
export function knownMetamagic(actor) {
    return new Set([...(actor?.items ?? [])].map((item) => item?.flags?.wildpath?.metamagic).filter(Boolean));
}
/** A spell Action's definition with a "Metamagic" choice, for a creature that knows options and has Sorcery Points. */
export function withMetamagic(raw, actor) {
    if (!raw?.tags?.includes("spell") || (raw.configuration ?? []).some((choice) => choice?.id === "metamagic"))
        return raw;
    const points = Number((actor?.system?.pools ?? []).find((pool) => pool.id === METAMAGIC_POOL)?.value) || 0;
    const known = knownMetamagic(actor);
    if (!points || !known.size)
        return raw;
    const options = ORDER.filter(option => known.has(option)).flatMap(option => metamagicOptions(option, raw, actor))
        .filter(option => option.cost <= points)
        .map(({ cost, effects, ...option }) => ({ ...option, effects: [{ type: "add-cost", cost: { allOf: [{ capability: METAMAGIC_POOL, amount: cost }] } },
            ...effects] }));
    if (!options.length)
        return raw;
    return { ...raw, configuration: [...(raw.configuration ?? []), { id: "metamagic", type: "select-one", label: "Metamagic", required: true,
                options: [{ id: "none", label: "None", value: "none" }, ...options] }] };
}
/** One option's choices for this spell (Transmuted: one per damage type), none when it does not apply. */
function metamagicOptions(option, raw, actor) {
    const cost = COSTS[option] ?? 1;
    const name = `${option.charAt(0).toUpperCase()}${option.slice(1)} Spell`;
    const label = (text) => `${text} (${cost} ${cost === 1 ? "point" : "points"})`;
    const one = (effects) => [{ id: option, value: option, label: label(BY_HAND.includes(option) ? `${name}, by hand` : name), cost, effects }];
    switch (option) {
        case "quickened": {
            const combat = globalThis.game?.combat;
            // turnKey's format (foundry-v14-persistent-areas): not after another spell slot spent this turn.
            const turn = combat?.started ? `${combat.id}:${combat.round}:${combat.turn ?? 0}` : null;
            const action = (raw.costs?.allOf ?? []).some((entry) => entry?.capability === "action");
            return (action && (!turn || (actor?.flags?.wildpath?.slotSpellTurn !== turn)))
                ? one([{ type: "replace-cost", from: "action", to: "bonus-action" }]) : [];
        }
        case "twinned": {
            const scale = (raw.configuration ?? []).flatMap((choice) => choice?.effects ?? [])
                .find((effect) => ["scaleTargets", "scale-targets"].includes(effect?.type));
            return scale ? one([{ type: "scale-targets", level: 1, baseLevel: 0, perLevel: Number(scale.perLevel) || 1 }]) : [];
        }
        case "transmuted": {
            const components = (raw.damage ?? []).filter((component) => SIX_TYPES.includes(component?.damageType));
            if (!components.length)
                return [];
            const ids = components.map((component) => component.id);
            const from = new Set(components.map((component) => component.damageType));
            return SIX_TYPES.filter(type => !from.has(type)).map(type => ({ id: `transmuted-${type}`, value: `transmuted-${type}`,
                label: label(`${name}: ${type}`), cost, effects: [{ type: "replace-damage-type", damageType: type, componentIds: ids }] }));
        }
        case "distant": {
            const range = raw.range;
            if (range?.type === "touch")
                return one([{ type: "set-range", range: { type: "ranged", normal: { value: 30, unit: "ft" } } }]);
            if ((range?.type !== "ranged") || !(Number(range.normal?.value) > 0))
                return [];
            const doubled = (distance) => (distance ? { ...distance, value: Number(distance.value) * 2 } : distance);
            return one([{ type: "set-range", range: { ...range, normal: doubled(range.normal), ...(range.long ? { long: doubled(range.long) } : {}) } }]);
        }
        case "extended": {
            // "a spell that has a duration of 1 minute or longer".
            const lasts = [...(raw.effects ?? []).map((effect) => effect?.duration), raw.concentration?.duration]
                .some(duration => durationSeconds(duration) >= 60);
            return lasts ? one([{ type: "scale-duration", factor: 2, maxSeconds: 86400, concentrationAdvantage: true }]) : [];
        }
        case "subtle":
            return one([{ type: "remove-components" }]);
        default:
            return one([]);
    }
}

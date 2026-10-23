/**
 * A change of size (2024 Enlarge/Reduce: one size larger or smaller). A creature's size is its Token's squares, so the
 * active GM resizes its Tokens when the `size` Modifiers on it change (their total is the steps), and gives them back
 * their own size, kept in `flags.wildpath.ownSize`, when those end.
 */
const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const SQUARES = [0.5, 1, 1, 2, 3, 4];
/**
 * The squares of a creature `steps` sizes from its own: its species' size when it has one (a Small one enlarged is
 * Medium, still 1 square), otherwise its Token's (1 square reads as Medium).
 */
export function resizedSquares(squares, steps, size = null) {
    const from = SIZES.includes(String(size)) ? SIZES.indexOf(String(size))
        : ((squares <= 0.5) ? 0 : ((squares <= 1) ? 2 : Math.min(Math.round(squares) + 1, 5)));
    return SQUARES[Math.min(Math.max(from + steps, 0), 5)];
}
export function createFoundryTokenSize({ game }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    /** An effect on a creature arrived, changed or ended: its Tokens take the size its `size` Modifiers give it. */
    async function onEffectChanged(effect) {
        const actor = effect.parent;
        if (!isActiveGM() || !actor?.getStatistic)
            return;
        const steps = Math.trunc(Number(actor.getStatistic(["size"])?.totalModifier) || 0);
        const species = [...(actor.items ?? [])].find(item => item.type === "species")?.system?.size ?? null;
        const tokens = actor.isToken ? [actor.token].filter(Boolean) : (actor.getActiveTokens?.(false, true) ?? []);
        for (const token of tokens) {
            const own = token.flags?.wildpath?.ownSize ?? { width: token.width, height: token.height };
            const squares = steps ? resizedSquares(Math.max(own.width, own.height), steps, species) : null;
            const target = squares ? { width: squares, height: squares } : own;
            if ((token.width === target.width) && (token.height === target.height))
                continue;
            // A resize in place, not a move: an unmeasured displacement, which the movement authority approves as a resize.
            await token.update({ ...target, "flags.wildpath.ownSize": (target === own) ? null : own }, { animate: false,
                movement: { [token.id]: { waypoints: [{ ...target, action: "displace" }], showRuler: false } } });
        }
    }
    return { onEffectChanged };
}

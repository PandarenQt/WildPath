/**
 * Floating combat text (after Baldur's Gate 3): what happens to a creature rises over its Tokens on every client
 * that can see them. Health changes come from the Actor update itself (`floatHealthChange`); an Action's outcomes
 * (Miss, Critical hit, Saved) come from its chat card's `flags.wildpath.floating`, on clients that can see the card.
 */
const globals = globalThis;
/** Colours by kind: damage, healing, a miss (and Immune), a critical hit and a saved roll. */
const FILLS = { damage: 0xdd3333, healing: 0x33cc66, miss: 0xdddddd, critical: 0xffcc33, saved: 0x66aaff };
const KIND_OF_LABEL = {
    "WILDPATH.CHAT.Outcome.Miss": "miss", "WILDPATH.CHAT.Outcome.Critical": "critical", "WILDPATH.CHAT.Outcome.SaveSuccess": "saved",
    "WILDPATH.CHAT.Outcome.Immune": "miss"
};
/** Damage coloured by its type, as Baldur's Gate 3 does; weapon damage keeps the damage red. */
const DAMAGE_FILLS = { acid: 0x99dd33, cold: 0x77ccff, fire: 0xff7722, force: 0xdd66ff, lightning: 0x88aaff,
    necrotic: 0x55aa77, poison: 0x66bb33, psychic: 0xff88cc, radiant: 0xffee77, thunder: 0x9988ff };
/** Raise `text` over each of `actor`'s visible Tokens on this client's canvas, in its kind's colour or `fill`. */
export function floatText(actor, text, kind, fill = null) {
    const layer = globals.canvas?.ready ? globals.canvas.interface : null;
    if (!layer || !actor)
        return;
    for (const token of actor.getActiveTokens?.(true) ?? (actor.object ? [actor.object] : [])) {
        if (!token.visible || token.document.isSecret)
            continue;
        void layer.createScrollingText(token.center, text, { anchor: globals.CONST.TEXT_ANCHOR_POINTS.CENTER,
            direction: globals.CONST.TEXT_ANCHOR_POINTS.TOP, distance: 2 * token.h, fontSize: 32, fill: fill ?? FILLS[kind],
            stroke: 0x000000, strokeThickness: 4, jitter: 0.25 });
    }
}
/**
 * A change in health, signed: "+3" in green; damage with its types, most first, in the colour of the first: "−8 Fire".
 */
export function floatHealthChange(actor, change, damageTypes = []) {
    if (!Number.isFinite(change) || !change)
        return;
    if (change > 0)
        return floatText(actor, `+${change}`, "healing");
    const types = damageTypes.map(type => globals.game.i18n.localize(`WILDPATH.DAMAGE.${type.charAt(0).toUpperCase()}${type.slice(1)}`));
    floatText(actor, [`−${Math.abs(change)}`, types.join(", ")].filter(Boolean).join(" "), "damage", DAMAGE_FILLS[damageTypes[0] ?? ""] ?? null);
}
/** Each Action card's floating outcomes, on the clients that may see the card (never a blind roll's). */
export function registerFloatingText() {
    globals.Hooks.on("createChatMessage", (message) => {
        const card = message;
        if (!card.visible || (card.blind && !globals.game.user?.isGM))
            return;
        for (const { uuid, label } of card.flags?.wildpath?.floating ?? []) {
            const kind = KIND_OF_LABEL[label ?? ""];
            if (uuid && kind)
                floatText(globals.fromUuidSync(uuid), globals.game.i18n.localize(label), kind);
        }
    });
}

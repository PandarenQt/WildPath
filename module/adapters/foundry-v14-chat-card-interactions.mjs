/**
 * A resolution card's named targets highlight their Token on hover and pan to it on click or Enter/Space
 * (structure inspired by Crucible's target links). Hidden targets are never linked by the card, and a Token
 * this client cannot see is ignored.
 */
export function registerChatCardInteractions(hooks = globalThis.Hooks) {
    hooks?.on("renderChatMessageHTML", (_message, html) => {
        for (const row of html?.querySelectorAll?.(".resolution-card [data-target-uuid]") ?? [])
            wireTargetRow(row);
    });
}
export function visibleTokenFor(uuid) {
    const resolve = globalThis.fromUuidSync;
    const document = uuid && resolve ? resolve(uuid) : null;
    const token = document?.object ?? document?.token?.object ?? document?.getActiveTokens?.()[0] ?? null;
    return token?.visible ? token : null;
}
function wireTargetRow(row) {
    const token = () => visibleTokenFor(row.dataset.targetUuid);
    const pan = () => {
        const center = token()?.center;
        const canvas = globalThis.canvas;
        if (center)
            canvas?.animatePan?.({ x: center.x, y: center.y });
    };
    row.addEventListener("mouseenter", event => token()?._onHoverIn?.(event, { hoverOutOthers: true }));
    row.addEventListener("mouseleave", event => token()?._onHoverOut?.(event));
    row.addEventListener("click", pan);
    row.addEventListener("keydown", event => {
        if ((event.key === "Enter") || (event.key === " ")) {
            event.preventDefault();
            pan();
        }
    });
}

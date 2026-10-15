import { areaClickCount, foundryAreaFootprint, foundryAreaTargetTokens, foundryPointInRange } from "../adapters/foundry-v14-area-placement.mjs";
import { createFoundryV14TacticalGridAdapter } from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
/** Creatures an area would hit: allies (the caster's own disposition) in amber, the others in red. */
const ALLY = 0xffaa00;
const OTHER = 0xff3333;
const LAYER = "wildpath-area-placement";
const CODE_KEYS = {
    NoGrid: "WILDPATH.AREA.NoGrid",
    NoFootprint: "WILDPATH.AREA.NoFootprint",
    NeedOrigin: "WILDPATH.AREA.NeedOrigin",
    OffGrid: "WILDPATH.AREA.OffGrid",
    OutOfRange: "WILDPATH.AREA.OutOfRange",
    UnsupportedShape: "WILDPATH.AREA.UnsupportedShape",
    NotOnEdge: "WILDPATH.AREA.NotOnEdge",
    NeedDirection: "WILDPATH.AREA.NeedDirection",
    BadDirection: "WILDPATH.AREA.BadDirection"
};
/**
 * Place an area Action with WildPath's own clicks. A radial area takes one click on a field; a cone or line
 * takes a corner on the caster's Token edge, then a direction. While the cursor moves, the highlight shows
 * exactly the fields the authority will resolve (it runs the same `foundryAreaFootprint`). Clicks go to the
 * placement only, never to Foundry's Token selection. Escape or right-click cancels.
 * @returns the placement points, or null when cancelled.
 */
export function placeFoundryArea({ definition, sourceToken }) {
    const { canvas, game } = globalThis;
    const adapter = createFoundryV14TacticalGridAdapter({ scene: sourceToken.parent });
    const needed = areaClickCount(definition);
    return pickPoints({
        needed,
        hint: needed === 1 ? "WILDPATH.AREA.PlaceRadial" : "WILDPATH.AREA.PlaceFromEdge",
        highlight: (points, cursor) => {
            const result = foundryAreaFootprint({ definition, sourceToken, points: [...points, cursor] });
            if (!result.ok)
                return [];
            const fields = result.footprint.fields.flatMap(field => {
                const center = adapter.fieldToCenterPoint(field);
                return center.ok && center.point ? [{ x: center.point.x - (canvas.grid.sizeX / 2), y: center.point.y - (canvas.grid.sizeY / 2) }] : [];
            });
            // Every creature the area would hit, as the authority will find them, allies included (Baldur's Gate 3).
            const source = sourceToken.disposition ?? 0;
            const creatures = foundryAreaTargetTokens({ sourceToken, footprint: result.footprint, definition })
                .filter(token => game.user.isGM || !token.hidden)
                .flatMap(token => token.getOccupiedGridSpaceOffsets().map(offset => ({ ...canvas.grid.getTopLeftPoint(offset),
                color: (token.disposition ?? 0) === source ? ALLY : OTHER })));
            return [...fields, ...creatures];
        },
        // A click counts only when it advances placement: a valid origin first, then a valid whole area.
        accept: (points, point) => {
            const result = foundryAreaFootprint({ definition, sourceToken, points: [...points, point] });
            return (result.ok || ((points.length === 0) && (needed === 2) && (result.needs === "direction"))) ? null : CODE_KEYS[result.code];
        }
    });
}
/**
 * Choose where a summon's creatures appear (2024: spaces the caster can see within range): one click per creature,
 * each on a field within the Action's range. The authority places each creature there, or on the nearest place it fits.
 * @returns the points, or null when cancelled.
 */
export function placeFoundrySummons({ definition, sourceToken, count }) {
    const { canvas } = globalThis;
    const field = (point) => canvas.grid.getTopLeftPoint(canvas.grid.getOffset(point));
    return pickPoints({
        needed: count,
        hint: "WILDPATH.SUMMON.Place",
        highlight: (points, cursor) => [...points, cursor].map(field),
        accept: (points, point) => (foundryPointInRange({ definition, sourceToken: sourceToken, point }) ? null : CODE_KEYS.OutOfRange)
    });
}
/**
 * WildPath's own clicks on the board: `needed` clicks, each checked by `accept` (a lang key to warn with, or null),
 * with `highlight` showing the fields (top-left points) the next click would give. Clicks go to the placement
 * only, never to Foundry's Token selection. Escape or right-click cancels.
 */
function pickPoints({ needed, hint, highlight, accept }) {
    const { canvas, game, ui } = globalThis;
    const board = canvas.app.view;
    const grid = canvas.interface.grid;
    const points = [];
    grid.addHighlightLayer(LAYER);
    ui.notifications.info(game.i18n.localize(hint));
    return new Promise(resolve => {
        const toCanvas = (event) => canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
        const draw = (cursor) => {
            grid.clearHighlightLayer(LAYER);
            for (const { x, y, color } of highlight(points, cursor)) {
                const tint = color ?? Number(game.user.color);
                grid.highlightPosition(LAYER, { x, y, color: tint, border: tint, alpha: color ? 0.55 : 0.35 });
            }
        };
        const finish = (value) => {
            board.removeEventListener("pointermove", onMove, true);
            board.removeEventListener("pointerdown", onDown, true);
            board.removeEventListener("contextmenu", onContextMenu, true);
            globalThis.removeEventListener("keydown", onKey, true);
            grid.destroyHighlightLayer(LAYER);
            resolve(value);
        };
        const onMove = (event) => draw(toCanvas(event));
        const onDown = (event) => {
            event.stopImmediatePropagation();
            event.preventDefault();
            if (event.button === 2)
                return finish(null);
            if (event.button !== 0)
                return;
            const point = toCanvas(event);
            const refused = accept(points, point);
            if (refused)
                return void ui.notifications.warn(game.i18n.localize(refused));
            points.push(point);
            if (points.length >= needed)
                finish({ points });
        };
        const onContextMenu = (event) => {
            event.stopImmediatePropagation();
            event.preventDefault();
        };
        const onKey = (event) => {
            if (event.key !== "Escape")
                return;
            event.stopImmediatePropagation();
            finish(null);
        };
        board.addEventListener("pointermove", onMove, true);
        board.addEventListener("pointerdown", onDown, true);
        board.addEventListener("contextmenu", onContextMenu, true);
        globalThis.addEventListener("keydown", onKey, true);
    });
}

import { areaClickCount, foundryAreaFootprint } from "../adapters/foundry-v14-area-placement.mjs";
import { createFoundryV14TacticalGridAdapter } from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
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
    const { canvas, game, ui } = globalThis;
    const board = canvas.app.view;
    const grid = canvas.interface.grid;
    const adapter = createFoundryV14TacticalGridAdapter({ scene: sourceToken.parent });
    const needed = areaClickCount(definition);
    const points = [];
    grid.addHighlightLayer(LAYER);
    ui.notifications.info(game.i18n.localize(needed === 1 ? "WILDPATH.AREA.PlaceRadial" : "WILDPATH.AREA.PlaceFromEdge"));
    return new Promise(resolve => {
        const toCanvas = (event) => canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
        const draw = (cursor) => {
            grid.clearHighlightLayer(LAYER);
            const result = foundryAreaFootprint({ definition, sourceToken, points: [...points, cursor] });
            if (!result.ok)
                return;
            for (const field of result.footprint.fields) {
                const center = adapter.fieldToCenterPoint(field);
                if (!center.ok || !center.point)
                    continue;
                grid.highlightPosition(LAYER, { x: center.point.x - (canvas.grid.sizeX / 2), y: center.point.y - (canvas.grid.sizeY / 2),
                    color: Number(game.user.color), border: Number(game.user.color), alpha: 0.35 });
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
            const result = foundryAreaFootprint({ definition, sourceToken, points: [...points, point] });
            // A click counts only when it advances placement: a valid origin first, then a valid whole area.
            if (!result.ok && !((points.length === 0) && (needed === 2) && (result.needs === "direction"))) {
                return void ui.notifications.warn(game.i18n.localize(CODE_KEYS[result.code]));
            }
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

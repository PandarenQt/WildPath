import {combatCarouselContext} from "../helpers/combat-carousel-context.mjs";

type Data = Record<string, unknown>;
type CarouselCombat = Parameters<typeof combatCarouselContext>[0]["combat"] & {
  started?: boolean; nextTurn(): Promise<unknown>; combatants: {get(id: string): {token?: {object?: TokenObject | null} | null} | undefined};
};
interface TokenObject {visible?: boolean; center: {x: number; y: number}; control?(options?: Data): unknown; isOwner?: boolean}
interface AppInstance {element: HTMLElement; rendered: boolean; render(options?: Data): Promise<unknown>; close(): Promise<unknown>}
type AppClass = new (options?: Data) => AppInstance;
interface Globals {
  foundry: {applications: {api: {ApplicationV2: AppClass; HandlebarsApplicationMixin(base: AppClass): AppClass}}};
  canvas?: {animatePan?(view: {x: number; y: number}): unknown};
  game: {combat?: CarouselCombat | null; user?: {isGM?: boolean}};
  CONFIG: {WILDPATH: {CONDITIONS: Record<string, {id: string; name: string; img: string; stacking?: boolean}>}};
  Hooks: {on(name: string, callback: (...args: unknown[]) => unknown): number};
}

const globals = globalThis as unknown as Globals;
const {ApplicationV2, HandlebarsApplicationMixin} = globals.foundry.applications.api;

/**
 * The in-play combat carousel (M6): the viewed combat's turn order across the top of the screen while it runs.
 * A portrait pans to its Token; the GM, or the owner of the creature whose turn it is, can end the turn through
 * Foundry's own `Combat#nextTurn`, so turn order stays Foundry's and WildPath's turn automation runs as usual.
 */
export class WildPathCombatCarousel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "wildpath-combat-carousel",
    classes: ["wildpath", "combat-carousel"],
    tag: "aside",
    window: {frame: false, positioned: false},
    actions: {next: WildPathCombatCarousel.#onNext, pan: WildPathCombatCarousel.#onPan}
  };

  static PARTS = {carousel: {template: "systems/wildpath/templates/hud/combat-carousel.hbs"}};

  async _prepareContext() {
    const combat = globals.game.combat;
    if ( !combat?.started ) return {shown: false};
    return {shown: true, ...combatCarouselContext({combat, isGM: globals.game.user?.isGM === true,
      conditions: Object.values(globals.CONFIG.WILDPATH.CONDITIONS)})};
  }

  static async #onNext() {
    await globals.game.combat?.nextTurn();
  }

  static async #onPan(this: WildPathCombatCarousel, event: Event, target: HTMLElement) {
    const id = target.closest<HTMLElement>("[data-combatant-id]")?.dataset.combatantId;
    const token = id ? globals.game.combat?.combatants.get(id)?.token?.object ?? null : null;
    if ( !token?.visible ) return;
    await globals.canvas?.animatePan?.(token.center);
    if ( token.isOwner ) token.control?.({releaseOthers: true});
  }
}

let carousel: WildPathCombatCarousel | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

/** Show the carousel while the viewed combat runs, and hide it otherwise. */
export function refreshCombatCarousel() {
  if ( pending ) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    carousel ??= new WildPathCombatCarousel();
    if ( globals.game.combat?.started ) void carousel.render({force: true});
    else if ( carousel.rendered ) void carousel.close();
  }, 50);
}

/** Register the hooks that keep the carousel on the viewed combat (called once the game is ready). */
export function registerCombatCarousel() {
  for ( const hook of ["createCombat", "updateCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant",
    "canvasReady", "updateActor", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "updateToken"] ) {
    globals.Hooks.on(hook, () => { if ( globals.game.combat || carousel?.rendered ) refreshCombatCarousel(); });
  }
  refreshCombatCarousel();
}

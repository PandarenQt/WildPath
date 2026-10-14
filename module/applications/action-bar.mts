import {actionBarContext} from "../helpers/action-bar-context.mjs";

type Data = Record<string, unknown>;
interface BarActor {
  uuid: string; name?: string; img?: string; isOwner?: boolean; system?: Data;
  items: {get(id: string): {use(): Promise<unknown>} | undefined} & Iterable<unknown>;
  effects: Iterable<{system?: {type?: string; level?: number}; disabled?: boolean}>;
}
interface AppInstance {element: HTMLElement; rendered: boolean; render(options?: Data): Promise<unknown>; close(): Promise<unknown>}
type AppClass = new (options?: Data) => AppInstance;
interface Globals {
  foundry: {applications: {api: {ApplicationV2: AppClass; HandlebarsApplicationMixin(base: AppClass): AppClass}}};
  canvas?: {tokens?: {controlled?: Array<{actor?: BarActor | null}>}};
  game: {user?: {character?: BarActor | null}};
  CONFIG: {WILDPATH: {CONDITIONS: Record<string, {id: string; name: string; img: string; stacking?: boolean}>}};
  Hooks: {on(name: string, callback: (...args: unknown[]) => unknown): number};
}

const globals = globalThis as unknown as Globals;
const {ApplicationV2, HandlebarsApplicationMixin} = globals.foundry.applications.api;

/**
 * The in-play action bar (M6): the controlled Token's creature, or the user's character when no Token is
 * controlled. Clicking an Action uses it through the real `Item.use()`, so the authority decides everything.
 */
export class WildPathActionBar extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "wildpath-action-bar",
    classes: ["wildpath", "action-bar"],
    tag: "aside",
    window: {frame: false, positioned: false},
    actions: {use: WildPathActionBar.#onUse}
  };

  static PARTS = {bar: {template: "systems/wildpath/templates/hud/action-bar.hbs"}};

  /** The creature shown, when a test or caller sets it; otherwise it follows the controlled Token. */
  actor: BarActor | null = null;

  /** The creature the bar shows now. */
  get shownActor(): BarActor | null {
    return this.actor ?? globals.canvas?.tokens?.controlled?.[0]?.actor ?? globals.game.user?.character ?? null;
  }

  async _prepareContext() {
    const actor = this.shownActor;
    return actor ? {shown: true, ...actionBarContext({actor, conditions: Object.values(globals.CONFIG.WILDPATH.CONDITIONS)})}
      : {shown: false};
  }

  static async #onUse(this: WildPathActionBar, event: Event, target: HTMLElement) {
    const id = target.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
    if ( id ) await this.shownActor?.items.get(id)?.use();
  }
}

let bar: WildPathActionBar | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

/** Show the bar for the creature in focus, hide it when there is none; changes to that creature re-render it. */
export function refreshActionBar() {
  if ( pending ) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    bar ??= new WildPathActionBar();
    if ( bar.shownActor?.isOwner ) void bar.render({force: true});
    else if ( bar.rendered ) void bar.close();
  }, 50);
}

/** Register the hooks that keep the bar on the creature in focus (called once the game is ready). */
export function registerActionBar() {
  const concerns = (document: unknown) => {
    const shown = bar?.shownActor;
    const owner = (document as {parent?: {uuid?: string}; uuid?: string} | null);
    return !!shown && ((owner?.uuid === shown.uuid) || (owner?.parent?.uuid === shown.uuid));
  };
  globals.Hooks.on("controlToken", () => refreshActionBar());
  for ( const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect",
    "deleteActiveEffect"] ) {
    globals.Hooks.on(hook, (document: unknown) => { if ( concerns(document) ) refreshActionBar(); });
  }
  refreshActionBar();
}

import {actionBarContext} from "../helpers/action-bar-context.mjs";
import type {OddsEntry} from "../helpers/action-bar-context.mjs";
import {foundryActionOdds} from "../resolvers/foundry-multiplayer-runtime.mjs";
import {COMMON_ACTION_IDS, commonAction} from "../helpers/common-actions.mjs";
import {REACTION_POLICIES, reactionPolicyOf} from "../helpers/automation-events.mjs";

type Data = Record<string, unknown>;
interface BarActor {
  uuid: string; name?: string; img?: string; isOwner?: boolean; system?: Data;
  items: {get(id: string): {use(): Promise<unknown>; setFlag(scope: string, key: string, value: unknown): Promise<unknown>} | undefined}
    & Iterable<{id?: string | null; flags?: Data}>;
  effects: Iterable<{system?: {type?: string; level?: number}; disabled?: boolean}>;
}
interface AppInstance {element: HTMLElement; rendered: boolean; render(options?: Data): Promise<unknown>; close(): Promise<unknown>}
type AppClass = new (options?: Data) => AppInstance;
interface BarToken {document: {id: string; actor?: unknown}; actor?: BarActor | null}
interface OddsLine {key: string; mode: string | null; ability: string | null; data: Record<string, unknown>}
interface Globals {
  foundry: {applications: {api: {ApplicationV2: AppClass; HandlebarsApplicationMixin(base: AppClass): AppClass}};
    utils: {escapeHTML(text: string): string}};
  canvas?: {tokens?: {controlled?: BarToken[]}};
  game: {user?: {character?: BarActor | null; isGM?: boolean; targets?: Iterable<BarToken>};
    i18n: {localize(key: string): string; format(key: string, data: Record<string, unknown>): string}};
  CONFIG: {WILDPATH: {CONDITIONS: Record<string, {id: string; name: string; img: string; stacking?: boolean}>};
    Item: {documentClass: {prototype: {use(this: unknown): Promise<unknown>}}}};
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
    actions: {use: WildPathActionBar.#onUse, reactionPolicy: WildPathActionBar.#onReactionPolicy}
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
    if ( !actor ) return {shown: false};
    const common = this.#common(actor);
    const context = actionBarContext({actor, conditions: Object.values(globals.CONFIG.WILDPATH.CONDITIONS),
      odds: this.#odds(actor, common), common});
    // Each target's odds, one line each, in the button's tooltip.
    const {i18n} = globals.game;
    for ( const action of context.groups.flatMap(group => group.actions) ) {
      if ( !action.odds ) continue;
      Object.assign(action.odds, {tooltip: (action.odds.lines as OddsLine[]).map(line => i18n.format(line.key, {...line.data,
        name: globals.foundry.utils.escapeHTML(String(line.data.name ?? "")), mode: line.mode ? i18n.localize(line.mode) : "",
        ability: line.ability ? i18n.localize(line.ability) : ""})).join("<br>")});
    }
    return {shown: true, ...context};
  }

  /** The common actions as this creature's Actions (Dash, Shove...). */
  #common(actor: BarActor) {
    const localize = (key: string) => globals.game.i18n.localize(key);
    return COMMON_ACTION_IDS.map(id => commonAction(actor, id, {localize})!);
  }

  /** The odds of each attack and save Action against the user's targets, as far as this user may see them. */
  #odds(actor: BarActor, common: readonly unknown[]): Record<string, readonly OddsEntry[]> {
    const {user} = globals.game;
    const targets = [...(user?.targets ?? [])].map(token => token.document);
    if ( !targets.length ) return {};
    const sourceToken = globals.canvas?.tokens?.controlled?.find(token => token.actor === actor)?.document
      ?? (actor as {getActiveTokens?(): BarToken[]}).getActiveTokens?.()[0]?.document ?? null;
    const odds = foundryActionOdds as unknown as (options: Record<string, unknown>) => OddsEntry[];
    return Object.fromEntries([...actor.items, ...common].filter(item => (item as {type?: string}).type === "action")
      .map(item => [(item as {id?: string}).id ?? "", odds({actor, action: item, sourceToken, targetTokens: targets, user})]));
  }

  static async #onUse(this: WildPathActionBar, event: Event, target: HTMLElement) {
    const id = target.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
    const actor = this.shownActor;
    if ( !id || !actor ) return;
    // A common action is no Item: Item#use runs on the Action this creature has for it.
    const common = id.startsWith("common-") ? this.#common(actor).find(action => action.id === id) : null;
    if ( common ) await globals.CONFIG.Item.documentClass.prototype.use.call(common);
    else await actor.items.get(id)?.use();
  }

  /** Cycle a reaction between Ask, Always and Never (Baldur's Gate 3's reaction settings). */
  static async #onReactionPolicy(this: WildPathActionBar, event: Event, target: HTMLElement) {
    const item = this.shownActor?.items.get(target.dataset.itemId ?? "");
    if ( !item ) return;
    const policies = REACTION_POLICIES as readonly string[];
    await item.setFlag("wildpath", "reactionPolicy", policies[(policies.indexOf(reactionPolicyOf(item)) + 1) % policies.length]);
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
    // A target's own changes (an effect revealing its defenses) change the odds shown.
    const targets = [...(globals.game.user?.targets ?? [])].map(token => (token.actor as {uuid?: string} | null)?.uuid);
    return !!shown && [shown.uuid, ...targets].some(uuid => uuid && ((owner?.uuid === uuid) || (owner?.parent?.uuid === uuid)));
  };
  globals.Hooks.on("controlToken", () => refreshActionBar());
  // The odds change with the user's targets, and with where the creatures stand.
  globals.Hooks.on("targetToken", (user: unknown) => { if ( user === globals.game.user ) refreshActionBar(); });
  globals.Hooks.on("updateToken", () => { if ( [...(globals.game.user?.targets ?? [])].length ) refreshActionBar(); });
  // The house rule's first change creates its Setting; later ones update it.
  for ( const hook of ["createSetting", "updateSetting"] ) globals.Hooks.on(hook, (setting: unknown) => {
    if ( (setting as {key?: string}).key === "wildpath.playersSeeOdds" ) refreshActionBar();
  });
  for ( const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect",
    "deleteActiveEffect"] ) {
    globals.Hooks.on(hook, (document: unknown) => { if ( concerns(document) ) refreshActionBar(); });
  }
  refreshActionBar();
}

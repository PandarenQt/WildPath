import {inspectResolution} from "../helpers/resolution-inspection.mjs";

type Data = Record<string, unknown>;
type InspectedRecord = Parameters<typeof inspectResolution>[0];
interface Waiting {resolutionId: string; requestId: string | null; type: string | null; userId: string}
interface Coordinator {
  records?: Map<string, InspectedRecord>;
  waitingRequests?(): Waiting[];
  answerForUsers?(resolutionId: string): Promise<unknown>;
}
interface AppInstance {render(options?: Data): Promise<unknown>}
type AppClass = new (options?: Data) => AppInstance;
interface Globals {
  foundry: {applications: {api: {ApplicationV2: AppClass; HandlebarsApplicationMixin(base: AppClass): AppClass}}};
  game: {user?: {isGM?: boolean}; i18n: {localize(key: string): string}; users?: {get(id: string): {name?: string} | undefined};
    wildpath?: {multiplayer?: {coordinator?: Coordinator}}};
  Hooks: {on(name: string, callback: (message: {flags?: {wildpath?: {resolutionId?: string}}}, html: HTMLElement) => unknown): number};
}

const globals = globalThis as unknown as Globals;
const {ApplicationV2, HandlebarsApplicationMixin} = globals.foundry.applications.api;
const RECENT = 25;

/**
 * The Rules Inspector (M6): the GM's view of why a resolution came out as it did, read from the authority's own
 * records on this client. Recent resolutions on the left, the chosen one's rolls, attacks, saves, health changes,
 * payments and errors on the right.
 */
export class WildPathRulesInspector extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "wildpath-rules-inspector",
    classes: ["wildpath", "rules-inspector", "themed", "theme-light"],
    window: {title: "WILDPATH.INSPECTOR.Title", resizable: true},
    position: {width: 760, height: 560},
    actions: {select: WildPathRulesInspector.#onSelect, answer: WildPathRulesInspector.#onAnswer}
  };

  static PARTS = {body: {template: "systems/wildpath/templates/apps/rules-inspector.hbs",
    templates: ["systems/wildpath/templates/apps/resolution-detail.hbs"]}};

  selectedId: string | null = null;
  #watch: ReturnType<typeof setInterval> | null = null;
  #seen = "";

  async _prepareContext() {
    const coordinator = globals.game.wildpath?.multiplayer?.coordinator;
    const records = [...(coordinator?.records?.values() ?? [])].reverse().slice(0, RECENT);
    const entries = records.map(inspectResolution);
    this.#seen = this.#signature();
    // A resolution named by its card that this client no longer holds (the world was reloaded, or it is too old) is
    // said to be gone, not swapped for the newest one.
    const named = this.selectedId ? coordinator?.records?.get(this.selectedId) : null;
    const unavailable = !!this.selectedId && !named;
    const selected = unavailable ? null
      : (entries.find(entry => entry.id === this.selectedId) ?? (named ? inspectResolution(named) : entries[0] ?? null));
    // Who each running resolution waits on, so the GM can answer for a Player who is away.
    const waiting = (coordinator?.waitingRequests?.() ?? []).filter(entry => entry.resolutionId === selected?.id)
      .map(entry => ({type: entry.type, user: globals.game.users?.get(entry.userId)?.name ?? entry.userId}));
    return {entries: entries.map(entry => ({id: entry.id, label: entry.label, status: entry.status,
      active: entry.id === selected?.id})), selected, waiting, unavailable};
  }

  /** What the records look like now: each one's id and stage, and who is waited on. */
  #signature() {
    const coordinator = globals.game.wildpath?.multiplayer?.coordinator;
    const records = [...(coordinator?.records?.values() ?? [])].slice(-RECENT)
      .map(record => `${(record as {resolutionId?: string}).resolutionId}:${(record as {state?: {status?: string}}).state?.status ?? ""}`);
    return JSON.stringify([records, coordinator?.waitingRequests?.().length ?? 0]);
  }

  /** While open, it follows the resolutions: redrawn when one starts, moves on or ends. */
  _onRender(context: Data, options: Data) {
    // @ts-expect-error The Foundry base class is typed only as far as this file needs.
    super._onRender(context, options);
    this.#watch ??= setInterval(() => {
      if ( this.#signature() !== this.#seen ) void this.render();
    }, 1000);
  }

  _onClose(options: Data) {
    // @ts-expect-error The Foundry base class is typed only as far as this file needs.
    super._onClose(options);
    if ( this.#watch ) clearInterval(this.#watch);
    this.#watch = null;
  }

  /** The GM answers, here, what the selected resolution waits on another user for. */
  static async #onAnswer(this: WildPathRulesInspector) {
    if ( this.selectedId === null ) {
      const first = [...(globals.game.wildpath?.multiplayer?.coordinator?.records?.values() ?? [])].at(-1) as {resolutionId?: string} | undefined;
      this.selectedId = first?.resolutionId ?? null;
    }
    if ( this.selectedId ) await globals.game.wildpath?.multiplayer?.coordinator?.answerForUsers?.(this.selectedId);
    await this.render();
  }

  static async #onSelect(this: WildPathRulesInspector, event: Event, target: HTMLElement) {
    this.selectedId = target.closest<HTMLElement>("[data-resolution-id]")?.dataset.resolutionId ?? null;
    await this.render();
  }
}

let inspector: WildPathRulesInspector | null = null;

/** Open the Inspector (GM only), on a resolution when one is named. */
export function openRulesInspector(resolutionId: string | null = null) {
  if ( !globals.game.user?.isGM ) return null;
  inspector ??= new WildPathRulesInspector();
  inspector.selectedId = resolutionId;
  void inspector.render({force: true});
  return inspector;
}

/** A GM sees an Inspect link on each resolution card. */
export function registerRulesInspector() {
  globals.Hooks.on("renderChatMessageHTML", (message, html) => {
    const resolutionId = message.flags?.wildpath?.resolutionId;
    const card = html?.querySelector?.(".resolution-card");
    if ( !globals.game.user?.isGM || !resolutionId || !card ) return;
    const link = document.createElement("button");
    link.type = "button";
    link.className = "wildpath-inspect";
    link.textContent = globals.game.i18n.localize("WILDPATH.INSPECTOR.Inspect");
    link.addEventListener("click", event => {
      event.preventDefault();
      openRulesInspector(resolutionId);
    });
    card.append(link);
  });
}

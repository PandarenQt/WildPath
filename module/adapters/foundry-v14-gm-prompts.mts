/**
 * The GM's decision card (`gmPrompt`, wave D A18; Q18.4 "prompt the GM to adjudicate"): an Action's follow-ups that the GM
 * decides, each an inline Action run at the GM's press. Once an Action with `gmPrompt: [{for, action}]` completes, the
 * active GM posts one card whispered to the GMs (`messageMode: "gm"`), its entries in `flags.wildpath.gmPrompt`:
 * `for: "failed"` gives one button per creature that failed the Action's save (an Earthquake fissure's "Falls in"),
 * `for: "picked"` one button acting on the pressing GM's own Foundry targets at the press (structures shaken, a
 * collapsing roof's creatures). A press routes like `report` (S6): the active GM runs it directly, another GM's client asks
 * it through the user query `wildpath.gmPrompt {messageId, entryId, targetIds}`, refused unless the server-attested
 * sender is a GM (Assistant GMs included, Q92 (f) default) and the card's author is a GM (a player can neither create a
 * message as a GM nor update one, so a GM-authored card's Actions are the system's own). The entry is claimed
 * (`used: true` written) before its Action runs, and released if it does not complete.
 *
 * An Action with `opens` that a lasting area ran (`parentArea`: an Earthquake's fissures, wave D A19) puts a `roll` entry
 * on the same card, pressed at once by the active GM: it rolls and lays out the openings as pending areas (the areas
 * adapter's rollOpenings) and adds an `open` entry, whose press brings them into effect (openOpenings). A roll whose die
 * is closed unrolled is released, so the GM can press it again.
 */

import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";
import {outcomeTargets} from "../helpers/forced-movement.mjs";
import {claimCard} from "../helpers/chat-card-view-model.mjs";
import {gmNotice} from "../helpers/gm-notice.mjs";

type Data = Record<string, unknown>;
export const GM_PROMPT_QUERY = "wildpath.gmPrompt";

/**
 * One button: its inline Action, on its creatures (`for: "failed"`) or on the pressing GM's targets (`for: "picked"`); or an
 * Action's openings, rolled and laid out (`for: "roll"`: `opens`, `parentArea`, `actionId`, `name`, `tags`) or opened
 * (`for: "open"`: `regionIds`, `definition`).
 */
export interface GmPromptEntry {id: string; for: "failed" | "picked" | "roll" | "open"; label: string; action?: Data; targets?: Data[] | null;
  used: boolean; [key: string]: unknown}
/** What a roll or Open entry runs (the areas adapter's rollOpenings and openOpenings): null when it did not complete. */
type Openings = Record<"roll" | "open", (entry: GmPromptEntry, card: GmPromptCard) => Promise<Data | null>>;
const OPENING_KINDS: readonly string[] = ["roll", "open"];
/** A card's flags (`flags.wildpath.gmPrompt`): whose Action ran them, and its entries. */
export interface GmPromptCard {sourceActorRef: string; sourceTokenId: string; sceneId: string; entries: GmPromptEntry[]}
interface PromptToken {id: string; name?: string; actor?: {uuid?: string} | null;
  parent?: {id: string; tokens?: {get(id: string): PromptToken | undefined}} | null}
interface PromptMessage {id: string; author?: {isGM?: boolean} | null; flags?: {wildpath?: {gmPrompt?: GmPromptCard}};
  update?(data: Data): Promise<unknown>}
interface PromptUser {id?: string; isGM?: boolean; targets?: Iterable<{id: string}>;
  query?(name: string, data: Data, options: Data): Promise<{ok?: boolean} | undefined>}
interface PromptGame {user?: PromptUser; users?: {activeGM?: PromptUser | null};
  i18n?: {format?(key: string, data: Data): string; localize?(key: string): string};
  messages?: {get(id: string): PromptMessage | undefined};
  scenes?: {get(id: string): {tokens?: {get(id: string): PromptToken | undefined}} | undefined}}

export function createFoundryGmPrompts({game, coordinator, resolveAction, logger=console, fromUuid=() => null, openings=null}: {
  game: PromptGame; coordinator: unknown; resolveAction: unknown; logger?: Pick<Console, "warn">;
  fromUuid?: (uuid: string) => Promise<unknown> | unknown; openings?: Openings | null;
}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
  const format = (key: string, data: Data) => game.i18n?.format?.(key, data) ?? key;
  let sequence = 0;

  /**
   * An Action with `gmPrompt` completed: the active GM posts its card, one entry per creature that failed its save for
   * each `failed` prompt (a creature whose Token is gone, a death's leaving Token, gets none) and one per `picked` prompt.
   * No card when no entry is left. Each entry's Action costs nothing: the GM's press is no use of its source's. A `fall`
   * with no feet falls as deep as the area that ran the Action (`parentArea`'s depth: a fissure's), filled in here, as the
   * press runs with no area of its own. With `opens`, its roll entry, pressed at once (the area that ran it, as it stood).
   */
  async function afterResolution({state, options}: {state?: Data; options?: {parentArea?: Data & {depth?: number} | null}}) {
    const definition = state?.actionDefinition as {id?: string; label?: string; tags?: string[]; save?: unknown;
      gmPrompt?: Array<{for?: string; action?: Data}>; opens?: {label?: string}} | undefined;
    if ( !state || !(definition?.gmPrompt?.length || definition?.opens) || !isActiveGM() ) return null;
    const parentArea = options?.parentArea ?? null;
    if ( definition.opens && !parentArea ) gmNotice("WILDPATH.NOTICE.OpensNoArea", {name: String(definition.label ?? "")}, undefined, {logger});
    const source = await fromUuid(String((state.source as Data | undefined)?.tokenRef ?? "")) as PromptToken | null;
    const scene = source?.parent;
    if ( !scene || !source?.actor?.uuid ) {
      gmNotice("WILDPATH.NOTICE.GmPromptNoToken", {}, undefined, {logger});
      return null;
    }
    const entries: GmPromptEntry[] = [];
    const depth = Number(parentArea?.depth) || 0;
    (definition.gmPrompt ?? []).forEach((prompt, index) => {
      const fall = prompt.action?.fall as {feet?: unknown} | undefined;
      const action: Data = {...prompt.action, costs: {allOf: []}, ...((fall && (fall.feet == null) && depth) ? {fall: {...fall, feet: depth}} : {})};
      const name = String(action.label ?? action.id ?? "");
      if ( prompt.for === "picked" ) {
        entries.push({id: String(index), for: "picked", label: format("WILDPATH.GMPROMPT.Picked", {action: name}), action, targets: null, used: false});
        return;
      }
      for ( const target of outcomeTargets(state, definition, "failure") ) {
        const token = scene.tokens?.get(String(target?.tokenId ?? ""));
        if ( !token?.actor?.uuid ) continue;
        entries.push({id: `${index}-${token.id}`, for: "failed", label: format("WILDPATH.GMPROMPT.Failed", {action: name, name: token.name ?? ""}),
          action, targets: [{actorRef: token.actor.uuid, tokenId: token.id, sceneId: scene.id}], used: false});
      }
    });
    if ( definition.opens && parentArea ) {
      const name = String(definition.opens.label ?? definition.label ?? definition.id ?? "");
      entries.push({id: "opens", for: "roll", label: format("WILDPATH.OPENS.Roll", {label: name}), opens: definition.opens, parentArea,
        actionId: String(definition.id ?? ""), name, tags: definition.tags ?? null, used: false});
    }
    if ( !entries.length ) return null;
    const {ChatMessage, foundry} = globalThis as unknown as {ChatMessage: {create(data: Data, options: Data): Promise<PromptMessage | undefined>;
      getSpeaker(data: Data): unknown}; foundry: {utils: {escapeHTML(text: string): string}}};
    const card: GmPromptCard = {sourceActorRef: source.actor.uuid, sourceTokenId: source.id, sceneId: scene.id, entries};
    const message = await ChatMessage.create({speaker: ChatMessage.getSpeaker({token: source}),
      content: `<p>${foundry.utils.escapeHTML(format("WILDPATH.GMPROMPT.Card", {action: String(definition.label ?? "")}))}</p>`,
      flags: {wildpath: {gmPrompt: card}}}, {messageMode: "gm"});
    // The roll needs no decision, so it is pressed now, unawaited (a physical-dice prompt never holds the turn).
    if ( message ) for ( const entry of entries.filter(each => each.for === "roll") ) {
      void press({messageId: message.id, entryId: entry.id}, game.user).catch(error => logger.warn("Wild Path | The openings could not be rolled", error));
    }
    return message;
  }

  let writes: Promise<unknown> = Promise.resolve();
  /**
   * Write an entry's `used` (its whole list: Foundry replaces an array it updates). Writes go one at a time, each reading
   * the list the last one left, so a run's release cannot overwrite another entry's claim still on its way (claimCard
   * keeps claims apart, but a release comes later, outside it). `added`: entries the run brought (a roll's Open entry).
   */
  function markUsed(message: PromptMessage, entryId: string, used: boolean, added: GmPromptEntry[] = []) {
    const write = writes.then(() => {
      const entries = message.flags?.wildpath?.gmPrompt?.entries ?? [];
      return message.update?.({"flags.wildpath.gmPrompt.entries": [...entries.map(entry => (entry.id === entryId ? {...entry, used} : entry)),
        ...added]});
    });
    writes = write.catch(() => null);
    return write;
  }

  /**
   * The active GM's press of `entryId` on card `messageId` for `user` (a GM): claimed first (`used: true`), then its Action
   * runs unawaited, as a press waits on saves and prompts far longer than a query lives, and the claim is released unless
   * it completed. A `picked` entry acts on `targetIds`, the presser's targets, those on the card's Scene. `{ok}`.
   */
  async function press({messageId, entryId, targetIds=[]}: {messageId?: unknown; entryId?: unknown; targetIds?: unknown},
    user: PromptUser | null | undefined) {
    const message = game.messages?.get(String(messageId));
    const card = message?.flags?.wildpath?.gmPrompt;
    if ( !user?.isGM || !isActiveGM() || !message?.author?.isGM || !card ) return {ok: false};
    const claimed = await claimCard(message, async () => {
      // Read again inside the claim: a press just before this one may have used it.
      const entry = (message.flags?.wildpath?.gmPrompt?.entries ?? []).find(each => each.id === String(entryId));
      if ( !entry || entry.used ) return null;
      const scene = game.scenes?.get(card.sceneId);
      const targets = (entry.for === "picked")
        ? (Array.isArray(targetIds) ? targetIds : []).map(id => scene?.tokens?.get(String(id))).filter(token => token?.actor?.uuid)
          .map(token => ({actorRef: token!.actor!.uuid, tokenId: token!.id, sceneId: card.sceneId}))
        : entry.targets ?? [];
      if ( !targets.length && !OPENING_KINDS.includes(entry.for) ) return null;
      await markUsed(message, entry.id, true);
      return {entry, targets};
    });
    if ( !claimed ) return {ok: false};
    void run(message, card, claimed.entry, claimed.targets)
      .catch(error => logger.warn("Wild Path | The GM's choice could not be run", error));
    return {ok: true};
  }

  async function run(message: PromptMessage, card: GmPromptCard, entry: GmPromptEntry, targets: Data[]) {
    if ( OPENING_KINDS.includes(entry.for) ) return runOpenings(message, card, entry);
    let state: {status?: string} | null = null;
    try {
      state = await runAuthorityAction({coordinator: coordinator as never, resolveAction: resolveAction as never, logger,
        senderUserId: String(game.user?.id), resolutionId: `gmPrompt:${message.id}:${entry.id}:${++sequence}`,
        definition: entry.action ?? {}, label: entry.label, actorRef: card.sourceActorRef,
        source: {tokenId: card.sourceTokenId, sceneId: card.sceneId}, targets}) as {status?: string} | null;
    } finally {
      // Not run (its source or target gone), failed or cancelled: the button works again.
      if ( state?.status !== "completed" ) await markUsed(message, entry.id, false);
    }
    return state;
  }

  /**
   * A roll or Open entry's run (openings): released unless it completed. A completed roll adds the Open entry, naming the
   * openings it laid out, how many of the count rolled and their depths.
   */
  async function runOpenings(message: PromptMessage, card: GmPromptCard, entry: GmPromptEntry) {
    let result: Data | null = null;
    try {
      result = await openings?.[entry.for as "roll" | "open"]?.(entry, card) ?? null;
    } finally {
      const laid = (entry.for === "roll") && result ? result as {regionIds: string[]; definition: Data; count: number; depths: number[]} : null;
      // None laid (the GM is told): the roll stays used, with nothing to open.
      const opened: GmPromptEntry[] = laid?.regionIds.length ? [{id: `${entry.id}-open`, for: "open", label: format("WILDPATH.OPENS.Open",
        {label: String(entry.name ?? ""), placed: String(laid.regionIds.length), count: String(laid.count), depths: laid.depths.join(", ")}),
        regionIds: laid.regionIds, definition: laid.definition, used: false}] : [];
      if ( !result || opened.length ) await markUsed(message, entry.id, Boolean(result), opened);
    }
    return result;
  }

  /** The active GM's query handler: a press from another GM's client (press checks the sender). */
  function handleQuery(data: Data = {}, {user=null}: {user?: PromptUser | null} = {}) {
    return press(data, user);
  }

  /**
   * The card's buttons, for a GM only and only on a card a GM wrote (a player's copy with the same flags gets none); a
   * used entry's is disabled. A `picked` press with no targets warns and sends nothing.
   */
  function onRender(message: PromptMessage, html: {querySelector?(selector: string): {append(node: unknown): void} | null;
    append(node: unknown): void}) {
    const card = message.flags?.wildpath?.gmPrompt;
    if ( !card || !game.user?.isGM || !message.author?.isGM ) return;
    const {document, ui} = globalThis as unknown as {document: {createElement(tag: string): {type: string; className: string;
      textContent: string; title: string; disabled: boolean; addEventListener(type: string, listener: () => unknown): void}};
      ui?: {notifications?: {warn?(text: string): void}}};
    const box = html.querySelector?.(".message-content") ?? html;
    for ( const entry of card.entries ?? [] ) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wildpath-gm-prompt";
      button.textContent = entry.label;
      button.disabled = Boolean(entry.used);
      if ( entry.used ) button.title = game.i18n?.localize?.("WILDPATH.GMPROMPT.Used") ?? "WILDPATH.GMPROMPT.Used";
      else if ( entry.for === "open" ) button.title = game.i18n?.localize?.("WILDPATH.OPENS.OpenHint") ?? "WILDPATH.OPENS.OpenHint";
      button.addEventListener("click", async () => {
        const targetIds = (entry.for === "picked") ? [...(game.user?.targets ?? [])].map(token => token.id) : [];
        if ( (entry.for === "picked") && !targetIds.length ) {
          ui?.notifications?.warn?.(format("WILDPATH.GMPROMPT.NoTargets", {label: entry.label}));
          return;
        }
        button.disabled = true;
        const data = {messageId: message.id, entryId: entry.id, targetIds};
        const result = isActiveGM() ? await press(data, game.user)
          : await game.users?.activeGM?.query?.(GM_PROMPT_QUERY, data, {timeout: 15000}).catch(() => ({ok: false}));
        if ( !result?.ok ) button.disabled = false;
      });
      box.append(button);
    }
  }

  return {afterResolution, press, handleQuery, onRender};
}

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
 */

import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";
import {outcomeTargets} from "../helpers/forced-movement.mjs";
import {claimCard} from "../helpers/chat-card-view-model.mjs";
import {gmNotice} from "../helpers/gm-notice.mjs";

type Data = Record<string, unknown>;
export const GM_PROMPT_QUERY = "wildpath.gmPrompt";

/** One button: its inline Action, on its creatures (`for: "failed"`) or on the pressing GM's targets (`for: "picked"`). */
export interface GmPromptEntry {id: string; for: "failed" | "picked"; label: string; action: Data; targets: Data[] | null; used: boolean}
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

export function createFoundryGmPrompts({game, coordinator, resolveAction, logger=console, fromUuid=() => null}: {
  game: PromptGame; coordinator: unknown; resolveAction: unknown; logger?: Pick<Console, "warn">;
  fromUuid?: (uuid: string) => Promise<unknown> | unknown;
}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
  const format = (key: string, data: Data) => game.i18n?.format?.(key, data) ?? key;
  let sequence = 0;

  /**
   * An Action with `gmPrompt` completed: the active GM posts its card, one entry per creature that failed its save for
   * each `failed` prompt (a creature whose Token is gone, a death's leaving Token, gets none) and one per `picked` prompt.
   * No card when no entry is left. Each entry's Action costs nothing: the GM's press is no use of its source's.
   */
  async function afterResolution({state}: {state?: Data}) {
    const definition = state?.actionDefinition as {label?: string; save?: unknown; gmPrompt?: Array<{for?: string; action?: Data}>} | undefined;
    if ( !state || !definition?.gmPrompt?.length || !isActiveGM() ) return null;
    const source = await fromUuid(String((state.source as Data | undefined)?.tokenRef ?? "")) as PromptToken | null;
    const scene = source?.parent;
    if ( !scene || !source?.actor?.uuid ) {
      gmNotice("WILDPATH.NOTICE.GmPromptNoToken", {}, undefined, {logger});
      return null;
    }
    const entries: GmPromptEntry[] = [];
    definition.gmPrompt.forEach((prompt, index) => {
      const action: Data = {...prompt.action, costs: {allOf: []}};
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
    if ( !entries.length ) return null;
    const {ChatMessage, foundry} = globalThis as unknown as {ChatMessage: {create(data: Data, options: Data): Promise<unknown>;
      getSpeaker(data: Data): unknown}; foundry: {utils: {escapeHTML(text: string): string}}};
    const card: GmPromptCard = {sourceActorRef: source.actor.uuid, sourceTokenId: source.id, sceneId: scene.id, entries};
    return ChatMessage.create({speaker: ChatMessage.getSpeaker({token: source}),
      content: `<p>${foundry.utils.escapeHTML(format("WILDPATH.GMPROMPT.Card", {action: String(definition.label ?? "")}))}</p>`,
      flags: {wildpath: {gmPrompt: card}}}, {messageMode: "gm"});
  }

  let writes: Promise<unknown> = Promise.resolve();
  /**
   * Write an entry's `used` (its whole list: Foundry replaces an array it updates). Writes go one at a time, each reading
   * the list the last one left, so a run's release cannot overwrite another entry's claim still on its way (claimCard
   * keeps claims apart, but a release comes later, outside it).
   */
  function markUsed(message: PromptMessage, entryId: string, used: boolean) {
    const write = writes.then(() => {
      const entries = message.flags?.wildpath?.gmPrompt?.entries ?? [];
      return message.update?.({"flags.wildpath.gmPrompt.entries": entries.map(entry => (entry.id === entryId ? {...entry, used} : entry))});
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
      if ( !targets.length ) return null;
      await markUsed(message, entry.id, true);
      return {entry, targets};
    });
    if ( !claimed ) return {ok: false};
    void run(message, card, claimed.entry, claimed.targets)
      .catch(error => logger.warn("Wild Path | The GM's choice could not be run", error));
    return {ok: true};
  }

  async function run(message: PromptMessage, card: GmPromptCard, entry: GmPromptEntry, targets: Data[]) {
    let state: {status?: string} | null = null;
    try {
      state = await runAuthorityAction({coordinator: coordinator as never, resolveAction: resolveAction as never, logger,
        senderUserId: String(game.user?.id), resolutionId: `gmPrompt:${message.id}:${entry.id}:${++sequence}`,
        definition: entry.action, label: entry.label, actorRef: card.sourceActorRef,
        source: {tokenId: card.sourceTokenId, sceneId: card.sceneId}, targets}) as {status?: string} | null;
    } finally {
      // Not run (its source or target gone), failed or cancelled: the button works again.
      if ( state?.status !== "completed" ) await markUsed(message, entry.id, false);
    }
    return state;
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

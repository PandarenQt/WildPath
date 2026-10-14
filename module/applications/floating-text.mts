/**
 * Floating combat text (after Baldur's Gate 3): what happens to a creature rises over its Tokens on every client
 * that can see them. Health changes come from the Actor update itself (`floatHealthChange`); an Action's outcomes
 * (Miss, Critical hit, Saved) come from its chat card's `flags.wildpath.floating`, on clients that can see the card.
 */

interface TokenObject {center: {x: number; y: number}; h: number; visible: boolean; document: {isSecret?: boolean}}
/** An Actor (each of its Tokens) or a TokenDocument (its own Token): what a card names its targets by. */
interface FloatingActor {getActiveTokens?(linked?: boolean): TokenObject[]; object?: TokenObject | null}
interface FloatingMessage {visible?: boolean; blind?: boolean; flags?: {wildpath?: {floating?: Array<{uuid?: string; label?: string}>}}}
interface Globals {
  canvas?: {ready?: boolean; interface?: {createScrollingText(origin: {x: number; y: number}, text: string, options: object): Promise<void>}};
  CONST: {TEXT_ANCHOR_POINTS: {CENTER: number; TOP: number; BOTTOM: number}};
  game: {user?: {isGM?: boolean}; i18n: {localize(key: string): string}};
  fromUuidSync(uuid: string): unknown;
  Hooks: {on(name: string, callback: (...args: unknown[]) => unknown): number};
}
const globals = globalThis as unknown as Globals;

/** Colours by kind: damage, healing, a miss, a critical hit and a saved roll. */
const FILLS = {damage: 0xdd3333, healing: 0x33cc66, miss: 0xdddddd, critical: 0xffcc33, saved: 0x66aaff};
const KIND_OF_LABEL: Record<string, keyof typeof FILLS> = {
  "WILDPATH.CHAT.Outcome.Miss": "miss", "WILDPATH.CHAT.Outcome.Critical": "critical", "WILDPATH.CHAT.Outcome.SaveSuccess": "saved"
};

/** Raise `text` over each of `actor`'s visible Tokens on this client's canvas. */
export function floatText(actor: FloatingActor | null | undefined, text: string, kind: keyof typeof FILLS) {
  const layer = globals.canvas?.ready ? globals.canvas.interface : null;
  if ( !layer || !actor ) return;
  for ( const token of actor.getActiveTokens?.(true) ?? (actor.object ? [actor.object] : []) ) {
    if ( !token.visible || token.document.isSecret ) continue;
    void layer.createScrollingText(token.center, text, {anchor: globals.CONST.TEXT_ANCHOR_POINTS.CENTER,
      direction: globals.CONST.TEXT_ANCHOR_POINTS.TOP, distance: 2 * token.h, fontSize: 32, fill: FILLS[kind],
      stroke: 0x000000, strokeThickness: 4, jitter: 0.25});
  }
}

/** A change in health, signed: "−8" in red, "+3" in green. */
export function floatHealthChange(actor: FloatingActor, change: number) {
  if ( !Number.isFinite(change) || !change ) return;
  floatText(actor, change > 0 ? `+${change}` : `−${Math.abs(change)}`, change > 0 ? "healing" : "damage");
}

/** Each Action card's floating outcomes, on the clients that may see the card (never a blind roll's). */
export function registerFloatingText() {
  globals.Hooks.on("createChatMessage", (message: unknown) => {
    const card = message as FloatingMessage;
    if ( !card.visible || (card.blind && !globals.game.user?.isGM) ) return;
    for ( const {uuid, label} of card.flags?.wildpath?.floating ?? [] ) {
      const kind = KIND_OF_LABEL[label ?? ""];
      if ( uuid && kind ) floatText(globals.fromUuidSync(uuid) as FloatingActor | null, globals.game.i18n.localize(label!), kind);
    }
  });
}

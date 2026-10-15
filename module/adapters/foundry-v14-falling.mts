import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";

/**
 * Falling (2024, G6): a creature above the floor of its Level that gets Prone, or a condition that takes its Speed to
 * 0, falls unless it can hover (a `GrantMovement` with `hover`). The active GM drops its Token to the floor as forced
 * movement, then resolves the fall as an authority Action: 1d6 Bludgeoning per 10 feet fallen (20d6 at most), and Prone.
 */

type Data = Record<string, unknown>;
interface FallToken {
  id: string; elevation?: number; level?: string | null;
  parent?: {id: string; levels?: {get(id: string): {elevation?: {bottom?: number | null}} | undefined}} | null;
  update(data: Data, operation?: Data): Promise<unknown>;
}
interface FallActor {
  uuid: string; isToken?: boolean; token?: FallToken | null;
  getActiveTokens?(linked?: boolean, document?: boolean): FallToken[];
  getGrantedMovement?(): Array<{hover?: boolean}>;
}

/** Conditions that make a flying creature fall: Prone, and those that take its Speed to 0. */
export const FALLING_CONDITIONS = Object.freeze(["prone", "grappled", "restrained", "paralyzed", "petrified", "stunned", "unconscious"]);

/** How a fall from `height` feet hurts: `{dice}` d6s (one per full 10 feet, 20 at most). */
export function fallDamageDice(height: number) {
  return Math.min(20, Math.floor(Math.max(Number(height) || 0, 0) / 10));
}

export function createFoundryFalling({game, coordinator, resolveAction, logger=console}: {
  game: {users?: {activeGM?: {id?: string} | null}; user?: {id?: string}; i18n?: {localize?(key: string): string}};
  coordinator: unknown; resolveAction: unknown; logger?: Pick<Console, "warn">;
}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
  let sequence = 0;

  /** A condition (an ActiveEffect with statuses) arrived on a creature: each of its Tokens in the air may fall. */
  async function onEffectCreated(effect: {parent?: unknown; statuses?: Iterable<string>}) {
    if ( !isActiveGM() || ![...(effect.statuses ?? [])].some(status => FALLING_CONDITIONS.includes(status)) ) return [];
    const actor = effect.parent as FallActor | null;
    if ( !actor?.uuid ) return [];
    const tokens = actor.isToken ? [actor.token].filter(Boolean) as FallToken[] : (actor.getActiveTokens?.(false, true) ?? []);
    const fallen = [];
    for ( const token of tokens ) if ( await fall(actor, token) ) fallen.push(token);
    return fallen;
  }

  /** Drop `token` to its Level's floor and resolve the fall; false when it is on the floor or can hover. */
  async function fall(actor: FallActor, token: FallToken) {
    const floor = Number(token.parent?.levels?.get(String(token.level))?.elevation?.bottom) || 0;
    const height = (Number(token.elevation) || 0) - floor;
    if ( (height <= 0) || (actor.getGrantedMovement?.() ?? []).some(movement => movement.hover) ) return false;
    await token.update({elevation: floor}, {wildpath: {movementKind: "forced"}});
    const dice = fallDamageDice(height);
    if ( !dice || !token.parent ) return true;
    const label = game.i18n?.localize?.("WILDPATH.FALLING.Fall") ?? "Falling";
    const self = {actorRef: actor.uuid, tokenId: token.id, sceneId: token.parent.id};
    // shortcut: the fall's Prone comes with its damage even when the creature takes none (immunity); 2024 spares it.
    await runAuthorityAction({coordinator: coordinator as never, resolveAction: resolveAction as never, logger,
      senderUserId: String(game.user?.id), resolutionId: `fall:${actor.uuid}:${++sequence}`, label, actorRef: actor.uuid,
      source: {tokenId: token.id, sceneId: token.parent.id}, target: self,
      definition: {schemaVersion: 1, id: "action:fall", label, costs: {allOf: []}, tags: ["fall"],
        damage: [{id: "fall", expression: {type: "dice", number: dice, faces: 6}, damageType: "bludgeoning"}],
        effects: [{id: "fall-prone", type: "condition", conditionId: "prone"}]}});
    return true;
  }

  return {onEffectCreated, fall};
}

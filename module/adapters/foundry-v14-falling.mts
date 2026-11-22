import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";
import {creatureTokens} from "./foundry-v14-creature-tokens.mjs";
import {rolledTargets} from "../helpers/forced-movement.mjs";
import {gmNotice} from "../helpers/gm-notice.mjs";

/**
 * Falling (2024, G6): a creature above the floor of its Level that gets Prone, or a condition that takes its Speed to
 * 0, falls unless it can hover (a `GrantMovement` with `hover`). The active GM drops its Token to the floor as forced
 * movement, then resolves the fall as an authority Action: 1d6 Bludgeoning per 10 feet fallen (20d6 at most), and Prone.
 * An Action with `fall: {feet}` drops the creatures it acts on into an opening below them (an Earthquake's fissure, a
 * pit) the same way (afterResolution).
 */

type Data = Record<string, unknown>;
interface FallToken {
  id: string; elevation?: number; level?: string | null;
  parent?: {id: string; levels?: {get(id: string): {elevation?: {bottom?: number | null}} | undefined}} | null;
  update(data: Data, operation?: Data): Promise<unknown>;
}
interface FallActor {
  uuid: string; isToken?: boolean; token?: FallToken | null;
  getDependentTokens?(options: {linked?: boolean; concreteOnly?: boolean}): FallToken[];
  getGrantedMovement?(): Array<{hover?: boolean}>;
}

/** Conditions that make a flying creature fall: Prone, and those that take its Speed to 0. */
export const FALLING_CONDITIONS = Object.freeze(["prone", "grappled", "restrained", "paralyzed", "petrified", "stunned", "unconscious"]);

/** The elevation of the floor of `token`'s Level (0 without Levels): the ground it falls to. */
function floorOf(token: FallToken) {
  return Number(token.parent?.levels?.get(String(token.level))?.elevation?.bottom) || 0;
}

/** How a fall from `height` feet hurts: `{dice}` d6s (one per full 10 feet, 20 at most). */
export function fallDamageDice(height: number) {
  return Math.min(20, Math.floor(Math.max(Number(height) || 0, 0) / 10));
}

export function createFoundryFalling({game, coordinator, resolveAction, logger=console, fromUuid=() => null}: {
  game: {users?: {activeGM?: {id?: string} | null}; user?: {id?: string}; i18n?: {localize?(key: string): string}};
  coordinator: unknown; resolveAction: unknown; logger?: Pick<Console, "warn">;
  fromUuid?: (uuid: string) => Promise<unknown> | unknown;
}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
  let sequence = 0;

  /** A condition (an ActiveEffect with statuses) arrived on a creature: each of its Tokens in the air may fall. */
  async function onEffectCreated(effect: {parent?: unknown; statuses?: Iterable<string>}) {
    if ( !isActiveGM() || ![...(effect.statuses ?? [])].some(status => FALLING_CONDITIONS.includes(status)) ) return [];
    const actor = effect.parent as FallActor | null;
    if ( !actor?.uuid ) return [];
    const tokens = creatureTokens(actor);
    const fallen = [];
    for ( const token of tokens ) if ( await fall(actor, token) ) fallen.push(token);
    return fallen;
  }

  /** Drop `token` to its Level's floor and resolve the fall; false when it is on the floor or can hover. */
  async function fall(actor: FallActor, token: FallToken) {
    const floor = floorOf(token);
    const height = (Number(token.elevation) || 0) - floor;
    if ( (height <= 0) || (actor.getGrantedMovement?.() ?? []).some(movement => movement.hover) ) return false;
    await token.update({elevation: floor}, {wildpath: {movementKind: "forced"}});
    await resolveFall(actor, token, height);
    return true;
  }

  /**
   * What a fall of `height` feet does to `actor`, whose Token has already come down: its damage and Prone, as an
   * authority Action (none under 10 feet). The Action's state, or null when nothing was rolled.
   */
  async function resolveFall(actor: Pick<FallActor, "uuid">, token: FallToken, height: number) {
    const dice = fallDamageDice(height);
    if ( !dice || !token.parent ) return null;
    const label = game.i18n?.localize?.("WILDPATH.FALLING.Fall") ?? "Falling";
    const self = {actorRef: actor.uuid, tokenId: token.id, sceneId: token.parent.id};
    // 2024: Prone, "unless it avoids taking damage from the fall" (immunity, a reaction that cancels it).
    return runAuthorityAction({coordinator: coordinator as never, resolveAction: resolveAction as never, logger,
      senderUserId: String(game.user?.id), resolutionId: `fall:${actor.uuid}:${++sequence}`, label, actorRef: actor.uuid,
      source: {tokenId: token.id, sceneId: token.parent.id}, target: self,
      definition: {schemaVersion: 1, id: "action:fall", label, costs: {allOf: []}, tags: ["fall"],
        damage: [{id: "fall", expression: {type: "dice", number: dice, faces: 6}, damageType: "bludgeoning"}],
        effects: [{id: "fall-prone", type: "condition", conditionId: "prone", whenDamaged: true}]}});
  }

  /**
   * An Action with `fall: {feet}` completed: each creature it acts on (`rolledTargets`: with a save, each that failed it;
   * with an attack, each it hit) drops into an opening `feet` deep in its Level's floor (or below where it stands, when
   * that is lower: one already in a pit), as forced movement, and takes that fall (resolveFall). One above the floor
   * falls through the air into it too, so it lands below the floor once, and the Prone it lands with does not drop it
   * again (onEffectCreated). With no `feet`, the opening is as deep as the area that ran the Action (`parentArea`'s
   * `depth`: a fissure's own trigger), and nothing falls when that area has none. The Tokens that fell.
   */
  async function afterResolution({state, options}: {state?: Data; options?: {parentArea?: {depth?: number} | null}}) {
    const definition = state?.actionDefinition as {fall?: {feet?: unknown}; save?: unknown; attack?: unknown} | undefined;
    const feet = Number(definition?.fall?.feet ?? options?.parentArea?.depth) || 0;
    if ( !state || !definition?.fall || (feet <= 0) || !isActiveGM() ) return [];
    const source = await fromUuid(String((state.source as Data | undefined)?.tokenRef ?? "")) as FallToken | null;
    // The creatures it acts on are on its source's Scene, as a push's are.
    const scene = source?.parent as unknown as {tokens: {get(id: string): (FallToken & {actor?: FallActor | null}) | undefined}} | null | undefined;
    if ( !scene ) {
      gmNotice("WILDPATH.NOTICE.FallNoToken", {}, undefined, {logger});
      return [];
    }
    const fallen = [];
    for ( const target of rolledTargets(state, definition) ) {
      const token = scene.tokens.get(String(target?.tokenId ?? ""));
      if ( !token?.actor?.uuid ) continue;
      const elevation = Number(token.elevation) || 0;
      const bottom = Math.min(elevation, floorOf(token)) - feet;
      await token.update({elevation: bottom}, {wildpath: {movementKind: "forced"}});
      await resolveFall(token.actor, token, elevation - bottom);
      fallen.push(token);
    }
    return fallen;
  }

  return {onEffectCreated, fall, resolveFall, afterResolution};
}

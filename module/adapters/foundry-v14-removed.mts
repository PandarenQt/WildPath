/**
 * Removed from the scene while a status lasts (a status config's `removes: true`: Trapped in a Mirror of Life Trapping).
 * The active GM hides its creature's Tokens and their Combatants, keeping each one's own `hidden` in
 * `flags.wildpath.removed`, and gives it back once none of its statuses removes it. Level-triggered from its statuses, as
 * the token-size adapter is, so two such effects keep it hidden until the last one ends. It reappears beside the creature
 * that gave the effect that ended when that effect's row says `metadata.returns: "source"`, else where it was, or beside
 * that spot when another creature stands there now. Its separation from everyone else is its status's `plane` (planeOf).
 */
import {WILDPATH} from "../config.mjs";
import {effectGiverActor} from "../helpers/effect-sources.mjs";
import {combatantOf, creatureTokens} from "./foundry-v14-creature-tokens.mjs";
import {blink, freeLanding, spaceBeside, type TeleportToken} from "./foundry-v14-teleport.mjs";
import {sceneCollision} from "./foundry-v14-walls.mjs";

interface Marked {
  hidden?: boolean; flags?: {wildpath?: {removed?: {hidden?: boolean} | null}};
  update(data: Record<string, unknown>, operation?: Record<string, unknown>): Promise<unknown>;
}
type RemovableToken = TeleportToken & Marked;
interface RemovableActor {statuses?: Iterable<string> | null; isToken?: boolean; token?: RemovableToken | null;
  getDependentTokens?(options: {linked?: boolean; concreteOnly?: boolean}): RemovableToken[]}
interface RemovingEffect {parent?: unknown; flags?: {wildpath?: {conditionEffect?: {metadata?: {returns?: unknown}}}}}
type RemovedCombatant = Marked & {tokenId?: string | null; sceneId?: string | null};
interface RemovedGame {users?: {activeGM?: {id?: string} | null}; user?: {id?: string};
  combats?: Iterable<{combatants?: Iterable<RemovedCombatant> | null}> | null}

/** Whether one of `actor`'s statuses removes it from the scene (`removes: true` in WILDPATH.CONDITIONS). */
export function removedFromScene(actor: {statuses?: Iterable<string> | null} | null | undefined): boolean {
  const conditions = (WILDPATH as {CONDITIONS?: Record<string, {removes?: boolean} | undefined>}).CONDITIONS ?? {};
  return [...(actor?.statuses ?? [])].some(status => conditions[status]?.removes === true);
}

export function createFoundryRemoved({game, fromUuidSync=(globalThis as {fromUuidSync?: unknown}).fromUuidSync}:
  {game: RemovedGame; fromUuidSync?: unknown}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
  /** The Token and each of its Combatants, in any combat. */
  const withCombatants = (token: RemovableToken): Marked[] => [token, ...[...(game.combats ?? [])]
    .map(combat => combatantOf(token, combat)).filter((entry): entry is RemovedCombatant => Boolean(entry))];

  /** Where `token` reappears as `effect` ends, its top-left there; null to stay where it is. */
  function landing(token: RemovableToken, effect: RemovingEffect) {
    const scene = token.parent;
    if ( effect.flags?.wildpath?.conditionEffect?.metadata?.returns === "source" ) {
      const giver = (effectGiverActor as (effect: unknown, fromUuidSync: unknown, game: unknown) => RemovableActor | null)(effect, fromUuidSync, game);
      const source = creatureTokens(giver).find(other => other.parent?.id === scene?.id);
      if ( source ) {
        // On its source's side of any wall (a mirror hung on one), not behind it.
        const collides = sceneCollision(scene as never);
        const from = source.getCenterPoint();
        const beside = spaceBeside(token, source, position => !collides(from, token.getCenterPoint(position), {type: "move"}));
        if ( beside ) return beside;
      }
    }
    // shortcut: spaceBeside searches one ring, so with that ring full it stays on the creature standing there; upgrade to a
    // second ring if play shows it.
    return freeLanding(token, {x: token.x, y: token.y}).ok ? null : spaceBeside(token, token);
  }

  /** An effect on a creature arrived, changed or ended: its Tokens are hidden while a status removes it, back after. */
  async function onEffectChanged(effect: RemovingEffect) {
    const actor = effect.parent as RemovableActor | null;
    if ( !isActiveGM() || !actor?.statuses ) return;
    const removed = removedFromScene(actor);
    for ( const token of creatureTokens(actor) ) {
      const marked = Boolean(token.flags?.wildpath?.removed);
      if ( removed && !marked ) {
        for ( const document of withCombatants(token) ) {
          if ( !document.flags?.wildpath?.removed ) await document.update({hidden: true, "flags.wildpath.removed": {hidden: Boolean(document.hidden)}});
        }
      } else if ( !removed && marked ) {
        // Moved before it is unmarked, so an area it reappears in can tell this from a walk in.
        const point = landing(token, effect);
        if ( point ) await blink(token, point);
        // A Combatant added while it was hidden copied the Token's hidden with no marker: it gets the Token's own back.
        const tokenBefore = token.flags?.wildpath?.removed;
        for ( const document of withCombatants(token) ) {
          const before = document.flags?.wildpath?.removed ?? tokenBefore;
          if ( before ) await document.update({hidden: Boolean(before.hidden), "flags.wildpath.removed": null});
        }
      }
    }
  }

  return {onEffectChanged};
}

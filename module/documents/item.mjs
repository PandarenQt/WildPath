import {buildFoundryActionUseIntent} from "../resolvers/foundry-multiplayer-runtime.mjs";

/**
 * The Item document subclass for the WildPath system.
 */
export default class WildPathItem extends Item {

  /**
   * If this is an "action" Item owned by an Actor, declare an Action intent through the
   * authoritative multiplayer runtime. This is the canonical player-facing execution path -
   * it does not calculate rules itself, it only requests resolution (see `game.wildpath`,
   * registered by `registerFoundryV14MultiplayerResolution`).
   * @returns {Promise<boolean>}
   */
  async use() {
    if ( (this.type !== "action") || !this.actor ) return false;
    const runtime = globalThis.game?.wildpath;
    if ( typeof runtime?.executeActionIntent !== "function" ) {
      console.warn("Wild Path | Multiplayer action runtime is not registered; unable to use this Action.");
      return false;
    }
    const built = buildFoundryActionUseIntent({actor: this.actor, action: this});
    if ( !built.ok ) {
      globalThis.ui?.notifications?.warn?.(built.reason ?? `Unable to use ${this.name}.`);
      return false;
    }
    const declared = await runtime.executeActionIntent(built.intent);
    if ( !declared.ok ) {
      globalThis.ui?.notifications?.warn?.(declared.reason ?? `Unable to use ${this.name}.`);
    }
    return declared.ok === true;
  }
}

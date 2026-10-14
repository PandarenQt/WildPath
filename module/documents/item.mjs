import {buildFoundryActionUseIntent} from "../resolvers/foundry-multiplayer-runtime.mjs";
import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {placeFoundryArea} from "../applications/area-placement.mjs";
import {areaClickCount} from "../adapters/foundry-v14-area-placement.mjs";

/**
 * The Item document subclass for the WildPath system.
 */
export default class WildPathItem extends Item {

  /** A granted resource needs its pool on the Actor (`GrantResource`); the user who made the change stores it. */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if ( userId === game.user.id ) void this.actor?.ensureGrantedPools?.();
  }

  _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if ( (userId === game.user.id) && ("system" in changed) ) void this.actor?.ensureGrantedPools?.();
  }

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
    // An area is placed on the canvas first; the authority derives its fields and targets from these clicks.
    const definition = actionDefinitionFromAction(this, {actorSystem: this.actor.system});
    if ( definition.ok && (definition.definition?.targeting?.type === "area") ) {
      const sourceToken = this.actor.token ?? this.actor.getActiveTokens?.(false, true)?.[0] ?? null;
      if ( !sourceToken || !globalThis.canvas?.ready ) {
        globalThis.ui?.notifications?.warn?.(globalThis.game.i18n.localize("WILDPATH.AREA.NoToken"));
        return false;
      }
      const area = areaClickCount(definition.definition) ? await placeFoundryArea({definition: definition.definition, sourceToken})
        : {points: []};
      if ( !area ) return false;
      built.intent.area = area;
      built.intent.source = {tokenId: sourceToken.id, tokenRef: sourceToken.uuid, sceneId: sourceToken.parent?.id ?? null};
    }
    const declared = await runtime.executeActionIntent(built.intent);
    if ( !declared.ok ) {
      globalThis.ui?.notifications?.warn?.(declared.reason ?? `Unable to use ${this.name}.`);
    }
    return declared.ok === true;
  }
}

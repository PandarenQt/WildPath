import {buildFoundryActionUseIntent} from "../resolvers/foundry-multiplayer-runtime.mjs";
import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {placeFoundryArea, placeFoundrySummons} from "../applications/area-placement.mjs";
import {areaClickCount} from "../adapters/foundry-v14-area-placement.mjs";
import {promptActionConfiguration} from "../adapters/foundry-v14-prompt-adapter.mjs";
import {foundryActorSystemSnapshot} from "../adapters/foundry-v14-actor-system-adapter.mjs";

/**
 * The Item document subclass for the WildPath system.
 */
export default class WildPathItem extends Item {

  /**
   * A granted resource needs its pool on the Actor (`GrantResource`); the user who made the change stores it. A magic
   * item's Actions come with it.
   */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if ( userId !== game.user.id ) return;
    void this.actor?.ensureGrantedPools?.();
    void this.#addGrantedActions();
  }

  /** The Actions an item brought with it go with it. */
  _onDelete(options, userId) {
    super._onDelete(options, userId);
    if ( (userId !== game.user.id) || !this.actor ) return;
    const granted = this.actor.items.filter(item => item.flags?.wildpath?.grantedBy === this.id).map(item => item.id);
    if ( granted.length ) void this.actor.deleteEmbeddedDocuments("Item", granted);
  }

  /**
   * A magic item's Actions (a wand's Fireball, `flags.wildpath.grants`: their ids) from the compendium it came from,
   * added to its owner and marked as brought by it.
   */
  async #addGrantedActions() {
    const ids = this.flags?.wildpath?.grants;
    const pack = this.actor && ids?.length ? foundry.utils.parseUuid(this._stats?.compendiumSource ?? "")?.collection : null;
    if ( !pack?.getDocuments ) return;
    const actions = await pack.getDocuments({_id__in: ids});
    if ( actions.length ) await this.actor.createEmbeddedDocuments("Item", actions.map(action => foundry.utils.mergeObject(action.toObject(),
      {"flags.wildpath.grantedBy": this.id, "_stats.compendiumSource": action.uuid})));
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
  /**
   * Use this Action. Its choices (a spell slot, a damage type) are asked first, with a preview, unless
   * `configuration` (`{choices}`) is given; the authority checks them like everything else.
   */
  async use({configuration=null}={}) {
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
    const definition = actionDefinitionFromAction(this, {actorSystem: this.actor.system});
    if ( configuration ) built.intent.configuration = configuration;
    else if ( definition.ok && definition.definition?.configuration?.length ) {
      const choices = await promptActionConfiguration({definition: definition.definition, actorSystem: foundryActorSystemSnapshot(this.actor),
        name: this.name});
      if ( choices === null ) return false;
      if ( choices ) built.intent.configuration = {choices};
    }
    // An area is placed on the canvas first; the authority derives its fields and targets from these clicks.
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
    // A summon's creatures appear where the caster clicks; without a Token on the canvas the authority places them.
    const summon = definition.ok ? definition.definition?.summon : null;
    const summoner = summon ? (this.actor.token ?? this.actor.getActiveTokens?.(false, true)?.[0] ?? null) : null;
    if ( summoner && globalThis.canvas?.ready && (summoner.parent === globalThis.canvas.scene) ) {
      const placed = await placeFoundrySummons({definition: definition.definition, sourceToken: summoner,
        count: Math.max(1, Math.min(Number(summon.count) || 1, 20))});
      if ( !placed ) return false;
      built.intent.summon = placed;
    }
    const declared = await runtime.executeActionIntent(built.intent);
    if ( !declared.ok ) {
      globalThis.ui?.notifications?.warn?.(declared.reason ?? `Unable to use ${this.name}.`);
    }
    return declared.ok === true;
  }
}

import {getCombatTurnStartLifecycleEvents} from "../helpers/combat.mjs";
import {executeEffectLifecycleCommit} from "../resolvers/effect-lifecycle-commit-resolver.mjs";

const FoundryCombatDocument = globalThis.foundry?.documents?.Combat ?? globalThis.Combat;

/**
 * Combat document subclass for WildPath's managed turn-start automation.
 */
export default class WildPathCombat extends FoundryCombatDocument {

  /* -------------------------------------------- */

  /**
   * Foundry V14 invokes this after the Combat update, on one designated GM user, for the actual
   * incoming Combatant. This is the authoritative place for turn-start resource recovery.
   * @param {Combatant} combatant
   * @param {object} context
   * @returns {Promise<object|undefined>}
   */
  async _onStartTurn(combatant, context={}) {
    await super._onStartTurn(combatant, context);

    const actor = combatant?.actor ?? null;
    if ( !actor ) return undefined;

    const events = getCombatTurnStartLifecycleEvents(this, combatant, context);
    const recovery = await actor.startTurn({
      combat: this,
      combatant,
      context,
      events
    });
    if ( recovery?.ok === false ) {
      console.warn("Wild Path | Managed Combat turn recovery rejected", recovery);
      return {ok: false, recovery, events};
    }

    const lifecycle = await executeEffectLifecycleCommit({
      actors: [actor],
      events,
      authority: foundryManagedCombatAuthority(),
      metadata: {
        hook: "Combat#_onStartTurn",
        combatId: this.id ?? this._id ?? null,
        combatantId: combatant?.id ?? combatant?._id ?? null
      }
    });
    if ( !lifecycle.ok ) {
      console.warn("Wild Path | Managed Combat turn lifecycle commit failed", lifecycle);
    }
    // A condition's damage at turn start follows the dying rules too.
    // Its conditions' damage at turn start (Bleeding, applied by startTurn) and the lifecycle's: a drop to 0 may be kept
    // up first (Relentless Endurance, Undead Fortitude: rescue).
    await globalThis.game?.wildpath?.dying?.afterPlans?.(actor, [...(recovery?.triggers?.mutationPlans ?? []),
      ...(lifecycle.mutationPlans ?? [])], {rescue: true});
    await this.#applyTurnEvent("turn.started", combatant);
    // Summons whose rounds have run out leave before the turn goes on.
    try {
      await globalThis.game?.wildpath?.summons?.onTurnStart?.(this);
    } catch (error) {
      console.warn("Wild Path | Summon expiry failed", error);
    }
    // 2024: a dying character rolls its death save at the start of its turn.
    try {
      await globalThis.game?.wildpath?.dying?.onTurnStart?.({combatant});
    } catch (error) {
      console.warn("Wild Path | Death save failed", error);
    }

    return {
      ok: recovery?.ok !== false && lifecycle.ok !== false,
      recovery,
      lifecycle,
      events
    };
  }

  /**
   * Lasting areas the ending combatant stands in, and its own automatic triggers, answer `turn.ended`. Runs on
   * Foundry's designated GM only.
   * @param {Combatant} combatant
   * @param {object} context
   */
  async _onEndTurn(combatant, context={}) {
    await super._onEndTurn(combatant, context);
    await this.#applyTurnEvent("turn.ended", combatant);
  }

  async #applyTurnEvent(event, combatant) {
    try {
      await globalThis.game?.wildpath?.areas?.onTurn?.(event, {combatant});
      await globalThis.game?.wildpath?.automation?.dispatch?.(event, {actor: combatant?.actor ?? null, token: combatant?.token ?? null});
    } catch (error) {
      console.warn(`Wild Path | Lasting areas or automatic triggers failed on ${event}`, error);
    }
  }
}

function foundryManagedCombatAuthority() {
  const user = globalThis.game?.user ?? null;
  const userId = user?.id ?? null;
  return {
    isGM: true,
    canCommit: true,
    userId,
    activeUserId: userId,
    activeGMId: userId
  };
}

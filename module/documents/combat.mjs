import {chaseTurnEnded} from "../applications/chases.mjs";
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
    await this.#refillLairActions();

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
    // In a chase, its complication roll (applications/chases.mjs).
    try {
      await chaseTurnEnded(combatant);
    } catch (error) {
      console.warn("Wild Path | A chase complication roll failed", error);
    }
    // 2014: a surprised creature's first turn has passed (2024 ends it when its initiative is rolled).
    const actor = combatant?.actor;
    if ( actor?.statuses?.has?.("surprised") && (globalThis.game?.settings?.get?.("wildpath", "rulesVersion") === "2014") ) {
      await actor.toggleCondition?.("surprised", {levels: -1});
    }
  }

  /**
   * Foundry's V14 `Combat#rollInitiative`, each die by the dice policy (`Combatant#rollInitiativeDice`), so a physical
   * roller types it. Closing one prompt stops there; those already rolled are kept.
   * @override
   */
  async rollInitiative(ids, {formula=null, updateTurn=true, messageMode, messageOptions={}}={}) {
    const updates = [];
    const messages = [];
    for ( const id of (typeof ids === "string" ? [ids] : ids) ) {
      const combatant = this.combatants.get(id);
      if ( !combatant?.isOwner ) continue;
      const shown = await combatant.rollInitiativeDice(formula);
      if ( !shown ) break;
      updates.push({_id: id, initiative: shown.result.total});
      const chatData = await shown.roll.toMessage(foundry.utils.mergeObject({
        speaker: ChatMessage.getSpeaker({actor: combatant.actor, token: combatant.token, alias: combatant.name}),
        flavor: game.i18n.format("COMBAT.RollsInitiative", {name: foundry.utils.escapeHTML(combatant.name)}),
        flags: {core: {initiativeRoll: true}}
      }, messageOptions), {messageMode: messageMode ?? (combatant.hidden ? "gm" : undefined), create: false});
      if ( messages.length ) chatData.sound = null; // One sound for the whole set, as Foundry's.
      messages.push(chatData);
    }
    if ( !updates.length ) return this;
    await this.updateEmbeddedDocuments("Combatant", updates, {turnEvents: false, ...(updateTurn ? {} : {combatTurn: this.turn})});
    await ChatMessage.create(messages);
    return this;
  }

  /**
   * 2014 Lair Actions, at the top of the round (the maintainer's choice; initiative count 100, before anyone): on the
   * round's first turn every creature in the combat with such a pool (`refillsAtInitiative`) has it back, and the GM is
   * told who may take one. Recorded on the combat (`flags.wildpath.lairRound`) so a round does it once.
   */
  async #refillLairActions() {
    if ( this.flags?.wildpath?.lairRound === this.round ) return;
    const lairs = [];
    for ( const actor of new Set([...(this.combatants ?? [])].map(entry => entry.actor).filter(Boolean)) ) {
      const ids = (actor.getGrantedResources?.() ?? []).filter(grant => Number.isFinite(grant.refillsAtInitiative)).map(grant => grant.id);
      if ( !ids.length ) continue;
      const values = Object.fromEntries((actor.system?.pools ?? []).filter(pool => ids.includes(pool.id) && (pool.value !== pool.max))
        .map(pool => [pool.id, pool.max]));
      if ( Object.keys(values).length ) await actor.updatePools(values);
      lairs.push(actor.name ?? "");
    }
    await this.setFlag?.("wildpath", "lairRound", this.round);
    if ( lairs.length ) await globalThis.ChatMessage?.create?.({content: globalThis.game?.i18n?.format?.("WILDPATH.COMBAT.LairActions",
      {names: lairs.join(", ")}) ?? lairs.join(", "), whisper: globalThis.ChatMessage.getWhisperRecipients?.("GM")?.map(user => user.id) ?? []});
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

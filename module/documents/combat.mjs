import {chaseTurnEnded} from "../applications/chases.mjs";
import {actionUnavailableReason} from "../helpers/action-bar-context.mjs";
import {eligibleTargetInRange} from "../adapters/foundry-v14-auras.mjs";
import {reactionPolicyOf} from "../helpers/automation-events.mjs";
import {getCombatTurnStartLifecycleEvents} from "../helpers/combat.mjs";
import {executeEffectLifecycleCommit} from "../resolvers/effect-lifecycle-commit-resolver.mjs";

const FoundryCombatDocument = globalThis.foundry?.documents?.Combat ?? globalThis.Combat;

/**
 * Combat document subclass for WildPath's managed turn-start automation.
 */
export default class WildPathCombat extends FoundryCombatDocument {

  /** Set while the ending creature's Actions are offered, so a second click meanwhile does not advance twice. */
  #offering = false;

  /**
   * Foundry V14's advance, after the turn-end offers (`offerTurnEndActions`) on the client ending the turn: they come
   * before the advance, which `_onEndTurn` (after it, on the GM) cannot. A used offer holds the turn: Item#use only
   * declares the Action, and the authority asks its targets and spends its cost after that returns, so its user ends the
   * turn again once it is done (Q61: spent before the turn advances). Declined, closed or failed, the turn advances,
   * unless it was advanced meanwhile (another GM). Only in a started combat (Q119 (b) default).
   * @override
   */
  async nextTurn(...args) {
    if ( this.#offering ) return this;
    const {round, turn} = this;
    const actor = this.started ? (this.combatant?.actor ?? null) : null;
    if ( actor?.isOwner ) {
      this.#offering = true;
      let used = false;
      try {
        used = await offerTurnEndActions(actor, this.combatant?.token ?? null);
      } catch (error) {
        console.warn("Wild Path | A turn-end offer failed", error);
      } finally {
        this.#offering = false;
      }
      if ( used || (this.round !== round) || (this.turn !== turn) ) return this;
    }
    return super.nextTurn(...args);
  }

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
    await this.#refillControlled(actor);

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
    const died = await globalThis.game?.wildpath?.dying?.afterPlans?.(actor, [...(recovery?.triggers?.mutationPlans ?? []),
      ...(lifecycle.mutationPlans ?? [])], {rescue: true});
    // Its areas that end with it go now, so none answers this turn start; the rest settles last (dying.onTurnStart).
    if ( died === true ) await globalThis.game?.wildpath?.dying?.endAreas?.(actor);
    await this.#applyTurnEvent("turn.started", combatant, context);
    // Summons whose rounds have run out leave before the turn goes on.
    try {
      await globalThis.game?.wildpath?.summons?.onTurnStart?.(this);
    } catch (error) {
      console.warn("Wild Path | Summon expiry failed", error);
    }
    // 2024: a dying character rolls its death save at the start of its turn; last, a death in this turn start settles.
    try {
      await globalThis.game?.wildpath?.dying?.onTurnStart?.({combatant, died: died === true});
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
    await this.#applyTurnEvent("turn.ended", combatant, context);
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

  /**
   * A creature with no Combatant here that the incoming one controls (a summon that never acts, Q32's scope) moves in its
   * encounter (`movementTracked`) and has its movement back on its controller's turn, so it moves then (Q99 (c)). A
   * converted creature its controller moves has Speed 0, so it moves only by the move its controller gives it (Q33).
   */
  async #refillControlled(controller) {
    const listed = new Set([...(this.combatants ?? [])].map(entry => entry.tokenId));
    for ( const scene of globalThis.game?.scenes ?? [] ) for ( const token of scene.tokens ?? [] ) {
      const actor = token.actor;
      if ( !actor || listed.has(token.id) || !(actor.system?.companion?.controllers ?? []).includes(controller.uuid) ) continue;
      if ( Number(actor.system?.resources?.movement?.spent) > 0 ) await actor.update({"system.resources.movement.spent": 0});
    }
  }

  async #applyTurnEvent(event, combatant, context) {
    try {
      await globalThis.game?.wildpath?.areas?.onTurn?.(event, {combatant, context});
      await globalThis.game?.wildpath?.automation?.dispatch?.(event, {actor: combatant?.actor ?? null, token: combatant?.token ?? null});
    } catch (error) {
      console.warn(`Wild Path | Lasting areas or automatic triggers failed on ${event}`, error);
    }
  }
}

/**
 * The Actions a creature is offered as its turn is about to end: each Action Item with `flags.wildpath.turnEndOffer: true`
 * (a 2014 sidekick's Helpful Assist, Q61; any homebrew "before your turn ends you may ..."), active, usable now as its
 * action bar says (its `requires` met) and its cost unspent as written, asked in turn of the user ending the turn, who
 * owns the creature (its player, or the GM for anyone: Q119 (b) default). Its Always / Ask / Never setting is a
 * reaction's (`reactionPolicy`): Never is not offered, Always is used without asking. The first one used (Item#use: its
 * choices, targets and cost, as the bar does) ends the offers and is true; the next end of the turn offers again what
 * is still unspent.
 */
async function offerTurnEndActions(actor, token) {
  const i18n = globalThis.game?.i18n;
  const localize = key => i18n?.localize?.(key) ?? key;
  const escape = text => globalThis.foundry?.utils?.escapeHTML?.(String(text ?? "")) ?? String(text ?? "");
  for ( const item of [...(actor.items ?? [])] ) {
    if ( (item.type !== "action") || (item.flags?.wildpath?.turnEndOffer !== true) || (item.system?.active === false) ) continue;
    const policy = reactionPolicyOf(item);
    if ( (policy === "never") || actionUnavailableReason({actor, action: item, localize,
      targetInRange: definition => eligibleTargetInRange(definition, token)}) ) continue;
    // Its cost as written: an Action standing in for a spent Bonus Action (the project's rule) is not what it left unspent.
    if ( !actor.canUseAction(item, {policies: {allowActionForSpentBonusAction: false}}) ) continue;
    const format = key => i18n?.format?.(key, {name: escape(item.name), creature: escape(actor.name)}) ?? escape(item.name);
    const yes = (policy === "always") || await globalThis.foundry?.applications?.api?.DialogV2?.confirm?.({
      classes: ["wildpath", "themed", "theme-light"], window: {title: localize("WILDPATH.COMBAT.TurnEndOfferTitle")},
      content: `<p>${format("WILDPATH.COMBAT.TurnEndOffer")}</p>`, rejectClose: false});
    if ( yes && (await item.use()) ) {
      globalThis.ui?.notifications?.info?.(format("WILDPATH.COMBAT.TurnEndOfferUsed"));
      return true;
    }
  }
  return false;
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

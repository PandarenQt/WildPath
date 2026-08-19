import {WildPathModifier, WildPathStatistic} from "../helpers/modifiers.mjs";
import WildPathConditionEffect from "../data/active-effect/condition.mjs";
import {
  commitActorResourceMutationPlan,
  resolveActorResourcePayment
} from "../resolvers/resource-resolver.mjs";

/**
 * The Actor document subclass for the WildPath system.
 * Centralizes resource math, action-economy spending, and condition toggling so every
 * Actor sub-type shares one consistent, generically-keyed API.
 */
export default class WildPathActor extends Actor {

  /* -------------------------------------------- */
  /*  Modifiers / Statistics                       */
  /* -------------------------------------------- */

  /**
   * Build a `WildPathStatistic` for a given domain, gathering every enabled modifier that
   * targets that domain (or the wildcard "all" domain) from this Actor's active,
   * non-suppressed ActiveEffects (both Actor-level and Item-level) and active embedded Items.
   * This is the PF2e-style calculation-engine entry point: domains are free-form strings
   * (conventionally a dot-path like "resources.health.max") rather than a fixed enum, so any
   * homebrew derived value can opt in without a schema change.
   * @param {string} domain
   * @returns {WildPathStatistic}
   */
  getStatistic(domain) {
    const modifiers = [];

    for ( const item of this.items ) {
      if ( item.system?.active === false ) continue;
      for ( const m of item.system?.modifiers ?? [] ) {
        if ( !m.domains.has(domain) && !m.domains.has("all") ) continue;
        modifiers.push(new WildPathModifier({...m, source: item.uuid}));
      }
    }

    for ( const effect of this.allApplicableEffects?.() ?? this.effects ) {
      if ( effect.disabled || effect.isSuppressed ) continue;
      for ( const m of effect.system?.modifiers ?? [] ) {
        if ( !m.domains.has(domain) && !m.domains.has("all") ) continue;
        modifiers.push(new WildPathModifier({...m, source: effect.uuid}));
      }
    }

    return new WildPathStatistic(domain, modifiers);
  }

  /* -------------------------------------------- */
  /*  Resources                                    */
  /* -------------------------------------------- */

  /**
   * Read a resource pool (built-in or custom) by id.
   * @param {string} id
   * @returns {{base: number, bonus: number, max: number, value: number, recovery: string}|null}
   */
  getResource(id) {
    return this.system.getResource?.(id) ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Can this Actor currently afford the given map of resource deltas (positive numbers = cost)?
   * @param {Record<string, number>} costs
   * @returns {boolean}
   */
  canAfford(costs) {
    return Object.entries(costs).every(([id, amount]) => {
      const resource = this.getResource(id);
      return resource && (resource.value >= amount);
    });
  }

  /* -------------------------------------------- */

  /**
   * Spend (or restore, with negative amounts) a single resource pool, clamped to [0, max].
   * This is the single chokepoint for resource mutation so future rules (overflow, immunities,
   * etc.) only need to be implemented once.
   * @param {string} id
   * @param {number} amount        Positive to spend, negative to restore.
   * @param {object} [options]
   * @param {boolean} [options.force=false]   Allow going into a negative/insufficient state.
   * @returns {Promise<boolean>}   Whether the change was applied.
   */
  async spendResource(id, amount, {force=false}={}) {
    const resource = this.getResource(id);
    if ( !resource ) return false;
    if ( !force && (amount > 0) && (resource.value < amount) ) return false;

    const path = (id in this.system.resources) ? `system.resources.${id}.value` : null;
    if ( path ) {
      const value = Math.clamp(resource.value - amount, 0, resource.max);
      await this.update({[path]: value});
      return true;
    }

    // Custom pool: update by index within the pools array.
    const index = this.system.pools.findIndex(p => p.id === id);
    if ( index < 0 ) return false;
    const value = Math.clamp(resource.value - amount, 0, resource.max);
    await this.update({[`system.pools.${index}.value`]: value});
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Spend multiple resources atomically: validates affordability for all deltas first (unless
   * forced), then applies every change in a single Actor update.
   * @param {Record<string, number>} costs
   * @param {object} [options]
   * @param {boolean} [options.force=false]
   * @returns {Promise<boolean>}
   */
  async spendResources(costs, {force=false}={}) {
    if ( !force && !this.canAfford(costs) ) return false;
    const updates = {};
    for ( const [id, amount] of Object.entries(costs) ) {
      const resource = this.getResource(id);
      if ( !resource ) continue;
      const value = Math.clamp(resource.value - amount, 0, resource.max);
      if ( id in this.system.resources ) updates[`system.resources.${id}.value`] = value;
      else {
        const index = this.system.pools.findIndex(p => p.id === id);
        if ( index >= 0 ) updates[`system.pools.${index}.value`] = value;
      }
    }
    if ( foundry.utils.isEmpty(updates) ) return false;
    await this.update(updates);
    return true;
  }

  /* -------------------------------------------- */
  /*  Actions                                      */
  /* -------------------------------------------- */

  /**
   * Can this Actor currently use the given Action item (sufficient resources available)?
   * @param {Item} action   An Item of type "action".
   * @returns {boolean}
   */
  canUseAction(action, options={}) {
    return this.resolveActionPayment(action, options).ok;
  }

  /* -------------------------------------------- */

  /**
   * Plan this Actor's resource payment for an Action item without mutating Actor state.
   * @param {Item} action
   * @param {object} [options]
   * @param {object} [options.policies]
   * @param {object} [options.actionContext]
   * @param {string|null} [options.selectedPaymentOptionId]
   * @returns {object}
   */
  resolveActionPayment(action, {policies={}, actionContext={}, selectedPaymentOptionId=null}={}) {
    return resolveActorResourcePayment({
      actorSystem: this.system,
      cost: action.system.getActivationCost(),
      action: {
        id: action.id,
        type: action.type,
        name: action.name,
        tags: action.system.tags ?? [],
        ...actionContext
      },
      policies,
      selectedPaymentOptionId
    });
  }

  /* -------------------------------------------- */

  /**
   * Discover generic economy payment options for an Action item without mutating Actor state.
   * Future resolvers should use this shape before selecting and committing a payment plan.
   * @param {Item} action
   * @param {object} [options]
   * @param {object} [options.policies]
   * @param {object} [options.actionContext]
   * @returns {object}
   */
  getActionPaymentOptions(action, {policies={}, actionContext={}}={}) {
    return this.resolveActionPayment(action, {policies, actionContext}).discovery;
  }

  /* -------------------------------------------- */

  /**
   * Spend the resource cost of an Action item. Does not perform any other action resolution
   * (attack rolls, effects, etc.) - this is purely the action-economy bookkeeping groundwork.
   * @param {Item} action   An Item of type "action".
   * @returns {Promise<boolean>}   Whether the cost was successfully paid.
   */
  async useAction(action, options={}) {
    const payment = this.resolveActionPayment(action, options);
    if ( !payment.ok ) return false;
    return commitActorResourceMutationPlan(this, payment.mutationPlan);
  }

  /* -------------------------------------------- */
  /*  Turn / Combat                                 */
  /* -------------------------------------------- */

  /**
   * Reset every resource pool flagged `recovery: "turn"` back to its maximum (Action, Bonus
   * Action, Reaction, Movement by default, plus any custom pool sharing that recovery cadence).
   * Call this on combat turn start (see wildpath.mjs hooks) or manually outside of combat.
   * @returns {Promise<void>}
   */
  async startTurn() {
    const updates = {};
    for ( const [id, resource] of Object.entries(this.system.resources) ) {
      if ( resource.recovery === "turn" ) updates[`system.resources.${id}.value`] = resource.max;
    }
    this.system.pools.forEach((pool, index) => {
      if ( pool.recovery === "turn" ) updates[`system.pools.${index}.value`] = pool.max;
    });
    if ( !foundry.utils.isEmpty(updates) ) await this.update(updates);
    await this.applyConditionTicks();
  }

  /* -------------------------------------------- */

  /**
   * Restore every resource pool flagged with the given recovery cadence ("shortRest"/"longRest")
   * back to its maximum.
   * @param {"shortRest"|"longRest"} recovery
   * @returns {Promise<void>}
   */
  async rest(recovery) {
    const updates = {};
    for ( const [id, resource] of Object.entries(this.system.resources) ) {
      if ( resource.recovery === recovery ) updates[`system.resources.${id}.value`] = resource.max;
    }
    this.system.pools.forEach((pool, index) => {
      if ( pool.recovery === recovery ) updates[`system.pools.${index}.value`] = pool.max;
    });
    if ( !foundry.utils.isEmpty(updates) ) await this.update(updates);
  }

  /* -------------------------------------------- */
  /*  Conditions                                   */
  /* -------------------------------------------- */

  /**
   * Toggle (or increase/decrease the level of) a condition on this Actor.
   * @param {string} type            A key in CONFIG.WILDPATH.CONDITIONS.
   * @param {object} [options]
   * @param {number} [options.levels=1]   Signed level change; ignored for non-stacking conditions.
   * @returns {Promise<ActiveEffect|null>}
   */
  async toggleCondition(type, {levels=1}={}) {
    return WildPathConditionEffect.applyDelta(type, this, levels);
  }

  /* -------------------------------------------- */

  /**
   * Apply every active condition's damage/healing-over-time ticks to this Actor's resources.
   * @returns {Promise<void>}
   */
  async applyConditionTicks() {
    const deltas = {};
    for ( const effect of this.effects ) {
      if ( (effect.type !== "condition") || effect.disabled ) continue;
      for ( const tick of effect.system.dot ?? [] ) {
        const amount = tick.restoration ? -tick.amount : tick.amount;
        deltas[tick.resource] = (deltas[tick.resource] ?? 0) + amount;
      }
    }
    if ( !foundry.utils.isEmpty(deltas) ) await this.spendResources(deltas, {force: true});
  }
}

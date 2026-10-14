import {WildPathModifier, WildPathStatistic} from "../helpers/modifiers.mjs";
import {
  damageProfileFromRuleElements, grantedMovementFromRuleElements, grantedResourcesFromRuleElements, modifiersFromRuleElements,
  rollModesFromRuleElements
} from "../helpers/rule-elements.mjs";
import {DEFAULT_FORM_STATISTICS, DEFAULT_KEPT_ITEM_TYPES, itemContributesWhileTransformed} from "../helpers/transformations.mjs";
import WildPathConditionEffect from "../data/active-effect/condition.mjs";
import {executeActionResolution} from "../resolvers/action-resolver.mjs";
import {executeConditionEffect} from "../resolvers/effect-resolver.mjs";
import {executeEffectLifecycleCommit} from "../resolvers/effect-lifecycle-commit-resolver.mjs";
import {planConditionTriggerConsequences} from "../resolvers/condition-trigger-resolver.mjs";
import {resolveActorResourcePayment} from "../resolvers/resource-resolver.mjs";
import {
  TURN_RECOVERY_CODES,
  getRestLifecycleEvents,
  validateTurnRecoveryContext
} from "../helpers/combat.mjs";

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
   * Several domains stack: a melee weapon attack reads `["attack.weapon", "attack.melee", "attack"]`, and a
   * modifier counts once if it targets any of them. Whether it applies depends on its source: an Action
   * Item's own modifiers (a +2 sword's attack) count only for that Action, everything else is Actor-wide,
   * and each modifier's predicate sees the statistic's `item` and `tags` (e.g. a ranged-only feat).
   * @param {string|string[]} domain
   * @param {object} [options]
   * @param {Item|null} [options.item]   The Action this statistic is computed for, if any.
   * @param {string[]} [options.tags]    Tags of what is being rolled (attack type, Action tags).
   * @returns {WildPathStatistic}
   */
  getStatistic(domain, {item=null, tags=[]}={}) {
    const domains = [domain].flat().filter(Boolean).map(String);
    const modifiers = [];

    const transformation = this.transformation;
    for ( const owner of this.items ) {
      if ( owner.system?.active === false ) continue;
      if ( (owner.type === "action") && (owner.id !== item?.id) ) continue;
      if ( transformation && !contributesWhileTransformed(owner, transformation) ) continue;
      for ( const m of owner.system?.modifiers ?? [] ) {
        if ( !domains.some(entry => modifierTargetsDomain(m, entry)) ) continue;
        modifiers.push(new WildPathModifier({...m, source: owner.uuid}));
      }
      for ( const entry of domains ) modifiers.push(...collectRuleElementModifiers(owner.system?.ruleElements, {
        actor: this,
        domain: entry,
        source: documentRuleElementSource(owner, "item"),
        context: {item: owner}
      }));
    }

    for ( const effect of this.allApplicableEffects?.() ?? this.effects ) {
      if ( effect.disabled || effect.isSuppressed ) continue;
      for ( const m of effect.system?.modifiers ?? [] ) {
        if ( !domains.some(entry => modifierTargetsDomain(m, entry)) ) continue;
        modifiers.push(new WildPathModifier({...m, source: effect.uuid}));
      }
      for ( const entry of domains ) modifiers.push(...collectRuleElementModifiers(effect.system?.ruleElements, {
        actor: this,
        domain: entry,
        source: documentRuleElementSource(effect, "effect"),
        context: {effect}
      }));
    }

    return new WildPathStatistic(domains[0] ?? null, modifiers, {
      context: {
        actor: this,
        actorSystem: this.system,
        item,
        tags: [...new Set(tags.filter(Boolean).map(String))]
      }
    });
  }

  /**
   * The damage profile this creature's own grants give it (resistances, immunities, ...), from its active
   * features, gear and effects. An Action Item's RuleElements describe that Action, so they never apply.
   * @returns {object|null}
   */
  getDamageProfile() {
    return damageProfileFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system});
  }

  /**
   * The advantage and disadvantage this creature's features, gear and effects give in `domains` (`RollMode`),
   * plus the acting Action's own. `context` is what their predicates see (`attack.adjacent`, ...).
   * @param {string[]} domains
   * @param {{item?: Item|null, context?: object}} [options]
   */
  getRollModes(domains, {item=null, context={}}={}) {
    const owners = grantOwners(this);
    if ( item?.system?.ruleElements?.length ) owners.push({ruleElements: item.system.ruleElements, source: documentRuleElementSource(item, "item")});
    return rollModesFromRuleElements(owners, {domains, context: {actor: this, actorSystem: this.system, ...context}});
  }

  /** The Speeds this creature's grants give (`GrantMovement`), as `{mode, distance}`. */
  getGrantedMovement() {
    return grantedMovementFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system});
  }

  /** The resources this creature's grants give (`GrantResource`); each backs its pool of the same id. */
  getGrantedResources() {
    return grantedResourcesFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system});
  }

  /**
   * The pools this creature's grants need that `pools` (stored source) lacks, each starting full. A pool
   * stays when its grant goes; with nothing granting it, its maximum falls back to its own base.
   */
  grantedPoolsMissing(pools) {
    const known = new Set(pools.map(pool => pool.id));
    return this.getGrantedResources().flatMap(({id, label, maximum, recovery}) => {
      if ( known.has(id) ) return [];
      known.add(id);
      return [{id, label: label || id, base: 0, bonus: 0, max: maximum, value: maximum,
        recovery: ["turn", "shortRest", "longRest"].includes(recovery) ? recovery : "none"}];
    });
  }

  /** Store any pool a grant newly needs (an Item or effect with `GrantResource` was added or changed). */
  async ensureGrantedPools() {
    const pools = this.toObject(true).system.pools;
    const missing = this.grantedPoolsMissing(pools);
    if ( missing.length ) await this.update({"system.pools": [...pools, ...missing]});
  }

  /**
   * Make this creature a companion, summon or sidekick of `controllers` (Actors or their uuids). Every Player
   * who owns one of them controls it; an empty list frees it. A Player's change is made by the active GM.
   * @param {{controllers: Array<Actor|string>, kind?: "companion"|"summon"|"sidekick"}} options
   */
  async setCompanion({controllers=[], kind}={}) {
    const companions = globalThis.game?.wildpath?.companions;
    if ( !companions ) throw new Error("The WildPath runtime is not ready.");
    return companions.setControllers(this, {kind, controllers: controllers.map(entry => (typeof entry === "string" ? entry : entry?.uuid))});
  }

  /* -------------------------------------------- */
  /*  Transformations                              */
  /* -------------------------------------------- */

  /** The active transformation, if any: `{effect, policy}` from an enabled effect that names a form. */
  get transformation() {
    for ( const effect of this.effects ) {
      const policy = effect.flags?.wildpath?.transformation;
      if ( policy?.formRef && !effect.disabled ) return {effect, policy};
    }
    return null;
  }

  /**
   * Take a form: the creature uses the form's listed statistics (the physical abilities, Armor Class and
   * speed by default) and gains copies of its features and Actions, while keeping its own features and the
   * Item types it keeps (features and gear by default). Any earlier transformation ends first.
   * @param {Actor} form
   * @param {{takes?: string[], keepItemTypes?: string[]}} [policy]
   * @returns {Promise<ActiveEffect>}
   */
  async transform(form, {takes=DEFAULT_FORM_STATISTICS, keepItemTypes=DEFAULT_KEPT_ITEM_TYPES}={}) {
    if ( this.transformation ) await this.revertTransformation();
    const [effect] = await this.createEmbeddedDocuments("ActiveEffect", [{
      name: game.i18n.format("WILDPATH.TRANSFORMATION.Effect", {form: form.name}), type: "effect", system: {}, img: form.img,
      flags: {wildpath: {transformation: {formRef: form.uuid, takes: [...takes], keepItemTypes: [...keepItemTypes]}}}
    }]);
    const copies = form.items.filter(entry => ["feature", "action"].includes(entry.type)).map(entry => {
      const data = entry.toObject();
      delete data._id;
      foundry.utils.setProperty(data, "flags.wildpath.transformedBy", effect.id);
      return data;
    });
    if ( copies.length ) await this.createEmbeddedDocuments("Item", copies);
    return effect;
  }

  /** End the active transformation: the form's copied features and Actions go with its effect. */
  async revertTransformation() {
    const active = this.transformation;
    if ( !active ) return false;
    await this.deleteTransformationCopies(active.effect.id);
    await active.effect.delete();
    return true;
  }

  /** Remove the Items a transformation copied from its form. */
  async deleteTransformationCopies(effectId) {
    const copies = this.items.filter(entry => entry.flags?.wildpath?.transformedBy === effectId).map(entry => entry.id);
    if ( copies.length ) await this.deleteEmbeddedDocuments("Item", copies);
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

    // V14 ArrayFields are fully replaced. toObject(true) clones persisted source,
    // excluding prepared maxima and transient modifierBonus contributions.
    const pools = this.toObject(true).system.pools;
    const pool = pools.find(p => p.id === id);
    if ( !pool ) return false;
    pool.value = Math.clamp(resource.value - amount, 0, resource.max);
    await this.update({"system.pools": pools});
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
    let pools;
    for ( const [id, amount] of Object.entries(costs) ) {
      const resource = this.getResource(id);
      if ( !resource ) continue;
      const value = Math.clamp(resource.value - amount, 0, resource.max);
      if ( id in this.system.resources ) updates[`system.resources.${id}.value`] = value;
      else {
        pools ??= this.toObject(true).system.pools;
        const pool = pools.find(p => p.id === id);
        if ( pool ) {
          pool.value = value;
          updates["system.pools"] = pools;
        }
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
   * Legacy/compatibility helper: resolves an Action through the older synchronous
   * `executeActionResolution` resolver (no pause/resume, reactions, prompts, or TacticalGrid
   * context). No longer the player-facing execution path - `WildPathItem#use()` now declares
   * an Action intent through the authoritative multiplayer runtime instead. Kept for direct
   * programmatic callers that need a synchronous resource-only resolution.
   * @param {Item} action   An Item of type "action".
   * @returns {Promise<boolean>}   Whether the cost was successfully paid.
   */
  async useAction(action, options={}) {
    const result = await executeActionResolution({actor: this, action, ...options});
    return result.ok;
  }

  /* -------------------------------------------- */
  /*  Turn / Combat                                 */
  /* -------------------------------------------- */

  /**
   * Reset every resource pool flagged `recovery: "turn"` back to its maximum (Action, Bonus
   * Action, Reaction, Movement by default, plus any custom pool sharing that recovery cadence).
   * This is only a managed Combat turn-start operation; callers must provide the committed
   * Combat, incoming Combatant, Foundry turn context, and semantic turn-start events.
   * @returns {Promise<object>}
   */
  async startTurn({combat=null, combatant=null, context=null, events=[]}={}) {
    const validation = validateTurnRecoveryContext({
      actor: this,
      combat,
      combatant,
      context,
      events
    });
    if ( !validation.ok ) return validation;

    const updates = {};
    for ( const [id, resource] of Object.entries(this.system.resources) ) {
      if ( resource.recovery === "turn" ) updates[`system.resources.${id}.value`] = resource.max;
    }
    const pools = this.toObject(true).system.pools;
    for ( const [index, resource] of this.system.pools.entries() ) {
      if ( resource.recovery !== "turn" ) continue;
      pools[index].value = resource.max;
      updates["system.pools"] = pools;
    }
    if ( !foundry.utils.isEmpty(updates) ) await this.update(updates);
    const triggers = await this.applyConditionTriggers({events});
    return {
      ok: true,
      code: TURN_RECOVERY_CODES.OK,
      updates,
      triggers
    };
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
    const pools = this.toObject(true).system.pools;
    for ( const [index, resource] of this.system.pools.entries() ) {
      if ( resource.recovery !== recovery ) continue;
      pools[index].value = resource.max;
      updates["system.pools"] = pools;
    }
    if ( !foundry.utils.isEmpty(updates) ) await this.update(updates);
    // The creature's own automatic triggers on a rest (the GM runs them; a Player's client reports the rest).
    await globalThis.game?.wildpath?.automation?.report?.("rest.completed", {actor: this, data: {restType: recovery}});

    const events = getRestLifecycleEvents({actor: this, restType: recovery});
    if ( !events.length ) return;

    const lifecycle = await executeEffectLifecycleCommit({
      actors: [this],
      events,
      authority: actorLifecycleCommitAuthority(this),
      metadata: {hook: "actorRest", recovery}
    });
    if ( !lifecycle.ok ) {
      console.warn("Wild Path | Rest lifecycle commit failed", lifecycle);
    }
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
    const result = await executeConditionEffect({
      actor: this,
      conditionId: type,
      levels,
      commitConditionPlan: ({actor, plan}) => WildPathConditionEffect.applyDelta(plan.conditionId, actor, plan.levels)
    });
    return result.ok ? result.effect : null;
  }

  /* -------------------------------------------- */

  /**
   * Apply active condition Trigger RuleElements for the supplied semantic turn events.
   * The pure planner owns trigger matching and durability mutation planning; this Foundry-facing
   * method only commits the planned Actor updates.
   * @param {object} [options]
   * @param {object[]} [options.events]
   * @returns {Promise<object>}
   */
  async applyConditionTriggers({events=[]}={}) {
    const result = planConditionTriggerConsequences({
      actor: this,
      actorSystem: this.system,
      effects: this.effects,
      events
    });
    if ( !result.ok ) {
      console.warn("Wild Path | Condition trigger planning failed", result);
    }
    const updates = Object.assign({}, ...result.mutationPlans.map(plan => plan.updates));
    if ( !foundry.utils.isEmpty(updates) ) await this.update(updates);
    return result;
  }

  /* -------------------------------------------- */

  /**
   * Compatibility alias for older callers. Legacy `system.dot` data is translated into synthetic
   * Trigger RuleElements by ConditionTriggerResolver when no persisted RuleElements are present.
   * @returns {Promise<object>}
   */
  async applyConditionTicks(options={}) {
    return this.applyConditionTriggers(options);
  }
}

function actorLifecycleCommitAuthority(actor) {
  const user = globalThis.game?.user ?? null;
  const ownsActor = user ? actor?.testUserPermission?.(user, "OWNER") === true : false;
  const canCommit = user?.isGM === true || actor?.isOwner === true
    || ownsActor;
  return {
    isGM: user?.isGM === true,
    canCommit,
    userId: user?.id ?? null,
    actorId: actor?.id ?? null
  };
}

function collectRuleElementModifiers(ruleElements, {actor, domain, source, context={}}) {
  if ( !ruleElements?.length ) return [];
  const result = modifiersFromRuleElements({
    ruleElements,
    domain,
    context: {
      actor,
      actorSystem: actor.system,
      ...context
    },
    source
  });
  if ( !result.ok ) console.warn("Wild Path | RuleElement modifier collection failed", result);
  return result.modifiers.map(modifier => new WildPathModifier(modifier));
}

function modifierTargetsDomain(modifier, domain) {
  const domains = normalizeDomains(modifier.domains ?? modifier.domain ?? modifier.selector);
  return domains.has(domain) || domains.has("all");
}

function normalizeDomains(value) {
  if ( value == null ) return new Set();
  if ( typeof value === "string" ) return new Set([value]);
  if ( typeof value.has === "function" && typeof value !== "string" ) return value;
  if ( Symbol.iterator in Object(value) ) return new Set([...value].map(String));
  return new Set([String(value)]);
}

// Module functions, not #private methods: Foundry prepares data inside the base Document constructor, before a
// subclass's private methods exist on the instance.

/** Grants count from active features and gear (those a transformation keeps) and enabled effects. */
function grantOwners(actor) {
  const transformation = actor.transformation;
  const items = [...actor.items].filter(item => (item.system?.active !== false) && (item.type !== "action")
    && (!transformation || contributesWhileTransformed(item, transformation)))
    .map(item => ({ruleElements: item.system?.ruleElements ?? [], source: documentRuleElementSource(item, "item")}));
  const effects = [...(actor.allApplicableEffects?.() ?? actor.effects)].filter(effect => !effect.disabled && !effect.isSuppressed)
    .map(effect => ({ruleElements: effect.system?.ruleElements ?? [], source: documentRuleElementSource(effect, "effect")}));
  return [...items, ...effects];
}

/** The form's copied Items always count; of the creature's own, only the kept types do. */
function contributesWhileTransformed(owner, transformation) {
  return (owner.flags?.wildpath?.transformedBy === transformation.effect.id)
    || itemContributesWhileTransformed(owner.type, transformation.policy);
}

function documentRuleElementSource(document, type) {
  return {
    type,
    uuid: document.uuid ?? null,
    id: document.id ?? null,
    name: document.name ?? null
  };
}

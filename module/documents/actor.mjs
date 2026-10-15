import {WildPathModifier, WildPathStatistic} from "../helpers/modifiers.mjs";
import {
  damageProfileFromRuleElements, grantedMovementFromRuleElements, grantedResourcesFromRuleElements, modifiersFromRuleElements,
  resourceCapsFromRuleElements, rollModesFromRuleElements, rollOutcomesFromRuleElements, extraDamageFromRuleElements, aurasFromRuleElements,
  conditionImmunitiesFromRuleElements, opportunityAttackAvoidanceFromRuleElements, extraAttacksFromRuleElements, normalizeRuleElementType,
  armorClassesFromRuleElements
} from "../helpers/rule-elements.mjs";
import {DEFAULT_FORM_STATISTICS, DEFAULT_KEPT_ITEM_TYPES, itemContributesWhileTransformed} from "../helpers/transformations.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import WildPathConditionEffect from "../data/active-effect/condition.mjs";
import {floatHealthChange} from "../applications/floating-text.mjs";
import {executeConditionEffect} from "../resolvers/effect-resolver.mjs";
import {executeEffectLifecycleCommit} from "../resolvers/effect-lifecycle-commit-resolver.mjs";
import {planConditionTriggerConsequences} from "../resolvers/condition-trigger-resolver.mjs";
import {resolveActorResourcePayment} from "../resolvers/resource-resolver.mjs";
import {
  TURN_RECOVERY_CODES,
  getRestLifecycleEvents,
  validateTurnRecoveryContext
} from "../helpers/combat.mjs";

/** An amount regained on a rest, its dice rolled first: `{total, rolls}`. */
async function rollAmount(expression, context) {
  const rolls = [];
  const roll = async node => {
    if ( !node || (typeof node !== "object") ) return node;
    if ( node.type === "dice" ) {
      const result = await new Roll(`${node.number ?? 1}d${node.faces}`).evaluate();
      rolls.push(result);
      return {...node, total: result.total + (Number(node.bonus) || 0)};
    }
    const next = {...node};
    if ( Array.isArray(next.terms) ) next.terms = await Promise.all(next.terms.map(roll));
    for ( const key of ["value", "left", "right", "numerator", "denominator"] ) if ( next[key] ) next[key] = await roll(next[key]);
    return next;
  };
  const result = evaluateValueExpression(await roll(expression), context);
  return {total: result.ok ? Math.floor(result.value) : 0, rolls};
}

/** 2024: a creature's AC without armor is 10 + its Agility modifier. */
const UNARMORED = Object.freeze({schemaVersion: 1, id: "unarmored", type: "ArmorClass", data: {label: "Unarmored",
  value: {type: "add", terms: [{type: "constant", value: 10}, {type: "ability-modifier", ability: "agility"}]}}});

/**
 * The Actor document subclass for the WildPath system.
 * Centralizes resource math, action-economy spending, and condition toggling so every
 * Actor sub-type shares one consistent, generically-keyed API.
 */
export default class WildPathActor extends Actor {

  /* -------------------------------------------- */
  /*  Floating combat text                         */
  /* -------------------------------------------- */

  /** The client making a health change records it in the update's options, which reach every client. */
  async _preUpdate(changes, options, user) {
    const allowed = await super._preUpdate(changes, options, user);
    if ( allowed === false ) return false;
    const next = foundry.utils.getProperty(changes, "system.resources.health.value");
    const current = this.system?.resources?.health?.value;
    if ( Number.isFinite(next) && Number.isFinite(current) && (next !== current) ) {
      foundry.utils.setProperty(options, "wildpath.healthChange", next - current);
    }
    return allowed;
  }

  /** Every client raises the change in health over the creature's visible Tokens. */
  _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if ( options.wildpath?.healthChange ) floatHealthChange(this, options.wildpath.healthChange, options.wildpath.damageTypes);
  }

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
  getStatistic(domain, {item=null, tags=[], auras=false}={}) {
    const domains = [domain].flat().filter(Boolean).map(String);
    const modifiers = [];
    // What a rule's predicate sees: the roll's tags (attack type, the Action's tags) and the creature's conditions.
    const seen = {tags: [...new Set(tags.filter(Boolean).map(String))], conditions: [...(this.statuses ?? [])]};

    const transformation = this.transformation;
    for ( const owner of this.items ) {
      if ( !contributes(owner) ) continue;
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
        context: {item: owner, ...seen}
      }));
    }

    // Auras around the creature (game.wildpath.auras), when a roll or defense is read; data preparation leaves them out.
    if ( auras ) for ( const owner of globalThis.game?.wildpath?.auras?.ownersFor?.(this) ?? [] ) {
      for ( const entry of domains ) modifiers.push(...collectRuleElementModifiers(owner.ruleElements, {actor: this, domain: entry,
        source: owner.source, context: seen}));
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
        context: {effect, ...seen},
        // A leveled condition (Exhaustion) scales its modifiers by `effect.system.level`.
        bindings: {effect: {system: {level: effect.system?.level ?? null}}}
      }));
    }

    return new WildPathStatistic(domains[0] ?? null, modifiers, {
      context: {
        actor: this,
        actorSystem: this.system,
        item,
        ...seen
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
    return rollModesFromRuleElements(owners, {domains, context: {actor: this, actorSystem: this.system,
      conditions: [...(this.statuses ?? [])], ...context}});
  }

  /**
   * The extra damage this creature's features, gear and effects, plus the acting Action's own rules, add in
   * `domains` (`ExtraDamage`). Predicates see the roll's tags and the creature's conditions.
   */
  getExtraDamage(domains, {item=null, tags=[], context={}}={}) {
    const owners = grantOwners(this);
    if ( item?.system?.ruleElements?.length ) owners.push({ruleElements: item.system.ruleElements, source: documentRuleElementSource(item, "item")});
    return extraDamageFromRuleElements(owners, {domains, context: {actor: this, actorSystem: this.system, item, tags,
      conditions: [...(this.statuses ?? [])], ...context}});
  }

  /** The auras this creature's features, gear and effects give it (`Aura`). */
  getAuras() {
    return aurasFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system, conditions: [...(this.statuses ?? [])]});
  }

  /** The conditions this creature's features, gear and effects make it immune to (`ConditionImmunity`). */
  getConditionImmunities() {
    return conditionImmunitiesFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system,
      conditions: [...(this.statuses ?? [])]});
  }

  /** The pools this creature's further attacks of an Attack action are paid from (`ExtraAttack`). */
  getExtraAttacks() {
    return extraAttacksFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system, conditions: [...(this.statuses ?? [])]});
  }

  /**
   * The ways this creature's features, gear and effects work out its Armor Class (`ArmorClass`): `{value, armor}`,
   * and the 2024 unarmored one, 10 + its Agility modifier. They count when its AC is not typed.
   */
  getArmorClasses() {
    const context = {actor: this, actorSystem: this.system, conditions: [...(this.statuses ?? [])]};
    return armorClassesFromRuleElements([...grantOwners(this), {ruleElements: [UNARMORED], source: null}], context);
  }

  /** Whether this creature's movement provokes Opportunity Attacks (`AvoidOpportunityAttacks`): `{always, movementModes}`. */
  getOpportunityAttackAvoidance() {
    return opportunityAttackAvoidanceFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system,
      conditions: [...(this.statuses ?? [])]});
  }

  /** The outcomes forced on this creature's rolls in `domains` (`RollOutcome`), e.g. automatic failure. */
  getRollOutcomes(domains, {context={}}={}) {
    return rollOutcomesFromRuleElements(grantOwners(this), {domains, context: {actor: this, actorSystem: this.system,
      conditions: [...(this.statuses ?? [])], ...context}});
  }

  /** Ceilings on this creature's resource maxima (`ResourceCap`): `{action: 0, movement: 0, ...}`. */
  getResourceCaps() {
    return resourceCapsFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system});
  }

  /** The Speeds this creature's grants give (`GrantMovement`), as `{mode, distance}`. */
  getGrantedMovement() {
    return grantedMovementFromRuleElements(grantOwners(this), {actor: this, actorSystem: this.system});
  }

  /** The resources this creature's grants give (`GrantResource`); each backs its pool of the same id. */
  getGrantedResources() {
    // An Action's own uses (Fire Breath, Second Wind, 3/Day) are a pool it spends: its GrantResource counts, though
    // its other RuleElements only describe that Action.
    const actions = [...(this.items ?? [])].filter(item => (item.type === "action") && (item.system?.active !== false)).map(item => ({
      ruleElements: (item.system?.ruleElements ?? []).filter(rule => normalizeRuleElementType(rule?.type) === "GrantResource"),
      source: documentRuleElementSource(item, "item")}));
    return grantedResourcesFromRuleElements([...grantOwners(this), ...actions], {actor: this, actorSystem: this.system});
  }

  /**
   * The pools this creature's grants need that `pools` (stored source) lacks, each starting full. A pool
   * stays when its grant goes; with nothing granting it, its maximum falls back to its own base.
   */
  grantedPoolsMissing(pools) {
    const known = new Set(pools.map(pool => pool.id));
    return this.getGrantedResources().flatMap(({id, label, maximum, current, recovery}) => {
      if ( known.has(id) ) return [];
      known.add(id);
      // A grant may start its pool empty (`current: 0`, Multiattack's attacks).
      return [{id, label: label || id, base: 0, bonus: 0, max: maximum, value: Math.min(current ?? maximum, maximum),
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
    // The creature's Tokens take the form's size; each one's own is kept to restore on revert.
    const tokens = tokensOf(this);
    const size = {width: form.prototypeToken?.width ?? 1, height: form.prototypeToken?.height ?? 1};
    const [effect] = await this.createEmbeddedDocuments("ActiveEffect", [{
      name: game.i18n.format("WILDPATH.TRANSFORMATION.Effect", {form: form.name}), type: "effect", system: {}, img: form.img,
      flags: {wildpath: {transformation: {formRef: form.uuid, takes: [...takes], keepItemTypes: [...keepItemTypes],
        tokenSizes: tokens.map(token => ({uuid: token.uuid, width: token.width, height: token.height}))}}}
    }]);
    // A pure resize is a "displace" movement in V14; the movement authority approves it without cost.
    for ( const token of tokens ) {
      if ( (token.width !== size.width) || (token.height !== size.height) ) await token.move([{...size, action: "displace"}]);
    }
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

  /** Remove the Items a transformation copied from its form, and give the creature's Tokens their size back. */
  async deleteTransformationCopies(effectId, deletedEffect=null) {
    const copies = this.items.filter(entry => entry.flags?.wildpath?.transformedBy === effectId).map(entry => entry.id);
    if ( copies.length ) await this.deleteEmbeddedDocuments("Item", copies);
    const effect = deletedEffect ?? this.effects.get(effectId) ?? null;
    for ( const {uuid, width, height} of effect?.flags?.wildpath?.transformation?.tokenSizes ?? [] ) {
      const token = globalThis.fromUuidSync?.(uuid);
      if ( token && ((token.width !== width) || (token.height !== height)) ) await token.move([{width, height, action: "displace"}]);
    }
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
    // Multiattack's attacks last only the turn it is used.
    for ( const grant of this.getGrantedResources().filter(entry => entry.emptiesAtTurnStart) ) {
      const index = this.system.pools.findIndex(pool => pool.id === grant.id);
      if ( (index < 0) || !pools[index].value ) continue;
      pools[index].value = 0;
      updates["system.pools"] = pools;
    }
    // Recharge: a spent pool whose grant says `recharge: 5` comes back on a d6 of 5 or more, rolled for the GM.
    for ( const grant of this.getGrantedResources().filter(entry => entry.recharge) ) {
      const index = this.system.pools.findIndex(pool => pool.id === grant.id);
      const pool = this.system.pools[index];
      if ( !pool || (pool.value >= pool.max) ) continue;
      const roll = await new Roll("1d6").evaluate();
      const recharged = roll.total >= grant.recharge;
      if ( recharged ) {
        pools[index].value = pool.max;
        updates["system.pools"] = pools;
      }
      await roll.toMessage({speaker: ChatMessage.getSpeaker({actor: this}),
        flavor: game.i18n.format(recharged ? "WILDPATH.RECHARGE.Recharged" : "WILDPATH.RECHARGE.Spent",
          {name: grant.label, range: grant.recharge === 6 ? "6" : `${grant.recharge}–6`})}, {messageMode: "gm"});
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
    const long = recovery === "longRest";
    const health = this.system.resources?.health;
    // 2024: a long rest needs at least 1 health at its start; at 0 it gives no benefit, but its hours still pass.
    const benefits = !long || !health || ((Number(health.value) || 0) >= 1);
    if ( !benefits ) globalThis.ui?.notifications?.warn?.(globalThis.game?.i18n?.format("WILDPATH.REST.NoBenefit", {name: this.name}));
    await globalThis.game?.wildpath?.dying?.restHours?.(this, long ? 8 : 1);
    if ( !benefits ) return;
    // 2024: a long rest also restores what a short rest does, and all health.
    const recovers = value => (value === recovery) || (long && (value === "shortRest"));
    const updates = {};
    if ( long && health && (health.value < health.max) ) updates["system.resources.health.value"] = health.max;
    for ( const [id, resource] of Object.entries(this.system.resources) ) {
      if ( recovers(resource.recovery) ) updates[`system.resources.${id}.value`] = resource.max;
    }
    const pools = this.toObject(true).system.pools;
    const grants = new Map(this.getGrantedResources().map(grant => [grant.id, grant]));
    for ( const [index, resource] of this.system.pools.entries() ) {
      if ( recovers(resource.recovery) ) {
        pools[index].value = resource.max;
        updates["system.pools"] = pools;
        continue;
      }
      // A partial refill (`GrantResource` `regain`): one use on a short rest, a wand's 1d6 + 1 charges.
      const grant = grants.get(resource.id);
      const amount = grant?.regain?.[recovery] ?? (long ? grant?.regain?.shortRest : null);
      if ( (amount == null) || (resource.value >= resource.max) ) continue;
      const {total, rolls} = await rollAmount(amount, {actor: this, actorSystem: this.system});
      pools[index].value = Math.min(resource.max, resource.value + Math.max(total, 0));
      updates["system.pools"] = pools;
      if ( rolls.length ) await rolls[0].toMessage({speaker: ChatMessage.getSpeaker({actor: this}),
        flavor: game.i18n.format("WILDPATH.REST.Regained", {name: grant.label, amount: pools[index].value - resource.value})},
      {messageMode: "gm"});
    }
    if ( !foundry.utils.isEmpty(updates) ) await this.update(updates);
    // 2024: a long rest removes one level of Exhaustion.
    if ( long && this.statuses?.has?.("exhaustion") ) await this.toggleCondition("exhaustion", {levels: -1});
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

function collectRuleElementModifiers(ruleElements, {actor, domain, source, context={}, bindings=null}) {
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
  return result.modifiers.map(modifier => new WildPathModifier(bindings ? {...modifier, bindings} : modifier, bindings ?? {}));
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

/** This creature's Tokens on every Scene: its own (a synthetic Actor), or every Token linked to it. */
function tokensOf(actor) {
  if ( actor.isToken ) return actor.token ? [actor.token] : [];
  return [...(globalThis.game?.scenes ?? [])].flatMap(scene => [...scene.tokens])
    .filter(token => token.actorLink && (token.actorId === actor.id));
}

/** Grants count from active features and gear (those a transformation keeps) and enabled effects. */
function grantOwners(actor) {
  const transformation = actor.transformation;
  const items = [...(actor.items ?? [])].filter(item => contributes(item) && (item.type !== "action")
    && (!transformation || contributesWhileTransformed(item, transformation)))
    .map(item => ({ruleElements: item.system?.ruleElements ?? [], source: documentRuleElementSource(item, "item")}));
  const effects = [...(actor.allApplicableEffects?.() ?? actor.effects)].filter(effect => !effect.disabled && !effect.isSuppressed)
    .map(effect => ({ruleElements: effect.system?.ruleElements ?? [], source: documentRuleElementSource(effect, "effect")}));
  return [...items, ...effects];
}

/** An Item's rules count while it is active (gear: equipped) and, when it needs attunement (2024), attuned. */
function contributes(item) {
  return (item.system?.active !== false) && (item.system?.attunement !== "required");
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
    name: document.name ?? null,
    // A leveled condition's rules can depend on its level (`source.level`, 2014 Exhaustion).
    ...((type === "effect") ? {level: document.system?.level ?? null} : {})
  };
}

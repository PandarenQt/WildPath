import {WILDPATH} from "../config.mjs";
import {serializeRuleElementDefinition} from "../helpers/rule-elements.mjs";
import {itemEffectSuppressed, sourceSuppressed} from "../helpers/effect-sources.mjs";
import {refuseBrokenRules, refusePlayerMechanics} from "../helpers/rule-guard.mjs";

/**
 * The ActiveEffect document subclass for the WildPath system.
 * Hooks into status-effect creation so toggling a condition from the Token HUD automatically
 * becomes a properly-typed "condition" effect, with declarative RuleElements copied onto the
 * effect. Legacy `generator()` payloads are still merged for compatibility.
 */
export default class WildPathActiveEffect extends ActiveEffect {

  /**
   * A player's edit of its RuleElements is refused: only a GM changes what it does. An edit adding problems to them is
   * refused, with them in words (a macro's too, not only a sheet's).
   */
  async _preUpdate(changes, options, user) {
    if ( refusePlayerMechanics(this, changes, user) ) return false;
    if ( refuseBrokenRules(this, foundry.utils.getProperty(changes, "system.ruleElements")) ) return false;
    return super._preUpdate(changes, options, user);
  }

  /**
   * A condition its creature is now immune to has no effect while that lasts (2024 Aura of Courage: "If a Frightened
   * ally enters the aura, that condition has no effect on that ally while there"; Aura of Devotion's Charmed).
   * @inheritDoc
   */
  get isSuppressed() {
    if ( super.isSuppressed ) return true;
    // An effect on an Item (an infusion) counts only while that Item does: equipped, and attuned when it or the binding
    // needs it. Nor while a `Suppress` rule of its creature matches where it came from (sourceSuppressed: an Antimagic
    // Field over a spell's effect or a magic item's binding).
    if ( this.parent?.documentName === "Item" ) return itemEffectSuppressed(this) || sourceSuppressed(this);
    if ( sourceSuppressed(this) ) return true;
    const actor = this.parent;
    // While its creature's immunities are worked out, that answers none (WildPathActor#getConditionImmunities).
    if ( (this.type !== "condition") || !this.system?.type || (typeof actor?.getConditionImmunities !== "function") ) return false;
    return actor.getConditionImmunities().includes(this.system.type);
  }

  /**
   * An effect may grant a resource that needs its pool on the Actor (`GrantResource`), and a condition may bring
   * others with it (2024 Unconscious is also Prone).
   */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if ( userId !== game.user.id ) return;
    // A pool it grants is stored by its Actor (WildPathActor#syncItemRecords).
    for ( const implied of WILDPATH.CONDITIONS[this.system?.type]?.implies ?? [] ) {
      const present = [...(this.parent?.effects ?? [])].some(effect => effect.system?.type === implied);
      if ( !present ) void this.parent?.toggleCondition?.(implied);
    }
  }

  /**
   * A possession (`hitPoints: "form"`) ending gives its creature back its own Hit Points here, on the deleting client and
   * awaited before the deletion, however it is deleted. Hit Points left that this client could not give the body ride in
   * the operation (`wildpath.formLeft`, by effect id, as V14's own Combatant adds `combatTurn`) to the active GM's hook.
   * @inheritDoc
   */
  static async _preDeleteOperation(documents, operation, user) {
    if ( (await super._preDeleteOperation(documents, operation, user)) === false ) return false;
    for ( const effect of documents ) {
      const left = await effect.parent?.releaseForm?.(effect);
      if ( left ) foundry.utils.setProperty(operation, `wildpath.formLeft.${effect.id}`, left);
    }
  }

  /** A transformation effect deleted directly (e.g. from the sheet) still takes the form's copied Items. */
  _onDelete(options, userId) {
    super._onDelete(options, userId);
    if ( (userId === game.user.id) && this.flags?.wildpath?.transformation ) void this.parent?.deleteTransformationCopies?.(this.id, this);
  }

  /** @inheritDoc */
  static async _fromStatusEffect(statusId, effectData, options) {
    const condition = WILDPATH.CONDITIONS[statusId];
    if ( condition ) {
      effectData.type = "condition";
      effectData.system = {...effectData.system, type: statusId};
      if ( condition.ruleElements?.length ) {
        const serialized = condition.ruleElements.map((definition, index) => serializeRuleElementDefinition(definition, {index}));
        const failures = serialized.filter(result => !result.ok);
        if ( failures.length ) console.warn("Wild Path | Invalid condition RuleElement definitions", {statusId, failures});
        effectData.system.ruleElements = [
          ...(effectData.system.ruleElements ?? []),
          ...serialized.filter(result => result.ok).map(result => result.definition)
        ];
      }
      if ( condition.generator ) {
        const actor = options?.parent ?? options?.actor ?? null;
        const generated = condition.generator(actor);
        foundry.utils.mergeObject(effectData.system, generated, {overwrite: false});
      }
    }
    return super._fromStatusEffect(statusId, effectData, options);
  }
}

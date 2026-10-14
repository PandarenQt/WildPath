import {WILDPATH} from "../config.mjs";
import {serializeRuleElementDefinition} from "../helpers/rule-elements.mjs";

/**
 * The ActiveEffect document subclass for the WildPath system.
 * Hooks into status-effect creation so toggling a condition from the Token HUD automatically
 * becomes a properly-typed "condition" effect, with declarative RuleElements copied onto the
 * effect. Legacy `generator()` payloads are still merged for compatibility.
 */
export default class WildPathActiveEffect extends ActiveEffect {

  /**
   * An effect may grant a resource that needs its pool on the Actor (`GrantResource`), and a condition may bring
   * others with it (2024 Unconscious is also Prone).
   */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if ( userId !== game.user.id ) return;
    void this.parent?.ensureGrantedPools?.();
    for ( const implied of WILDPATH.CONDITIONS[this.system?.type]?.implies ?? [] ) {
      const present = [...(this.parent?.effects ?? [])].some(effect => effect.system?.type === implied);
      if ( !present ) void this.parent?.toggleCondition?.(implied);
    }
  }

  /** A transformation effect deleted directly (e.g. from the sheet) still takes the form's copied Items. */
  _onDelete(options, userId) {
    super._onDelete(options, userId);
    if ( (userId === game.user.id) && this.flags?.wildpath?.transformation ) void this.parent?.deleteTransformationCopies?.(this.id);
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

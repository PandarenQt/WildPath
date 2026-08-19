import {WILDPATH} from "../config.mjs";

/**
 * The ActiveEffect document subclass for the WildPath system.
 * Hooks into status-effect creation so toggling a condition from the Token HUD automatically
 * becomes a properly-typed "condition" effect, with any mechanical `generator()` payload
 * (e.g. damage-over-time) merged in - mirroring Crucible's CrucibleActiveEffect pattern.
 */
export default class WildPathActiveEffect extends ActiveEffect {

  /** @inheritDoc */
  static async _fromStatusEffect(statusId, effectData, options) {
    const condition = WILDPATH.CONDITIONS[statusId];
    if ( condition ) {
      effectData.type = "condition";
      effectData.system = {...effectData.system, type: statusId};
      if ( condition.generator ) {
        const actor = options?.parent ?? options?.actor ?? null;
        const generated = condition.generator(actor);
        foundry.utils.mergeObject(effectData.system, generated, {overwrite: false});
      }
    }
    return super._fromStatusEffect(statusId, effectData, options);
  }
}

import {combineRollModes, d20FormulaWith} from "../helpers/rolls.mjs";
import {actorAbilityModifier} from "../helpers/combat-statistics.mjs";
import {sunlightContext} from "../adapters/foundry-v14-sunlight.mjs";

const FoundryCombatantDocument = globalThis.foundry?.documents?.Combatant ?? globalThis.Combatant;

/** Initiative is an Agility check (2024's Dexterity): these domains carry its advantage, disadvantage and Modifiers. */
const INITIATIVE_DOMAINS = Object.freeze(["initiative", "check", "check.agility"]);

/**
 * The Combatant document subclass: initiative rolls with the creature's advantage or disadvantage (Incapacitated
 * and Poisoned have disadvantage in 2024) and its initiative and check Modifiers (Exhaustion).
 */
export default class WildPathCombatant extends FoundryCombatantDocument {

  /** @override */
  _getInitiativeFormula() {
    const formula = super._getInitiativeFormula();
    const actor = this.actor;
    if ( !actor?.getRollModes ) return formula;
    return d20FormulaWith(formula, {
      // Initiative is an Agility check: a creature in sunlight with Sunlight Sensitivity rolls it with Disadvantage.
      rollMode: combineRollModes(actor.getRollModes([...INITIATIVE_DOMAINS], {context: sunlightContext(this.token)})),
      modifier: (actor.getStatistic?.([...INITIATIVE_DOMAINS])?.totalModifier ?? 0) + (actorAbilityModifier(actor, "agility") ?? 0)
    });
  }
}

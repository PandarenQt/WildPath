import {ROLL_TYPES, combineRollModes, createD20RollRequest, d20FormulaWith} from "../helpers/rolls.mjs";
import {actorAbilityModifier} from "../helpers/combat-statistics.mjs";
import {sunlightContext} from "../adapters/foundry-v14-sunlight.mjs";
import {fearContext} from "../adapters/foundry-v14-fear.mjs";
import {requestShownDice, requestShownRoll} from "../adapters/foundry-digital-roll-provider.mjs";

const FoundryCombatantDocument = globalThis.foundry?.documents?.Combatant ?? globalThis.Combatant;

/** Initiative is an Agility check (2024's Dexterity): these domains carry its advantage, disadvantage and Modifiers. */
const INITIATIVE_DOMAINS = Object.freeze(["initiative", "check", "check.agility"]);

/** A Combatant's initiative as a d20 test: `{rollMode, modifier}`, or null for a creature with no roll modes. */
function initiativeTest(combatant) {
  const actor = combatant.actor;
  if ( !actor?.getRollModes ) return null;
  return {
    // Initiative is an Agility check: a creature in sunlight with Sunlight Sensitivity rolls it with Disadvantage.
    rollMode: combineRollModes(actor.getRollModes([...INITIATIVE_DOMAINS], {context: {...sunlightContext(combatant.token), ...fearContext(combatant.token)}})),
    modifier: (actor.getStatistic?.([...INITIATIVE_DOMAINS])?.totalModifier ?? 0) + (actorAbilityModifier(actor, "agility") ?? 0)
  };
}

/**
 * The Combatant document subclass: initiative rolls with the creature's advantage or disadvantage (Incapacitated
 * and Poisoned have disadvantage in 2024) and its initiative and check Modifiers (Exhaustion).
 */
export default class WildPathCombatant extends FoundryCombatantDocument {

  /** @override */
  _getInitiativeFormula() {
    const formula = super._getInitiativeFormula();
    const test = initiativeTest(this);
    return test ? d20FormulaWith(formula, test) : formula;
  }

  /**
   * Its initiative rolled by the dice policy, as every roll outside an Action (`requestShownRoll`): a physical roller types
   * the d20; an explicit formula is typed as its total. `{result, roll}`, or null when closed unrolled.
   * @param {string|null} [formula]
   */
  rollInitiativeDice(formula=null) {
    const title = game.i18n.format("COMBAT.RollsInitiative", {name: this.name});
    const test = formula ? null : initiativeTest(this);
    if ( !test ) return requestShownDice(formula || this._getInitiativeFormula(), {title});
    const resolutionId = `initiative:${foundry.utils.randomID()}`;
    return requestShownRoll(createD20RollRequest({id: `${resolutionId}:roll`, resolutionId, type: ROLL_TYPES.INITIATIVE,
      formula: this._getInitiativeFormula(), ...test}), {title});
  }

  /** @override Foundry's roll, by the dice policy; closed unrolled, its initiative stays as it was. */
  async rollInitiative(formula) {
    const shown = await this.rollInitiativeDice(formula);
    return shown ? this.update({initiative: shown.result.total}) : this;
  }
}

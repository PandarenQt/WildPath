import WildPathBaseItem from "./base.mjs";
import {WILDPATH} from "../../config.mjs";
import {computeActionCostMap} from "../../helpers/actions.mjs";

const {SchemaField, NumberField, ArrayField, StringField} = foundry.data.fields;

/**
 * A spendable Action: the primary vehicle for BG3-style action-economy costs.
 * Costs are expressed as resource deltas so `WildPathActor#useAction` can spend them through
 * the same generic `spendResource` chokepoint used everywhere else.
 */
export default class WildPathAction extends WildPathBaseItem {

  /** @inheritDoc */
  static defineSchema() {
    const costs = {};
    for ( const id of WILDPATH.ACTION_COST_RESOURCES ) {
      costs[id] = new NumberField({required: true, integer: true, initial: 0, min: 0});
    }
    return {
      ...super.defineSchema(),
      cost: new SchemaField({
        ...costs,
        /** Additional, freeform resource costs (e.g. a custom "ki" pool). */
        custom: new ArrayField(new SchemaField({
          resource: new StringField({required: true, blank: false}),
          amount: new NumberField({required: true, integer: true, initial: 1, min: 0})
        }))
      })
    };
  }

  /* -------------------------------------------- */

  /**
   * Compute the full set of resource deltas this action would spend, expressed as a plain
   * `{resourceId: amount}` map suitable for `WildPathActor#spendResources`. Delegates to the
   * pure, unit-tested `computeActionCostMap` helper (see helpers/actions.mjs).
   * @returns {Record<string, number>}
   */
  getCostMap() {
    return computeActionCostMap(this.cost);
  }
}

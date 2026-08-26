import {modifiersField, ruleElementsField} from "../fields.mjs";

const {HTMLField, BooleanField} = foundry.data.fields;

/**
 * Shared schema for every Item sub-type in the WildPath system.
 */
export default class WildPathBaseItem extends foundry.abstract.TypeDataModel {

  /** @inheritDoc */
  static defineSchema() {
    return {
      description: new HTMLField({required: true, blank: true}),
      /**
       * Declarative modifiers contributed by this Item while `active` is true. This is the
       * primary data-driven extensibility point for homebrew content (equivalent in spirit to
       * PF2e Rule Elements, but intentionally minimal): each entry targets one or more `domains`
       * (e.g. "resources.health.max") and is combined via WildPathActor#getStatistic.
       */
      modifiers: modifiersField(),
      /**
       * Declarative, serializable rule contributions supplied by this Item while `active` is
       * true. RuleElements describe contributions that owning domains interpret; they do not
       * execute resolver-specific behavior directly.
       */
      ruleElements: ruleElementsField(),
      /**
       * Whether this Item's rule contributions currently apply (e.g. gear is equipped, a feature
       * is active/toggled on). Inactive items are ignored by modifier collection entirely.
       */
      active: new BooleanField({required: true, initial: true})
    };
  }
}

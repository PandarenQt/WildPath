import {validateActionDefinition} from "../helpers/action-definitions.mjs";
import {summarizeActionDefinition} from "../helpers/action-definition-summary.mjs";
import {validateRuleElementDefinition} from "../helpers/rule-elements.mjs";

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ItemSheetV2} = foundry.applications.sheets;

/**
 * A minimal, functional ItemSheet for the WildPath system. Its Action definition and RuleElements are edited as
 * JSON and checked by the engine's own validators before anything is saved (the first slice of the Homebrew
 * Builder); an invalid draft stays on the sheet with its errors and is not saved.
 */
export default class WildPathItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "item"],
    position: {width: 560, height: 680},
    form: {submitOnChange: true}
  };

  /** @override */
  static PARTS = {
    sheet: {template: "systems/wildpath/templates/item/item-sheet.hbs"}
  };

  /** Invalid JSON drafts kept across renders: `{definition|ruleElements: {text, errors}}`. */
  #drafts = {};

  /* -------------------------------------------- */

  /**
   * Modifier `domains` is a SetField edited as a comma-separated list. Modifier fields are written as
   * `system.modifiers.<index>.<field>`, which V14 drops for ArrayFields, so they are folded into the whole array.
   * The JSON editors are parsed and validated here; only a valid draft reaches the document.
   * @inheritDoc
   */
  _processFormData(event, form, formData) {
    const submitData = super._processFormData(event, form, formData);
    const modifiers = submitData.system?.modifiers;
    if ( modifiers && !Array.isArray(modifiers) ) {
      const stored = this.item.toObject(true).system.modifiers;
      for ( const [index, changes] of Object.entries(modifiers) ) {
        if ( stored[Number(index)] ) Object.assign(stored[Number(index)], changes);
      }
      submitData.system.modifiers = stored;
    }
    for ( const modifier of submitData.system?.modifiers ?? [] ) {
      if ( typeof modifier.domains === "string" ) {
        modifier.domains = modifier.domains.split(",").map(d => d.trim()).filter(d => d);
      }
    }
    const drafts = submitData.wildpath ?? {};
    delete submitData.wildpath;
    if ( typeof drafts.definitionJson === "string" ) {
      const definition = this.#parseDraft("definition", drafts.definitionJson, parsed => validateActionDefinition(parsed).errors
        ?.map(entry => `${entry.path}: ${entry.reason}`) ?? []);
      // The edited definition replaces the stored one whole: keys it leaves out return to their initial value.
      if ( definition ) foundry.utils.setProperty(submitData, "system.definition",
        {...this.item.system.schema.fields.definition.getInitialValue(), ...definition});
    }
    if ( typeof drafts.ruleElementsJson === "string" ) {
      const ruleElements = this.#parseDraft("ruleElements", drafts.ruleElementsJson, parsed => !Array.isArray(parsed)
        ? ["RuleElements must be a list."]
        : parsed.flatMap((entry, index) => {
          const result = validateRuleElementDefinition(entry, {index});
          return result.ok ? [] : [`${index}: ${result.reason ?? result.code}`];
        }));
      if ( ruleElements ) foundry.utils.setProperty(submitData, "system.ruleElements", ruleElements);
    }
    return submitData;
  }

  /** A rejected draft changes nothing, so no update re-renders the sheet: render it to show the errors. */
  async _processSubmitData(event, form, submitData, options) {
    const result = await super._processSubmitData(event, form, submitData, options);
    if ( Object.keys(this.#drafts).length ) await this.render();
    return result;
  }

  /** A parsed, valid draft, or null with the draft and its errors kept for the next render. */
  #parseDraft(key, text, validate) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.#drafts[key] = {text, errors: [error.message]};
      return null;
    }
    const errors = validate(parsed);
    if ( errors.length ) {
      this.#drafts[key] = {text, errors};
      return null;
    }
    delete this.#drafts[key];
    return parsed;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const source = this.item.toObject(true).system;
    context.item = this.item;
    context.system = this.item.system;
    context.isAction = this.item.type === "action";
    context.actionCostResources = CONFIG.WILDPATH.ACTION_COST_RESOURCES;
    context.modifiers = this.item.system.modifiers.map((modifier, index) => ({
      ...modifier, index, domainsText: Array.from(modifier.domains).join(", ")
    }));
    if ( context.isAction ) {
      const definition = source.definition ?? {};
      context.definitionJson = this.#drafts.definition?.text ?? JSON.stringify(definition, null, 2);
      context.definitionErrors = this.#drafts.definition?.errors ?? [];
      context.definitionSummary = summarizeActionDefinition(definition).map(([label, text]) => ({label, text}));
    }
    context.ruleElementsJson = this.#drafts.ruleElements?.text ?? JSON.stringify(source.ruleElements ?? [], null, 2);
    context.ruleElementErrors = this.#drafts.ruleElements?.errors ?? [];
    return context;
  }
}

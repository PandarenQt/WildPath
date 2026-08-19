const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ItemSheetV2} = foundry.applications.sheets;

/**
 * A minimal, functional ItemSheet for the WildPath system's groundwork phase.
 */
export default class WildPathItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "item"],
    position: {width: 480, height: 480},
    form: {submitOnChange: true}
  };

  /* -------------------------------------------- */

  /**
   * Modifier `domains` is a SetField; the plain-text sheet input edits it as a comma-separated
   * list and this converts it back before the core form-processing pipeline casts it.
   * @inheritDoc
   */
  _processFormData(event, form, formData) {
    const submitData = super._processFormData(event, form, formData);
    for ( const modifier of submitData.system?.modifiers ?? [] ) {
      if ( typeof modifier.domains === "string" ) {
        modifier.domains = modifier.domains.split(",").map(d => d.trim()).filter(d => d);
      }
    }
    return submitData;
  }

  /** @override */
  static PARTS = {
    sheet: {template: "systems/wildpath/templates/item/item-sheet.hbs"}
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.system = this.item.system;
    context.isAction = this.item.type === "action";
    context.actionCostResources = CONFIG.WILDPATH.ACTION_COST_RESOURCES;
    context.modifiers = this.item.system.modifiers.map((modifier, index) => ({
      ...modifier, index, domainsText: Array.from(modifier.domains).join(", ")
    }));
    return context;
  }
}

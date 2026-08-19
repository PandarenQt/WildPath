import {createActorSheetViewModel} from "../helpers/character-sheet-view-models.mjs";

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ActorSheetV2} = foundry.applications.sheets;

/**
 * ActorSheet for the WildPath system's groundwork phase.
 * The sheet stays presentation-focused: action use still routes through the Actor/Item document API.
 */
export default class WildPathActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "actor"],
    position: {width: 720, height: 760},
    form: {submitOnChange: true},
    actions: {
      startTurn: WildPathActorSheet.#onStartTurn,
      useItem: WildPathActorSheet.#onUseItem,
      toggleCondition: WildPathActorSheet.#onToggleCondition
    }
  };

  /** @override */
  static PARTS = {
    sheet: {template: "systems/wildpath/templates/actor/actor-sheet.hbs"}
  };

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sheet = createActorSheetViewModel({
      actor: this.actor,
      abilityLabels: CONFIG.WILDPATH.ABILITIES,
      resourceLabels: CONFIG.WILDPATH.RESOURCES,
      conditionDefinitions: Object.values(CONFIG.WILDPATH.CONDITIONS)
    });
    context.sheet = sheet;
    Object.assign(context, sheet);
    return context;
  }

  /* -------------------------------------------- */
  /*  Action Handlers                              */
  /* -------------------------------------------- */

  /**
   * @this {WildPathActorSheet}
   */
  static async #onStartTurn() {
    await this.actor.startTurn();
  }

  /* -------------------------------------------- */

  /**
   * @this {WildPathActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onUseItem(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( !item ) return;
    const used = await item.use();
    if ( used === false ) ui.notifications.warn(`Not enough resources to use ${item.name}.`);
  }

  /* -------------------------------------------- */

  /**
   * @this {WildPathActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onToggleCondition(event, target) {
    const {conditionId} = target.closest("[data-condition-id]")?.dataset ?? {};
    if ( !conditionId ) return;
    const active = this.actor.statuses.has(conditionId);
    await this.actor.toggleCondition(conditionId, {levels: active ? -1 : 1});
  }
}

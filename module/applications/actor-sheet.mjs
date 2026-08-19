const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ActorSheetV2} = foundry.applications.sheets;

/**
 * A minimal, functional ActorSheet for the WildPath system's groundwork phase.
 * Intentionally unstyled/basic - the point of this phase is the underlying data model and
 * document API, not sheet polish.
 */
export default class WildPathActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "actor"],
    position: {width: 560, height: 620},
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
    context.system = this.actor.system;
    context.abilities = Object.entries(this.actor.system.abilities).map(([key, ability]) => ({
      key, value: ability.value, label: CONFIG.WILDPATH.ABILITIES[key]?.label ?? key
    }));
    context.resources = Object.entries(this.actor.system.resources).map(([key, resource]) => ({
      key, ...resource, label: CONFIG.WILDPATH.RESOURCES[key]?.label ?? key
    }));
    context.pools = this.actor.system.pools.map((pool, index) => ({...pool, index}));
    context.items = this.actor.items.contents;
    context.effects = this.actor.effects.contents;
    context.conditions = Object.values(CONFIG.WILDPATH.CONDITIONS).map(c => ({
      ...c,
      active: this.actor.statuses.has(c.id)
    }));
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

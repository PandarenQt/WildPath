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
      useItem: WildPathActorSheet.#onUseItem,
      toggleCondition: WildPathActorSheet.#onToggleCondition,
      rest: WildPathActorSheet.#onRest,
      createItem: WildPathActorSheet.#onCreateItem,
      openItem: WildPathActorSheet.#onOpenItem,
      deleteItem: WildPathActorSheet.#onDeleteItem,
      createEffect: WildPathActorSheet.#onCreateEffect,
      openEffect: WildPathActorSheet.#onOpenEffect,
      toggleEffect: WildPathActorSheet.#onToggleEffect,
      deleteEffect: WildPathActorSheet.#onDeleteEffect
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
    context.typeLabel = CONFIG.Actor.typeLabels?.[this.actor.type] ?? this.actor.type;
    context.dyingModes = {auto: "WILDPATH.SHEET.DyingMode.auto", deathSaves: "WILDPATH.SHEET.DyingMode.deathSaves",
      dies: "WILDPATH.SHEET.DyingMode.dies"};
    return context;
  }

  /** A right-click on a stacking condition removes one of its levels (a click adds one). */
  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const element of this.element.querySelectorAll("[data-condition-id][data-stacking]") ) {
      element.addEventListener("contextmenu", event => {
        event.preventDefault();
        void this.actor.toggleCondition(element.dataset.conditionId, {levels: -1});
      });
    }
  }

  /**
   * Pool fields are written as `system.pools.<index>.<field>`; V14 drops ArrayField element paths, so they are
   * folded into the whole stored array.
   * @override
   */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    const pools = data.system?.pools;
    if ( pools && !Array.isArray(pools) ) {
      const stored = this.actor.toObject(true).system.pools;
      for ( const [index, changes] of Object.entries(pools) ) {
        if ( stored[Number(index)] ) Object.assign(stored[Number(index)], changes);
      }
      data.system.pools = stored;
    }
    return data;
  }

  /* -------------------------------------------- */
  /*  Action Handlers                              */
  /* -------------------------------------------- */

  /** @this {WildPathActorSheet} */
  static async #onUseItem(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( !item ) return;
    // Item#use() already surfaces a specific failure notification; nothing further to show here.
    await item.use();
  }

  /** @this {WildPathActorSheet} A click adds a level to a stacking condition, else toggles it. */
  static async #onToggleCondition(event, target) {
    const element = target.closest("[data-condition-id]");
    const conditionId = element?.dataset.conditionId;
    if ( !conditionId ) return;
    if ( element.dataset.stacking !== undefined ) return this.actor.toggleCondition(conditionId, {levels: 1});
    const active = this.actor.statuses.has(conditionId);
    await this.actor.toggleCondition(conditionId, {levels: active ? -1 : 1});
  }

  /** @this {WildPathActorSheet} */
  static async #onRest(event, target) {
    await this.actor.rest(target.dataset.recovery);
  }

  /** @this {WildPathActorSheet} */
  static async #onCreateItem(event, target) {
    const type = target.dataset.type;
    const name = game.i18n.format("WILDPATH.SHEET.NewItem", {type: game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type)});
    // A new Action starts from a valid definition (one Action, no effect) for the sheet's editor to build on.
    const system = type === "action" ? {definition: {schemaVersion: 1, id: `action:${foundry.utils.randomID()}`, label: name,
      costs: {allOf: [{capability: "action", amount: 1}]}}} : {};
    const [item] = await this.actor.createEmbeddedDocuments("Item", [{type, name, system}]);
    item?.sheet?.render(true);
  }

  /** @this {WildPathActorSheet} */
  static async #onOpenItem(event, target) {
    this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.sheet?.render(true);
  }

  /** @this {WildPathActorSheet} */
  static async #onDeleteItem(event, target) {
    await this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.deleteDialog();
  }

  /** @this {WildPathActorSheet} */
  static async #onCreateEffect(event, target) {
    const [effect] = await this.actor.createEmbeddedDocuments("ActiveEffect", [{type: "effect", system: {},
      name: game.i18n.localize("WILDPATH.SHEET.NewEffect"), img: "icons/svg/aura.svg"}]);
    effect?.sheet?.render(true);
  }

  /** @this {WildPathActorSheet} */
  static async #onOpenEffect(event, target) {
    this.#effectFor(target)?.sheet?.render(true);
  }

  /** @this {WildPathActorSheet} */
  static async #onToggleEffect(event, target) {
    const effect = this.#effectFor(target);
    await effect?.update({disabled: !effect.disabled});
  }

  /** @this {WildPathActorSheet} */
  static async #onDeleteEffect(event, target) {
    await this.#effectFor(target)?.deleteDialog();
  }

  #effectFor(target) {
    return this.actor.effects.get(target.closest("[data-effect-id]")?.dataset.effectId) ?? null;
  }
}

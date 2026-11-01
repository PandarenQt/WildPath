import {ABOARD_ROLES} from "../data/actor/vehicle.mjs";

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ActorSheetV2} = foundry.applications.sheets;

/** What the sheet types as comma-separated lists. */
const LISTS = ["damage", "conditions"];

/**
 * A vehicle's sheet (vehicles-and-mythic.md): its numbers, who is aboard and in what role, and its Actions. An Actor dropped
 * on it comes aboard as crew. Its Actions are used by a creature aboard (the authority picks one the user owns whose role
 * the Action requires), at that creature's cost.
 */
export default class WildPathVehicleSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "actor", "vehicle", "themed", "theme-light"],
    position: {width: 620, height: 640},
    form: {submitOnChange: true},
    actions: {
      useItem: WildPathVehicleSheet.#onUseItem,
      openItem: WildPathVehicleSheet.#onOpenItem,
      deleteItem: WildPathVehicleSheet.#onDeleteItem,
      leave: WildPathVehicleSheet.#onLeave
    }
  };

  /** @override */
  static PARTS = {sheet: {template: "systems/wildpath/templates/actor/vehicle-sheet.hbs"}};

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const system = this.actor.system;
    context.system = system;
    context.immunities = Object.fromEntries(LISTS.map(key => [key, system.immunities[key].join(", ")]));
    context.roles = Object.fromEntries(ABOARD_ROLES.map(role => [role, `WILDPATH.VEHICLE.Role.${role}`]));
    context.aboard = system.aboard.map((entry, index) => ({index, role: entry.role,
      name: fromUuidSync(entry.actorUuid, {strict: false})?.name ?? game.i18n.localize("WILDPATH.VEHICLE.Missing")}));
    context.actions = this.actor.items.filter(item => item.type === "action").map(item => ({id: item.id, name: item.name, img: item.img}));
    return context;
  }

  /** A role is changed in place; V14 drops ArrayField element paths from the form, so the whole list is written. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const select of this.element.querySelectorAll("select[data-aboard-index]") ) {
      select.addEventListener("change", event => {
        event.stopPropagation();
        const aboard = this.actor.toObject(true).system.aboard;
        const entry = aboard[Number(select.dataset.aboardIndex)];
        if ( entry ) void this.actor.update({"system.aboard": aboard.with(Number(select.dataset.aboardIndex), {...entry, role: select.value})});
      });
    }
  }

  /** @override Immunities are typed as comma-separated lists. */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    for ( const key of LISTS ) {
      const value = data.system?.immunities?.[key];
      if ( typeof value === "string" ) data.system.immunities[key] = value.split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean);
    }
    return data;
  }

  /** @override A creature dropped on the vehicle comes aboard as crew (its role can be changed). */
  async _onDropActor(event, actor) {
    if ( !this.isEditable || (actor.uuid === this.actor.uuid) ) return null;
    const aboard = this.actor.toObject(true).system.aboard;
    if ( aboard.some(entry => entry.actorUuid === actor.uuid) ) return null;
    await this.actor.update({"system.aboard": [...aboard, {actorUuid: actor.uuid, role: "crew"}]});
    return actor;
  }

  /** @this {WildPathVehicleSheet} */
  static async #onUseItem(event, target) {
    await this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.use();
  }

  /** @this {WildPathVehicleSheet} */
  static async #onOpenItem(event, target) {
    this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.sheet?.render(true);
  }

  /** @this {WildPathVehicleSheet} */
  static async #onDeleteItem(event, target) {
    await this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.deleteDialog();
  }

  /** @this {WildPathVehicleSheet} A creature leaves the vehicle. */
  static async #onLeave(event, target) {
    const index = Number(target.closest("[data-aboard-index]")?.dataset.aboardIndex);
    const aboard = this.actor.toObject(true).system.aboard;
    if ( aboard[index] ) await this.actor.update({"system.aboard": aboard.toSpliced(index, 1)});
  }
}

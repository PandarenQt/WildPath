import {createActorSheetViewModel} from "../helpers/character-sheet-view-models.mjs";
import {actorProficiencyBonus, resolveActorCheckStatistic, resolveActorDefense} from "../helpers/combat-statistics.mjs";
import {levelUp} from "./level-up.mjs";

/** Item types whose drop opens the level-up dialog (G8): a class's first level, a species or background. */
const LEVELLED = new Set(["class", "species", "background"]);

/** What the sheet's training fields list (comma-separated names). */
const TRAINING = ["armor", "weapons", "tools", "masteries"];

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
      toggleEquipped: WildPathActorSheet.#onToggleEquipped,
      toggleAttuned: WildPathActorSheet.#onToggleAttuned,
      levelUp: WildPathActorSheet.#onLevelUp,
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
      conditionDefinitions: Object.values(CONFIG.WILDPATH.CONDITIONS),
      effectiveAc: resolveActorDefense(this.actor, "ac")?.value ?? null,
      proficiency: actorProficiencyBonus(this.actor)
    });
    context.sheet = sheet;
    Object.assign(context, sheet);
    // Each skill with its check bonus (ability, proficiency or expertise, Modifiers), and its proficiency to set.
    const signed = value => (value < 0 ? `${value}` : `+${value}`);
    context.skills = Object.entries(CONFIG.WILDPATH.SKILLS ?? {}).map(([key, skill]) => ({key, label: skill.label,
      abilityLabel: CONFIG.WILDPATH.ABILITIES[skill.ability]?.label ?? skill.ability,
      proficiency: this.actor.system.skills?.[key]?.proficiency ?? 0,
      modifierText: signed(resolveActorCheckStatistic(this.actor, {skill: key})?.totalModifier ?? 0)}));
    context.proficiencyLevels = {0: "WILDPATH.SHEET.SkillProficiency.None", 1: "WILDPATH.SHEET.SkillProficiency.Proficient",
      2: "WILDPATH.SHEET.SkillProficiency.Expertise"};
    context.training = TRAINING.map(key => ({key, label: `WILDPATH.SHEET.Training.${key}`, hint: `WILDPATH.SHEET.Training.Hint.${key}`,
      value: (this.actor.system.training?.[key] ?? []).join(", ")}));
    context.typeLabel = CONFIG.Actor.typeLabels?.[this.actor.type] ?? this.actor.type;
    // A "Level up" button per class while the character is below level 20 (G8).
    const classes = this.actor.items.filter(item => item.type === "class");
    const total = classes.reduce((sum, item) => sum + (Number(item.system.levels) || 0), 0);
    context.levelUps = this.isEditable && (total < 20) ? classes.map(item => ({id: item.id,
      label: game.i18n.format("WILDPATH.LEVELUP.Button", {name: item.name})})) : [];
    context.dyingModes = {auto: "WILDPATH.SHEET.DyingMode.auto", deathSaves: "WILDPATH.SHEET.DyingMode.deathSaves",
      dies: "WILDPATH.SHEET.DyingMode.dies"};
    return context;
  }

  /**
   * A right-click on a stacking condition removes one of its levels (a click adds one). A gear row's quantity is the
   * Item's own field, so it is saved on that Item rather than with the Actor's form.
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const input of this.element.querySelectorAll("input[data-item-field]") ) {
      input.addEventListener("change", event => {
        event.stopPropagation();
        const item = this.actor.items.get(input.closest("[data-item-id]")?.dataset.itemId);
        const value = Number(input.value);
        if ( item && Number.isFinite(value) ) void item.update({[input.dataset.itemField]: Math.max(0, value)});
      });
    }
    for ( const element of this.element.querySelectorAll("[data-condition-id][data-stacking]") ) {
      element.addEventListener("contextmenu", event => {
        event.preventDefault();
        void this.actor.toggleCondition(element.dataset.conditionId, {levels: -1});
      });
    }
  }

  /** A class, species or background dropped from elsewhere asks its level's choices (G8). */
  async _onDropItem(event, item) {
    const moved = item.parent?.uuid === this.actor.uuid;
    const created = await super._onDropItem(event, item);
    if ( created && !moved && LEVELLED.has(created.type) ) {
      await levelUp(this.actor, created, {level: created.type === "class" ? (Number(created.system.levels) || 1) : 0});
    }
    return created;
  }

  /**
   * Pool fields are written as `system.pools.<index>.<field>`; V14 drops ArrayField element paths, so they are
   * folded into the whole stored array.
   * @override
   */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    // Training is typed as a comma-separated list.
    for ( const key of TRAINING ) {
      const value = data.system?.training?.[key];
      if ( typeof value === "string" ) data.system.training[key] = value.split(",").map(entry => entry.trim()).filter(Boolean);
    }
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

  /** @this {WildPathActorSheet} The next level of a class. */
  static async #onLevelUp(event, target) {
    const item = this.actor.items.get(target.dataset.itemId);
    if ( item ) await levelUp(this.actor, item, {level: (Number(item.system.levels) || 1) + 1});
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

  /** @this {WildPathActorSheet} Equipping gear turns its rules on (`system.active`). */
  static async #onToggleEquipped(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( item ) await item.update({"system.active": !item.system.active});
  }

  /** 2024: a creature is attuned to at most three magic items at once. */
  static async #onToggleAttuned(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( !item ) return;
    const attuning = item.system.attunement === "required";
    if ( attuning && (this.actor.items.filter(entry => entry.system?.attunement === "attuned").length >= 3) ) {
      return void ui.notifications.warn(game.i18n.localize("WILDPATH.SHEET.AttuneLimit"));
    }
    await item.update({"system.attunement": attuning ? "attuned" : "required"});
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

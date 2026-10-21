import {xpForLevel} from "../helpers/encounters.mjs";
import {createActorSheetViewModel} from "../helpers/character-sheet-view-models.mjs";
import {actorProficiencyBonus, resolveActorCheckStatistic, resolveActorDefense} from "../helpers/combat-statistics.mjs";
import {levelUp} from "./level-up.mjs";
import {ruleProblems} from "../helpers/rule-guard.mjs";
import {portentDice, portentFeature} from "../adapters/foundry-v14-portent.mjs";
import {LANGUAGES} from "../helpers/level-up.mjs";
import {chooseAbilityScores} from "./ability-scores.mjs";
import {mysticArcanumPoolId, preparedSpellLimit, preparesSpell, spellBaseLevel} from "../helpers/spellcasting.mjs";

/** Item types whose drop opens the level-up dialog (G8): a class's first level, a species or background. */
const LEVELLED = new Set(["class", "species", "background"]);

/** What the sheet's training fields list (comma-separated names). */
const TRAINING = ["armor", "weapons", "tools", "masteries", "languages"];
const LANGUAGE_KEYS = [...LANGUAGES.standard, ...LANGUAGES.rare, "telepathy"];

/** A language's name from its key; free text ("understands Common but can't speak") stays as it is. */
function languageLabel(name) {
  const key = `WILDPATH.LANGUAGES.${name}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : name;
}

/** A language typed by its name as its key; anything else as typed. */
function languageKey(entry) {
  return LANGUAGE_KEYS.find(key => (key === entry.toLowerCase()) || (languageLabel(key).toLowerCase() === entry.toLowerCase())) ?? entry;
}

/** A language a rule gives, in words: "Telepathy 120 ft.", "Any language (spoken)", "Elvish (Telepathic Bond)". */
function grantedLanguageLabel(grant) {
  const name = languageLabel(grant.language);
  const ranged = Number(grant.range) > 0 ? game.i18n.format("WILDPATH.LANGUAGES.Ranged", {language: name, range: grant.range}) : name;
  const notes = [grant.spokenOnly ? "WILDPATH.LANGUAGES.Spoken" : null, grant.bond ? "WILDPATH.LANGUAGES.Bond" : null].filter(Boolean)
    .map(note => game.i18n.localize(note));
  return notes.length ? `${ranged} (${notes.join(", ")})` : ranged;
}

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ActorSheetV2} = foundry.applications.sheets;

/**
 * ActorSheet for the WildPath system's groundwork phase.
 * The sheet stays presentation-focused: action use still routes through the Actor/Item document API.
 */
/** The 2024 Challenge Ratings. */
const CHALLENGE_RATINGS = Object.freeze([0, 0.125, 0.25, 0.5, ...Array.from({length: 30}, (_, index) => index + 1)]);
const challengeLabel = value => ({0.125: "1/8", 0.25: "1/4", 0.5: "1/2"})[value] ?? String(value);

export default class WildPathActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "actor", "themed", "theme-light"],
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
      endEnchantment: WildPathActorSheet.#onEndEnchantment,
      levelUp: WildPathActorSheet.#onLevelUp,
      abilityScores: WildPathActorSheet.#onAbilityScores,
      togglePrepared: WildPathActorSheet.#onTogglePrepared,
      toggleArcanum: WildPathActorSheet.#onToggleArcanum,
      rollTest: WildPathActorSheet.#onRollTest,
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
    // A character's experience, toward its next level (the `advancement` setting at XP).
    if ( (this.actor.type === "character") && (game.settings.get("wildpath", "advancement") === "xp") ) {
      const level = Number(this.actor.system.details?.level) || 1;
      context.experience = {value: Number(this.actor.system.details?.xp) || 0, next: (level < 20) ? xpForLevel(level + 1) : null};
    }
    // The sheet edits the creature's own training and proficiencies (its source); what its Items give it is shown
    // beside them, never saved as its own (G8: losing the Item loses it).
    const own = this.actor._source?.system ?? {};
    for ( const ability of context.abilities ?? [] ) {
      const mine = own.abilities?.[ability.key]?.saveProficient === true;
      ability.saveGranted = ability.saveProficient && !mine;
      ability.saveProficient = mine;
    }
    // Each skill with its check bonus (ability, proficiency or expertise, Modifiers), and its proficiency to set.
    const signed = value => (value < 0 ? `${value}` : `+${value}`);
    context.skills = Object.entries(CONFIG.WILDPATH.SKILLS ?? {}).map(([key, skill]) => ({key, label: skill.label,
      abilityLabel: CONFIG.WILDPATH.ABILITIES[skill.ability]?.label ?? skill.ability,
      proficiency: own.skills?.[key]?.proficiency ?? 0,
      granted: ((this.actor.system.skills?.[key]?.proficiency ?? 0) > (own.skills?.[key]?.proficiency ?? 0))
        ? `WILDPATH.SHEET.SkillProficiency.${["None", "Proficient", "Expertise"][this.actor.system.skills[key].proficiency] ?? "Proficient"}` : null,
      modifierText: signed(resolveActorCheckStatistic(this.actor, {skill: key})?.totalModifier ?? 0)}));
    context.proficiencyLevels = {0: "WILDPATH.SHEET.SkillProficiency.None", 1: "WILDPATH.SHEET.SkillProficiency.Proficient",
      2: "WILDPATH.SHEET.SkillProficiency.Expertise"};
    // Languages by their names; what its rules give beside them ("Telepathy 120 ft.", "Any language (spoken)").
    const named = (key, names) => ((key === "languages") ? names.map(languageLabel) : names);
    const grants = (key) => ((key === "languages") ? (this.actor.getGrantedLanguages?.() ?? []).map(grantedLanguageLabel) : []);
    context.training = TRAINING.map(key => ({key, label: `WILDPATH.SHEET.Training.${key}`, hint: `WILDPATH.SHEET.Training.Hint.${key}`,
      value: named(key, own.training?.[key] ?? []).join(", "),
      granted: [...named(key, (this.actor.system.training?.[key] ?? []).filter(name => !(own.training?.[key] ?? []).includes(name))),
        ...grants(key)].join(", ")}));
    context.typeLabel = CONFIG.Actor.typeLabels?.[this.actor.type] ?? this.actor.type;
    // Its biography as read (links, language tags), edited as written.
    context.enrichedBiography = await foundry.applications.ux.TextEditor.implementation.enrichHTML(this.actor.system.biography ?? "",
      {relativeTo: this.actor, secrets: this.actor.isOwner});
    // A creature's Challenge Rating, fractions included (1/8, 1/4, 1/2).
    if ( this.actor.type === "npc" ) {
      context.challengeOptions = Object.fromEntries(CHALLENGE_RATINGS.map(value => [String(value), challengeLabel(value)]));
      context.challenge = String(this.actor.system.details?.threat ?? 0);
    }
    // Where each effect came from, by name (never a raw uuid).
    for ( const entry of context.effects ?? [] ) {
      const effect = this.actor.effects.get(entry.id);
      const ref = String(effect?.flags?.wildpath?.conditionEffect?.sourceRef ?? effect?.origin ?? "").replace(/^uuid:/, "");
      const source = ref ? fromUuidSync(ref, {strict: false}) : null;
      entry.sourceName = (source && (source !== this.actor)) ? (source.name ?? null) : null;
    }
    // An Item's enchantments (an Artificer's infusions), each of which can be ended.
    for ( const row of context.gearItems ?? [] ) row.enchantments = [...(this.actor.items.get(row.id)?.effects ?? [])]
      .filter(effect => effect.flags?.wildpath?.enchantment).map(effect => ({id: effect.id, name: effect.name}));
    // Items and effects whose rules can't be read (they are skipped): named, so they can be opened and fixed.
    context.brokenRules = [...this.actor.items, ...this.actor.effects]
      .filter(document => (document.system?.ruleElements ?? []).length && ruleProblems(document.system.ruleElements).length)
      .map(document => document.name);
    // A Diviner's foretelling rolls not yet used (Portent).
    context.portent = portentFeature(this.actor) ? portentDice(this.actor).map(die => die.value).join(", ") : "";
    // A "Level up" button per class while the character is below level 20 (G8).
    const classes = this.actor.items.filter(item => item.type === "class");
    const total = classes.reduce((sum, item) => sum + (Number(item.system.levels) || 0), 0);
    context.levelUps = this.isEditable && (total < 20) ? classes.map(item => ({id: item.id,
      label: game.i18n.format("WILDPATH.LEVELUP.Button", {name: item.name})})) : [];
    // Ability scores are generated at creation (2024: after the class, before the background's increases).
    context.canChooseAbilityScores = this.isEditable && (this.actor.type === "character") && (total <= 1)
      && !this.actor.items.some(item => item.type === "background");
    // Spells of 1st level or higher are prepared (2024): a toggle on each, and the count against the classes' limit.
    for ( const row of context.actionItems ?? [] ) {
      const item = this.actor.items.get(row.id);
      row.prepares = preparesSpell(item);
      row.prepared = item?.system?.prepared !== false;
      // A spell of level 6 to 9 may be its level's Mystic Arcanum while the creature has that arcanum.
      const level = item?.system?.definition?.tags?.includes("spell") ? spellBaseLevel(item.system.definition) : null;
      const pool = (level >= 6) ? this.actor.system.pools.find(entry => entry.id === mysticArcanumPoolId(level)) : null;
      row.arcanum = (pool && (pool.max > 0)) ? {level, on: item.flags?.wildpath?.arcanum === true} : null;
    }
    const preparing = this.actor.items.filter(preparesSpell);
    const limit = preparedSpellLimit(classes, [...this.actor.items]);
    const count = preparing.filter(item => item.system.prepared !== false).length;
    context.preparedSpells = (preparing.length || (limit !== null)) ? {count, limit, over: (limit !== null) && (count > limit)} : null;
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
      // From the keyboard: "-" or Backspace lowers it, as a right-click does.
      element.addEventListener("keydown", event => {
        if ( !["-", "Backspace"].includes(event.key) ) return;
        event.preventDefault();
        void this.actor.toggleCondition(element.dataset.conditionId, {levels: -1});
      });
    }
  }

  /** A class, species or background dropped from elsewhere asks its level's choices (G8). */
  async _onDropItem(event, item) {
    const moved = item.parent?.uuid === this.actor.uuid;
    const created = await super._onDropItem(event, item);
    // An enchanted Item (an infusion) handed over from another creature this user owns moves, not copies: two copies
    // would both count against its creator's limit.
    const from = item.parent;
    if ( created && !moved && (from?.documentName === "Actor") && from.isOwner
      && [...(item.effects ?? [])].some(effect => effect.flags?.wildpath?.enchantment) ) await item.delete();
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
      if ( typeof value === "string" ) data.system.training[key] = value.split(",").map(entry => entry.trim()).filter(Boolean)
        // A language typed by its name is stored as its key ("Elvish": "elvish"); anything else as typed.
        .map(entry => ((key === "languages") ? languageKey(entry) : entry));
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
    const recovery = target.dataset.recovery;
    // A short rest first asks which Hit Dice to spend (2024); closing that dialog cancels the rest.
    if ( recovery === "shortRest" ) {
      const dice = await WildPathActorSheet.#askHitDice(this.actor);
      if ( dice === null ) return;
      await this.actor.spendHitDice(dice);
    }
    await this.actor.rest(recovery);
  }

  /** How many of each size of Hit Die to spend: `{faces: count}`, `{}` with none to spend, null when cancelled. */
  static async #askHitDice(actor) {
    const pools = actor.system.pools.filter(pool => pool.id.startsWith("hit-die.d") && (pool.value > 0));
    if ( !pools.length ) return {};
    const health = actor.system.resources.health;
    const rows = pools.map(pool => `<label>${game.i18n.format("WILDPATH.REST.HitDiceSpend", {die: pool.id.slice("hit-die.".length),
      value: pool.value, max: pool.max})} <input type="number" name="${pool.id.slice("hit-die.d".length)}" value="0" min="0"
      max="${pool.value}" step="1"></label>`).join("");
    const answer = await foundry.applications.api.DialogV2.input({classes: ["wildpath", "themed", "theme-light"],
      window: {title: game.i18n.format("WILDPATH.REST.ShortRestTitle", {name: actor.name})},
      content: `<p>${game.i18n.format("WILDPATH.REST.HitDiceHint", {value: health.value, max: health.max})}</p>${rows}`,
      ok: {label: game.i18n.localize("WILDPATH.SHEET.ShortRest")},
      rejectClose: false
    });
    return answer ? Object.fromEntries(Object.entries(answer).map(([faces, count]) => [faces, Number(count) || 0])) : null;
  }

  /** @this {WildPathActorSheet} An ability check, skill check or saving throw. */
  static async #onRollTest(event, target) {
    const {ability, skill, save} = target.dataset;
    await this.actor.rollTest({ability: ability ?? null, skill: skill ?? null, save: save ?? null});
  }

  /** @this {WildPathActorSheet} Prepare or unprepare a spell; preparing more than the classes allow warns, not blocks. */
  static async #onTogglePrepared(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( !item ) return;
    const prepared = item.system.prepared === false;
    await item.update({"system.prepared": prepared});
    const limit = preparedSpellLimit(this.actor.items.filter(entry => entry.type === "class"), [...this.actor.items]);
    const count = this.actor.items.filter(entry => preparesSpell(entry) && (entry.system.prepared !== false)).length;
    if ( prepared && (limit !== null) && (count > limit) ) {
      ui.notifications.warn(game.i18n.format("WILDPATH.SHEET.PreparedOver", {name: this.actor.name, count, limit}));
    }
  }

  /** @this {WildPathActorSheet} Make a spell its level's Mystic Arcanum (one a level), or no longer. */
  static async #onToggleArcanum(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( !item ) return;
    const on = item.flags?.wildpath?.arcanum !== true;
    const level = spellBaseLevel(item.system.definition);
    const others = this.actor.items.filter(entry => (entry !== item) && (entry.flags?.wildpath?.arcanum === true)
      && (spellBaseLevel(entry.system.definition) === level));
    await this.actor.updateEmbeddedDocuments("Item", [{_id: item.id, "flags.wildpath.arcanum": on},
      ...(on ? others.map(entry => ({_id: entry.id, "flags.wildpath.arcanum": false})) : [])]);
  }

  /** @this {WildPathActorSheet} Generate the six ability scores (standard array, point buy or 4d6). */
  static async #onAbilityScores() {
    await chooseAbilityScores(this.actor);
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
  /** End one of an Item's enchantments (an infusion): only its own rules go. */
  static async #onEndEnchantment(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    await item?.effects?.get(target.dataset.effectId)?.delete();
  }

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

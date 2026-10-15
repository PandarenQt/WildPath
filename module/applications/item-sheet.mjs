import {CUSTOM_EFFECT_DURATION_UNITS, CUSTOM_EFFECT_EXPIRY_EVENTS, validateActionDefinition} from "../helpers/action-definitions.mjs";
import {summarizeActionDefinition} from "../helpers/action-definition-summary.mjs";
import {ACTION_TEMPLATES, addBuilderRow, applyActionTemplate, builderIssues, builderToDefinition, definitionToBuilder,
  removeBuilderRow, spellSlotChoice} from "../helpers/action-builder.mjs";
import {DEFAULT_RULE_ELEMENT_REGISTRY, validateRuleElementDefinition} from "../helpers/rule-elements.mjs";
import {addRule, removeRule, ruleIssues, rowsToRules} from "../helpers/rule-builder.mjs";
import {RULE_ROWS_TEMPLATE, ruleButtonPath, ruleRowsContext} from "./rule-rows.mjs";
import {previewAction} from "../helpers/action-preview.mjs";
import {actionCombatStatistics, resolveActorCheckStatistic} from "../helpers/combat-statistics.mjs";
import {foundryActorSystemSnapshot} from "../adapters/foundry-v14-actor-system-adapter.mjs";

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ItemSheetV2} = foundry.applications.sheets;

/** What the engine's validator finds wrong with a list of RuleElements; empty when it is valid. */
export function ruleElementListErrors(ruleElements) {
  if ( !Array.isArray(ruleElements) ) return ["RuleElements must be a list."];
  return ruleElements.flatMap((entry, index) => {
    const result = validateRuleElementDefinition(entry, {index});
    if ( !result.ok ) return [`${index}: ${result.reason ?? result.code}`];
    // The validator checks shape only; a type no handler knows would be skipped when the rules are read.
    return DEFAULT_RULE_ELEMENT_REGISTRY.has(result.ruleElement.type) ? [] : [`${index}: Unknown RuleElement type: ${entry.type}`];
  });
}

/** 2024 damage types, offered as suggestions; any slug is accepted. */
const DAMAGE_TYPES = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant",
  "slashing", "thunder"];

const choices = (values, prefix) => Object.fromEntries(values.map(value => [value, `${prefix}${value || "NotSet"}`]));

/**
 * The WildPath ItemSheet. An Action is built on the Builder tab (homebrew-content-builder.md, second slice): plain
 * fields that write into its definition, checked by the engine's validator before anything is saved. Every Item's
 * RuleElements are rows on the Rules tab (third slice). The Advanced tab keeps the JSON editors, and an invalid draft
 * on any tab stays on the sheet with its errors and is not saved.
 */
export default class WildPathItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "sheet", "item"],
    position: {width: 620, height: 720},
    form: {submitOnChange: true},
    actions: {
      builderAdd: WildPathItemSheet.#onBuilderAdd,
      builderRemove: WildPathItemSheet.#onBuilderRemove,
      builderTemplate: WildPathItemSheet.#onBuilderTemplate,
      builderTest: WildPathItemSheet.#onBuilderTest,
      ruleAdd: WildPathItemSheet.#onRuleAdd,
      ruleRemove: WildPathItemSheet.#onRuleRemove
    }
  };

  /** @override */
  static PARTS = {
    header: {template: "systems/wildpath/templates/item/header.hbs"},
    tabs: {template: "templates/generic/tab-navigation.hbs"},
    builder: {template: "systems/wildpath/templates/item/builder.hbs", templates: [RULE_ROWS_TEMPLATE], scrollable: [""]},
    rules: {template: "systems/wildpath/templates/item/rules.hbs", templates: [RULE_ROWS_TEMPLATE], scrollable: [""]},
    test: {template: "systems/wildpath/templates/item/test.hbs", templates: ["systems/wildpath/templates/apps/resolution-detail.hbs"],
      scrollable: [""]},
    advanced: {template: "systems/wildpath/templates/item/advanced.hbs", scrollable: [""]},
    description: {template: "systems/wildpath/templates/item/description.hbs"}
  };

  /** @override */
  static TABS = {
    sheet: {tabs: [{id: "builder", label: "WILDPATH.ITEMSHEET.Tab.builder"}, {id: "rules", label: "WILDPATH.ITEMSHEET.Tab.rules"},
      {id: "test", label: "WILDPATH.ITEMSHEET.Tab.test"}, {id: "advanced", label: "WILDPATH.ITEMSHEET.Tab.advanced"}, {id: "description", label: "WILDPATH.ITEMSHEET.Tab.description"}],
    initial: "builder"}
  };

  /**
   * Drafts kept across renders until they are fixed: `definition` and `ruleElements` (JSON, `{text, errors}`), and
   * `builder` and `rules` (rows, `{values, errors, issues}`).
   */
  #drafts = {};

  /** The Test tab's sample target and d20, and its last preview (`previewAction`). */
  #test = {ac: 13, health: 30, saveBonus: 0, d20: 10, result: null};

  /** Options the builder reads formulas and fills defaults with. */
  get #builderOptions() {
    return {abilities: Object.keys(CONFIG.WILDPATH.ABILITIES), conditions: Object.keys(CONFIG.WILDPATH.CONDITIONS),
      fallbackId: `action:${this.item.id}`};
  }

  /* -------------------------------------------- */

  /** Only an Action has a Builder and a Test tab. @override */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    if ( this.item.type !== "action" ) {
      delete parts.builder;
      delete parts.test;
    }
    return parts;
  }

  /** @override */
  _getTabsConfig(group) {
    const config = super._getTabsConfig(group);
    if ( (group !== "sheet") || (this.item.type === "action") ) return config;
    return {...config, tabs: config.tabs.filter(tab => !["builder", "test"].includes(tab.id)), initial: "rules"};
  }

  /** @override */
  _prepareTabs(group) {
    const config = this._getTabsConfig(group);
    if ( config && !config.tabs.some(tab => tab.id === this.tabGroups[group]) ) this.tabGroups[group] = config.initial;
    return super._prepareTabs(group);
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if ( context.tabs?.[partId] ) context.tab = context.tabs[partId];
    return context;
  }

  /* -------------------------------------------- */

  /**
   * Modifier `domains` is a SetField edited as a comma-separated list. Modifier fields are written as
   * `system.modifiers.<index>.<field>`, which V14 drops for ArrayFields, so they are folded into the whole array.
   * The Builder and the JSON editors are read and validated here; only a valid definition reaches the document.
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
    if ( this.item.type === "action" ) {
      const definition = this.#definitionFromBuilder(drafts.builder) ?? this.#definitionFromJson(drafts.definitionJson);
      if ( definition ) foundry.utils.setProperty(submitData, "system.definition", this.#replacement(definition));
    }
    const ruleElements = this.#rulesFromRows(drafts.rules) ?? this.#rulesFromJson(drafts.ruleElementsJson);
    if ( ruleElements ) foundry.utils.setProperty(submitData, "system.ruleElements", ruleElements);
    return submitData;
  }

  /** The RuleElements the Rules tab's changed rows make, or null when they changed nothing or are kept as a draft. */
  #rulesFromRows(values) {
    if ( !values ) return null;
    const result = rowsToRules(values, this.item.toObject(true).system.ruleElements, {field: "wildpath.rules",
      abilities: this.#builderOptions.abilities});
    if ( result.errors.length ) {
      this.#drafts.rules = {values, errors: result.errors};
      return null;
    }
    if ( !result.changed ) {
      delete this.#drafts.rules;
      return null;
    }
    const issues = ruleElementListErrors(result.ruleElements);
    if ( issues.length ) {
      this.#drafts.rules = {values, errors: [], issues};
      return null;
    }
    delete this.#drafts.rules;
    delete this.#drafts.ruleElements;
    return result.ruleElements;
  }

  /** The RuleElements typed in the Advanced JSON editor, when they differ from the stored ones and are valid. */
  #rulesFromJson(text) {
    if ( typeof text !== "string" ) return null;
    const stored = JSON.stringify(this.item.toObject(true).system.ruleElements ?? [], null, 2);
    if ( !this.#drafts.ruleElements && (text.replace(/\r\n/g, "\n") === stored) ) return null;
    return this.#parseDraft("ruleElements", text, ruleElementListErrors);
  }

  /**
   * The edited definition replaces the stored one whole: keys it leaves out return to their initial value. Without
   * ForcedReplacement, V14 merges nested objects, so a key removed inside one (attack.properties) would survive.
   */
  #replacement(definition) {
    return foundry.data.operators.ForcedReplacement.create({...this.item.system.schema.fields.definition.getInitialValue(), ...definition});
  }

  /** The definition the Builder's changed fields make, or null when they changed nothing or are kept as a draft. */
  #definitionFromBuilder(values) {
    if ( !values ) return null;
    const result = builderToDefinition(values, this.item.toObject(true).system.definition, this.#builderOptions);
    if ( result.errors.length ) {
      this.#drafts.builder = {values, errors: result.errors};
      return null;
    }
    if ( !result.changed ) {
      delete this.#drafts.builder;
      return null;
    }
    if ( !validateActionDefinition(result.definition).ok ) {
      this.#drafts.builder = {values, errors: [], issues: builderIssues(result.definition)};
      return null;
    }
    delete this.#drafts.builder;
    delete this.#drafts.definition;
    return result.definition;
  }

  /** The definition typed in the Advanced JSON editor, when it differs from the stored one and is valid. */
  #definitionFromJson(text) {
    if ( typeof text !== "string" ) return null;
    const stored = JSON.stringify(this.item.toObject(true).system.definition, null, 2);
    if ( !this.#drafts.definition && (text.replace(/\r\n/g, "\n") === stored) ) return null;
    return this.#parseDraft("definition", text, parsed => validateActionDefinition(parsed).errors
      ?.map(entry => `${entry.path}: ${entry.reason}`) ?? []);
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

  /* -------------------------------------------- */

  /** Save a definition made by a Builder button, after folding in what the form holds now. */
  async #editDefinition(change) {
    const values = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(this.form).object).wildpath?.builder;
    const result = builderToDefinition(values, this.item.toObject(true).system.definition, this.#builderOptions);
    if ( result.errors.length ) return ui.notifications.warn("WILDPATH.BUILDER.FixFirst", {localize: true});
    const definition = change(result.definition);
    if ( !definition.id ) definition.id = this.#builderOptions.fallbackId;
    delete this.#drafts.builder;
    delete this.#drafts.definition;
    return this.item.update({system: {definition: this.#replacement(definition)}});
  }

  /** Add or remove a rule row: on the Rules tab (`item`) or in an Action's custom effect (`effect:<index>`). */
  async #editRules(target, change) {
    const {list, path} = ruleButtonPath(target);
    if ( list !== "item" ) {
      const index = Number(list.split(":")[1]);
      return this.#editDefinition(definition => {
        const effect = definition.effects?.[index];
        if ( effect ) effect.ruleElements = change(effect.ruleElements ?? [], path);
        return definition;
      });
    }
    const values = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(this.form).object).wildpath?.rules;
    const result = rowsToRules(values, this.item.toObject(true).system.ruleElements, {field: "wildpath.rules",
      abilities: this.#builderOptions.abilities});
    if ( result.errors.length ) return ui.notifications.warn("WILDPATH.BUILDER.FixFirst", {localize: true});
    delete this.#drafts.rules;
    delete this.#drafts.ruleElements;
    return this.item.update({system: {ruleElements: change(result.ruleElements, path)}});
  }

  /**
   * Run the Action against the Test tab's sample target: the owner's own statistics (or a sample creature for an
   * unowned Action), fixed dice, and nothing committed.
   */
  static async #onBuilderTest() {
    const values = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(this.form).object).wildpath?.test ?? {};
    for ( const key of ["ac", "health", "saveBonus", "d20"] ) {
      if ( Number.isFinite(Number(values[key])) && (values[key] !== null) ) this.#test[key] = Number(values[key]);
    }
    const definition = this.item.toObject(true).system.definition;
    const actor = this.item.actor;
    let actorSystem = null;
    const statistics = {};
    if ( actor ) {
      actorSystem = foundryActorSystemSnapshot(actor);
      const normalized = this.item.system.getActionDefinition().definition ?? definition;
      Object.assign(statistics, actionCombatStatistics(actor, normalized, {item: this.item}));
      if ( normalized.check ) {
        const bonus = resolveActorCheckStatistic(actor, {ability: normalized.check.ability ?? null, skill: normalized.check.skill ?? null});
        statistics.check = bonus ? {modifier: bonus.totalModifier} : {};
      }
    }
    this.#test.result = await previewAction(definition, {actorSystem, statistics, d20: this.#test.d20, label: this.item.name,
      target: {ac: this.#test.ac, health: this.#test.health, saveBonus: this.#test.saveBonus,
        name: game.i18n.localize("WILDPATH.TEST.Target")}});
    await this.render({parts: ["test"]});
  }

  static async #onRuleAdd(event, target) {
    await this.#editRules(target, (rules, path) => addRule(rules, "bonus", path));
  }

  static async #onRuleRemove(event, target) {
    await this.#editRules(target, (rules, path) => removeRule(rules, path.at(-1), path.slice(0, -1)));
  }

  static async #onBuilderAdd(event, target) {
    await this.#editDefinition(definition => addBuilderRow(definition, target.dataset.section, this.#builderOptions));
  }

  static async #onBuilderRemove(event, target) {
    await this.#editDefinition(definition => removeBuilderRow(definition, target.dataset.section, Number(target.dataset.index)));
  }

  /** Replace the definition with a template; an Action that already does something asks first. */
  static async #onBuilderTemplate() {
    const key = this.element.querySelector(".template-choice")?.value;
    const stored = this.item.toObject(true).system.definition;
    const doesSomething = ["range", "targeting", "area", "attack", "save", "check"].some(part => stored[part])
      || ["damage", "healing", "effects", "configuration"].some(part => stored[part]?.length);
    if ( doesSomething && !(await foundry.applications.api.DialogV2.confirm({window: {title: "WILDPATH.BUILDER.Template.Legend"},
      content: `<p>${game.i18n.localize("WILDPATH.BUILDER.Template.Confirm")}</p>`})) ) return;
    const definition = applyActionTemplate(stored, key, this.#builderOptions);
    if ( !definition ) return;
    delete this.#drafts.builder;
    delete this.#drafts.definition;
    await this.item.update({system: {definition: this.#replacement(definition)}});
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const source = this.item.toObject(true).system;
    context.item = this.item;
    context.system = this.item.system;
    context.isAction = this.item.type === "action";
    context.isGear = this.item.type === "gear";
    context.armorKinds = {"": "WILDPATH.ITEMSHEET.ArmorKind.none", light: "WILDPATH.ITEMSHEET.ArmorKind.light",
      medium: "WILDPATH.ITEMSHEET.ArmorKind.medium", heavy: "WILDPATH.ITEMSHEET.ArmorKind.heavy", shield: "WILDPATH.ITEMSHEET.ArmorKind.shield"};
    // A class, subclass, species or background (G8): its own fields, and what each level gives.
    context.progression = ["class", "subclass", "species", "background"].includes(this.item.type) ? {
      isClass: this.item.type === "class", isSubclass: this.item.type === "subclass", isSpecies: this.item.type === "species",
      hitDice: {6: "d6", 8: "d8", 10: "d10", 12: "d12"},
      progressions: {none: "WILDPATH.ITEMSHEET.Progression.none", full: "WILDPATH.ITEMSHEET.Progression.full",
        half: "WILDPATH.ITEMSHEET.Progression.half"},
      abilities: Object.fromEntries([["", ""], ...Object.entries(CONFIG.WILDPATH.ABILITIES).map(([key, ability]) => [key, ability.label])]),
      sizes: Object.fromEntries(["tiny", "small", "medium", "large", "huge", "gargantuan"].map(size => [size, `WILDPATH.SIZES.${size}`])),
      levels: Object.entries(Object.groupBy(this.item.system.advancement ?? [], entry => Number(entry.level) || 1))
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([level, entries]) => ({level, entries: entries.map(entry => entry.title ?? entry.type ?? "?")}))
    } : null;
    context.actionCostResources = CONFIG.WILDPATH.ACTION_COST_RESOURCES.map(key => ({key,
      label: CONFIG.WILDPATH.RESOURCES[key]?.label ?? key}));
    context.modifiers = this.item.system.modifiers.map((modifier, index) => ({
      ...modifier, index, domainsText: Array.from(modifier.domains).join(", ")
    }));
    if ( context.isAction ) {
      const definition = source.definition ?? {};
      context.definitionJson = this.#drafts.definition?.text ?? JSON.stringify(definition, null, 2);
      context.definitionErrors = this.#drafts.definition?.errors ?? [];
      context.b = this.#builderContext(definition);
      const status = this.#test.result?.status;
      context.t = {...this.#test, owner: this.item.actor?.name ?? null,
        statusText: game.i18n.has(`WILDPATH.TEST.Status.${status}`) ? game.i18n.localize(`WILDPATH.TEST.Status.${status}`) : status};
    }
    context.ruleElementsJson = this.#drafts.ruleElements?.text ?? JSON.stringify(source.ruleElements ?? [], null, 2);
    context.ruleElementErrors = this.#drafts.ruleElements?.errors ?? [];
    const rules = this.#drafts.rules;
    context.r = ruleRowsContext(source.ruleElements, {prefix: "wildpath.rules", list: "item", errors: rules?.errors ?? [],
      draft: rules?.values, editable: this.isEditable});
    context.rulesIssues = rules ? [game.i18n.localize("WILDPATH.ITEMSHEET.NotSaved"), ...(rules.issues ?? [])]
      : ruleIssues(source.ruleElements).map(issue => `${issue.index + 1}: ${issue.text}`);
    return context;
  }

  /** The Builder tab: the definition's builder values (or the draft being fixed), its choices and its issues. */
  #builderContext(definition) {
    const values = definitionToBuilder(definition);
    const draft = this.#drafts.builder;
    for ( const [section, submitted] of Object.entries(draft?.values ?? {}) ) {
      if ( Array.isArray(values[section]) ) {
        for ( const [index, row] of Object.entries(submitted ?? {}) ) if ( values[section][index] ) Object.assign(values[section][index], row);
      } else if ( values[section] ) Object.assign(values[section], submitted);
    }
    const fieldErrors = Object.fromEntries((draft?.errors ?? []).map(error => [error.field,
      game.i18n.format(`WILDPATH.BUILDER.Formula.${error.key}`, error.data)]));
    const rows = section => values[section].map((row, index) => ({...row, error: fieldErrors[`${section}.${index}.formula`],
      errorId: `${this.id}-${section}-${index}-error`}));
    const sectionLabel = section => game.i18n.localize(`WILDPATH.BUILDER.Section.${section}`);
    const issues = (draft?.issues ?? builderIssues(definition)).map(issue => ({level: issue.level,
      text: `${sectionLabel(issue.section)}: ${issue.key ? game.i18n.localize(`WILDPATH.BUILDER.Issue.${issue.key}`) : issue.text}`}));
    const {range, targets, area, roll, slot} = values;
    const conditions = CONFIG.WILDPATH.CONDITIONS;
    // A stored value the choices do not list is still shown, as itself.
    const keep = (map, value) => ((value && !(value in map)) ? {...map, [value]: value} : map);
    const abilities = Object.fromEntries(Object.entries(CONFIG.WILDPATH.ABILITIES).map(([key, ability]) => [key, ability.label]));
    const choiceCount = (definition.configuration?.length ?? 0) - (spellSlotChoice(definition.configuration) ? 1 : 0);
    const advancedOnly = [["configuration", choiceCount], ["transform", definition.transform],
      ["summon", definition.summon], ["controllerCosts", definition.controllerCosts?.allOf?.length || definition.controllerCosts?.anyOf],
      ["stabilize", definition.stabilize], ["ruleElements", definition.ruleElements?.length], ["duration", definition.duration]]
      .filter(([, present]) => present).map(([key]) => game.i18n.localize(`WILDPATH.BUILDER.Part.${key}`));
    return {
      editable: this.isEditable,
      listId: this.id,
      values,
      summary: summarizeActionDefinition(definition).map(([label, text]) => ({label, text})),
      issues: draft ? [{level: "error", text: game.i18n.localize("WILDPATH.ITEMSHEET.NotSaved")}, ...issues] : issues,
      templates: Object.fromEntries(Object.keys(ACTION_TEMPLATES).map(key => [key, `WILDPATH.BUILDER.Template.${key}`])),
      capabilities: [...Object.values(CONFIG.WILDPATH.ECONOMY_CAPABILITIES), ...Array.from({length: 9}, (_, i) => `spell-slot.${i + 1}`)],
      damageTypes: DAMAGE_TYPES,
      rangeHasDistance: ["touch", "reach", "ranged"].includes(range.type),
      rangeIsRanged: range.type === "ranged",
      targetsMultiple: targets.type === "multiple",
      showArea: (targets.type === "area") || Boolean(area.shape),
      areaIsLine: area.shape === "line",
      rollMixed: roll.kind === "mixed",
      rollIsAttack: roll.kind === "attack",
      rollIsSave: roll.kind === "save",
      rollIsCheck: roll.kind === "check",
      rollHasDC: ["save", "check"].includes(roll.kind),
      dcError: fieldErrors["roll.dc"],
      upcastError: fieldErrors["slot.upcast"],
      showSlot: values.basics.spell || Boolean(slot.level),
      showUpcast: Boolean(slot.level) && (values.damage.length > 0),
      damage: rows("damage"),
      healing: rows("healing"),
      effects: values.effects.map((row, index) => ({...row, isCondition: row.kind !== "effect", stacks: Boolean(conditions[row.conditionId]?.stacking),
        r: row.kind === "effect" ? ruleRowsContext(definition.effects[index]?.ruleElements, {prefix: `wildpath.builder.effects.${index}.rules`,
          field: `effects.${index}.rules`, list: `effect:${index}`, errors: draft?.errors ?? [], draft: draft?.values?.effects?.[index]?.rules,
          editable: this.isEditable}) : null})),
      advancedOnly: advancedOnly.join(", "),
      choices: {
        slotLevels: {"": "WILDPATH.BUILDER.Slot.None", ...Object.fromEntries(Array.from({length: 9}, (_, i) => [i + 1,
          game.i18n.format("WILDPATH.BUILDER.Slot.Level", {level: i + 1})]))},
        rangeTypes: choices(["", "self", "touch", "reach", "ranged", "sight", "special"], "WILDPATH.BUILDER.Range."),
        targetTypes: choices(["", "self", "single", "multiple", "area", "none"], "WILDPATH.BUILDER.Targets."),
        areaShapes: choices(["radial", "emanation", "cone", "line"], "WILDPATH.BUILDER.Area."),
        rollKinds: choices(["none", "attack", "save", "check"], "WILDPATH.BUILDER.Roll."),
        attackTypes: choices(["melee", "ranged"], "WILDPATH.BUILDER.Roll."),
        statistics: choices(["weapon", "spell"], "WILDPATH.BUILDER.Roll."),
        attackAbilities: {"": "WILDPATH.BUILDER.Roll.Automatic", ...abilities},
        abilities: keep(abilities, roll.saveAbility || roll.checkAbility),
        onSuccess: keep(choices(["half", "none", "full"], "WILDPATH.BUILDER.Roll.Success."), roll.onSuccess),
        provenances: values.damage.reduce((map, row) => keep(map, row.provenance),
          choices(["weapon-base", "spell-base", "additional"], "WILDPATH.BUILDER.Damage.")),
        effectKinds: choices(["condition", "effect"], "WILDPATH.BUILDER.Effects."),
        conditions: Object.fromEntries(Object.entries(conditions).map(([key, condition]) => [key, condition.name ?? key])),
        durationUnits: choices(["", ...CUSTOM_EFFECT_DURATION_UNITS], "WILDPATH.BUILDER.Units."),
        expiry: choices(["", ...CUSTOM_EFFECT_EXPIRY_EVENTS], "WILDPATH.BUILDER.Expiry.")
      }
    };
  }
}

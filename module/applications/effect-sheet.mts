import {ruleElementListErrors} from "./item-sheet.mjs";
import {addRule, removeRule, rowsToRules} from "../helpers/rule-builder.mjs";
import {RULE_ROWS_TEMPLATE, ruleButtonPath, ruleRowsContext} from "./rule-rows.mjs";

type Data = Record<string, unknown>;
interface EffectDocument {toObject(source?: boolean): {system?: {ruleElements?: unknown[]}}}
interface ConfigClass {
  new (options?: Data): object;
  DEFAULT_OPTIONS: Data;
  PARTS: Record<string, Data>;
  TABS: {sheet: {tabs: Data[]} & Data};
}
interface Globals {
  foundry: {applications: {sheets: {ActiveEffectConfig: ConfigClass}; ux: {FormDataExtended: new (form: HTMLFormElement) => {object: Data}}};
    utils: {setProperty(object: Data, key: string, value: unknown): boolean; expandObject(object: Data): Data}};
  game: {i18n: {localize(key: string): string; format(key: string, data: Data): string}};
  ui: {notifications: {warn(message: string, options?: Data): void}};
  CONFIG: {WILDPATH: {ABILITIES: Record<string, unknown>}};
}

const globals = globalThis as unknown as Globals;
const {ActiveEffectConfig} = globals.foundry.applications.sheets;
const {footer, ...parts} = ActiveEffectConfig.PARTS;
const rowOptions = () => ({field: "wildpath.rules", abilities: Object.keys(globals.CONFIG.WILDPATH.ABILITIES)});

/**
 * Foundry's effect sheet with a Rule Elements tab: the effect's RuleElements as rule rows (homebrew-content-builder.md,
 * third slice), and as JSON under Advanced. The engine's validator checks the list on Save; an invalid list keeps the
 * sheet open with the errors in a notification, and nothing is saved.
 */
export class WildPathEffectSheet extends ActiveEffectConfig {
  static override DEFAULT_OPTIONS = {classes: ["wildpath", "themed", "theme-light"], actions: {ruleAdd: WildPathEffectSheet.#onRuleAdd,
    ruleRemove: WildPathEffectSheet.#onRuleRemove}};

  static override PARTS = {...parts, ruleElements: {template: "systems/wildpath/templates/effect/rule-elements.hbs",
    templates: [RULE_ROWS_TEMPLATE], scrollable: [""]}, footer: footer!};

  static override TABS = {sheet: {...ActiveEffectConfig.TABS.sheet, tabs: [...ActiveEffectConfig.TABS.sheet.tabs,
    {id: "ruleElements", icon: "fa-solid fa-scroll", label: "WILDPATH.ITEMSHEET.RuleElements"}]}};

  declare document: EffectDocument;
  declare form: HTMLFormElement;
  declare isEditable: boolean;
  declare submit: (options?: Data) => Promise<unknown>;

  async _preparePartContext(partId: string, context: Data) {
    // @ts-expect-error The Foundry base class is typed only as far as this file needs.
    const partContext: Data = await super._preparePartContext(partId, context);
    if ( partId === "ruleElements" ) {
      const stored = this.document.toObject(true).system?.ruleElements ?? [];
      partContext.ruleElementsJson = JSON.stringify(stored, null, 2);
      partContext.r = ruleRowsContext(stored, {prefix: "wildpath.rules", list: "effect", editable: this.isEditable});
    }
    return partContext;
  }

  /** The rows' list when they changed, else the JSON's when it differs from the stored list; throws on a mistake. */
  _processFormData(event: Event, form: HTMLFormElement, formData: unknown) {
    // @ts-expect-error The Foundry base class is typed only as far as this file needs.
    const submitData: Data = super._processFormData(event, form, formData);
    const drafts = (submitData.wildpath ?? {}) as {rules?: unknown; ruleElementsJson?: unknown};
    delete submitData.wildpath;
    const stored = this.document.toObject(true).system?.ruleElements ?? [];
    const rows = rowsToRules(drafts.rules, stored, rowOptions());
    let errors: string[] = rows.errors.map(error => globals.game.i18n.format(`WILDPATH.BUILDER.Formula.${error.key}`, error.data));
    let ruleElements: unknown = rows.changed ? rows.ruleElements : null;
    const text = drafts.ruleElementsJson;
    if ( !errors.length && !ruleElements && (typeof text === "string") && (text.replace(/\r\n/g, "\n") !== JSON.stringify(stored, null, 2)) ) {
      try {
        ruleElements = JSON.parse(text);
      } catch (error) {
        errors = [(error as Error).message];
      }
    }
    if ( ruleElements ) errors.push(...ruleElementListErrors(ruleElements));
    if ( errors.length ) throw new Error(`${globals.game.i18n.localize("WILDPATH.ITEMSHEET.NotSaved")} ${errors.join("; ")}`);
    if ( ruleElements ) globals.foundry.utils.setProperty(submitData, "system.ruleElements", ruleElements);
    return submitData;
  }

  /** Add or remove a rule row: the form is folded in and saved, as Foundry's own change rows are. */
  async #editRules(target: HTMLElement, change: (rules: unknown[], path: number[]) => unknown[]) {
    const {path} = ruleButtonPath(target);
    const values = globals.foundry.utils.expandObject(new globals.foundry.applications.ux.FormDataExtended(this.form).object)
      .wildpath as {rules?: unknown} | undefined;
    const result = rowsToRules(values?.rules, this.document.toObject(true).system?.ruleElements ?? [], rowOptions());
    if ( result.errors.length ) return globals.ui.notifications.warn("WILDPATH.BUILDER.FixFirst", {localize: true});
    return this.submit({updateData: {system: {ruleElements: change(result.ruleElements, path)}}});
  }

  static async #onRuleAdd(this: WildPathEffectSheet, _event: Event, target: HTMLElement) {
    await this.#editRules(target, (rules, path) => addRule(rules, "bonus", path));
  }

  static async #onRuleRemove(this: WildPathEffectSheet, _event: Event, target: HTMLElement) {
    await this.#editRules(target, (rules, path) => removeRule(rules, path.at(-1) ?? 0, path.slice(0, -1)));
  }
}

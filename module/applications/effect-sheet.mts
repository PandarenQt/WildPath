import {ruleElementListErrors} from "./item-sheet.mjs";

type Data = Record<string, unknown>;
interface EffectDocument {toObject(source?: boolean): {system?: {ruleElements?: unknown[]}}}
interface ConfigClass {
  new (options?: Data): object;
  DEFAULT_OPTIONS: Data;
  PARTS: Record<string, Data>;
  TABS: {sheet: {tabs: Data[]} & Data};
}
interface Globals {
  foundry: {applications: {sheets: {ActiveEffectConfig: ConfigClass}}; utils: {setProperty(object: Data, key: string, value: unknown): boolean}};
  game: {i18n: {localize(key: string): string}};
}

const globals = globalThis as unknown as Globals;
const {ActiveEffectConfig} = globals.foundry.applications.sheets;
const {footer, ...parts} = ActiveEffectConfig.PARTS;

/**
 * Foundry's effect sheet with a Rule Elements tab, edited as JSON like the item sheet's
 * (homebrew-content-builder.md, first slice). The engine's validator checks the list on Save; an invalid list
 * keeps the sheet open with the errors in a notification, and nothing is saved.
 */
export class WildPathEffectSheet extends ActiveEffectConfig {
  static override DEFAULT_OPTIONS = {classes: ["wildpath"]};

  static override PARTS = {...parts, ruleElements: {template: "systems/wildpath/templates/effect/rule-elements.hbs"}, footer: footer!};

  static override TABS = {sheet: {...ActiveEffectConfig.TABS.sheet, tabs: [...ActiveEffectConfig.TABS.sheet.tabs,
    {id: "ruleElements", icon: "fa-solid fa-scroll", label: "WILDPATH.ITEMSHEET.RuleElements"}]}};

  declare document: EffectDocument;

  async _preparePartContext(partId: string, context: Data) {
    // @ts-expect-error The Foundry base class is typed only as far as this file needs.
    const partContext: Data = await super._preparePartContext(partId, context);
    if ( partId === "ruleElements" ) {
      partContext.ruleElementsJson = JSON.stringify(this.document.toObject(true).system?.ruleElements ?? [], null, 2);
    }
    return partContext;
  }

  _processFormData(event: Event, form: HTMLFormElement, formData: unknown) {
    // @ts-expect-error The Foundry base class is typed only as far as this file needs.
    const submitData: Data = super._processFormData(event, form, formData);
    const text = (submitData.wildpath as {ruleElementsJson?: unknown} | undefined)?.ruleElementsJson;
    delete submitData.wildpath;
    if ( typeof text !== "string" ) return submitData;
    let ruleElements: unknown;
    let errors: string[];
    try {
      ruleElements = JSON.parse(text);
      errors = ruleElementListErrors(ruleElements);
    } catch (error) {
      errors = [(error as Error).message];
    }
    if ( errors.length ) throw new Error(`${globals.game.i18n.localize("WILDPATH.ITEMSHEET.NotSaved")} ${errors.join("; ")}`);
    globals.foundry.utils.setProperty(submitData, "system.ruleElements", ruleElements);
    return submitData;
  }
}

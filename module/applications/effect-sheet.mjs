import { ruleElementListErrors } from "./item-sheet.mjs";
import { addRule, removeRule, rowsToRules } from "../helpers/rule-builder.mjs";
import { RULE_ROWS_TEMPLATE, ruleButtonPath, ruleRowsContext } from "./rule-rows.mjs";
const globals = globalThis;
const { ActiveEffectConfig } = globals.foundry.applications.sheets;
const { footer, ...parts } = ActiveEffectConfig.PARTS;
const rowOptions = () => ({ field: "wildpath.rules", abilities: Object.keys(globals.CONFIG.WILDPATH.ABILITIES) });
/**
 * Foundry's effect sheet with a Rule Elements tab: the effect's RuleElements as rule rows (homebrew-content-builder.md,
 * third slice), and as JSON under Advanced. The engine's validator checks the list on Save; an invalid list keeps the
 * sheet open with the errors in a notification, and nothing is saved.
 */
export class WildPathEffectSheet extends ActiveEffectConfig {
    static DEFAULT_OPTIONS = { classes: ["wildpath", "themed", "theme-light"], actions: { ruleAdd: WildPathEffectSheet.#onRuleAdd,
            ruleRemove: WildPathEffectSheet.#onRuleRemove } };
    static PARTS = { ...parts, ruleElements: { template: "systems/wildpath/templates/effect/rule-elements.hbs",
            templates: [RULE_ROWS_TEMPLATE], scrollable: [""] }, footer: footer };
    static TABS = { sheet: { ...ActiveEffectConfig.TABS.sheet, tabs: [...ActiveEffectConfig.TABS.sheet.tabs,
                { id: "ruleElements", icon: "fa-solid fa-scroll", label: "WILDPATH.ITEMSHEET.RuleElements" }] } };
    async _preparePartContext(partId, context) {
        // @ts-expect-error The Foundry base class is typed only as far as this file needs.
        const partContext = await super._preparePartContext(partId, context);
        if (partId === "ruleElements") {
            const stored = this.document.toObject(true).system?.ruleElements ?? [];
            partContext.ruleElementsJson = JSON.stringify(stored, null, 2);
            partContext.r = ruleRowsContext(stored, { prefix: "wildpath.rules", list: "effect", editable: this.isEditable });
        }
        return partContext;
    }
    /** The rows' list when they changed, else the JSON's when it differs from the stored list; throws on a mistake. */
    _processFormData(event, form, formData) {
        // @ts-expect-error The Foundry base class is typed only as far as this file needs.
        const submitData = super._processFormData(event, form, formData);
        const drafts = (submitData.wildpath ?? {});
        delete submitData.wildpath;
        const stored = this.document.toObject(true).system?.ruleElements ?? [];
        const rows = rowsToRules(drafts.rules, stored, rowOptions());
        let errors = rows.errors.map(error => globals.game.i18n.format(`WILDPATH.BUILDER.Formula.${error.key}`, error.data));
        let ruleElements = rows.changed ? rows.ruleElements : null;
        const text = drafts.ruleElementsJson;
        if (!errors.length && !ruleElements && (typeof text === "string") && (text.replace(/\r\n/g, "\n") !== JSON.stringify(stored, null, 2))) {
            try {
                ruleElements = JSON.parse(text);
            }
            catch (error) {
                errors = [error.message];
            }
        }
        if (ruleElements)
            errors.push(...ruleElementListErrors(ruleElements));
        if (errors.length)
            throw new Error(`${globals.game.i18n.localize("WILDPATH.ITEMSHEET.NotSaved")} ${errors.join("; ")}`);
        if (ruleElements)
            globals.foundry.utils.setProperty(submitData, "system.ruleElements", ruleElements);
        return submitData;
    }
    /** Add or remove a rule row: the form is folded in and saved, as Foundry's own change rows are. */
    async #editRules(target, change) {
        const { path } = ruleButtonPath(target);
        const values = globals.foundry.utils.expandObject(new globals.foundry.applications.ux.FormDataExtended(this.form).object)
            .wildpath;
        const result = rowsToRules(values?.rules, this.document.toObject(true).system?.ruleElements ?? [], rowOptions());
        if (result.errors.length)
            return globals.ui.notifications.warn("WILDPATH.BUILDER.FixFirst", { localize: true });
        return this.submit({ updateData: { system: { ruleElements: change(result.ruleElements, path) } } });
    }
    static async #onRuleAdd(_event, target) {
        await this.#editRules(target, (rules, path) => addRule(rules, "bonus", path));
    }
    static async #onRuleRemove(_event, target) {
        await this.#editRules(target, (rules, path) => removeRule(rules, path.at(-1) ?? 0, path.slice(0, -1)));
    }
}

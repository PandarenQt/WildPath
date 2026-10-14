import { ruleElementListErrors } from "./item-sheet.mjs";
const globals = globalThis;
const { ActiveEffectConfig } = globals.foundry.applications.sheets;
const { footer, ...parts } = ActiveEffectConfig.PARTS;
/**
 * Foundry's effect sheet with a Rule Elements tab, edited as JSON like the item sheet's
 * (homebrew-content-builder.md, first slice). The engine's validator checks the list on Save; an invalid list
 * keeps the sheet open with the errors in a notification, and nothing is saved.
 */
export class WildPathEffectSheet extends ActiveEffectConfig {
    static DEFAULT_OPTIONS = { classes: ["wildpath"] };
    static PARTS = { ...parts, ruleElements: { template: "systems/wildpath/templates/effect/rule-elements.hbs" }, footer: footer };
    static TABS = { sheet: { ...ActiveEffectConfig.TABS.sheet, tabs: [...ActiveEffectConfig.TABS.sheet.tabs,
                { id: "ruleElements", icon: "fa-solid fa-scroll", label: "WILDPATH.ITEMSHEET.RuleElements" }] } };
    async _preparePartContext(partId, context) {
        // @ts-expect-error The Foundry base class is typed only as far as this file needs.
        const partContext = await super._preparePartContext(partId, context);
        if (partId === "ruleElements") {
            partContext.ruleElementsJson = JSON.stringify(this.document.toObject(true).system?.ruleElements ?? [], null, 2);
        }
        return partContext;
    }
    _processFormData(event, form, formData) {
        // @ts-expect-error The Foundry base class is typed only as far as this file needs.
        const submitData = super._processFormData(event, form, formData);
        const text = submitData.wildpath?.ruleElementsJson;
        delete submitData.wildpath;
        if (typeof text !== "string")
            return submitData;
        let ruleElements;
        let errors;
        try {
            ruleElements = JSON.parse(text);
            errors = ruleElementListErrors(ruleElements);
        }
        catch (error) {
            errors = [error.message];
        }
        if (errors.length)
            throw new Error(`${globals.game.i18n.localize("WILDPATH.ITEMSHEET.NotSaved")} ${errors.join("; ")}`);
        globals.foundry.utils.setProperty(submitData, "system.ruleElements", ruleElements);
        return submitData;
    }
}

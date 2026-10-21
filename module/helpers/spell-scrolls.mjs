/**
 * Spell Scrolls (2024 DMG, 2026-10-21). A scroll is gear carrying its spell's Action (`flags.wildpath.grantedActions`),
 * which comes with it onto whoever holds it (documents/item.mjs). Read, it casts its spell:
 * - at the spell's own level, with no slot, and with the scroll's save DC and attack bonus (by level, below);
 * - a creature that casts no spells can't read it; one whose highest spell level is below the spell's makes an ability
 *   check with its spellcasting ability, DC 10 + the spell's level, and on a failure the spell is gone (Item#use);
 * - either way, once read the scroll crumbles (adapters: consumeScroll).
 * shortcut: any spellcaster can read any scroll, not only one whose spell is on its class's list; upgrade with class
 * spell lists.
 */

/** The scroll's save DC and attack bonus by spell level (2024 DMG). */
export const SCROLL_STATS = Object.freeze([[13, 5], [13, 5], [13, 5], [15, 7], [15, 7], [17, 9], [17, 9], [18, 10], [18, 10], [19, 11]]
  .map(([dc, attack]) => ({dc, attack})));

/** A spell Action's own level: its `metadata.spellLevel`, else the lowest its slot choice names (0 for a cantrip). */
export function spellLevelOf(definition) {
  const own = Number(definition?.metadata?.spellLevel);
  if ( Number.isFinite(own) ) return own;
  const slot = (definition?.configuration ?? []).find(choice => choice.id === "spell-slot");
  const levels = Object.keys(slot?.levelByResourceId ?? {}).map(id => Number(String(id).split(".").pop())).filter(Number.isFinite);
  return levels.length ? Math.min(...levels) : 0;
}

/** The spell its scroll casts: no slot, at its own level, with the scroll's DC and attack bonus; reading it uses it up. */
export function scrollDefinition(definition) {
  const level = spellLevelOf(definition);
  const {dc, attack} = SCROLL_STATS[Math.min(Math.max(level, 0), 9)];
  const configuration = (definition.configuration ?? []).filter(choice => choice.id !== "spell-slot");
  return {...definition, id: `${definition.id}:scroll`, label: definition.label, tags: [...new Set([...(definition.tags ?? []), "scroll"])],
    configuration, scroll: true, metadata: {...(definition.metadata ?? {}), spellLevel: level},
    ...(definition.save ? {save: {...definition.save, dc: {value: dc}}} : {}),
    ...(definition.attack ? {attack: {...definition.attack, fixedBonus: attack}} : {})};
}

/** The highest spell level a creature casts (its slots or Pact Magic), 0 for one that casts only cantrips or none. */
export function highestSpellLevel(actor) {
  const spellcasting = actor?.system?.spellcasting ?? {};
  const slots = (spellcasting.slots ?? []).map((count, index) => ((Number(count) > 0) ? index + 1 : 0));
  const pact = (Number(spellcasting.pact?.slots) > 0) ? (Number(spellcasting.pact?.level) || 0) : 0;
  return Math.max(0, ...slots, pact);
}

/** A read Spell Scroll crumbles: one fewer of its gear, and gone (with its Actions) at none. */
export async function consumeScrollOf(action) {
  const scroll = action?.actor?.items?.get?.(action.flags?.wildpath?.grantedBy);
  if ( !scroll ) return;
  const left = (Number(scroll.system?.quantity) || 1) - 1;
  if ( left > 0 ) await scroll.update({"system.quantity": left});
  else await scroll.delete();
}

/** A spell Action Item's scroll: gear named for it, carrying the Action that casts it from the scroll. */
export function scrollItemData(spell, {name=null}={}) {
  const definition = scrollDefinition(spell.system.definition);
  const label = name ?? `Spell Scroll (${spell.name})`;
  return {name: label, type: "gear", img: "icons/sundries/scrolls/scroll-bound-sealed-red.webp",
    system: {quantity: 1, weight: 0, description: spell.system.description ?? ""},
    flags: {wildpath: {scrollLevel: spellLevelOf(spell.system.definition), grantedActions: [{name: `${spell.name} (Scroll)`, type: "action", img: spell.img,
      system: {active: true, description: spell.system.description ?? "", definition: {...definition, label: `${spell.name} (Scroll)`},
        ruleElements: []}}]}}};
}

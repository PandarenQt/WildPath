/**
 * What a converted document's conversion notes (`flags.wildpath.conversion.notes`) say, by reason: the gap census
 * counts them (scripts/content/gap-census.mjs), and a GM's item sheet marks a document with real gaps ("partly by hand").
 * Informational reasons say how something is handled, not what is missing.
 */

const RULES = [
  [/^Multiattack: not automated/, () => "Multiattack"],
  [/^Multiattack: any of its attacks/, () => "shortcut: Multiattack's named attacks not enforced"],
  [/^Multiattack: its other parts/, () => "Multiattack: a replacement or an ability it uses (by hand)"],
  [/effect: (\w+) is not a WildPath condition/, match => `condition: ${match[1]}`],
  [/effect: ".*" marks its creature \(narrative\)/, () => "narrative marker (a reminder, nothing to automate)"],
  [/effect: ".*" marks its creature only/, () => "effect marker only (its rules by hand)"],
  // A change of its token's image is how it looks, nothing to automate.
  [/effect: ".*" change img \(\w+\) not converted/, () => "effect image (how it looks)"],
  [/effect: ".*" change (\S+) \((\w+)\) not converted/, match => `effect change: ${match[1].replace(/\.(str|dex|con|int|wis|cha)\./, ".<ability>.")
    .replace(/skills\.\w+\./, "skills.<skill>.").replace(/movement\.\w+/, "movement.<mode>")} (${match[2]})`],
  [/cantrip damage growing/, () => "cantrip scaling by level"],
  [/more healing at higher levels/, () => "healing upcast"],
  [/versatile/, () => "versatile damage"],
  [/Recharge/, () => "recharge"],
  [/temporary Hit Points/, () => "temporary Hit Points"],
  [/targets: count/, () => "target count from a formula (upcast targets)"],
  [/area: .*-ft (\w+) is not supported/, match => `area shape: ${match[1]}`],
  [/a cylinder's height/, () => "area shape: cylinder height"],
  [/is passive or triggered \(narrative\)/, () => "passive trait (its text is its rule)"],
  [/is passive or triggered/, () => "passive or triggered ability"],
  [/concentration: nothing it sustains/, () => "concentration effect not converted"],
  [/summon: what it gains with the spell's level/, () => "summon: what it gains with the spell's level (not added)"],
  [/summon: a creature chosen by Challenge Rating/, () => "summon: a creature chosen by Challenge Rating"],
  [/summon: its creature is not among the converted/, () => "summon: its creature is not converted"],
  [/summon: a count of/, () => "summon: a count from a formula"],
  [/^not automated \((\w+), narrative\)/, () => "narrative use (its cost is all there is)"],
  [/concentration: its caster concentrates/, () => "concentration sustained (its effect is noted apart)"],
  [/^not automated \((\w+)\)/, match => `used, not automated: ${match[1]} activity`],
  [/save: a failure gives/, () => "save: conditions from its text (the rest by hand)"],
  [/save: a failure marks its creature \(narrative\)/, () => "narrative save (it tells or hides; nothing to automate)"],
  [/save: a failure marks its creature only/, () => "save: a failure marks its creature (rules by hand)"],
  [/^rolled \((\w+)\); what it does is by hand/, match => `rolled, consequences by hand: ${match[1]} activity`],
  [/^not automated:/, () => "used, not automated: no activity"],
  [/consumption: (\w+)/, match => `consumption: ${match[1]}`],
  [/custom formula/, () => "custom damage formula"],
  [/bonus "([^"]*)" not converted/, match => `formula: ${match[1].replace(/\d+/g, "n").slice(0, 40)}`],
  [/uses: maximum "([^"]*)"/, match => `uses maximum: ${match[1].replace(/\d+/g, "n").slice(0, 40)}`],
  [/save: .* DC .* not converted/, () => "save DC formula"],
  [/item's base damage/, () => "item base damage on a non-weapon"],
  [/a choice of [^ ]+ uses/, () => "a choice (damage type or save ability)"],
  [/is not an action-economy cost/, () => "long activation (minutes, hours)"],
  [/attack: (bonus|\+\d+ magic)/, () => "attack bonus or magic bonus"],
  [/partial recovery/, () => "partial recovery on a short rest"],
  [/vulnerabilities/, () => "vulnerabilities"],
  [/condition immunities/, () => "condition immunities"],
  [/magic or silvered/, () => "resistance bypasses"],
  [/AC: /, () => "AC calculation"],
  [/healing: temporary/, () => "temporary Hit Points"],
  // A feature that converted to nothing that acts while its text names a rule (convertItem's silent check).
  [/^silent: /, () => "silent: a rule in its text, nothing converted"]
];
/** Reasons that say how something is handled rather than what is missing: counted apart from the real gaps. */
export const INFORMATIONAL = new Set(["narrative use (its cost is all there is)", "passive trait (its text is its rule)",
  "narrative marker (a reminder, nothing to automate)", "narrative save (it tells or hides; nothing to automate)", "effect image (how it looks)",
  "concentration sustained (its effect is noted apart)",
  "long activation (minutes, hours)", "resistance bypasses"]);

export const noteReason = note => {
  // A creature's notes name the item first ("Multiattack: not automated..."); the reason is what follows.
  for ( const text of [note, note.replace(/^[^:"]+: /, "")] ) {
    for ( const [pattern, name] of RULES ) {
      const match = text.match(pattern);
      if ( match ) return name(match);
    }
  }
  return `other: ${note.replace(/"[^"]*"/g, "\"…\"").replace(/\d+/g, "n").slice(0, 50)}`;
};

/** Its notes that name something missing (not informational). */
export function realGapNotes(notes) {
  return (Array.isArray(notes) ? notes : []).filter(note => (typeof note === "string") && !INFORMATIONAL.has(noteReason(note)));
}

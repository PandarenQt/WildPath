/**
 * What a converted document's conversion notes (`flags.wildpath.conversion.notes`) say, by reason: the gap census
 * counts them (scripts/content/gap-census.mjs), and a GM's item sheet marks a document with real gaps ("partly by hand").
 * Informational reasons say how something is handled, not what is missing.
 */

const RULES = [
  [/^Multiattack: not automated/, () => "Multiattack"],
  [/^Multiattack: any of its attacks/, () => "shortcut: Multiattack's named attacks not enforced"],
  [/^Multiattack: its other parts/, () => "Multiattack: a replacement or an ability it uses (by hand)"],
  [/^upcast: /, () => "upcast by hand"],
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
  // 2024 Polymorph: the form's statistics, its Challenge Rating limit, its Temporary Hit Points and "can't cast spells" are
  // automated; "limited in the actions it can perform by the anatomy of its new form" is the GM's call, nothing to automate.
  [/^transform: .* what the creature may do in its form is by hand/, () => "transform: what its form's anatomy allows (the GM's call)"],
  [/is passive or triggered \(narrative\)/, () => "passive trait (its text is its rule)"],
  [/is passive or triggered/, () => "passive or triggered ability"],
  [/concentration: nothing it sustains/, () => "concentration effect not converted"],
  [/summon: its Hit Dice by the spell's level/, () => "summon: Hit Dice by level (spent only on a rest)"],
  [/summon: what it gains with the spell's level/, () => "summon: what it gains with the spell's level (not added)"],
  [/summon: a creature chosen by Challenge Rating/, () => "summon: a creature chosen by Challenge Rating"],
  [/^summon: not in the SRD/, () => "summon: forms outside the SRD left out"],
  [/summon: its creature is not among the converted/, () => "summon: its creature is not converted"],
  [/summon: a count of/, () => "summon: a count from a formula"],
  [/summon: ".*" raises no character: /, () => "summon: a character its text kills at 0 Hit Points is dying (by hand)"],
  [/^not automated \((\w+), narrative\)/, () => "narrative use (its cost is all there is)"],
  [/concentration: its caster concentrates/, () => "concentration sustained (its effect is noted apart)"],
  [/^not automated \((\w+)\)/, match => `used, not automated: ${match[1]} activity`],
  [/save: a failure gives/, () => "save: conditions from its text (the rest by hand)"],
  [/^save: its Advantage if /, () => "save: Advantage in a case its text names (by hand)"],
  [/^save: its repeat's (?:Dis)?[Aa]dvantage if /, () => "save: its repeat's Advantage or Disadvantage in a case its text names (by hand)"],
  [/^effect: its creature can't end \w+ on itself/, () => "effect: a condition its creature can't end itself (by hand)"],
  [/escape: destroying what holds it/, () => "escape: destroying what holds it (by hand)"],
  [/escape: what its check does besides freeing it/, () => "escape: what its check does besides freeing (by hand)"],
  [/^interval: what else its description says/, () => "interval: what else its text says (by hand)"],
  [/^hazard: what else its description says/, () => "hazard: what else its text says (by hand)"],
  [/^drain: ".*" is by hand/, () => "drain: its outcome or ending elsewhere in its text (by hand)"],
  [/^drain: its user regaining Hit Points/, () => "drain: its user's healing by the amount (by hand)"],
  [/^drain: its Hit Point maximum drains stay/, () => "drain: restored once its condition ends (by hand)"],
  [/^drain: what a Hit Point maximum of 0 does/, () => "drain: a Hit Point maximum of 0 (by hand)"],
  [/^area: what else its description says/, () => "area: what else its text says (by hand)"],
  [/^area: its caster's choice /, () => "area: its caster's choice of whom it affects (by hand)"],
  [/^summon: its Bonus Action should be its summoner's/, () => "summon: its Bonus Action is its own, not its summoner's (by hand)"],
  [/^draw: a result already drawn this turn/, () => "draw: no repeat in a turn (by hand)"],
  [/^draw: what else its result's text says/, () => "draw: what else a drawn result says (by hand)"],
  [/^save: a second failure's outcome/, () => "save: a second failure's outcome (by hand)"],
  [/^trigger: ".*" after a spell cast as a Reaction/, () => "trigger: after a spell cast as a Reaction (by hand)"],
  [/save: a failure marks its creature \(narrative\)/, () => "narrative save (it tells or hides; nothing to automate)"],
  [/save: a failure marks its creature only/, () => "save: a failure marks its creature (rules by hand)"],
  [/^rolled \(\w+, narrative\)/, () => "narrative save (it tells or hides; nothing to automate)"],
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
  [/^silent: /, () => "silent: a rule in its text, nothing converted"],
  [/^free cast: /, () => "free cast: an option of its cast (by hand)"]
];
/** Reasons that say how something is handled rather than what is missing: counted apart from the real gaps. */
export const INFORMATIONAL = new Set(["narrative use (its cost is all there is)", "passive trait (its text is its rule)",
  "narrative marker (a reminder, nothing to automate)", "narrative save (it tells or hides; nothing to automate)", "effect image (how it looks)",
  "concentration sustained (its effect is noted apart)",
  "long activation (minutes, hours)", "resistance bypasses",
  "summon: forms outside the SRD left out", "summon: Hit Dice by level (spent only on a rest)",
  "transform: what its form's anatomy allows (the GM's call)"]);

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

/**
 * The documents the gap census counts from one source's notes (`{"<name> [<dnd5e id>]": notes}`; an older package keys
 * them by name alone), as `[key, notes]`: a copy (the same name and notes: a Tinderbox in each pack that holds one) is one
 * document, and a stat block's feature also kept as an Item of its own (a Monster Manual's), every note of which a stat
 * block holding that very document (`held`: its dnd5e id → those stat blocks' notes, from convertActor's `holds`) has
 * under its name ("Rampage: ..."), is counted on the stat block. A document only named like one is still counted.
 */
export function censusDocuments(documents, held=new Map()) {
  const nameOf = key => key.replace(/ \[[^\]]+\]$/u, "");
  const seen = new Set();
  const unique = Object.entries(documents ?? {}).filter(([key, notes]) => {
    const copy = JSON.stringify([nameOf(key), notes]);
    return !seen.has(copy) && seen.add(copy);
  });
  return unique.filter(([key, notes]) => {
    const holder = held.get(key.match(/ \[([^\]]+)\]$/u)?.[1]);
    const name = nameOf(key);
    return !holder || !notes.length || !notes.every(note => holder.includes(note.startsWith(`${name}: `) ? note : `${name}: ${note}`));
  });
}

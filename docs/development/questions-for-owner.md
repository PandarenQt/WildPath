# Questions for the owner

Questions that came up during autonomous work. None of them blocks the work: each one says what was done meanwhile.
Answer inline (or in the vault's decisions list), and the next session acts on the answer.

## Open

### Q1. Should a second client logged in as the same GM be refused? (2026-10-31)
Foundry lets one user log in from two browsers. With the GM, both clients then act as the WildPath authority
(`game.users.activeGM` names a user, not a client). Every Action is resolved twice, and every request reaches its
Player twice. Seen live on 2026-10-31, when another session's browser stayed logged in as the GM.

- Done meanwhile: a stray duplicate prompt no longer ends the next Action (`6bb6c8c7`). The rule "one GM login per
  world" is in `docs/architecture/multiplayer-authority.md`.
- Options:
  1. Leave it as a documented rule.
  2. Each GM client claims the authority over the socket; a second one warns its user and stands down.
  3. Show a warning only.
- Recommendation: option 3 first (cheap: a notice when another client of the same GM user answers), then 2 if it
  ever happens in play.
- **Answered 2026-10-31: leave it to Foundry; not a security concern here. The documented rule stands.**

### Q2. A Player who reconnects mid-Action: send their prompt again? (2026-10-31)
Plan item 1.1 asked that "a reconnecting client is sent its open prompts again". Today a Player who disconnects has
their open requests handed to the GM at once (`releaseRequestsOf`), so nothing waits on them when they return.
Sending the prompt back would mean taking it away from the GM again.

- Done meanwhile: nothing; the GM answers, or cancels with Cancel Action.
- Recommendation: keep it as it is. Ask again only if Players complain that the GM answers for them after a reload.
- **Answered 2026-10-31: make it an option to pass the prompt back to the Player (plan 7.2).**

### Q3. A GM creature's own rerolls beside the players' monster offer (2026-10-31)
When a GM creature rolls and some player has Heroic Inspiration, the GM is asked "Reroll its roll with a player
character's Heroic Inspiration?" (`inspirationMonsterRerolls`). A test says the creature's own options are then never
offered (`test/transform-action.test.mjs`: Indomitable "never on a monster's GM-chosen reroll"), so a GM-run fighter
loses its Indomitable, and a GM creature its own Countercharm or a Bardic Inspiration die, whenever a player holds a point.

- Done meanwhile: an ally's help (another creature's Countercharm) now joins after a failure, asked of the ally's
  player (see `docs/architecture/reactions.md`, Countercharm). The creature's own options still follow the test.
- Question: was "never on a monster's reroll" meant to keep the GM's dialog about the players' points only, or should a
  GM creature's own features join it after a failure, like an ally's do now?
- Recommendation: let them join after a failure (`failedOnly`), which is one line per helper.
- **Answered 2026-10-31: they join after the failure (plan 7.1).**

### Q4. Inscrutable (two sphinxes): read the roller's targets in a sheet roll? (2026-10-31)
2024 Inscrutable: "Wisdom (Insight) checks made to ascertain its intentions or sincerity are made with Disadvantage."
The Disadvantage belongs to the creature checked about, but a sheet's Insight check names no one. The proposed way is
to treat the creatures the roller has targeted as the ones the check is about (`game.user.targets`, read in
`Actor#rollTest` on the rolling client), with a `checked.<skill>` roll-mode domain on them.

- Done meanwhile: nothing; it is the last silent SRD feature besides narrative ones. Its other sentence (no scrying,
  no thought reading) is narrative.
- Question: is reading the roller's targets in `rollTest` acceptable (the runtime already reads them to build
  intents), or should an Insight check about a creature be an Action of its own with a target?
- Recommendation: read the targets; it needs no new UI and matches how attacks pick their target.
- **Answered 2026-10-31: reading the roller's targets is acceptable, or the GM handles it; the suggestion goes in a "possible upgrades" markdown (plan 7.3).**

### Q5. Creature spaces in movement (plan 3.4, swarms) (2026-10-31)
Plan item 3.4 assumed movement refuses an occupied space and swarms would be exempted through `occupancyPolicy`. It
does not: the movement pipeline has the seam but the Foundry runtime supplies no policy, so any creature may end its
move on another, or walk through a hostile one. Swarms already "share" spaces because nobody is blocked.

2024 rules: a creature may move through an ally's space, and through a hostile creature's only if one of them is Tiny
or the two are two sizes apart; moving through another creature's space is Difficult Terrain; no creature may willingly
end its move in an occupied space. Swarms (and a few others) ignore these.

- Done meanwhile: nothing; tokens move as before.
- Question: should movement enforce these rules now? It changes how every token moves, so a GM dragging a token over
  another would be refused (forced movement and teleports already avoid occupied spaces).
- Recommendation: yes, as an `occupancyPolicy` from the runtime, with a world setting "Creatures block movement" (on by
  default), the GM's own drags exempt, and a `swarm` trait (from the stat block's type) that ignores it.
- **Answered 2026-10-31: the recommendation; keep the exceptions features give, and make the Difficult Terrain of moving through a creature optional (plan 3.4).**
  Built 2026-11-01: `creatureOccupancyPolicy`, the settings "Creatures block movement" and "Moving through another
  creature is Difficult Terrain", and `occupancy.*` Modifiers for swarms, Incorporeal Movement and Halfling Nimbleness
  (movement-paths.md, "Creatures' spaces").

### Q6. Vehicles and mythic phases: four choices before building (plan 5.1) (2026-10-31)
The design is in `docs/architecture/vehicles-and-mythic.md`. SRD 5.2 has 8 ships (numbers only: AC, HP, Damage
Threshold, crew, passengers, cargo) and no mythic creature; none of the owned books has one either.

- Question 1: a new `vehicle` Actor type (a new persisted data format), or an `npc` with a vehicle flag?
  Recommendation: the new type, so ships don't get saves, conditions and death rules they don't have.
- Question 2: who uses a vehicle's Actions? Recommendation: a creature aboard as crew, with its own Action; the
  vehicle has no turn.
- Question 3: should Tokens standing on a vehicle move with it? Recommendation: yes, by the same offset, with no
  reactions or costs.
- Question 4: mythic phases have no content to test against. Build the seam now (a `Phase` rule on 0 Hit Points,
  `mythic` Actions forbidden until then), or wait for content? Recommendation: build the seam with a test creature.
- Done meanwhile: nothing. Damage Threshold doesn't depend on these answers, so it can be built next.
- **Answered 2026-10-31: the recommendations (plan 5.1).**

### Q7. Two paladins' Auras of Protection stack (2026-10-31)
2024: "a creature can benefit from only one Aura of Protection at a time". Today each aura's save bonus is an untyped
Modifier, and untyped Modifiers always stack, so a creature inside two paladins' auras gets both bonuses.

- Question: how should the "one at a time" rule be kept?
  - (a) A modifier type of its own for Aura of Protection, so two of them don't stack (the highest counts). A config
    entry and a label.
  - (b) A general "one per aura" rule: a creature benefits from only one copy of the same aura (by its id), whichever
    is best. Covers future auras too.
- Done meanwhile: nothing; they stack.
- Recommendation: (b), since it matches the rule's wording and needs no new modifier type.
- **Answered 2026-10-31: the recommendation, (b) (plan 7.4).**

### Q8. Potent Spellcasting's Temporary Hit Points to another creature (Cleric 14) (2026-10-31)
2024 Improved Blessed Strikes: after dealing damage with a cantrip, the cleric can give itself or a creature within 60
feet Temporary Hit Points equal to twice its Wisdom modifier. A reaction can't pick a creature other than the one hit.

- Question: which shape?
  - (a) Two steps: the cantrip's damage fills a one-turn pool; a "Potent Spellcasting: Heal" Action (free, single
    creature within 60 ft) spends it. Uses the normal targeting. Medium.
  - (b) One step: a new reaction target chooser (the redirect prompt reused) so the reaction itself picks the creature.
    Larger, but it reuses for other "you or a creature within X" riders.
- Done meanwhile: nothing; it stays by hand (noted).
- Recommendation: (a) now; (b) when a second feature needs a reaction target.
- **Answered 2026-10-31: (b), a reaction target chooser, built generally: War Caster's reaction spell needs the same (the triggering creature, itself, or any creature in range) (plan 7.5).**

### Q9. Circle of the Land spells and Natural Recovery's free cast (2026-10-31)
Natural Recovery casts one prepared Circle Spell without a slot once per Long Rest. WildPath doesn't know which spells are
Circle Spells: the land is chosen at each Long Rest, and its spells aren't granted.

- Question: which route?
  - (a) Automate Circle of the Land Spells first: a land choice at each Long Rest that grants that land's spells,
    always prepared; then Natural Recovery's free cast reads them.
  - (b) A stopgap: a sheet toggle marking the circle spells the druid has (as Mystic Arcanum's), and the free cast
    reads the mark.
- Done meanwhile: nothing; both stay by hand.
- Recommendation: (a); it removes two gaps and fits "nothing by hand". (b) only if (a) waits long.
- **Answered 2026-10-31: (a) (plan 7.7).** Built 2026-11-01: `grantItems`, Circle of the Land Spells' land at each Long
  Rest and Natural Recovery's free cast (classes-and-spellcasting.md).

### Q10. Overchannel: an Action that damages its own caster (Evoker 14) (2026-10-31)
2024 Overchannel: a wizard spell of level 1-5 that deals damage deals maximum damage; each later use before a Long Rest
deals 2d12 Necrotic per spell level (+1d12 per further use) to the wizard, ignoring Resistance and Immunity. The
maximum damage is small to build, but nothing in the engine lets an Action damage its own caster, and the maximum
shouldn't ship without the backlash.

- Question: build "damage to its own source" as a resolution capability (a `sourceDamage` list rolled after the
  Action's damage, committed on the caster in the same transaction, with a per-component "ignores Resistance and
  Immunity", and the caster's Concentration save)? It is a new pattern; later features could use it (2014 Overchannel,
  some cursed items, Blood Magic-style homebrew).
- Done meanwhile: nothing; Overchannel stays by hand (noted).
- Recommendation: yes; medium-sized, with the maximize half shipped together.
- **Answered 2026-10-31: the recommendation (plan 7.6).** Built 2026-11-01: `sourceDamage` (action-resolution.md) and
  Overchannel's choice (classes-and-spellcasting.md).

### Q11. Rules the caster gives a save it imposes (Magical Ambush, Eldritch Strike, Eldritch Hex) (2026-10-31)
Three book features make a creature's save against the caster worse: an Arcane Trickster casting while Invisible
(Disadvantage on the save), an Eldritch Knight's weapon hit (Disadvantage on its next save against the knight's spell),
a Great Old One's Hex (Disadvantage on saves of the hexed ability). Today a save reads only the saver's own rules.

- Question: add a caster-side save domain (the caster's RollModes on `imposed.save`, read in the caster's context and
  combined with the saver's), and `save.fromCaster.<mark>` (the marks the saver carries from that caster, as attacks
  have `attack.fromAttacker`)? It is a new resolution capability; the three features then become data.
- Done meanwhile: nothing; they stay by hand (silent in the census).
- Recommendation: yes; small to medium, and it mirrors what attacks already do.
- **Answered 2026-10-31: yes (done `647978f5`: `imposed.save` and `save.fromSource`; Magical Ambush, Eldritch Strike, Eldritch Hex are data).**

### Q12. Shared Bastions (plan 5.2): what is shared, and how members join (2026-10-31)
The design is in `docs/architecture/shared-bastions.md` (three designs judged against the Bastion code and the local DMG).
The combining rules keep each character's slots, orders, hirelings, defenders and event roll; only the floor plan is shared.

- Done meanwhile: stage 0 only (`81b189a5`): a Bastion turn runs on the active GM alone, and an order given mid-turn is
  kept. Nothing else is built.
- Questions, each with a recommendation (the doc has the options):
  1. Share only the map; keep everything else per character, as the DMG does. Recommend: yes.
  2. Store membership as one optional field on each member (`system.bastion.shared: {id, squares}`), no group
     document. Recommend: yes.
  3. Joining: open to any visible group, announced in chat, the GM can remove anyone (no approval step). Recommend: yes.
  4. Ground a member doesn't pool is unused while it's a member (no private second map). Recommend: yes.
  5. Squares outside the grid are kept and shown as problems, solo maps included (today they are dropped when the map
     opens). Recommend: yes.
  6. A joining member's cells are kept; overlaps show as problems. Recommend: yes.
  7. The shared Bastion is named by its members (no shared name field). Recommend: yes.
  8. Build the DMG's zero-defender shutdown (an Attack with no defenders shuts a special facility), missing today even
     for solo Bastions. Recommend: yes, as its own item.
  9. Covering an ally's defender losses: leave out until 8 is built, then each member opts in. Recommend: yes.
  10. Grid: a square of side ceil(sqrt(pooled squares)), painting capped at the pool. Recommend: yes.
- **Answered 2026-10-31: all ten recommendations (plan 5.2).**

### Q13. Boon of Spell Recall and slot-paid features (2026-10-31)
Boon of Spell Recall is built (`a8a46c93`): a spell paid with a level 1-4 slot rolls a d4, and a roll equal to the slot's
level keeps the slot (Reaction spells too; the card says whether it was kept).

- Question 1: under the Paladin's Smite house rule, the 2014-style Divine Smite is cast as a level 1+ spell with a slot.
  Should the boon's d4 apply to it? Done meanwhile: yes, like any spell paid with a level 1-4 slot.
- Question 2: Wild Companion paid with a spell slot now counts as casting Find Familiar (`90ba955c`: the boon rolls, and
  Counterspell can answer it). Should the Wild Shape-paid version count as a cast too? Done meanwhile: no (it spends
  no slot). Making it count also needs the action bar to place it among 1st-level spells.
- Recommendation: keep both as they are.
- **Answered 2026-10-31: keep both as they are.**

### Q14. Migration 5 (feature shapes) was added without asking first (2026-10-31)
Plan 2.8 made the name-keyed features generic data (Life Bond, Potent Cantrip, Elemental Adept, Mystic Arcanum, Spell
Mastery, Signature Spells). A stored copy of one of them has only its identifier, so the build agent added migration 5
(`7ec59324`, docs/architecture/world-migrations.md): when a world loads, it copies the new rules and `spellChoice` flag
from each stored feature's compendium copy. It only adds; it replaces nothing. Migrations need your approval first, and
this one was not asked: that is my process miss.

- Done meanwhile: the packs (SRD and the four books) are reconverted and rebuilt, so the migration would read current
  copies. No world has loaded since, so it has not run anywhere.
- Options:
  1. Keep it. Existing characters keep working (Spell Mastery's toggle, Life Bond, Elemental Adept, ...).
  2. Revert it. Those stored features stop working until each is refreshed (Refresh Items) or re-added.
- Recommendation: option 1.
- **Answered 2026-10-31: keep it, and make it re-run whenever the converted packs change** (done: content stamps,
  docs/architecture/world-migrations.md).

### Q15. A creature unaffected by certain spells (Spell Immunity, Telepathic Shroud) (2026-10-31)
A Helmed Horror is immune to three spells its maker chose; a creature with Telepathic Shroud is immune to Divination
spells. No rule shape makes a creature unaffected by an Action: Forbid bars its own Actions, damage immunity matches
damage types, and an automatic save success misses spells with no save (Magic Missile, Hunter's Mark).

- Done meanwhile: nothing; both stay by hand (silent in the census).
- Question: add a generic target-side rule `Unaffected {actions: <predicate over the Action's tags>}` (mirroring Forbid)?
  Then: is such a creature left out of the Action's targets (an area passes over it; a single-target spell at it is not
  cast), or targeted and the use wasted (the spell is spent and nothing happens to it)? The second matches the rules
  text ("immune") and needs no change to targeting. Spells would also get a `spell:<identifier>` tag so a named spell is
  matched by identity rather than by name.
- Recommendation: yes, targeted and wasted, with the `spell:` tag; the shroud's on/off Bonus Action is the feature's
  active toggle.
- **Answered 2026-10-31: the recommendation: an `Unaffected` rule, the creature targeted and the use wasted, spells tagged `spell:<identifier>` (plan 7.10).** (done: docs/architecture/rule-elements.md, Unaffected).

### Q16. Inspiring Help (Expert sidekick): dice added to the Help it gives (2026-10-31)
An Expert sidekick's Help adds 1d6 (2d6 at level 20) to the helped roll, or to the attack's damage on a hit instead. The
common Help Action (2024) puts its effect on the enemy, and target-side attack modifiers are flat numbers, so no shape
can add dice there.

- Done meanwhile: nothing; it stays by hand (silent).
- Options: (a) let target-side `attacked` Modifiers roll dice and see `attack.helpedByAlly` (changes how every such
  modifier is rolled); (b) the converter gives the sidekick its own "Help (Inspiring Help)" and "Assist" Actions whose
  effects carry the die (a second Help beside the common one). The "damage instead" choice needs a prompt on the hit in
  either case.
- Recommendation: (a) without the damage option for now; it is a sidekick-only feature, so low priority.
- **Answered 2026-10-31: (b), done properly. Both halves are shapes that exist: the sidekick's own Help puts one effect on the helped ally carrying a Bardic-Inspiration-style die for its roll and an ExtraDamage rider for its hit; whichever is used ends it (plan 7.11).**

### Q17. Release plumbing (plan 6.5): version, changelog, merge to main (2026-11-01)
The branch `milestone/action-runtime-live-proof` is 613 commits ahead of `main`, and `system.json` is still 0.9.0 with no
`url`, `manifest` or `download`. Plan 6.5 waits on your go-ahead because a version and a merge to `main` are yours to call.

- Done meanwhile: nothing; work continues on the branch.
- Questions: (1) which version (recommend 0.10.0: many features, still pre-1.0); (2) merge to `main` now, or after a full
  Quench run and a two-browser pass on the new features (vehicles, shared Bastions, creature spaces); (3) the GitHub
  repository URLs for `url`, `manifest` and `download` (a release asset `system.zip` with `manifest` pointing at the latest
  release's `system.json` is Foundry's usual pattern); (4) a CHANGELOG.md written from the plans and the Development Log.
- Recommendation: 0.10.0, after one full Quench run and the two-browser pass; the standard GitHub release URLs; a
  changelog grouped by feature, not by commit.

### Q18. SRD gap sweep: rules choices before 17 items can be automated (2026-11-01)
The SRD gap sweep (`bf042e2b`) automated about 105 items. These need a choice first; each stays by hand meanwhile.

1. **Ice Knife in the silver dragons' Spellcasting.** dnd5e's Ice Knife has no license (it is not SRD 5.2), but two SRD
   stat blocks cast it. Convert it for those stat blocks' casting in the SRD pack? Recommend: no; keep it by hand in the
   SRD pack (your local world gets it from the PHB). The rest of the Multiattack (Paralyzing Breath) is built regardless.
2. **Hide and Search as a contest (Cloak of Elvenkind).** Today Hide gives Invisible at a fixed DC 15 and Search is a
   plain check. Make Search contest the Hide's stored Stealth total (2024 rules), with a `perceived` roll-mode domain
   the cloak (and homebrew) can use? Recommend: yes, medium.
3. **Damageable wall sections (Wall of Ice's Frigid Air: Ice Devil, Staff of Frost, Water Ring).** Give wall spells
   sections with HP (a Region per panel), so a broken section can leave its sheet of cold air? Recommend: not now (large);
   mark Frigid Air by hand.
4. **Earthquake's fissures (Earth Ring).** GM-placed line areas with a save and a fall, or narrative? Recommend: GM-placed
   lines; "Collapsing Structure" narrative either way.
5. **Helm of Brilliance's gems.** Track the four gem counts as pools (rolled once), spent by its casts and read by its
   Explosive Emanation? Recommend: yes, small to medium.
6. **Pipes of the Sewers' swayed rats.** Should a swayed swarm flip its Token's disposition / become a controlled
   companion? Recommend: yes, as companion control while the piper keeps playing.
7. **Mirror of Life Trapping.** When is the save made (on activation, on entering 30 ft, at turn start), and is a trapped
   creature removed from the Scene? Recommend: on entering 30 ft or starting a turn there; trapped = removed (a status).
8. **Contingency.** A fixed list of WildPath events to pick from (drops to 0 HP, Bloodied, falls, submerged…), storing the
   spell and its slot? Recommend: yes, a list.
9. **Large ones: Antimagic Field, Magic Jar (possession), Simulacrum.** Automate any of them now? Recommend: Antimagic
   Field yes (Forbid spells/magic Actions inside, suppress magical effects and rules inside; large); Magic Jar and
   Simulacrum by hand for now.

### Q19. One condition from two sources: one effect, or one per source? (2026-11-07)
A creature has one effect per condition (`findConditionEffect` in `condition-effect-commit-resolver.mjs`), and a
second source's plan writes its own duration, concentration, source and escape DC over the first's. So a creature
Restrained by a Net and then by a Web holds the Web's flags only: when the Web's caster loses concentration, the Net's
hold ends with it, and its escape DC is the Web's. `action-definitions.md` ("two grapples of the same condition are one
condition") and `areas.md` (`heldElsewhere`) document the one-effect model as a shortcut.

- Question: should a non-stacking condition (Grappled, Restrained, Burning) from several sources be one effect per
  source group (`effectGroupKey`: Action and source), each with its own duration, concentration and escape DC, the
  condition lasting while any of them does? If yes:
  1. Does Escape end only the hold it was rolled against (the highest DC), or every hold of that condition?
  2. Does a removal with no effect id (a cure, standing up) end every effect of that condition, or one?
  3. Do a non-stacking condition's own Triggers (Burning's 1d4) run once per creature however many sources it has?
     (Today each effect's Trigger runs, so two effects would deal it twice.)
  4. Does a sourced plan leave a GM-toggled, unflagged condition alone and add its own beside it, or take it over as now?
- Cost if yes: the lookup and binary apply select by group; a second effect is built from the condition's status data
  (V14 `toggleStatusEffect` creates nothing while one exists); Trigger deduplication; Escape names its hold;
  `heldElsewhere` and the two shortcut notes go. Additive fields only, no migration.
- Done meanwhile: nothing; the newer source's flags win. A plan that names its effect by id now finds that one first.
- Recommendation: yes; (1) only the hold rolled against, (2) every effect of that condition, (3) once, (4) add beside it.

### Q20. Resistance and Vulnerability together, and rounding per hit part (2026-11-12)
`applyTypedAdjustmentsToComponent` in `damage-adjustment-resolver.mjs` multiplies each damage component by one combined
factor (the strongest Resistance times the strongest Vulnerability) and rounds once, per component. Two consequences
against the 2024 wording ("Resistance and then Vulnerability are applied after all other modifiers"; halved, round down):
- With both, 5 Fire becomes 5 (5 x 0.5 x 2), not 4 (halve and round down to 2, then double).
- Two components of one type in one hit (a weapon's Fire plus a rider's Fire, 3 + 3, with Resistance) give 1 + 1 = 2,
  not 3 (half of 6 rounded down).

- Question: apply Resistance, round, then Vulnerability, over the total of each damage type in a hit, as the 2024 text
  reads? The 2014 rule ordered them the same way, so this does not depend on the ruleset.
- Cost if yes: group components by type before adjusting, keep each component's share for the chat card's breakdown,
  and update the test that pins the combined factor. No data change.
- Done meanwhile: nothing; the combined per-component factor stays.
- Recommendation: yes. A creature with both to the same type is rare, but two parts of one type in a hit are common
  (a Flame Tongue hit with Searing Smite: 2d6 + 1d6 Fire), and each odd part loses a point today.

### Q21. Prismatic Spray: two rays of one color on one creature (2026-11-13)
Prismatic Spray, Special (8): "The target is struck by two rays. Roll twice, rerolling any 8." The two rolls can give the
same color. The rolled choice (`draw`, action-definitions.md "Drawn choices") keeps each option's parts once per
creature, and a color's 12d6 is one roll shared by every creature that color hit (2024: damage to several targets at
once is rolled once).

- Question: when both rolls give the same color, does the creature take that ray twice (its 12d6 twice, or the Indigo or
  Violet effect twice), or once?
- Cost if twice: the draw stage keeps each repeat as a separate copy of that color's parts, with its own damage roll
  for that creature. No data change, no migration.
- Done meanwhile: once. The converter notes it on every Prismatic Spray it converts ("takes it once (Q21)").
- Recommendation: twice for damage (the text says "struck by two rays"); Indigo's or Violet's condition twice changes
  nothing, as a condition does not stack.

### Q22. "Succeed instead" on an automatic failure (2026-11-13)
Ring of Evasion ("When you fail a Dexterity saving throw ... succeed on that save instead"), Scarab of Protection and
Mage Slayer's Guarded Mind are now a test offer that turns a failed save into a success (`testOffer.succeed`,
classes-and-spellcasting.md "Dice on a failed d20 test"). Some saves fail automatically: Paralyzed, Stunned, Petrified
and Unconscious fail Strength and Dexterity saves, and a feature can force a failure through a `RollOutcome`. The texts
say only "when you fail". The Ring and the Scarab cost a Reaction, and all four conditions are Incapacitated, which leaves
no Reaction. So in practice the question is about offers with no Reaction (Guarded Mind, homebrew).

- Question: can a "succeed instead" feature turn an automatic failure into a success?
- Done meanwhile: yes. The offer reuses Legendary Resistance's `succeed-instead` save override, which already turns an
  automatic failure into a success (rule-elements.md "Legendary Resistance"). The engine treats both the same.
- Cost if no: one more key on the test offer (`notAutomatic: true`, say), checked where the save stage asks it. The
  converter would set the key on these rows; world Items already embedded get it when re-imported. No migration.
- Recommendation: yes. It matches Legendary Resistance, nothing in the wording excludes it, and the Reaction cost already
  keeps an Incapacitated wearer from using the Ring or the Scarab.

### Q23. A Hit Point drain: does damage Temporary Hit Points absorb count as "the damage taken"? (2026-11-13)
Wraith, Specter, Wight, Vampire, Vampire Spawn, Succubus, Clay Golem and Harm lower the target's Hit Point maximum "by an
amount equal to the damage taken" (an effect's `amount: {damage}`, action-definitions.md "An amount stamped as it
lands"). Example: a Wraith deals 18 Necrotic damage to a target with 10 Temporary Hit Points. The target loses 10
Temporary and 8 real Hit Points.

- Question: is its Hit Point maximum lowered by 18 or by 8?
- Done meanwhile: 18. `damage.applied` already counts damage that Temporary Hit Points absorb as taken
  (`damagedTargetsOf`), so "taken" means one thing everywhere.
- Cost if 8: the drain counts only what reached the creature's own Hit Points (its damage plan's amount), split across
  damage types in proportion. No data change, no migration.
- Recommendation: 18. 2024 calls the whole amount damage the creature takes; Temporary Hit Points only change which
  pool it comes out of.

### Q24. "Immediately after you cast X using a spell slot" when the spell is countered (2026-11-14)
Beguiling Magic, Protective Verses and the Essence Shards now answer their creature's own cast through the
`action.completed` event (rule-elements.md "Automatic triggers"). That event fires only for an Action that completed.
A countered spell is cancelled, not completed, and 2024 Counterspell says its slot is not expended.

- Question: does a rider worded "immediately after you cast X using a spell slot" (or "when you cast X") still happen
  when the spell is countered?
- Done meanwhile: no. A countered (cancelled) or failed Action never reports `action.completed`, so none of its riders
  run.
- Cost if yes: the runtime's `afterCancelled` would report the event too, tagged so (`cancelled`), and these Triggers
  would accept it unless they say "using a spell slot". No data change, no migration.
- Recommendation: no. A countered spell has no effect and spends no slot (2024), so "after you cast it using a spell
  slot" did not happen.

### Q25. Eye Rays: "reroll if the beholder has already used that ray during this turn" (2026-11-14)
Eye Rays now draws its ray and runs that ray's own Action (`useAction`, action-definitions.md "An option that uses another
Action"). A Beholder's Multiattack uses Eye Rays three times, a Death Tyrant's too, and a Spectator's and a Beholder
Zombie's twice. About one Beholder Multiattack in four rolls a ray it already used that turn.

- Question: should the draw itself skip a ray already used this turn, now?
- Done meanwhile: by hand, noted on each document ("draw: a result already drawn this turn is rerolled by hand"). With
  physical dice the GM rolls again before answering the draw; with digital dice the duplicate ray fires as rolled.
- Cost if now: one additive draw key (`noRepeat: "turn"`), a per-turn record of the options its creature drew (written
  after the Action, as `recordAttackTurn` does, but holding a set), the intent adapter passing it to the draw stage (as
  `castLevelChoices` does), and the draw rolling again on an excluded result (taking it when every option is excluded).
  About 30 lines in three files and three tests; no migration.
- Recommendation: yes, as the next item. The digital fallback (cancelling the ray in the Inspector) is awkward.

### Q26. Eye Rays: may a ray still be used on its own? (2026-11-14)
Each ray is still an Action of its own, costing an Action, as before this change; Eye Rays runs it for free when drawn.

- Question: should a ray be usable on its own at all?
- Done meanwhile: yes, unchanged. It is the GM's fallback for a reroll (Q25) or a ruling.
- Cost if no: the rays would be usable only after Eye Rays, paid from a pool Eye Rays refills. Since the drawn ray runs
  for free, that pool would hand the GM one extra ray each use, so it needs a "follow-up only" Action notion instead
  (a cost-free Action Item would be a free, unlimited Action). No migration.
- Recommendation: keep them until Q25 removes the main reason for the fallback, then decide.

### Q27. A drawn ray that can no longer resolve (2026-11-14)
The ray runs after Eye Rays completes. Its target may have died to an earlier ray of the same Multiattack, or become
Unaffected by it, before this one resolves (an Action the authority runs leaves an Unaffected creature out).

- Question: what happens to that ray?
- Done meanwhile: it fails or does nothing, as any Action does, the GM sees the result, and the Eye Rays use stays spent.
- Cost if it should be shot again: a re-pick of the target for the ray (the drawing Action's user asked again), and an
  Eye Rays use refunded when none is left. No data change, no migration.
- Recommendation: keep it. The text picks the target when the ray is shot, and a ray at a dead target is wasted.

### Q28. A lasting area's trigger with a once-a-turn record of its own: does it also spend the area's? (2026-11-14)
A lasting area's trigger may now carry `once: "turn"` (areas.md "Once per turn"): it comes at most once a combat turn on
a record of its own. The converter gives it to a repeat that answers entering beside other turn-boundary repeats ("enters
the area for the first time on a turn or starts its turn there", next to an end-of-turn save). Example: such an entering
fires, and on the same turn a trigger of the same area without its own record (a leaving trigger) would answer.

- Question: does the entering also use up the area's shared once per turn, so the other trigger is skipped?
- Done meanwhile: no. A trigger with its own record neither spends nor is spent by the shared record, so marking one
  trigger never changes what the area's other triggers do. Each source sentence carries its own "first time on a turn".
- Cost if yes: the own-record trigger also writes the shared record (one line in `apply`). No data change, no migration.
  No converted document has both shapes today.
- Recommendation: no. The texts that give several repeats limit each one in its own sentence.

### Q29. Guardian of Faith's 60 damage: what counts toward it? (2026-11-14)
Guardian of Faith now carries a lasting area with a damage budget (`persistence.budget: {damage: 60}`, areas.md "Carried
by a summon, and a damage budget"): "The guardian vanishes when it has dealt a total of 60 damage." Example: the guardian
has dealt 50, and its next 20 Radiant damage hits a creature with 8 Hit Points left.

- Question: does that strike count 20 or 8, and does damage Temporary Hit Points absorb count?
- Done meanwhile: 20, Temporary Hit Points included, as Q23 decided for "the damage taken". The strike that reaches 60
  deals its full damage, then the guardian vanishes.
- Cost of the other answer: capping the last strike at what remains, or counting only Hit Points lost (the plan's
  amount clamped to the creature's Hit Points), is a few lines in `spend`. No data change, no migration.
- Recommendation: keep it. The text counts damage dealt, and overkill is still damage the guardian dealt.

### Q30. Conjure Animals: "you can force that creature" and "a creature you can see" (2026-11-14)
The pack now carries a lasting area that affects its caster's enemies (`affects: "enemies"`), as Spirit Guardians does.

- Question: should the caster be asked each time whether to force the save, and should a creature the caster cannot see
  be left out?
- Done meanwhile: every enemy of the caster in reach saves automatically and allies never do; sight is not checked
  beyond hidden Tokens. Each converted document notes this ("area: its caster's choice ... is by hand").
- Cost of asking: a "you can" choice on the carried trigger, asked of the caster's user in the middle of another
  creature's movement for every creature it reaches. Checking sight is a line-of-sight test from the caster's Token
  in `apply`. No data change, no migration.
- Recommendation: keep it. Asking mid-movement for every creature is slow, and the choice almost always forces enemies.

### Q31. Dispel Magic on a summon's carried area (2026-11-14)
A carried area has no cast level of its own, so Dispel Magic does not offer it on its own.

- Question: should Dispel Magic be able to end Flaming Sphere, Guardian of Faith or Conjure Animals by choosing its area?
- Done meanwhile: no. Ending the spell (dismissing its summon) with Dispel Magic stays by hand, as it was before this
  change.
- Cost of yes: stamp the cast level on the carried area and have its end dismiss its carrier (the path the budget
  already takes). No data change, no migration.
- Recommendation: yes, as a small follow-up. Ending the area should end the spell, and the dismissal path exists now.

### Q32. Spiritual Weapon, Arcane Sword, Arcane Hand, Conjure Fey: whose Bonus Action? (2026-11-14)
These creatures take their own turn right after their caster and pay with their own Bonus Action. So today the caster
gets the creature's attack every round and keeps their own Bonus Action. The texts say: "As a Bonus Action on your
later turns, you can move the force ... and repeat the attack", and an attack "when the sword appears" or "when you cast
the spell" that the cast itself pays for.

- Question: confirm the reading. The creature's attack on the turn it appears is free (the cast's), and on later turns
  it costs its caster's Bonus Action.
- Done meanwhile: unchanged behaviour, noted on each such Action ("summon: its Bonus Action should be its summoner's;
  today it acts on its own turn at no cost to its caster (by hand)").
- Cost of the fix: the converter makes those Actions cost the caster's Bonus Action (`controllerCosts`, the companion
  path), and the summon carries one free command on the turn it appears (an additive `summon.freeCommand`, spent in the
  same transaction). Both must ship together: alone, the first would make Spiritual Weapon's attack on the cast turn
  impossible. No migration.
- Recommendation: yes, as the next item.

### Q33. Flaming Sphere's and Conjure Animals' moves (2026-11-14)
"As a Bonus Action, you can move the sphere up to 30 feet" (and the sphere stops when moved into a creature's space,
which then saves), and "when you move on your turn, you can also move the pack up to 30 feet".

- Question: should these move with their caster's turn, as the text says?
- Done meanwhile: each summon moves on its own turn with its own Speed, as every summon does now. The sphere's Roll keeps
  its Bonus Action cost, and its ram (the save and the stop) stays by hand.
- Cost of yes: a move granted on the caster's turn (the Arcane Eye's paid move already exists) plus a stop-on-entering
  rule for the sphere's ram. No migration.
- Recommendation: decide with Q32, since both change when a summon acts.

### Q34. Pact and Protection of the Talisman: who is "the wearer"? (2026-11-14)
Tasha's talisman adds 1d4 to its wearer's failed check (Pact) or save (Protection), from the warlock's uses (a number
equal to the warlock's Proficiency Bonus, back on a Long Rest). The warlock can give the talisman to another creature.
Both are now test offers (classes-and-spellcasting.md "Dice on a failed d20 test").

- Question: when another creature wears the talisman, should that creature be offered the die, paid from the warlock's
  uses?
- Done meanwhile: the offer is the warlock's own, as though the warlock wears it. Another wearer is by hand, noted on
  both documents ("talisman: offered to its warlock; another creature wearing it is by hand").
- Cost of yes: the talisman becomes gear carrying the offer, and the offer pays from another creature's pool (its
  warlock's), a payment across creatures that test offers do not have today. About one new key and its payer
  registration; no migration.
- Recommendation: keep the default. The prompt is opt-in, so a warlock whose ally wears the talisman just keeps the roll.

### Q35. "When you make a check" features on sheet rolls and Initiative (2026-11-14)
Test offers come only on Actions that roll against a DC (Hide's Stealth, an escape, a converted check). Ability checks
rolled from the sheet and Initiative have no DC, so they never fail and are never offered. Ambush, Tactical Assessment,
Commanding Presence and Tandem Footwork add a die to checks such as Stealth, History, Insight, Persuasion and Initiative,
and Peerless Skill, Tactical Mind, Flash of Genius, Psi-Bolstered Knack and Magical Guidance reach only check Actions.

- Question: should sheet rolls and Initiative offer a creature's dice after any roll, since there is no DC to fail?
- Done meanwhile: by hand. The four documents stay in the census, and the converted check offers come on check Actions
  only.
- Cost of yes: a new part on `Actor#rollTest` and `Combatant#rollInitiativeDice` that asks for the offers after the
  roll, whatever it shows, and applies the die, bonus or reroll to the result. No data change, no migration.
- Recommendation: yes, as its own item. Most checks in play are sheet rolls.

### Q36. Guided Strike: "a creature within 30 feet" (2026-11-14)
Guided Strike's +10 now helps its cleric's own miss and the miss of a creature within 30 feet, through the ally offer
path. That path never offers help to a creature hostile to its bearer.

- Question: should Guided Strike be offered on an enemy's miss too?
- Done meanwhile: no. Only the cleric and creatures not hostile to it are offered.
- Cost of yes: an additive key on the offer (`hostile: true`) that lets the ally path offer it to any creature in range.
  No migration.
- Recommendation: keep the default. Helping an enemy's attack hit is almost never what a player wants, and a GM can
  still rule it by hand.

### Q37. Cover against a lasting area's own save: from where? (2026-11-14)
A lasting area's trigger (entering it, a turn starting or ending in it) runs its Action from the Token that placed it
(`flags.wildpath.area.sourceTokenId`), and `actionCover` measures cover from that Token's corners, since the trigger's
Action carries no area point. Live (2026-11-14): a creature walking into the DMG Brown Mold got "Half cover" on its save,
measured from the hazard's Token far away. Any placed area does the same: a creature entering Moonbeam is measured
from its caster. Instant areas already measure from the area's point of origin (senses-and-cover.md).

- Question: where is cover measured from for a lasting area's trigger?
- Done meanwhile: nothing; still from the placing Token's corners.
- Options:
  1. From the area's point of origin, as for an instant area: a placed area's center (`areaCenter`), an emanation's or
     aura's Token. A creature standing in the area almost never has cover then.
  2. No cover at all against a lasting area's trigger.
  3. Keep the placing Token's corners.
- Cost of 1 or 2: the areas adapter passes the area's origin (or none) with the trigger's Action, and `actionCover`
  reads it. No data change, no migration.
- Recommendation: 1. It is the rule instant areas already follow, and it keeps an emanation (Spirit Guardians)
  measured from its caster.

### Q38. Telekinesis: walked, or set down anywhere within reach? (2026-11-14)
Telekinesis says "you move it up to 30 feet in any direction within the spell's range". An aimed push (`push.choose`,
areas.md "Forced Movement") now lets its caster click a free space within 30 feet of the creature and within the spell's
range.

- Question: does the creature travel there, so walls and other creatures in the way stop it, or is it set down on the
  chosen space like a teleport that can't pass walls?
- Done meanwhile: walked as forced movement, a field at a time in a straight line toward the chosen space, stopped by
  walls, creatures and the Scene's edge. It spends no Speed and provokes no Opportunity Attack (the push rule).
- Cost of "set down": the adapter moves the Token straight to the landing (a Blink, as a teleport) after a wall check
  between the two points. A few lines; no migration.
- Recommendation: keep the default. It is how every other push moves, and lasting areas the creature crosses still see
  it enter.

### Q39. An aimed push: chosen before or after the roll? (2026-11-14)
The caster clicks where the creature goes when using the Action, before the save is rolled, as for a teleport or an
area.

- Question: should the caster pick the space only after the creature fails its save?
- Done meanwhile: before. If the creature saves (or the attack misses), nothing moves.
- Cost of "after": a prompt to the caster from the authority between the save and the move, a new request in the
  resolution. About one new prompt; no data change.
- Recommendation: keep the default. The roll rarely changes where the caster wants the creature, and it keeps the
  Action a single click flow.

### Q40. Roper's Reel: "each creature Grappled by it" (2026-11-14)
Reel now pulls its targets 30 feet toward the roper, and refuses any target the roper does not grapple
(`targeting.sourceCondition: "grappled"`).

- Question: should Reel pull every creature the roper grapples without targeting them?
- Done meanwhile: the roper's controller targets them (any number), each refused unless Grappled by the roper.
- Cost of yes: a targeting option that picks every creature holding a condition from the source (a new
  `targeting.type`), resolved by the authority. No migration.
- Recommendation: keep the default. Targeting the grappled creatures is one click each, and the refusal keeps it honest.

### Q41. Telekinesis on a Gargantuan creature (2026-11-14)
"You can try to move a Huge or smaller creature."

- Question: is a Gargantuan creature refused as a target, or does it save and stay put?
- Done meanwhile: it can be targeted and rolls its save; neither the move nor Restrained applies to it (`maxSize: "huge"`
  on both).
- Cost of "refused": a target size limit on the Action (`targeting.maxSize`), checked by the authority as
  `maxSizeAboveSource` is. No migration.
- Recommendation: refuse it, as its own small item. Rolling a save that can do nothing is confusing at the table.

### Q42. Kraken's Fling: automate the throw? (2026-11-14)
"The kraken throws a Large or smaller creature Grappled by it to a space it can see within 60 feet of itself", and "the
creature thrown and each creature in the destination space" make the save.

- Question: automate the throw as a chosen landing that flies over creatures in the way, with each creature in the
  landing space saving too?
- Done meanwhile: by hand, noted on the Kraken ("push: the throw to a space it picks is by hand"). The save, damage and
  Prone on the thrown creature stay automated.
- Cost of yes: a thrown kind of aimed push (no walk: set down on the landing), a target taken from the source's grapple,
  and a second target set from the landing's occupants. About three new keys; no migration.
- Recommendation: by hand until a second document needs a throw.

### Q43. A magic weapon made from a base weapon: what binding it costs, and attunement (2026-11-14)
dnd5e gives the enchantment that makes a base weapon into Giant Slayer, Luck Blade, Nine Lives Stealer, Sword of
Wounding or Hammer of Thunderbolts no activation. Each is now a template Action, as Vorpal Sword and Weapon +1 are
(inventory.md "Item enchantments").

- Question: what does binding the magic item to one of the character's weapons cost, and must its "Requires Attunement"
  (and Luck Blade's "while the weapon is on your person") be enforced?
- Done meanwhile: free, one Item at a time (using it again moves it). The bonuses count while the enchanted weapon is
  equipped: a base Longsword needs no attunement, so attunement is not enforced, and "on your person" reads as equipped.
- Cost of a cost: an `activation` row per item (ACTIVATIONS_BY_HAND), a few lines. Cost of attunement: the enchantment
  sets the host Item's attunement to required (a new enchant key the adapter applies), a small adapter change; no
  migration.
- Recommendation: keep it free (the GM hands out the item), and enforce attunement as its own small item.

### Q44. Rod of the Pact Keeper: "your Warlock spells", and who picks +1, +2 or +3 (2026-11-14)
The rod is now a template with a choice of +1, +2 or +3 to spell attack rolls and spell save DCs.

- Question: should the bonus count only for Warlock spells, and should the GM, not the holder, set the rod's tier?
- Done meanwhile: any of the holder's spells while the rod is equipped (spells carry no class tag; only wrong for a
  multiclass warlock). The holder picks the tier each use, as with the Wand of the War Mage, so a +1 rod can be used
  as +3.
- Cost of "Warlock only": a class tag on cast spells and a predicate on it; spells learned from several classes need
  the class they were cast as. Cost of "GM sets the tier": one converted Action per tier instead of a choice, the GM
  handing out the right one. Neither needs a migration.
- Recommendation: one Action per tier (the honest one is cheap); Warlock-only when a second document needs class tags.

### Q45. Blessing of Weapon Enhancement: "one nonmagical weapon" (2026-11-14)
- Question: should the choice leave out magic weapons?
- Done meanwhile: any one of the creature's weapons. The gear choice does not filter by magic.
- Cost of yes: a `magical: false` filter on gear choices (the weapon's `mgc` property), a few lines; no migration.
- Recommendation: keep the default until a second document asks for it.

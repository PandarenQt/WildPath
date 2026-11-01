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

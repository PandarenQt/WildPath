# Questions for the owner

Questions that came up during autonomous work. None of them blocks the work: each one says what was done meanwhile.
Answer inline (or in the vault's decisions list), and the next session acts on the answer.

## Caster-granted actions

- **Owner decision 2026-11-16.** Use Baldur's Gate 3 as the gameplay reference when a spell gives its caster a follow-up choice. Grant the caster an Action for that choice. It is available immediately if there are no prerequisites and becomes available whenever its prerequisites are met. Each use follows the spell's own timing and cost.
- For example, the 2024 Conjure Animals pack move becomes available when the caster moves on their turn (Q33). Attacks that belong to an independently acting summon use that summon's turn and action economy (Q32).
- **Owner decision 2026-11-16.** As a general rule, each summon acts on its own turn at its own initiative. The caster-turn movement granted by Flaming Sphere and the 2024 Conjure Animals pack follows Q33.
- **Owner decision 2026-11-16 (scope of the summon rule).** Every summon that acts rolls its own initiative, including summons whose text says it "shares your Initiative count" or "takes its turn immediately after yours" (Summon Dragon, Giant Insect, Animate Objects, Bag of Tricks, elemental items). Exception: a controlled mount (Find Steed) keeps its rider's turn. A summon that never acts (Mage Hand, Floating Disk, Arcane Eye, sensors, illusions) gets no combat turn.

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
  Built 2026-11-21: War Caster's reactive spell, a reaction Trigger's `asOpportunity`, `eachAction` and `replaceCost` (reactions.md "War Caster's reaction spell"): each one-action spell at one creature is offered beside the Opportunity Attack, aimed at the mover, cast with the Reaction.

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
- **Answered 2026-11-15: use 0.10.0. Merge to `main` after a full Quench run and a two-browser pass on vehicles, shared Bastions and creature spaces. Use the GitHub repository URL and standard release URLs for `system.json` and `system.zip`. Group the changelog by feature.**

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
- **Answered 2026-11-16:**
  1. **Ice Knife.** Give both silver dragons Ice Knife if the spell is in the open SRD. It is. Use the Monster Manual stat block's casting details if versions differ. The SRD gives the adult the base spell and the ancient the level 2 version. [SRD 5.2.1, spell p. 141](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf#page=141) and [silver dragons, pp. 324–325](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf#page=324).
  2. **Hide and Search.** Yes. For the 2024 rules, resolve Hide against DC 15 and store the successful Stealth total as the DC for a searcher's Wisdom (Perception) check. Support the proposed `perceived` roll-mode domain for the cloak.
  3. **Wall of Ice.** Plan destructible 10-foot sections and automatic Frigid Air. When a section reaches 0 HP, open that section and create a sheet of frigid air in its space. The first time a creature crosses that sheet on a turn, roll a Constitution save for 5d6 Cold damage at base level, half on success. Add 1d6 per slot level above 6. [SRD 5.2.1, pp. 172–173](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf#page=172).
  4. **Earthquake.** Have the system suggest how the fissures unfold and where to place them. Fissure tiles should overwrite walls where they overlap. Prompt the GM to adjudicate the remaining consequences, including falls and structural damage. Use the spell's fissure timing and placement rules for the initial suggestion. [SRD 5.2.1, p. 127](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf#page=127).
  5. **Helm of Brilliance.** Roll the four gem counts once, track each pool, spend the matching gems on casts and use the remaining counts for Explosive Emanation.
  6. **Pipes of the Sewers.** Treat a swayed swarm as the piper's companion while the piper keeps playing. Offer a separate action to take control of another eligible rat swarm. A swarm already controlled by another actor is ineligible.
  7. **Mirror of Life Trapping.** Prompt the save on entering the 30-foot range or starting a turn there. Mark a trapped creature and remove its token from the scene.
  8. **Contingency.** When the player first casts Contingency, they choose the contingent spell and spend its spell slot. Store that choice for this casting. When the circumstance arises, the GM can prompt the player to resolve the stored spell. Accepting the prompt costs no additional spell slot, action or reaction, even if the player has already used their reaction this round. A fixed event list is unnecessary.
  9. **Antimagic Field, Simulacrum and Magic Jar.** Automate all three. For Antimagic Field, block affected spellcasting and magic actions within the field and suppress affected magical effects and rules while they are inside it. For Simulacrum, copy the target actor at casting and apply the spell's changes to the copy. For Magic Jar, represent the vessel as an item and give the caster possession and return actions. Reuse the existing cast, possess and return entries and track which soul is in each body or vessel.
- **Owner decision 2026-11-16 (order).** Build these large features after the answer deltas from Q19–Q76, one at a time, each designed with its open rules questions recorded first.
- **Application of the caster-action decision (2026-11-16).** For Magic Jar, grant possession while the caster occupies the vessel and return-from-host while the caster occupies a host. For Contingency, the GM’s grant enables the stored spell’s free resolution. For the Pipes, enable taking another swarm when an eligible uncontrolled swarm is available.

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
- **Answered 2026-11-16: Track each condition source separately, with its own duration, concentration and escape DC. The condition lasts while any source remains. (a) Escape targets the highest-DC hold and removes only that hold on success. (b) A removal that clears the condition without naming a source clears every instance. (c) Burning damage stacks across active sources. Each source contributes its own 1d4 when its trigger is due, so two sources due together deal 2d4. (d) Keep a GM-applied condition as its own instance when another source applies it.**
  Built 2026-11-21: a non-stacking condition is one effect per source (`conditionSourceKey`: its Action and source;
  the GM's is its own), applied beside the others and refreshed by its own source; Escape and Free name the hold they
  end (`metadata.effectId`), a lifecycle end names its instance, a removal naming none ends every instance (the commit
  and the sheet's toggle-off), a second instance is built from the first's status data, and two Burnings due together
  roll 2d4 as one damage (Q93 (b)). `heldElsewhere` keeps only its custom-effect half (effect-resolver.md).

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
- Done meanwhile (until 2026-11-21): nothing; the combined per-component factor stayed.
- Recommendation: yes. A creature with both to the same type is rare, but two parts of one type in a hit are common
  (a Flame Tongue hit with Searing Smite: 2d6 + 1d6 Fire), and each odd part loses a point today.
- **Answered 2026-11-16: Total damage of each type within a single hit. Apply Resistance to that total, round down, then apply Vulnerability. Two 3-Fire components in one hit deal 3 after Resistance. A 5-Fire hit deals 4 when both Resistance and Vulnerability apply.**
  Built 2026-11-21: the damage adjustment resolver totals each type's parts within a damage result (one hit; a rider's damage joins its attack's) and splits the total back over them (damage-resolver.md), with Q94's defaults.

### Q21. Prismatic Spray: two rays of one color on one creature (2026-11-13)
Prismatic Spray, Special (8): "The target is struck by two rays. Roll twice, rerolling any 8." The two rolls can give the
same color. The rolled choice (`draw`, action-definitions.md "Drawn choices") keeps each option's parts once per
creature, and a color's 12d6 is one roll shared by every creature that color hit (2024: damage to several targets at
once is rolled once).

- Question: when both rolls give the same color, does the creature take that ray twice (its 12d6 twice, or the Indigo or
  Violet effect twice), or once?
- Cost if twice: the draw stage keeps each repeat as a separate copy of that color's parts, with its own damage roll
  for that creature. No data change, no migration.
- Done meanwhile (until 2026-11-20): once, with a converter note ("takes it once (Q21)"); both are gone now.
- Recommendation: twice for damage (the text says "struck by two rays"); Indigo's or Violet's condition twice changes
  nothing, as a condition does not stack.
- **Answered 2026-11-16: Resolve both rays even when they have the same color and target. Roll each damaging ray separately. Duplicate applications of the same non-stacking condition have no additional effect.**
  Built 2026-11-20: the draw stage's `repeats` copy a repeated damage ray for its creature, and each ray is its own damage result (`metadata.damageInstance`, action-definitions.md "Drawn choices": its own concentration check, death save and damage hooks), with Q95's default.

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
- **Answered 2026-11-16: An eligible creature can use a “succeed instead” feature on an automatic failure if it can pay the usual cost. An Unconscious creature cannot use the feature, even when it costs no reaction.**
  Built 2026-11-20: `testOffer.unlessStatus: "unconscious"` on the three "succeed instead" rows (classes-and-spellcasting.md "Unless a status"), with Q96's default.

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
- **Answered 2026-11-16: Use the full damage taken, including damage absorbed by temporary HP. In the Wraith example, reduce the target’s HP maximum by 18.**

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
- **Answered 2026-11-16: “When you cast” triggers fire when the casting begins, even if the spell is subsequently countered. “After you cast” triggers require the casting to complete and do not fire if the spell is countered.**
  Built 2026-11-21: the `action.cast` event, reported for a completed cast and for one a counter stopped (tagged `countered`); the converter puts "when you cast" riders on it and keeps "after you cast" on `action.completed` (rule-elements.md "Automatic triggers"), with Q97's defaults.

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
- **Answered 2026-11-16: Automatically reroll an Eye Ray that this creature has already used on the current turn.**
  Built 2026-11-20: `draw.noRepeat: "turn"` (action-definitions.md "Drawn choices"), on every Action whose text says
  "reroll if ... already used ... this turn", with Q98's (a) and (b) defaults.

### Q26. Eye Rays: may a ray still be used on its own? (2026-11-14)
Each ray is still an Action of its own, costing an Action, as before this change; Eye Rays runs it for free when drawn.

- Question: should a ray be usable on its own at all?
- Done meanwhile: yes, unchanged. It is the GM's fallback for a reroll (Q25) or a ruling.
- Cost if no: the rays would be usable only after Eye Rays, paid from a pool Eye Rays refills. Since the drawn ray runs
  for free, that pool would hand the GM one extra ray each use, so it needs a "follow-up only" Action notion instead
  (a cost-free Action Item would be a free, unlimited Action). No migration.
- Recommendation: keep them until Q25 removes the main reason for the fallback, then decide.
- **Answered 2026-11-16: Keep individual rays available to the GM as standalone Actions for now. Revisit that fallback after automatic same-turn rerolls (Q25) are implemented.**

### Q27. A drawn ray that can no longer resolve (2026-11-14)
The ray runs after Eye Rays completes. Its target may have died to an earlier ray of the same Multiattack, or become
Unaffected by it, before this one resolves (an Action the authority runs leaves an Unaffected creature out).

- Question: what happens to that ray?
- Done meanwhile: it fails or does nothing, as any Action does, the GM sees the result, and the Eye Rays use stays spent.
- Cost if it should be shot again: a re-pick of the target for the ray (the drawing Action's user asked again), and an
  Eye Rays use refunded when none is left. No data change, no migration.
- Recommendation: keep it. The text picks the target when the ray is shot, and a ray at a dead target is wasted.
- **Answered 2026-11-16: Resolve Eye Rays, Extra Attack and Multiattack one attack at a time. Choose the target for the first ray or attack, resolve it fully, then choose the next target using the resulting battlefield. A creature killed by an earlier attack does not consume a later attack through a target choice made in advance.**
- Built (2026-11-21): a user's Eye Rays holds its creature until its drawn ray has resolved, follow-ups included, so the
  next Eye Rays (and its target) waits for it; Multiattack and Extra Attack swings already waited for the last one's
  follow-ups (2026-11-20). The GM's Cancel Action on a stuck ray frees the creature.

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
- **Answered 2026-11-16: Keep a trigger’s own once-per-turn limit independent of the area’s shared limit. Entering can spend the entry trigger and still leave a separate exit trigger available on the same turn.**

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
- **Answered 2026-11-16: Count the full damage dealt toward the guardian’s 60, including overkill and damage absorbed by temporary Hit Points. Resolve the final strike in full, then remove the guardian when the total reaches or exceeds 60.**

### Q30. Conjure Animals: "you can force that creature" and "a creature you can see" (2026-11-14)
The pack now carries a lasting area that affects its caster's enemies (`affects: "enemies"`), as Spirit Guardians does.

- Question: should the caster be asked each time whether to force the save, and should a creature the caster cannot see
  be left out?
- Done before the answer: every enemy of the caster in reach saves automatically and allies never do; sight is not checked
  beyond hidden Tokens. Each converted document notes this ("area: its caster's choice ... is by hand").
- Cost of asking: a "you can" choice on the carried trigger, asked of the caster's user in the middle of another
  creature's movement for every creature it reaches. Checking sight is a line-of-sight test from the caster's Token
  in `apply`. No data change, no migration.
- Recommendation: keep it. Asking mid-movement for every creature is slow, and the choice almost always forces enemies.
- **Answered 2026-11-16: Use separate flows by edition. In 2014, prompt the caster to choose the animals to summon. In 2024, prompt eligible enemies directly for a Dexterity save when the pack moves within 10 feet of them, they enter that range, or they end their turn there. Each creature saves at most once per turn. Use the 2024 Emanation rules to measure the area from the spectral pack as it moves. Apply the spell’s caster-sight requirement when determining eligible enemies. [2024 spell](https://www.dndbeyond.com/spells/2619044-conjure-animals) and [Emanation, SRD p. 181](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf#page=181).**
  Built 2026-11-20 (2024): the pack's carried area's triggers carry `targeting.eligible` `seenBySource` ("a creature you can see"), so a creature its caster does not see (`tokenSees`) is left alone on every event and spends none of its once per turn, beside `affects: "enemies"` (asked directly, none spared); the by-hand note is gone (areas.md). The 2014 choice of animals was built earlier (Q99's default).

### Q31. Dispel Magic on a summon's carried area (2026-11-14)
A carried area has no cast level of its own, so Dispel Magic does not offer it on its own.

- Question: should Dispel Magic be able to end Flaming Sphere, Guardian of Faith or Conjure Animals by choosing its area?
- Done meanwhile: no. Ending the spell (dismissing its summon) with Dispel Magic stayed by hand until it was built
  (2026-11-21, below).
- Cost of yes: stamp the cast level on the carried area and have its end dismiss its carrier (the path the budget
  already takes). No data change, no migration.
- Recommendation: yes, as a small follow-up. Ending the area should end the spell, and the dismissal path exists now.
- **Answered 2026-11-16: Allow Dispel Magic to target the area carried by Flaming Sphere, Guardian of Faith or the 2024 Conjure Animals pack. Use the original casting level to resolve the dispel. On success, end the spell and dismiss its carrier.**
- Built (2026-11-21): a carried area has its spell's cast level (the slot, else the spell's), so Dispel Magic lists it
  and resolves it by that level; ending it (the areas adapter's `end`) dismisses its carrier with its whole cast, and the
  caster's concentration marker goes with the spell's last creature (areas.md, companions.md).

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
- **Answered 2026-11-16: Use the BG3-style summon action economy for Spiritual Weapon, Arcane Sword, Arcane Hand and Conjure Fey. Each summon takes its own turn on its own initiative and pays for its attacks from its own action economy, including on its first turn. The caster keeps their Bonus Action.**
- **Scope, 2026-11-16:** see "Caster-granted actions" at the top. Every acting summon rolls its own initiative, except a controlled mount.
  Built 2026-11-20: `summon.initiative` (companions.md "Combat (2024)"): an acting summon rolls one Initiative per cast,
  a controlled mount (Find Steed) keeps its rider's turn, one that never acts gets no Combatant; the by-hand note is gone,
  and Conjure Fey's caster-side "Teleport and Attack" is not converted. Q99 (a), (b), (h) and (i)'s first half are built
  with their defaults.

### Q33. Flaming Sphere's and Conjure Animals' moves (2026-11-14)
"As a Bonus Action, you can move the sphere up to 30 feet" (and the sphere stops when moved into a creature's space,
which then saves), and "when you move on your turn, you can also move the pack up to 30 feet".

- Question: should these move with their caster's turn, as the text says?
- Done meanwhile: each summon moves on its own turn with its own Speed, as every summon does now. The sphere's Roll keeps
  its Bonus Action cost, and its ram (the save and the stop) stays by hand.
- Cost of yes: a move granted on the caster's turn (the Arcane Eye's paid move already exists) plus a stop-on-entering
  rule for the sphere's ram. No migration.
- Recommendation: decide with Q32, since both change when a summon acts.
- **Answered 2026-11-16: Move Flaming Sphere and the 2024 Conjure Animals pack on the caster’s turn. The caster can spend a Bonus Action to move the sphere up to 30 feet. If it enters a creature’s space, stop the sphere there and prompt that creature for its save. When the caster moves on their turn, they can also move the spectral pack up to 30 feet without spending a Bonus Action. Use Q30 for the pack’s save prompts.**
- **Application of the caster-action decision (2026-11-16).** Give the caster the sphere-move Action while the spell is active and its Bonus Action cost can be paid. Enable the pack-move choice when the caster moves on their turn. Keep the pack’s enemy save prompts under Q30.
  Built 2026-11-21: the sphere's Roll on the caster's bar costs the caster's Bonus Action and gives 30 feet until the
  caster's turn ends with `occupancy.ram`: it stops in the first creature's space it enters, and that creature saves
  against the spell (`area.rammed` on its carried area). The pack's free Move (`byController`) is on the caster's bar,
  enabled once the caster has moved on its own turn, once a turn. Q99 (c), (d) and (e)'s first half are built with their defaults
  (companions.md "Moves on the caster's turn").

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
- **Answered 2026-11-16: Offer the d4 to the creature currently wearing the talisman when it fails an eligible ability check (Pact) or saving throw (Protection). If the wearer accepts, spend one use from the granting warlock’s corresponding pool, including when another creature wears it.**
  Built 2026-11-21: `testOffer.givenStatus: "talisman"` on both rows (classes-and-spellcasting.md "A status its bearer gives"). The wearer is offered the die and decides, and the warlock pays. Pact of the Talisman's Give Talisman Action gives the effect, one wearer at a time (Q64's `replacesEarlier`), with Q100's defaults. The premium book gets it on its next reconvert.

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
- **Answered 2026-11-16: Offer eligible features after ability checks rolled from the sheet and after Initiative rolls. If a feature requires a failed check, use the known result when available. Ask whether the check failed only when the outcome is unknown and failure is required for an otherwise eligible feature.**

### Q36. Guided Strike: "a creature within 30 feet" (2026-11-14)
Guided Strike's +10 now helps its cleric's own miss and the miss of a creature within 30 feet, through the ally offer
path. That path never offers help to a creature hostile to its bearer.

- Question: should Guided Strike be offered on an enemy's miss too?
- Done meanwhile: no. Only the cleric and its allies were offered (a neutral creature too once built, below).
- Cost of yes: an additive key on the offer (`hostile: true`) that lets the ally path offer it to any creature in range.
  No migration.
- Recommendation: keep the default. Helping an enemy's attack hit is almost never what a player wants, and a GM can
  still rule it by hand.
- **Answered 2026-11-16: Offer Guided Strike when the cleric misses or a nonhostile creature within 30 feet of the cleric misses. Leave the decision to help a hostile creature to the GM.**
  Built 2026-11-20: `testOffer.nonhostile: true` on Guided Strike reaches a neutral creature too (never a GM-hidden one for a player's cleric), with Q102's default.

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
- **Answered 2026-11-16: Apply no cover bonus to a saving throw caused by a lasting area's own trigger. This applies to placed areas, auras and emanations.**
  Built 2026-11-20: `noCover` from the areas adapter and from turn-event Emanation Triggers to `actionCover` (senses-and-cover.md, areas.md), with Q103's defaults.

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
- **Answered 2026-11-16: While Telekinesis is active, grant the caster its repeat-use Action at the spell's normal timing and cost. Move the target as forced movement along the path toward the chosen destination. Walls, occupied spaces and the scene edge stop it. Resolve area-entry triggers along the path.**
  Built 2026-11-20: "Telekinesis (Again)" and its copies require that the caster's marker was not begun this combat turn (`startedThisTurn`, from the effect's V14 `start`), so an Action Surge on the cast's turn gives no second use (action-definitions.md "Requires"). The walked move and area entry were built before.

### Q39. An aimed push: chosen before or after the roll? (2026-11-14)
The caster clicks where the creature goes when using the Action, before the save is rolled, as for a teleport or an
area.

- Question: should the caster pick the space only after the creature fails its save?
- Done meanwhile: before. If the creature saves (or the attack misses), nothing moves.
- Cost of "after": a prompt to the caster from the authority between the save and the move, a new request in the
  resolution. About one new prompt; no data change.
- Recommendation: keep the default. The roll rarely changes where the caster wants the creature, and it keeps the
  Action a single click flow.
- **Answered 2026-11-16: The caster chooses the destination of an aimed push when declaring the Action, before the attack or save is rolled. Move the target only if the push succeeds.**

### Q40. Roper's Reel: "each creature Grappled by it" (2026-11-14)
Reel now pulls its targets 30 feet toward the roper, and refuses any target the roper does not grapple
(`targeting.sourceCondition: "grappled"`).

- Question: should Reel pull every creature the roper grapples without targeting them?
- Done meanwhile: the roper's controller targets them (any number), each refused unless Grappled by the roper.
- Cost of yes: a targeting option that picks every creature holding a condition from the source (a new
  `targeting.type`), resolved by the authority. No migration.
- Recommendation: keep the default. Targeting the grappled creatures is one click each, and the refusal keeps it honest.
- **Answered 2026-11-16: The roper's controller chooses which of its grappled creatures to pull. Allow any number of eligible targets and pull each selected target up to 30 feet toward the roper.**

### Q41. Telekinesis on a Gargantuan creature (2026-11-14)
"You can try to move a Huge or smaller creature."

- Question: is a Gargantuan creature refused as a target, or does it save and stay put?
- Done meanwhile: it could be targeted and rolled its save; neither the move nor Restrained applied to it (`maxSize: "huge"`
  on both), until built (below).
- Cost of "refused": a target size limit on the Action (`targeting.maxSize`), checked by the authority as
  `maxSizeAboveSource` is. No migration.
- Recommendation: refuse it, as its own small item. Rolling a save that can do nothing is confusing at the table.
- **Answered 2026-11-16: application of the caster-action decision.** For Telekinesis against creatures, accept targets up to Huge. Reject a Gargantuan creature before rolling or spending the use on that target. Other eligible creatures and the spell’s object option remain available.
  Built 2026-11-20: `targeting.maxSize: "huge"` on Telekinesis and its copies; the authority refuses a larger target before anything is rolled or spent (targeting.md).

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
- **Answered 2026-11-16: Automate Fling and build reusable support for controller-chosen targets and destinations whenever an ability calls for a non-random choice. For a throw, allow an occupied landing space, identify the thrown creature and every creature it lands on, and resolve the throwing ability's saves, damage and conditions for each affected creature. For the Kraken, its controller chooses a Large or smaller creature it grapples and a visible destination within 60 feet of the Kraken that is not in the air. It throws the creature over intervening creatures. The thrown creature and each creature already in the landing space make their own DC 25 Dexterity save. Failure deals 4d8 Bludgeoning damage and knocks that creature Prone. Success deals half damage without applying Prone.**

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
- **Answered 2026-11-16: (a) Binding the magic item to a base weapon is free. (b) Enforce attunement when the magic item requires it. (c) Require the weapon to be equipped for its benefits, including the Luck Blade benefits described as working while it is on the bearer’s person.**
  Built 2026-11-21: (b) `enchant.attunement` on a weapon template needing attunement, its binding made unattuned and
  attuned from the sheet's Attuned toggle on the weapon's row (counted toward the limit), and a gear template's binding
  (Armor of Resistance on a base armor) counting only while its gear is attuned; (c) its benefits count only while the
  weapon is equipped and the binding attuned, and its other Actions (Luck Blade's Wish, an Oathbow's Swear Oath) require
  a working binding of its key (requiresContext's `enchantments`). Flame Tongue's attunement is noted by hand. With
  Q107's defaults (inventory.md "Item enchantments").

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
- **Answered 2026-11-16: (a) Rarity fixes the rod’s bonus. WildPath selects the rarity when generating loot, hoards or store stock, or the GM selects it when assigning the item. Use that tier for every cast with the rod. (b) Final ruling: defer class checks generally, including enforcement of the rod’s Warlock-spells-only bonus. A second feature needing class tags does not by itself reopen this decision.**
  Built 2026-11-21: (a) each tier option carries its rarity (`option.rarity`), and the granting gear's `system.rarity`,
  set by the GM on its sheet, leaves only that tier offered (`withGrantedRarity`), with Q108's defaults. Generating loot,
  hoards and store stock is not built (the randomizer roadmap); the rod's Warlock-only note stays (b).

### Q45. Blessing of Weapon Enhancement: "one nonmagical weapon" (2026-11-14)
- Question: should the choice leave out magic weapons?
- Done meanwhile: any one of the creature's weapons; the gear choice did not filter by magic, until built (below).
- Cost of yes: a `magical: false` filter on gear choices (the weapon's `mgc` property), a few lines; no migration.
- Recommendation: keep the default until a second document asks for it.
- **Answered 2026-11-16: application of the caster-action decision.** For Blessing of Weapon Enhancement, offer only the bearer’s nonmagical weapons. A magical weapon cannot satisfy this choice.
  Built 2026-11-20: `optionsFrom.magical: false` on the Blessing's gear choice and Magic Weapon's weapons choice, with Q109's default (action-configuration.md).

### Q46. Warding Flare, Deflect Attack, Glorious Defense, Arrow-Catching Shield: an ally's attack roll too? (2026-11-14)
Warding Flare answers "a creature that you can see within 30 feet" making an attack roll; the Steel Defender's Deflect
Attack, a creature it sees within 5 feet; Glorious Defense, any hit on a creature it sees within 10 feet; Arrow-Catching
Shield, any ranged attack on a creature within 5 feet. None of the texts says hostile.

- Question: should they be offered on an ally's attack roll too?
- Done meanwhile: only a hostile creature's, as you chose for Counterspell and Cutting Words (no prompt on every
  attack an ally makes). Shadowy Dodge and Limited Foresight answer an attack on their own creature.
- Cost of yes: drop the hostile clause from four rows; every ally attack within 30 feet of a cleric (or every party hit
  next to a paladin) then asks first.
- Recommendation: keep hostile only.
- **Answered 2026-11-16: Prompt for Warding Flare, Deflect Attack, Glorious Defense and Arrow-Catching Shield only when the attacker is hostile and the feature’s own conditions are met.**

### Q47. Redirect Attack and the Golden Goblin Bicuspid: "an ally", "Small or Medium", "another goblin" (2026-11-14)
- Question: which of the picked creature's limits should be enforced?
- Done meanwhile: "an ally" is enforced as not hostile to the reactor (a neutral creature counts), so the Bicuspid can't
  move an enemy's hit onto another enemy. "Small or Medium" (2024 Goblin Boss) and "another goblin" (Tasha's) are not
  checked: the GM's call at the pick. Known limit: the reaction is offered, and spends its Reaction (and the Bicuspid's
  use) when taken, even when no such creature is within 5 feet; it then changes nothing (Cloud Rune shares this). The
  GM declines it then.
- Cost of yes: a `maxSize` and a creature-type filter on the redirect's candidates, a few lines each; no migration.
- Recommendation: add them when a second document needs either.
- **Answered 2026-11-16: For ally selection, treat neutral creatures as friendly until attacked. Plan automatic redirect recipient filters for each feature’s size and creature requirements, including Small or Medium and another goblin. Apply the conditional-action rule to an empty redirect: when no eligible recipient is available, do not spend the Reaction or item use. When WildPath can determine that no candidate qualifies, the reaction is unavailable.**
- **"Until attacked", 2026-11-16:** a neutral creature turns hostile to a side when it attacks a creature on that side, or a creature on that side attacks it. This lasts until the combat ends. It is stored as a GM-written record on the Combat; Token dispositions are not changed.
  Built 2026-11-21: `rider.redirectDamage.eligible` (a predicate over the candidate, with a new `size` fact; the converter reads "a Small or Medium ally"), a redirect (and a `retarget` or a reaction's pick of a creature in range, which take `eligible` too) offered only while a creature qualifies (`redirectable`), one that finds nobody when paid failing without spending, and `flags.wildpath.turnedHostile` on the Combat, written once an attack completes and read by the one hostility check `tokensHostile` (reactions.md), with Q110's and Q111's defaults. An attack roll is what "attacks" means; a reaction's own attack (an Opportunity Attack) records nothing yet.

### Q48. Redirect Attack and Arrow-Catching Shield: answered only on a hit? (2026-11-14)
The texts say "makes an attack roll against it" and "makes a ranged attack roll against a target".

- Question: should a miss also be movable (onto a creature the same roll would hit)?
- Done meanwhile: answered once the roll hits (before its damage), the same roll checked against the new creature's AC
  (Cloud Rune's way). A miss is never moved.
- Cost of yes: a redirect on `attack.miss` too, which retargets a miss into a hit and needs its damage rolled after
  the fact; a new window shape.
- Recommendation: keep it on hits only (moving a miss onto an ally is rarely wanted).
- **Answered 2026-11-16: Offer Redirect Attack and Arrow-Catching Shield only after the attack hits its original target, before damage. Check the original attack roll against the new target’s AC.**
  Built 2026-11-20: a natural 20 (the attack's critical range) moved this way always lands (`redirectedDamage`), with Q114's default for cover.

### Q49. Goblin Boss's Redirect Attack: swapping places (2026-11-14)
- Question: automate "the goblin and that ally swap places"?
- Done meanwhile: by hand, noted ("Redirect Attack: reaction: swapping places is by hand"); the attack moves.
- Cost of yes: a reusable swap rider moving both Tokens (also Bait and Switch and Trickster's Transposition), on the
  push/teleport adapters; its own item, no migration.
- Recommendation: build it as its own part with those three documents.
- **Answered 2026-11-16: Automate the exchange of the two chosen tokens’ positions. Use the same swap mechanic for Redirect Attack, Bait and Switch, and Trickster’s Transposition.**
  Built 2026-11-21: one swap part (`swapTokens`): `swap: true` on an Action (its creature and its one target) and
  `rider.swap` on a redirect (its creature and the creature picked); the SRD Goblin Boss converts with it. Bait and
  Switch can be written as data with it, but the converter does not write it yet (no SRD document to read it from) and
  the premium books are not reconverted (the owner's 2026-11-21 "framework first"); Transposition waits on Invoke
  Duplicity's illusion as a summoned Token (Q113 (b)).

### Q50. Disadvantage before the roll or after it (2026-11-14)
The 2014 Warding Flare text imposes Disadvantage "before it hits or misses", which could be read as after the d20.

- Question: should these reactions answer after the roll (roll again, keep the lower)?
- Done meanwhile: before the roll (`action.declared`), as the 2024 texts read ("makes an attack roll ... impose
  Disadvantage"). The reactor decides without seeing the d20.
- Cost of after: a "roll another d20, keep the lower" rider in the after-roll window; Runic Shield's "reroll, use the
  new roll" could share it.
- Recommendation: keep before.
- **Answered 2026-11-16: Commit to Warding Flare and comparable reactions that impose Disadvantage before the attack roll, while the first d20 is still unknown.**

### Q51. A Brutal Strike after a Warding Flare in the same window (2026-11-14)
- Question: should Brutal Strike's "forgo Advantage" leave another creature's Disadvantage in place?
- Done meanwhile: reactions in one window resolve in initiative order, and Brutal Strike's rider replaces every roll
  mode source, so a Warding Flare answered first is wiped and its use spent for nothing (rare: a barbarian's Reckless
  Attack against a cleric's ally).
- Cost of fixing: Brutal Strike's rider drops only Advantage sources instead of replacing the mode; it changes its
  tested semantics, a small change.
- Recommendation: fix it as its own small item.
- **Answered 2026-11-16: Brutal Strike removes the Advantage the barbarian forgoes. Preserve Disadvantage from other sources, including Warding Flare.**
  Built 2026-11-20: `rider.forgoRollMode: "advantage"` (reactions.md), with Q112's defaults. The "initiative order" above was
  wrong: a reaction to its own Action comes after its target's (priority 200).

### Q52. Divine Fury: automatic, or offered? (2026-11-14)
The text says the first creature hit "takes extra damage" (not optional), but its type is chosen each time.

- Question: should it apply on its own (with a type choice) instead of being offered?
- Done meanwhile: two offers, Necrotic and Radiant, sharing one use a turn while raging, as Divine Strike's. Declining
  forgoes it, and a declined offer on the turn's first hit can still be taken on a later hit that turn, though the
  rules mean only the first creature hit.
- Cost of yes: an automatic Trigger with a damage-type choice (`reactionPolicy: always` plus a type choice), and a
  "first hit this turn" record that a decline also spends; a new small part.
- Recommendation: keep the offers until a second "first creature you hit" feature needs the record.
- **Answered 2026-11-16: Plan automatic Divine Fury damage on the first qualifying hit on each of the barbarian’s turns while raging. The player chooses Radiant or Necrotic on that hit. The use cannot be saved for a later hit that turn.**
  Built 2026-11-20 (rule-elements.md): one automatic Action (`reactionPolicy: always`) whose Necrotic or Radiant its
  controller picks on the turn's first qualifying hit; Q116's defaults: a decline or a closed type prompt spends nothing,
  and Divine Strike is one asked offer with the same type choice.

### Q53. Rend Mind: the free use and the Psionic Energy use on the same hit (2026-11-14)
- Question: should taking one stop the other on that hit, and should the free use come back on a Long Rest?
- Done meanwhile: both are offered while each can be paid, so both can be used on one hit (the second Stunned does
  nothing more). dnd5e gives the 2024 free use no recovery, so it does not come back by itself (the GM restores it).
- Cost of yes: a shared once key per hit, and a Long Rest recovery read from "until you finish a Long Rest" for an
  activity's own uses; each a few lines, no migration.
- Recommendation: add the Long Rest recovery; keep both offers.
- **Answered 2026-11-16: Restore Rend Mind’s free use on a Long Rest. The player may use both the free use and a separately paid Psionic Energy use on the same hit if both are available.**

### Q54. Psionic Strike's "within 30 feet of you": measured when? (2026-11-14)
- Done meanwhile: at the hit, from the attacker to the creature hit (`toTarget.{self}.distance`).
- Cost of another reading: none needed unless the owner reads it otherwise.
- Recommendation: keep.
- **Answered 2026-11-16: Measure Psionic Strike’s 30-foot range from the attacker to the target at the moment the attack hits.**

### Q55. Physician's Touch's Poisoned: always offered with Hand of Harm? (2026-11-14)
- Done meanwhile: Physician's Touch adds a choice to Hand of Harm's own hit offer (`CHOICES_FOR`, as Restoring Touch on
  Lay on Hands), defaulting to Poisoned until the end of the monk's next turn; "No" leaves it out. One offer, Hand of
  Harm's damage, Focus cost and once a turn. Its Hand of Healing's ending a condition stays by hand.
- Cost of another reading: none needed unless the owner wants Poisoned without asking (a single-option choice, as
  Eldritch Hex's).
- Recommendation: keep.
- **Answered 2026-11-16: Include the Poisoned choice in the Hand of Harm prompt. Default to applying Poisoned until the end of the monk’s next turn and let the monk decline it.**

### Q56. Gathered Swarm's push and its third option (2026-11-14)
- Question: should the save's "moved by the swarm up to 15 feet horizontally" and "you are moved 5 feet" be automated?
- Done meanwhile: the two offers share one use a turn; the 1d6 Piercing is automated; the save is rolled and the
  move's direction and distance are the GM's, by hand ("rolled (save); what it does is by hand"); the third option is
  by hand. A reaction offer cannot ask for a landing point yet (only an Item's own use does), so an aimed push there
  would move nobody.
- Cost of yes: a reaction offer collecting a landing (`intent.push.point`) as Item use does, which also frees
  Elemental Attunement's "toward or away" push; a pipeline change.
- Recommendation: build the landing for reaction offers as its own item.
- **Answered 2026-11-16: On a qualifying hit, offer the ranger the eligible Gathered Swarm choices with one shared use per turn. Build reusable destination selection for reaction offers now and automate both moves. The ranger chooses where the target moves up to 15 feet horizontally on a failed save, or where the ranger moves 5 feet when using the self-movement option.**

### Q57. Staff of Withering's charge: offered on every hit while charges remain? (2026-11-14)
- Done meanwhile: yes, an offer on the staff's own hits (`hit:staff-of-withering`), never automatic; the 2d10 Necrotic
  lands on either save outcome and Withered (Disadvantage on Strength and Constitution checks and saves, 1 hour) only on
  a failure, as dnd5e's data has it.
- Cost of another reading: none.
- Recommendation: keep.
- **Answered 2026-11-16: application of the caster-action decision.** Offer the charge spend to the wielder on a hit with the Staff of Withering while a charge is available. Spend a charge only if the wielder accepts.

### Q58. Lunar Form: is "a Wild Shape form's attack" any attack while transformed? (2026-11-14)
- Done meanwhile: by hand (noted), because Polymorph transforms too and nothing tells a Wild Shape form's attack apart.
- Cost of yes: the same hit offer with a Wild Shape status gate (`whileStatus`), once that status exists.
- Recommendation: add a Wild Shape status when the next Wild Shape feature needs it.
- **Answered 2026-11-16: Offer Lunar Form’s optional attack benefit on any attack the druid makes while Wild Shape is active, in any Wild Shape form. Polymorph alone does not qualify.**
- Built (2026-11-21): a transform's `status` is on its transformation effect, so its creature has it while the form
  lasts; the converter gives Wild Shape `status: "wild-shape"` (Polymorph and Shapechange none), and reads "a target
  you hit with a <Wild Shape> form's attack" as a hit offer on any hit with `whileStatus` that status
  (classes-and-spellcasting.md, rule-elements.md). The premium Lunar Form gets it on the next premium reconvert; it
  is an Action Item, offered in a form under Q117's default.

### Q59. "Lightly obscured" (Nature's Mantle): only not in Bright Light? (2026-11-14)
- Question: should "while you are in an area that is lightly obscured" also count fog, foliage and areas the GM paints?
- Done meanwhile: it is read as not in Bright Light (dim light or darkness), the same `requires` as Shadow Stealth's; in
  fog or foliage under bright light the GM allows it by hand.
- Cost of yes: an "obscured" tag on lasting areas and Regions (as `environment.<tag>` is), read by `requires`; a small
  part, plus tagging the spells that obscure.
- Recommendation: keep until obscuring areas need tagging for another rule (Fog Cloud's Blinded reading).
- **Answered 2026-11-16: Determine eligibility for Nature’s Mantle from the degree of obscurity at the wearer’s position. Recognize light obscurity from fog, foliage and GM-marked areas, including in bright light. Use the area’s actual degree of obscurity when resolving the mantle’s Hide option.**
  Built 2026-11-21: an Action's `requires` reads `obscured` (`obscurityAt`: lasting areas, light, and the GM's "Lightly obscured" Region or Scene tag) and `coverFromFoes`, and the converter gives "while you are in an area that is lightly obscured" `obscured` lightly or heavily (action-definitions.md, senses-and-cover.md), with Q118's defaults. The premium Nature's Mantle keeps the old "not in Bright Light" reading until the books are reconverted.

### Q60. "While in dim light or darkness" on a Scene without Token vision (2026-11-14)
- Done meanwhile: such a Scene is all Bright Light, as Light Sensitivity and Sunlight Sensitivity read it, so Shadow
  Stealth (and Nature's Mantle) are refused there. A GM turns Token vision on for a dark map.
- Cost of another reading: treating a vision-less Scene as unknown light (neither bright nor dim) would change those
  sensitivities too; a small change with a wider reach.
- Recommendation: keep.
- **Answered 2026-11-16: For features that check lighting, treat a scene with token vision disabled as bright. Resolve Nature’s Mantle using the separate obscurity ruling in Q59.**
  Built (pinned 2026-11-21): such a Scene gives no `obscured` unless an area or the GM's tag obscures it, so Nature's Mantle is refused there untagged.

### Q61. A 2014 sidekick's Helpful: both halves of Help as a Bonus Action? (2026-11-14)
- Done meanwhile: its Bonus Action is Help on an attack (Distracted on an enemy within 5 feet); helping an ability check
  (Assist) as a Bonus Action is by hand (noted), because Assist's skills are its user's, chosen when used.
- Cost of yes: a second Action of the feature built per actor at use (Assist at its cost), as the common Assist is; a
  small change in where an Item's Action is built.
- Recommendation: keep; the attack half is the one used in combat.
- **Answered 2026-11-16: Automate the 2014 sidekick’s ability-check Assist. When its turn is about to end and its Bonus Action is still unspent, offer Assist to its controller. If accepted, let the controller choose the ally and applicable skill and spend the Bonus Action before advancing the turn.**

### Q62. Rage of the Wilds' Eagle: offered in every Rage? (2026-11-14)
- Done meanwhile: Eagle is a Bonus Action Disengage and Dash while raging (`requires: {hasCondition: "raging"}`), offered
  whichever option the Rage took. The free Disengage and Dash as the Rage starts is by hand (noted).
- Cost of yes (only in an Eagle Rage): a choice of option on the Rage Action, each putting its own marker (an effect per
  option), and Eagle requiring that marker; it also lets Bear and Wolf be automated. A medium change to the Rage Action.
- Recommendation: do it with Bear and Wolf, as one item.
- **Answered 2026-11-16: Have the barbarian choose Eagle, Bear or Wolf when Rage begins. Track the choice for that Rage and enable Eagle’s Bonus Action Dash and Disengage only during an Eagle Rage. Implement the three choices together.**
  Built 2026-11-21: a required choice on Rage (Bear preselected), each option adding to Rage's own `raging` effect (`add-to-effect`, action-configuration.md), so it lasts and ends with that Rage. Bear: Resistance to all but Force, Necrotic, Psychic and Radiant. Eagle: Disengage and Dash as the Rage starts and the `rage-eagle` status its Bonus Action requires. Wolf: an aura on enemies within 5 feet granting only allies' attacks Advantage (`attack.attackerAllies`). The premium book gets it on its next reconvert.

### Q63. Fast Hands' magic item as a Bonus Action (2026-11-14)
- Done meanwhile: Use an Object is the Utilize action at a Bonus Action; "or take the Magic action to use a magic item"
  is by hand (noted).
- Cost of yes: an additive alternative cost (a Bonus Action) on the creature's magic-item Actions while it has Fast
  Hands, a part of its own (`costs.anyOf` granted by a rule).
- Recommendation: build it when a second feature changes a magic item's cost.
- **Answered 2026-11-16: Plan Fast Hands as an alternative Bonus Action cost when the thief takes the Magic action to use an eligible magic item. Keep the normal Action option and the item’s own costs and restrictions.**
  Built 2026-11-21: Use an Object's "or take the Magic action to use a magic item" is a choice on the creature's magical Action-cost Actions that a gear Item brought (`choiceFor.actions`, action-configuration.md), "no" by default, its other option paying the Bonus Action instead (`replace-cost`); the item's charges, attunement and equip checks stay. A magic weapon's attack, an escape check (Portable Hole, Dimensional Shackles) and a species' or feature's magical Action (Breath Weapon) are left out. SRD reconverted; the premium book gets it on its next reconvert.

### Q64. Blessing of the Trickster: whose Long Rest ends it, and one at a time? (2026-11-14)
- Done meanwhile: "This blessing lasts until the caster finishes a Long Rest" is `restsLeft: 1`, counting the blessed
  creature's own Long Rests (a party usually rests together). "Or they use this feature again" is by hand (noted): using
  it on several allies in turn leaves them all blessed until they rest.
- Cost of the caster's rest: an additive `restsLeftOf: "source"` read where Long Rests count `restsLeft`, which is small.
  Cost of one at a time: an effect that ends the giver's earlier copies when given again, a part of its own (an Oathbow's
  sworn enemy would use it too).
- Recommendation: keep the bearer's rest; build one-at-a-time when a second feature needs it.
- **Answered 2026-11-16: End Blessing of the Trickster when the recipient finishes a Long Rest. Build automatic replacement: once a new use succeeds, end that caster’s previous blessing and apply the new one. Track this per caster so another caster’s blessing is unaffected.**
  Built 2026-11-21: an effect's `replacesEarlier: true` (action-definitions.md "One copy per giver"). The converter reads it from "or they use this feature again". Once a use gives a new copy, every earlier copy from the same giver ends, on any creature. Another giver's copies stay, also on the same creature (a second copy beside it, not it taken over). The recipient's Long Rest was already `restsLeft: 1`. The premium book gets it on its next reconvert.

### Q65. Warrior Commander's Greatsword: Sap or Maneuver? (2026-11-14)
- Done meanwhile: Sap (Disadvantage on the target's next attack roll before the start of the commander's next turn) is put
  on every hit, as dnd5e's only effect is; Maneuver stays its own unautomated use. A GM deletes Sap on a turn the
  commander picks Maneuver.
- Cost of the choice: a configuration option on the attack like Animal Spirit's (`keepEffect`), "Sap" or "Maneuver (no
  Sap)"; small, in the converter.
- Recommendation: the option, as a small follow-up.
- **Answered 2026-11-16: Offer Sap or Maneuver on the Warrior Commander’s Greatsword attack. Apply Sap only if the controller selects it.**

### Q66. Watcher's Will: "you and the chosen creatures" (2026-11-14)
- Done meanwhile: the Advantage on Intelligence, Wisdom and Charisma saves goes to the chosen creatures; the cleric has
  it only by choosing itself as one of them (one fewer other creature). The cleric's own share is noted by hand.
- Cost of yes: a copy of the effect with `appliesTo: "source"` when the words say "you and the chosen creatures"; small,
  in the converter.
- Recommendation: the copy.
- **Answered 2026-11-16: Grant Watcher’s Will to the user as well as the chosen creatures. The user gains the save benefits without spending a target slot on themself.**

### Q67. Faithful Hound: "At the start of each of your turns" (2026-11-14)
- The text means the caster's turn; every summon now takes its own turn right after its caster's (Q32, Q33).
- Done meanwhile: the bite is an automatic `turn.started` Trigger on the hound, on one enemy within 5 feet its controller
  picks, at the start of the hound's own turn: the caster acts before it bites, not after.
- Cost of the caster's turn: a Trigger reading its summoner's `turn.started` (an additive `around.on: "summoner"` in the
  dispatcher's others' loop, by the summon Token's `flags.wildpath.summon.casterUuid`); no migration.
- Recommendation: decide with Q32 and Q33, since all three are about when a summon acts.
- **Answered 2026-11-16: Faithful Hound bites at the start of its own turn on its own initiative. Its controller chooses one eligible enemy within 5 feet. Use the general summon initiative ruling for turn order.**
  Built 2026-11-20: the hound rolls its own Initiative (its bite is a Trigger on its own turn, so it acts; Q32's build).

### Q68. Guarded Mind: "end every effect on yourself giving you those conditions" (2026-11-14)
- A spell may give Charmed beside another condition as separate effects (Hypnotic Pattern's Incapacitated).
- Done meanwhile: it removes the Charmed and Frightened conditions (`levels: -1`); other effects of the same source stay.
- Cost of the whole effect: an additive `ends: {statuses: [...]}` kind (beside `tags` and `contagions`) that deletes each
  effect with one of those statuses together with its effect group; small, in the pipeline.
- Recommendation: the whole effect, since "every effect ... giving you" reads as the spell's whole effect.
- **Answered 2026-11-16: On the user, end each entire effect that causes Charmed or Frightened, including linked conditions from that same effect. Effects from independent sources are evaluated separately.**
  Built 2026-11-20: `ends: {statuses: ["charmed", "frightened"]}` on Guarded Mind's turn Trigger ends each effect giving one with the rest of its effect group (the same Action's id and source); others stay (action-definitions.md "Ending Effects On Targets"). The premium books get it on their next reconvert.

### Q69. Cosmic Omen: Weal or Woe this Long Rest? (2026-11-14)
- After a Long Rest the druid rolls a die: an even number gives Weal (add the d6), an odd one Woe (subtract it), until
  the next Long Rest.
- Done before the answer: both were offered, Weal on its own or an ally's failure and Woe on a foe's success; keeping to
  the one rolled was by hand (noted on the feature).
- Cost of the other answer: a Long Rest Trigger that rolls the omen and gives its creature a status, and an additive
  `whileStatus` per side of the offer (a Weal and a Woe offer, each reading its status); a converter change, no migration.
- Recommendation: keep both offered unless a player misuses it.
- **Answered 2026-11-16: application of the caster-action decision.** Use the druid’s Long Rest omen to determine which option is available. An even roll grants Weal and an odd roll grants Woe until the next Long Rest. Offer the granted option only on an eligible roll.
  Built 2026-11-21: a Long Rest automation Trigger on the feature draws 1d6 and keeps a Weal or Woe status for one Long Rest; the
  offer's `whileStatus: {allies, foes}` asks each side for its status (classes-and-spellcasting.md). The premium books get it on
  their next reconvert.

### Q70. A foe's penalty: on any success, or only when it could change the result? (2026-11-14)
- Boon of Fate, Bend Luck, Cosmic Omen's Woe and the Astromancy Archive take dice off a foe's successful d20 test.
- Done meanwhile: offered on any rolled success except a natural 20's hit; its bearer sees the roll and decides.
- Cost of the other answer: offer it only when its dice's most could make the roll fail (total minus number times faces
  below the DC or AC); one filter in the pipeline, but the bearer then learns the margin from the offer's presence.
- Recommendation: keep, unless the prompts feel noisy at the table.
- **Answered 2026-11-16: Offer the penalty die on any eligible rolled success, even when its maximum could not change the outcome. Keep the existing exception for a natural-20 attack hit.**

### Q71. Bend Luck at any distance? (2026-11-14)
- "Another creature you can see" names no range.
- Done before the answer: any distance on the Scene; a foe only when the sorcerer's Token sees it, an ally whether seen or not
  (the shortcut every ally offer has).
- Cost of the other answer: a sight check on the ally side too (`relationsToSource`, as the foe side reads it), for every
  ally offer with a "you can see" clause; a converter flag per row.
- Recommendation: keep.
- **Answered 2026-11-16: application of the caster-action decision.** Offer Bend Luck at any distance on the scene when the sorcerer can see the other creature and the feature’s usual conditions are met. Apply the sight requirement to allies and foes alike.
  Built 2026-11-20: an ally's option on a row with `side` is sight-checked as a foe's is (`tokenSees`), and so is one on an ally-only row with `seen: true` (Flash of Genius, Q125's default) (classes-and-spellcasting.md "A foe's success").

### Q72. Restore Balance: before the roll (2026-11-14)
- "A creature you can see is about to roll a d20 with Advantage or Disadvantage": it acts before the roll, so it cannot
  be a test offer, which comes after the roll with the outcome known.
- Done meanwhile: by hand (its utility note stays).
- Cost of automating it: a window before any creature's d20 is rolled (like Warding Flare's `action.declared`, but for
  any check, save or attack), asking whoever can cancel its roll mode; a new pipeline stage.
- Recommendation: a later item, decided with Q50's "before or after" choice.
- **Answered 2026-11-16: Put Restore Balance automation on the build plan. When a creature the user can see is about to make an attack roll, ability check or saving throw with Advantage or Disadvantage, offer the reaction before rolling the d20. Accepting cancels that roll mode for this roll. Declining preserves it.**
- **Architecture approved, 2026-11-16:** a new pipeline stage before the d20. A `rollModeOffer` item flag mirrors test offers and is asked before the d20 of an attack roll, ability check or saving throw with Advantage or Disadvantage. Sheet rolls are included; Initiative is excluded. The bearer must be within 60 feet and see the roller. The cancel applies to that roll only and does not carry over to a reroll.

### Q73. "Charmed or Frightened (your choice)": chosen before or after the save? (2026-11-14)
- Beguiling Twist's failed save gives one of two conditions, its user's choice.
- Done meanwhile: chosen as the Reaction is used, before the save (the `effect-choice` configuration, as Command's).
- Cost of the other answer: a choice prompt after the outcome is known; a new pipeline step.
- Recommendation: keep.
- **Answered 2026-11-16: For Beguiling Twist, choose Charmed or Frightened when using the reaction, before the target rolls its save. Apply the chosen condition on a failed save.**

### Q74. A 2014 "Each creature within N feet of it" save: allies too? (2026-11-14)
- A Shadow Spirit's Dreadful Scream, a dragon's legacy Wing Attack.
- Done before the answer: every creature in the emanation but its user, allies included, as "each creature" says. One that
  qualifies its creatures ("that can hear it and that isn't a demon": a Vrock's Stunning Screech) stays one chosen target.
- Cost of the other answer: sparing allies is `affects: "enemies"` on the area, a converter choice per wording; a
  creature-type filter for the Vrock is a new area part.
- Recommendation: keep; the creature-type filter as its own item.
- **Answered 2026-11-16: For a 2014 area that affects each creature around its user, include allies and exclude the user. Plan a separate eligibility filter for abilities with additional requirements. For the Vrock’s Stunning Screech, include only creatures that can hear it and are not demons.**
  Built 2026-11-20: a 2014 "Each creature within N feet of it that can hear it and that isn't a demon must" is its self emanation with `targeting.eligible` read from its qualifiers (not Deafened; neither type nor subtype "demon"), which leaves the others out of the area (targeting.md; Q126's default (a) as far as it is modelled: a Silence area deafens nobody yet, Silence being by hand).

### Q75. Dreadful Glare: "If the target can see the mummy" (2026-11-14)
- Done before the answer: not checked; the GM picks a target that can see it, and its note says the rest is by hand.
- Cost of the other answer: sight between two Tokens checked at targeting, which nothing models yet (the Robe of Eyes'
  "that can see you" is the same shortcut).
- Recommendation: keep until sight is modelled for targeting.
- **Answered 2026-11-16: Plan reusable directional sight checks at targeting. Dreadful Glare requires the target to see the mummy. Use the same direction for the Robe of Eyes clause that checks whether a creature can see its wearer.**
- **Correction, 2026-11-16:** the "a creature that can see you" clause belongs to the Robe of Scintillating Colors, not the Robe of Eyes (our question named the wrong item). The answer is applied to the Robe of Scintillating Colors; see Q127.
  Built 2026-11-20: `targeting.eligible`, a predicate over `seesSource`, `seenBySource` (both `tokenSees`), its conditions and its creature data; a single target failing it is refused, nothing spent (Q127 (a) default), an area leaves it out. The 2014 Dreadful Glare (`seesSource`, and `seenBySource` too with "targets one creature it can see") and the Robe's Stun save (`seesLitSource`: seeing its wearer in the robe's own light, not yet on the Scene as its targets are judged) carry it; the by-hand notes are gone (targeting.md).

### Q76. A Tasha's Festering Aura and its summoner (2026-11-14)
- "Any creature, other than you, that starts its turn within 5 feet of the spirit" (the PHB's "(other than you)" alike).
- Done meanwhile: the turn Trigger reaches every other creature, the summoner included, with a by-hand note.
- Cost of the other answer: an additive exclusion of the summoner on the Trigger's `around`; `affects: "enemies"` would
  wrongly spare the summoner's allies, whom the text includes.
- Recommendation: add the exclusion as its own item; it fixes both books' forms.
- **Answered 2026-11-16: Automate the summoner exclusion for Festering Aura in both book versions. Other eligible creatures, including the summoner’s allies, are affected when they start their turn within 5 feet of the spirit.**
  Built 2026-11-20: "(other than you)" and ", other than you," are `around.notSummoner: true`, which spares the Actor its summon flag names (Festering Aura and the 2024 Whispering Aura); allies stay in (rule-elements.md). The premium books get it on their next reconvert.

## Follow-ups from reconciling the answers with the build (2026-11-16)

A read-only review compared every answer above with the code and turned the differences into build batches
(`autonomous-gap-runs-plan.md`, waves A-D). These questions are what the answers leave open. Each one names the default
a batch builds until you answer. Q77-Q86 come from run 13's design packets; Q87 on follow the answer groups.

### Q77. Land's Aid: whom the healing may go to (2026-11-16)
"One creature of your choice in that area regains Hit Points."
- Default until answered: any creature the Sphere covered, whatever its save, including one that just took its Necrotic
  damage and the druid if inside. A damaged creature is healed after the damage.
- Recommendation: keep; it is the text.

### Q78. Celestial and Defender Spirit: Temporary Hit Points to the creature just hit? (2026-11-16)
The spirit's Radiant Mace gives Temporary Hit Points to "itself or another creature it can see within 10 feet".
- (a) May the creature it just hit be chosen? (b) May the spirit give none ("can choose")?
- Default until answered: the target is never offered; the Temporary Hit Points are always given (they never hurt).
- Recommendation: keep both.

### Q79. Several targets earning one share of healing (2026-11-16)
A homebrew area drain ("regain Hit Points equal to the damage dealt") hits three creatures.
- Default until answered: an amount share is the sum over every target that earned it; a dice share is rolled once,
  however many earned it.
- Recommendation: keep.

### Q80. Will-o'-Wisp's Consume Life when the target does not die (2026-11-16)
The target fails its save, but something keeps it alive.
- Default until answered: the wisp regains its Hit Points on the failed save, whatever happens to the target.
- Recommendation: regain only when the target dies. That needs a death check after the commit; build it if you agree.

### Q81. Rod of Absorption: a slot regained, or a slot beyond the maximum? (2026-11-16)
- Default until answered: an expended slot of level 1-5 that the user has is regained, costing that many stored levels.
  It is refused while that level is full.
- Other reading: the stored energy pays a spell's slot cost directly, like Pact slots. That is a larger change.
- Recommendation: keep.

### Q82. A cancelled or absorbed cantrip costs 0 levels? (2026-11-16)
- Default until answered: yes. A cantrip is level 0, so an Ioun Stone cancels it for free and the Rod stores nothing.
- Recommendation: keep.

### Q83. The Rod of Absorption's "typically 1d10 levels" when found (2026-11-16)
- Default until answered: the energy pool starts empty and the GM sets it on the sheet. Spells cast by allies at the
  holder are not offered to the Rod (see Q128), so it fills only from hostile spells or the GM's edit.
- Recommendation: roll 1d10 into the pool when the Rod first lands on an Actor, the same "rolled once" part as the Helm
  of Brilliance's gems (Q92c).
- Note (2026-11-21): that part now exists (`GrantResource` `current: 1d10`), so the recommendation is one converter row;
  the default (empty) is kept until answered.

### Q84. "Roll a 20 on the d20" or "a Critical Hit"? (2026-11-16)
The text of Mace of Smiting, Wave, the Axe of the Dwarvish Lords, both swords and Boon of Irresistible Offense says "roll
a 20". dnd5e reads it as critical damage, which also fires on a Champion's 19, and does not fire on a 20 that a Guardian
Emblem made a normal hit.
- Default until answered: the text. The bonus applies only when the d20 shows 20 (`natural: 20`, "N or higher" for
  homebrew), whether or not the hit is a Critical Hit.
- Recommendation: keep.

### Q85. Boon of Irresistible Offense: "the ability score increased by this feat" (2026-11-16)
Feat ability increases are applied by hand, so the system does not record which score the feat raised.
- Default until answered: the higher of Strength and Dexterity, dealt every time. "You can deal" is treated as always
  wanted: extra damage has no downside.
- Recommendation: keep until feat ability increases are recorded.

### Q86. Mace of Smiting's plain attack against a Construct (2026-11-16)
- Default until answered: as dnd5e. The plain attack gives 7, and the player picks the separate "Attack Construct"
  Action (+3, 14) against a Construct.
- Recommendation: one attack that adds the Construct bonus by the target's creature type. It is small, and it removes a
  choice a player can get wrong.

### Q87. Inspiring Help: whose position counts (Q16 follow-up) (2026-11-16)
The sidekick's Help today counts any ally of the helped creature standing beside the target. 2014 Help needs the target
within 5 feet of the helper.
- Default until answered: the shortcut (any ally beside the target).
- Recommendation: check the effect's giver, through a new `attack.giverNearTarget` context flag (small to medium).

### Q88. Passing a prompt back: a button or a setting? (Q2 follow-up) (2026-11-16)
It was built as a per-prompt GM button, "Pass back to {name}", shown once the Player is back.
- Default until answered: the button.
- Recommendation: keep; ask again if GMs forget to press it.

### Q89. Release mechanics (Q17 follow-up) (2026-11-16)
- (a) Is `system.zip` built by a GitHub Actions workflow on a `v*` tag (no new npm dependency), or by a local script you
  run? (b) Is a `manifest` on `releases/latest` acceptable, or should each version pin its own?
- Default until answered: (a) a GitHub Actions workflow; (b) `releases/latest`, Foundry's usual pattern. Files that must
  not ship (`CLAUDE.md`, `DESIGN.md`, `PRODUCT.md`, `.impeccable`, docs/development) are left out of the zip.
- Recommendation: the defaults.

### Q90. Ice Knife beyond the silver dragons (Q18.1 follow-up) (2026-11-16)
- Should Ice Knife (and any other spell SRD 5.2.1 has that dnd5e leaves unlicensed) also ship as a standalone spell in
  the SRD pack, on class lists and scrolls? Should the converter sweep for other SRD 5.2.1 additions?
- Default until answered: only inside the two dragons' stat blocks.
- Recommendation: ship it standalone and run the sweep; it is the open SRD.

### Q91. Hide and Search details (Q18.2 follow-up) (2026-11-16)
- (a) Which hidden creatures does one Search check: all on the Scene, those within the searcher's sight, or one the
  searcher picks? (b) Does being found end Invisible for every observer, or only for the searcher? (c) 2014 Hide: a
  contest against passive Perception? (d) The Cloak of Elvenkind: may one Search roll plus an extra d20 for each
  Disadvantage creature stand in for Disadvantage on that creature only?
- Default until answered: (a) every hidden creature the searcher's Token can see the space of; (b) for everyone (2024:
  the condition ends); (c) 2014 Hide contests the highest passive Perception among the searcher's foes; (d) yes.
- Recommendation: the defaults.
- Built meanwhile (2026-11-21, with Q18.2): (a) and (b), every creature but the searcher's allies (one disposition), so
  an ally's Search does not end its own hidden rogue's condition while a neutral creature finds and is found; (d), with
  the searcher's own Advantage or Disadvantage counted against the creature's, so fresh dice stand in when they cancel (action-definitions.md, "Finding the hidden"). (c) is not
  built: the common actions are 2024's, and there is no 2014 Hide to contest.

### Q92. Rules for Q18's large features (2026-11-16)
These are built after the answer deltas, one at a time (your 2026-11-16 decision). Each gets its own design first.
- (a) **Wall of Ice.** How does a player attack one section: by targeting a section cell, through a temporary object
  Token, or by GM-applied damage? Do intact sections block sight (Foundry Wall documents, a new pattern) or only
  movement? Default: a temporary object Token per section; sections block movement and sight through Wall documents
  created and deleted with the area.
- (b) **Earthquake.** The spell says fissures "can't be under structures", but your answer says fissure tiles overwrite
  walls. Which wins? Is "overwrite" a permanent deletion of Scene Walls, or a hide while the spell lasts? Do fissures
  outlast concentration? Default: the GM's placement wins (walls hidden, not deleted), and fissures stay after the spell
  as the text says.
- (c) **Helm of Brilliance.** When are the gems rolled: on first equip or attunement, or when the helm first lands on an
  Actor? With physical dice, is that a requested roll? Should "Taking Fire Damage" be automated (a d20 after failing a
  save against a spell; on a 1 the emanation fires and the helm is destroyed)? Default: rolled when it first lands on an
  Actor, through the dice policy; Taking Fire Damage automated.
  - Built meanwhile (2026-11-21, with Q18.5): the first two. A `GrantResource` whose `current` has dice is rolled once,
    by the dice policy (physical dice: a typed roll; closed unrolled, it is asked again at the next sync), when its Item
    lands on the creature, attuned or not (rule-elements.md, "Rolled starts"); the four gem pools are spent by the casts,
    gate Diamond Light, Fire Opal Flames and Ruby Resistance, and set Explosive Emanation's Radiant damage, which may be
    used once. Not built: Taking Fire Damage's d20 (the damage event does not yet say the damage came from a failed save
    against a spell) and the helm's destruction after the emanation (no part destroys an Item); both stay by hand, so the
    emanation is a free Action its wearer takes once, on that 1, as the other by-hand triggered uses are (a Sword of
    Sharpness's 20). Its gem gates need a stored gem (`poolLeft`), so a count not yet rolled grants nothing.
- (d) **Pipes of the Sewers.** Is a swarm swayed automatically when it comes within 30 feet while the piper plays, or
  only when the piper takes the separate action? Is any "Swarm of Rats" eligible by its creature data, or any Swarm of
  Tiny Beasts? Default: the separate action (your answer); any swarm whose members are rats, read from the stat block.
  - Built meanwhile (2026-11-21, with Q18.6): the default, as follows.
    - A Play the Pipes Magic action gives its piper a marker until the start of its next turn. Call Swarm of Rats
      requires the marker, and its swarms arrive with no controller (`summon.uncontrolled`).
    - Sway Rats is the separate Action, free while playing. It targets one creature within 30 feet whose stat block is
      named "Swarm of Rats" and that nothing controls (`targeting.eligible` on `actor.name` and
      `actor.system.companion.controllers`). It makes a DC 15 Wisdom save. It is available only while such a swarm
      stands within 30 feet (`requires` on `eligibleTargetInRange`), as your Q18 application asks.
    - On a failure, the swarm becomes the piper's companion through a Swayed effect (`metadata.control`). On a success,
      Sway Rats leaves it Unaffected for 24 hours.
    - Swayed ends as the swarm's turn starts once its piper is not playing. If its piper is more than 30 feet away, it
      also ends then, with the 24 hours (an effect Trigger's `giver`).
    - The swarm keeps its own disposition, though the text makes it Friendly to its piper's allies.
    - Swaying is a separate Action only, as the default says. Nothing sways a swarm automatically as it comes within
      30 feet.
    - "Swarm of Rats" is matched by the stat block's name, as no creature data says what a swarm's members are.
- (e) **Mirror of Life Trapping.** Does "remove its token" mean deleting the Token and restoring it from stored data on
  release, or hiding it with an untargetable status? Must the creature be able to see the mirror (blind creatures
  immune)? Default: hidden with a status, so nothing is lost; sight is required.
- (f) **Contingency.** Enforce the 2024 limits on the stored spell (level 5 or lower, a one-action casting time, can
  target the caster)? Does a new Contingency end the old one? May an Assistant GM trigger it? Default: yes, yes, yes.
- (g) **Antimagic Field.** What does it suppress: spell effects only, or also magic items' rules and summoned or created
  creatures (2024: they wink out)? Is the caster's own concentration exempt? Marking existing world items or effects as
  magical would be a migration. Default: spells, magic items' rules and summons, read from data already present (a
  spell's source, an item's rarity), so no migration; concentration continues.
- (h) **Simulacrum.** Is the copy a persistent world Actor? Does it copy the target's current spell slots, or full ones?
  Is "can't regain spell slots" tracked? Default: a persistent world Actor, full slots, and no slot recovery.
- (i) **Magic Jar.** Does the caster's player operate the host's own Actor (host statistics, with the caster's mental
  scores and class features), or does the caster's Actor transform into the host? What happens to each soul when the
  vessel or a body is destroyed? Default: the caster's Actor transforms into the host, reusing the transformation part;
  destruction follows the 2024 text.

### Q93. Condition instances per source: details (Q19 follow-up) (2026-11-16)
- (a) **Escape across conditions.** A creature is Grappled at DC 12 and Restrained by a Web at DC 15. Escape always picks
  Grappled first today. Should it take the highest DC across both conditions, or should the player choose?
- (b) **Burning from two sources at turn start.** One damage instance of 2d4 (one concentration save, Resistance on the
  total under Q20), or two separate 1d4 instances?
- (c) **Grappled by two creatures.** 2024 gives Disadvantage on attacks "against any target other than the grappler".
  Does attacking either grappler avoid it?
- (d) **Scope.** Per-source tracking applies only to non-stacking conditions; Exhaustion levels and custom effects
  (Bless from two casters, which 2024 says do not combine) stay one effect. Agreed?
- (e) **Reapplying from the same Action and source** (a recast Web, a second Grapple by the same grappler): it refreshes
  its own instance. Agreed?
- Default until answered: (a) the player chooses, with the highest DC preselected; (b) one 2d4 instance; (c) attacking
  any of its grapplers avoids it; (d) yes; (e) yes.
- Built meanwhile (2026-11-21): the defaults. (a) Escape and Free ask which condition's hold with a required choice, the
  higher DC preselected (a Grappled first among equals); of one condition's holds only the highest DC's is offered (Q19 (a)); (b) the same condition's damage of one type due on one event is one
  damage Action adding each instance's dice; (c) needed nothing, `attack.fromTarget` reads each instance's source.

### Q94. Resistance and reductions: order (Q20 follow-up) (2026-11-16)
- (a) 2024 applies Resistance and Vulnerability after all other modifiers, but flat and scaled reductions (Heavy Armor
  Master, Stone's Endurance) apply after them today. Should reductions move before Resistance?
- (b) A halving with no damage type (Uncanny Dodge) on 3 Slashing and 3 Fire: halve each type (1 + 1), or the hit's
  total (3)?
- Default until answered: (a) yes, reductions first, as 2024 orders them; (b) the hit's total.
- Recommendation: the defaults.
- Built meanwhile (2026-11-21): the defaults. Immunity, then reductions, then Resistance and Vulnerability, then absorption
  and a Damage Threshold; a Resistance marked `wholeHit` (the converter's Uncanny Dodge) halves the hit's total across
  types, while Petrified's Resistance to all damage, which has no mark, halves each type.

### Q95. Prismatic Spray's two rays: rolled per creature? (Q21 follow-up) (2026-11-16)
- Should each creature's ray damage be rolled for that creature, or only the repeated ray, with the first ray's roll
  shared across creatures as today? Do the two rays count as two damage instances for concentration?
- Default until answered: the first ray of each colour is shared as today, a repeat is rolled for that creature, and
  they are two damage instances.
- Recommendation: the default.
- Built meanwhile (2026-11-20): the default. Two rays of different colours on one creature are two damage instances
  too (a damage result, so a concentration check and a death save, each), as the two rays of one colour are.

### Q96. The Unconscious bar beyond "succeed instead" (Q22 follow-up) (2026-11-16)
- Does it also apply to Legendary Resistance on an Unconscious monster, and to free offers that are not "succeed
  instead" (Halfling Luck, Portent)?
- Default until answered: only the "succeed instead" offers. Legendary Resistance and the others are unchanged.
- Recommendation: also bar Legendary Resistance (an Unconscious creature makes no choices), but not Portent, which
  belongs to the diviner.
- Built meanwhile (2026-11-20): the default.

### Q97. "When you cast" riders: timing and edge cases (Q24 follow-up) (2026-11-16)
- (a) Must a "when you cast" rider resolve before the spell's own effects (true casting-start timing, a large change),
  or is it enough that it fires when the cast completes and also when it is countered?
- (b) A "when you cast X using a spell slot" rider on a countered spell: no slot is spent under 2024. Does it still
  count as cast using a slot?
- (c) Does a GM-cancelled cast, or one refused by validation, fire "when you cast" riders?
- (d) (added 2026-11-21) A countered spell cast with a Metamagic option: does the option count as used ("when you use a
  Metamagic option", the Essence Shards), and are its Sorcery Points spent? Counterspell now wastes only the Action,
  Bonus Action or Reaction, so the shard's rider would come with no points spent.
- Default until answered: (a) on completion and on a counter; (b) yes; (c) no; (d) it counts as used, as (b)'s slot
  does, and its points are not spent.
- Built meanwhile (2026-11-21): the default.

### Q98. Eye Rays and one attack at a time: details (Q25-Q27 follow-up) (2026-11-16)
- (a) Does "already used that ray" also count a ray the GM used on its own this turn? Default: only drawn rays count.
- (b) Outside combat there is no turn, so duplicates fire as rolled. Should an out-of-combat Multiattack count as one
  turn? Default: duplicates fire as rolled.
- (c) Eye Rays asks for the target before the ray is rolled. Should the ray be rolled first and the target chosen once it
  is known (for example, not aiming a Sleep Ray at an Undead)? It is a larger change: a draw before targeting. Default:
  target first.
- (d) While a ray or attack waits on a save, does the hold also block the creature's movement, or only its Actions?
  Default: only its Actions.
- (e) Q26 revisit: once rerolls are automatic, should the individual ray Actions stay on the GM's action bar, be hidden
  from players, or be removed? Default: they stay for the GM.
- Built meanwhile (2026-11-20): (a) and (b), the defaults: only options its `noRepeat` draw drew are recorded, and
  outside combat nothing is. (c), (d) and (e) are unchanged.
- Built meanwhile (2026-11-21): (c) and (d), the defaults: the target is still picked before the ray is rolled, and a
  creature's move waits only for its other move, never for its Action or a ray it is held by (before, any of its open
  Actions refused its move too).

### Q99. Summons: details (Q30-Q33 and summon initiative follow-ups) (2026-11-16)
- (a) One initiative roll per creature, or one per cast (2014 Conjure Animals' 8 wolves)? Under physical dice the GM is
  asked, not the caster's player. Default: one roll per cast, shared by its creatures, asked of the GM.
- (b) A summon that rolls higher than the current turn first acts next round. Acceptable? Default: yes.
- (c) Do Flaming Sphere, the spectral pack and Arcane Eye still move on their own turns, or only through the caster?
  Default: only through the caster (Speed 0 on their own turn; they have no turn under the scope decision).
- (d) After a ram, may the sphere share the rammed creature's space? Does that creature also make the end-of-turn save
  within 5 feet in the same round? Default: it shares the space, and both saves happen.
- (e) Is the pack's free 30 feet once per caster turn and used in one go, or split across several of the caster's moves?
  Default: once per turn, in one go.
- (f) Should Dispel Magic aimed at the summon itself (the sphere or pack Token) also end the spell? Once carried areas
  have a cast level, a 2024 Darkness overlapping a Flaming Sphere's light dispels it (as written). Should that dismiss the
  sphere? Default: yes and yes.
- (g) 2014 Conjure Animals: can the caster mix beast kinds within one option? Does the 20-creature cap apply when the
  9th-level upcast gives 32? Default: one kind per option; the cap stays.
- (h) Summoner-paid Actions (Arcane Eye's move, Flaming Sphere's move, the pack's move): the caster's bar only, or both
  bars? Default: the caster's bar only.
- (i) Should the caster-side "Conjure Fey (Teleport and Attack)" item go, now that the fey acts on its own turn with its
  own Command? Should "Faithful Hound (Move Hound)" become a caster-paid move on the caster's bar, like Arcane Eye's?
  Default: yes to both.
- Built meanwhile (2026-11-20): (a), (b) and (h), the defaults; (i)'s first half (the converter drops a summoning
  spell's Bonus Action utility beside a summon its text commands "as a Bonus Action on your later turns"). (i)'s second
  half stays by hand: the hound has no move of its own to host a caster-paid Action. (c): Arcane Eye, Flaming Sphere and
  the pack get no combat turn now, as their creatures pay for nothing themselves; their movement is tracked while their
  caster fights and comes back on its turn, their own Speed until Q33's moves set it to 0 (companions.md).
- Built meanwhile (2026-11-21): (c), (d) and (e)'s first half, the defaults. Arcane Eye, Flaming Sphere and the pack have Speed 0 of
  their own and move only by their caster's Move, whose 30 feet last until the caster's turn ends. A rammed creature
  shares the sphere's space and still saves at its own turn's end beside it. The pack's Move is once per caster turn;
  "in one go" is not enforced: its 30 feet may be dragged in several steps, between the caster's moves, within that turn.
- Built meanwhile (2026-11-21): (f), the defaults. Dispel Magic targeting a lasting spell's creature (rounds or
  concentration) judges it by the level it was cast at and dismisses its whole cast; 2024 Darkness of that level over a
  Flaming Sphere's light dismisses the sphere. An instantaneous spell's creature (Find Familiar) stays.

### Q100. The talisman's wearer: details (Q34 follow-up) (2026-11-16)
- (a) What does giving the talisman cost: free, an object interaction or an Action, at touch range? Does the warlock count
  as its wearer until it gives the talisman away?
- (b) Does the wearer get the die when the warlock's Token is not on the same Scene?
- (c) Pact and Protection share one talisman and so one wearer. Does Rebuke of the Talisman use the same wearer?
- Default until answered: (a) a free object interaction at touch range, and the warlock is the wearer until then; (b)
  yes; (c) yes.
- Built meanwhile (2026-11-21): (a), (b) and (c)'s first half, the defaults. Give Talisman is free (object interactions
  are not counted, so it is also unlimited) and reaches touch range. The offer is read from the wearer's effect, not the
  warlock's Token (its giving Action once that Token is deleted), and both features follow the one `talisman` effect. The
  warlock's own die before any gift is the rows' `heldUntilGiven`, not built into `givenStatus`. Rebuke of the Talisman is still by hand.

### Q101. Offers on sheet rolls: details (Q35 follow-up) (2026-11-16)
- (a) Do saving throws rolled from the sheet get offers too (Protection of the Talisman, Disciplined Survivor)?
- (b) Initiative cannot fail. Are features that need a failed check offered on it?
- (c) A feature spent only if the check then succeeds (Peerless Skill, Tactical Mind, Psi-Bolstered Knack): ask again
  after the die, and refund the use on "still fails"?
- (d) Should offers that answer a foe's success (Bend Luck, Cosmic Omen's Woe, Boon of Fate) appear on a foe's sheet
  check, after asking "did it succeed?"?
- (e) Should Ambush, Tactical Assessment, Commanding Presence and Tandem Footwork become offers on any result now?
- Default until answered: (a) yes; (b) no; (c) yes; (d) no; (e) yes, on sheet checks and Initiative as their texts list.

### Q102. Other "a creature" offers reaching neutral creatures (Q36 follow-up) (2026-11-16)
- Should the other ranged offers whose text says "a creature" (Countercharm, Flash of Genius, Burst of Ingenuity,
  Cosmic Omen's Weal, Astromancy Archive, Boon of Fate) also reach neutral creatures, as Guided Strike now does?
- Default until answered: only Guided Strike.
- Recommendation: all of them; it is the same key.
- Built meanwhile (2026-11-20): the default.

### Q103. No cover on a lasting area's trigger: edge cases (Q37 follow-up) (2026-11-16)
- (a) Should a creature behind Total Cover from walls be left out of a lasting area's or aura's save, or affected like
  everyone in it? Should a creature's own Total Cover status (a swallowed creature) still keep it out?
- (b) Is a death burst (an emanation when a creature dies) an instant area that keeps cover from the creature, or an
  aura with none?
- Default until answered: (a) walls give nothing, but a creature's own Total Cover status still keeps it out; (b) an
  instant area, with cover.
- Built meanwhile (2026-11-20): both defaults.

### Q104. Telekinesis: details (Q38 follow-up) (2026-11-16)
- (a) A landing whose straight path is blocked is refused at the click today. Should the caster be allowed to aim past
  the obstacle, with the creature stopping where it is blocked?
- (b) Outside combat there is no turn, so the repeat can be used right after the cast. Acceptable?
- Default until answered: (a) refused, as today; (b) yes.
- Built meanwhile (2026-11-20): the default; `startedThisTurn` is empty outside combat.

### Q105. "Controller-chosen" scope (Q40 and Q42 follow-up) (2026-11-16)
- (a) Does it cover "up to N feet" pushes and pulls (Reel's "up to 30 feet", the Merrow's Harpoon), which today always
  use the full distance? If yes, does the controller choose a distance, or a landing per target?
- (b) Does an area's "each creature of your choice" get a per-creature include or exclude step at placement (Land's Aid
  and similar)?
- (c) Should the existing by-hand choice notes be swept too, or only Fling for now?
- Default until answered: (a) yes, a distance per target; (b) yes; (c) swept as each batch reaches them.

### Q106. Kraken's Fling: details (Q42 follow-up) (2026-11-16)
- (a) When the thrown creature lands on an occupied space, does it share it with the occupants, or end in the nearest
  free space beside it?
- (b) Does the throw end the Kraken's Grappled on the thrown creature, and with it the Tentacle's "Restrained until the
  grapple ends"? Should that be a general rule (a grapple ends when the held creature moves beyond the grappler's
  reach)?
- (c) Does the thrown creature trigger lasting areas it flies over, or only the one at its landing?
- (d) Who is "in the destination space": only creatures on the ground there, or flying ones too? Do occupants get cover?
- Default until answered: (a) the nearest free space beside it; (b) yes, as a general rule; (c) only the landing; (d)
  the ground only, with no cover.

### Q107. Enchantment attunement: details (Q43 follow-up) (2026-11-16)
- (a) When an attuned enchanted weapon is handed to another creature, or the binding moves to another weapon, does it
  need attuning again?
- (b) Do a Luck Blade's Wish Action, charges and template Action follow the bound weapon to another creature, or stay
  with the one who received the Luck Blade?
- (c) Bindings already in worlds carry no attunement flag and would count as attuned until re-bound. Acceptable, or a
  one-off migration that marks them "required"?
- Default until answered: (a) yes; (b) they follow the weapon; (c) acceptable, with no migration.
- Built meanwhile (2026-11-21): (a) a new binding starts unattuned, and an Item or binding dropped onto another creature
  arrives unattuned (gear too); (b) the template's other Actions need a working binding of its key, so only the bound
  weapon's holder can use them; handing them to the new holder is by hand (the Actions are not moved); (c) no migration.

### Q108. Rarity fixes the tier: details (Q44 follow-up) (2026-11-16)
- (a) Apply it to every gear-granted template with tiers (Wand of the War Mage, Armor and Shield +1/+2/+3), not only the
  Rod? Weapon +1/+2/+3 has no gear to hold a rarity: does it stay the holder's pick?
- (b) Converted gear has a blank rarity. Until a GM sets it, does the holder still pick the tier, or is use refused?
- (c) Should only the GM be able to change an item's rarity?
- Default until answered: (a) all of them; Weapon +N stays the holder's pick; (b) the holder picks; (c) yes.
- Built meanwhile (2026-11-21): the default. Any gear-granted Action whose options carry `rarity` (Wand of the War Mage,
  Armor and Shield +1/+2/+3, the Rod); Weapon and Ammunition +1/+2/+3 have no gear and stay the holder's pick;
  `system.rarity` is a GM-only field.

### Q109. "Nonmagical" weapons: details (Q45 follow-up) (2026-11-16)
- (a) dnd5e marks almost every enchantment template "nonmagical only" (Weapon, Armor and Shield +N, Luck Blade, Vorpal
  Sword). Enforce it on all of them, or only where the text says "nonmagical"?
- (b) Does a weapon that is magical only for a while (Magic Weapon, an infusion, another template's binding) count as
  magical? Should Magic Weapon's own "nonmagical weapon" choice get the same filter?
- Default until answered: (a) only where the text says it; (b) yes, and yes.
- Built meanwhile (2026-11-20): the default. "Magic for a while" is a magic item's attack, another binding on the Item,
  or an effect marked `magicWeapon` (Magic Weapon's text: "becomes a magic weapon"); an effect that only names the weapon
  (2024 Shillelagh, Sacred Weapon, Pact of the Blade) does not count.

### Q110. Neutral creatures: reach of "friendly until attacked" (Q47 follow-up) (2026-11-16)
- (a) Today auras' "allies" leave neutral creatures out, while redirects and willing targeting count them. Does
  "neutral counts as friendly" reach auras too?
- (b) Does a neutral creature's very first attack already count as hostile for the Q46 reactions (a Warding Flare
  against that attack)?
- Default until answered: (a) no, only ally selection; (b) yes.
- Built meanwhile (2026-11-21): the default. Auras, movement through spaces and the area preview read dispositions only; the attack's own reads (its reactions, test offers, `onReduce`) count its turn to hostility from the start, and the record is written once it completes, so a refused attack records nothing.

### Q111. "Another goblin" (2026-11-16)
- 2014 Goblin Boss and the Golden Goblin Bicuspid: match the creature subtype "goblinoid" (which also admits hobgoblins
  and bugbears), or leave it as the GM's pick? Engine code cannot check creature names.
- Default until answered: the GM's pick.
- Recommendation: "goblinoid"; close enough, and automatic.
- Built meanwhile (2026-11-21): the default, noted on the document ("another goblin is by hand (Q111)"). A yes is one converter line: `eligible: {equals: {path: "actor.system.details.subtype", value: "goblinoid"}}`, which the engine already reads.

### Q112. Brutal Strike after a Warding Flare (Q51 follow-up) (2026-11-16)
- (a) Brutal Strike's text says the roll "mustn't have Disadvantage". Is it still allowed after a Warding Flare in the
  same window, rolled with Disadvantage, or withdrawn?
- (b) Does "forgo any Advantage" drop every Advantage source (Help too), or only Reckless Attack's?
- Default until answered: (a) withdrawn; (b) every Advantage source.
- Built meanwhile (2026-11-20): both defaults (`event.data.attackDisadvantaged` in its predicate; `forgoRollMode`).

### Q113. Swapping places: details (Q49 follow-up) (2026-11-16)
- (a) When the two creatures differ in size, where does each land, and what if the larger one would overlap a third
  creature? Does the swap happen before the redirected damage, or after the attack resolves?
- (b) Trickster's Transposition needs Invoke Duplicity's illusion as a summoned Token first. Build that?
- Default until answered: (a) each lands on the other's top-left corner, refused if it would overlap a third creature;
  after the attack resolves; (b) yes, as part of the swap batch.
- Built meanwhile (2026-11-21): (a) (`swapLandings`; also refused off the Scene or when the two would overlap each other;
  an Action's swap is refused before anything is spent, a reaction's moves neither). (b) not yet: the illusion is a
  premium-only document and a copy-of-the-caster summon is its own item.

### Q114. Redirected hits: criticals and AC (Q48 follow-up) (2026-11-16)
- A critical that came from an override (the first target was Unconscious within 5 feet) stays critical on the new
  creature today. Should it? Does the new target's AC include its cover and attack-specific bonuses?
- Default until answered: only a natural 20 stays critical; AC includes cover.
- Built meanwhile (2026-11-20): the cover (`redirectCandidates`' `coverFrom`; a creature with Total cover from the attacker
  is not offered; the first target's own cover leaves the roll). Not built: the new creature's other attack-specific bonuses; an override's critical keeps its
  doubled dice on the new creature (its damage is rolled before the move).

### Q115. 2014 Warding Flare: "an attacker that can't be blinded is immune" (2026-11-16)
- Default until answered: by hand (noted).
- Recommendation: automate it as a predicate on the attacker's condition immunities; it is small.

### Q116. Divine Fury and Divine Strike: details (Q52 follow-up) (2026-11-16)
- (a) If the barbarian sets Divine Fury to "Ask" in the action bar and then declines, or closes the damage-type prompt,
  is that turn's use spent?
- (b) Should Divine Strike's two type offers (Necrotic and Radiant) also become one offer with a type choice?
- Default until answered: (a) not spent; (b) yes, for consistency.
- Built meanwhile (2026-11-20): the default (rule-elements.md). A closed type prompt ends its whole Action, as any
  closed prompt does, so that attack lands nothing either.

### Q117. Reactions while transformed (Q58 follow-up) (2026-11-16)
- A transformed creature keeps only its feature and gear Items' rules, but its reactions are still offered. A paladin
  Polymorphed by an enemy still gets its Smite offers. Should reactions follow the transformation's kept items, with
  Wild Shape keeping its druid's hit offers?
- Default until answered: offered in every form, as today.
- Recommendation: follow the kept items.

### Q118. Nature's Mantle and obscurity: details (Q59 follow-up) (2026-11-16)
- (a) Does a Heavily Obscured place (darkness, Fog Cloud) also satisfy "an area that is Lightly Obscured"?
- (b) Should obscurity only decide whether the mantle's Hide is offered, or should Hide itself start requiring Heavily
  Obscured or cover (2024), with the mantle relaxing that to Lightly Obscured?
- (c) Should the SRD's lightly obscuring spell areas (Web, Insect Plague) become lightly obscured lasting areas?
- Default until answered: (a) yes; (b) Hide requires Heavily Obscured or cover, and the mantle relaxes it; (c) yes.
- Built meanwhile (2026-11-21): (a) the mantle requires `obscured` lightly or heavily; (b) the common Hide, and every
  converted Action that is Hide alone, requires Heavily Obscured or Three-Quarters or Total Cover from every foe; only
  the mantle's "While" of obscurity replaces that, and any other (Shadow Stealth's Dim Light) adds to it; a feature
  letting its creature Hide elsewhere (Naturally Stealthy) is noted by hand; (c) Web and Insect Plague are
  `obscures: "lightly"` areas. Hide's cover is cover only: a foe that cannot see (Blinded, or in darkness without
  Darkvision) still counts. The premium books' Hide Actions lack the requirement until reconverted.

### Q119. The 2014 sidekick's turn-end Assist: details (Q61 follow-up) (2026-11-16)
- (a) Does it follow 2014 Help (any ability check, no proficiency, no 30-foot range) or the 2024 Assist the engine has?
- (b) When the GM advances the turn of a player-controlled sidekick, or its controller is offline: wait for the player,
  ask the GM, or skip? Only in combat?
- Default until answered: (a) 2014 Help, since the sidekick is 2014; (b) ask the GM; only in combat.

### Q120. Rage of the Wilds: details (Q62 follow-up) (2026-11-16)
- (a) Does Wolf's Advantage exclude the barbarian's own attacks ("your allies")?
- (b) When Rage is extended or renewed, does the choice carry over or get asked again? When the GM ends Rage early, does
  the option's marker go with it?
- Default until answered: (a) yes; (b) carries over; the marker ends with the Rage.
- Built meanwhile (2026-11-21): the defaults. (a) the Wolf aura never grants the barbarian's own attacks. (b) the option is
  part of the Rage's own effect, so it carries over for as long as that Rage lasts and ends with it, the GM's ending
  included. Rage is not extended (it lasts its 10 minutes). Using Rage again while raging is read as a new activation, not a
  renewal: the book's "whenever you activate your Rage" and Q62's answer ("choose ... when Rage begins") ask again, another
  option replacing the old Rage and the same one refreshing it. Carrying the option over there instead needs the actor's
  statuses in the configuration dialog's context; say if you want it.

### Q121. Fast Hands: does casting from a magic item count? (Q63 follow-up) (2026-11-16)
- Does casting a spell from a wand, staff or scroll count as "the Magic action to use a magic item"?
- Default until answered: no; only activations that are not spells.
- Recommendation: keep; 2024 Fast Hands names the Magic action, and casting is its own action.
- Built meanwhile (2026-11-21): the default. An Action tagged `spell` (a wand's or a necklace's spell) is not offered
  Fast Hands; an item's own spell attack (Ring of the Ram) is a use of the item and is.

### Q122. Warrior Commander's Maneuver (Q65 follow-up) (2026-11-16)
- Does choosing Maneuver do anything beyond dropping Sap, or does Maneuver stay a separate use? Is a GM-run creature
  asked on every attack?
- Default until answered: Maneuver only drops Sap, and its own use stays separate; the GM is asked with Sap preselected.

### Q123. Guarded Mind and concentration links (Q68 follow-up) (2026-11-16)
- When the Charmed or Frightened comes from a caster's concentration effect on several creatures, ending it on the user
  leaves the caster concentrating on the others. Agreed?
- Default until answered: yes, only the user's copies end.
- Built meanwhile (2026-11-20): the default; `ends.statuses` deletes only the user's effects.

### Q124. Cosmic Omen before the first omen (Q69 follow-up) (2026-11-16)
- Before the first Long Rest roll (no Weal or Woe yet), offer neither side or both? Is the Long Rest roll automatic, or a
  "you can" choice?
- Default until answered: neither side; the roll is automatic.
- Built meanwhile (2026-11-21): the default.

### Q125. Ally-side sight for ally-only offers (Q71 follow-up) (2026-11-16)
- Should the sight check also apply to ally-only offers whose text says "you can see" (Flash of Genius), or only to the
  two-sided rows?
- Default until answered: every offer whose text says "you can see".
- Built meanwhile (2026-11-20): the default for the one ally-only row whose text says "you can see" (Flash of Genius, `seen: true`); Countercharm, Guided Strike and Burst of Ingenuity say no such thing.

### Q126. "Can hear it" and automatic successes (Q74 follow-up) (2026-11-16)
- (a) Does "can hear it" mean only "not Deafened", or do Silence areas and distance count too?
- (b) The 2024 SRD Vrock's "(demons succeed automatically)" is unautomated, and 13 other SRD creatures have similar
  "succeed automatically" text. Should that become an automatic success by creature type? It is a different mechanic
  from the 2014 exclusion.
- Default until answered: (a) not Deafened and not inside a Silence area; (b) yes, as its own small part.
- Built meanwhile (2026-11-20): (a) not Deafened; a Silence area is not modelled (Silence is by hand), so it counts once its area deafens. (b) not built: an automatic success by creature type is its own item.

### Q127. Directional sight: details (Q75 follow-up) (2026-11-16)
- Our Q75 named the Robe of Eyes, but the "can see you" clause belongs to the Robe of Scintillating Colors.
- (a) When a single target fails the sight check, refuse the Action (nothing spent), or spend it with no effect?
- (b) Should the other direction ("a creature the mummy can see", and many "a creature you can see" spells) be checked
  too, for all such spells or named ones only?
- Default until answered: (a) refuse, nothing spent; (b) all such spells, by their text.
- Built meanwhile (2026-11-20): (a) the default. (b) a 2024 stat block's "one creature the <monster> can see" (`seenBySource`: the two Dreadful Glares and 34 other SRD creature Actions); a spell's "a creature you can see within range" is not read yet (its reader is its own item; nothing is checked for those meanwhile).

### Q128. Rod of Absorption and Staff of the Magi: an ally's spell (2026-11-16)
- Filling the Rod by having an ally cast a spell at the holder is the usual way to charge it. Should the Rod and the
  Staff answer a non-hostile caster's spell that targets only the holder?
- Default until answered: hostile casters only (the Q46 pattern); the GM fills the Rod by hand.
- Recommendation: allow it when the spell targets only the holder.

### Q129. Boon of Spell Recall when a spell is cancelled and its slot wasted (2026-11-16)
- When an Ioun Stone or the Rod cancels a spell and its slot is still spent, does Boon of Spell Recall's d4 roll to keep
  that slot? Q24 makes "when you cast" happen even for a countered spell, which argues yes.
- Default until answered: no roll (noted in the code).
- Built meanwhile (2026-11-21): the default, pinned by a test.
- Recommendation: roll it.

### Q130. Reaction prompts: show the attack total to the creature it hit (2026-11-20)
- A reaction offered on an attack that hit (Shield, Arrow-Catching Shield) or on a foe-side test offer ("roll succeeded.
  Change the result?") names the attacker but not the roll. Live round 9 saw a player spend Shield (+5) against a 28 that
  hit AC 16, where knowing the total would have saved the reaction. Whether a table announces attack totals is its own
  choice; a GM-only roll mode hides it today.
- Should the prompt show the roll total (never the attacker's modifiers) to the player choosing, when the roll is not
  GM-only? And should a GM-only roll show nothing, or "hit by N or less" when the reaction would decide it?
- Default until answered: unchanged; the prompt shows no total.
- Recommendation: show the total when the roll is visible to the chooser; for a GM-only roll show nothing.

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

### Q2. A Player who reconnects mid-Action: send their prompt again? (2026-10-31)
Plan item 1.1 asked that "a reconnecting client is sent its open prompts again". Today a Player who disconnects has
their open requests handed to the GM at once (`releaseRequestsOf`), so nothing waits on them when they return.
Sending the prompt back would mean taking it away from the GM again.

- Done meanwhile: nothing; the GM answers, or cancels with Cancel Action.
- Recommendation: keep it as it is. Ask again only if Players complain that the GM answers for them after a reload.

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

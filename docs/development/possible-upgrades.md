# Possible upgrades

Improvements the owner has accepted as worth doing someday but not now. Until one is built, the GM handles that rule by
hand. Each entry says what is missing today and how it could be built.

## Inscrutable: Insight checks about a creature (owner, Q4 2026-10-31)

- **Today:** a sphinx's Inscrutable (Disadvantage on Insight checks made to read its intentions) is the GM's to apply.
  A sheet's Insight check names no creature, so nothing knows who the check is about.
- **Upgrade:** treat the creatures the roller has targeted as the ones the check is about. `Actor#rollTest` on the
  rolling client reads `game.user.targets` (the runtime already reads them to build Action intents), and a
  `checked.<skill>` roll-mode domain on each targeted creature applies its rules to the roll. Inscrutable then converts
  to `RollMode {domains: ["checked.insight"], mode: "disadvantage"}`. The same domain serves any "checks made about
  this creature" rule (homebrew included).
- **Size:** small. No new UI. A check with no targets is unchanged.

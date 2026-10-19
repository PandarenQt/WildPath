# RuleElements

RuleElements are Wild Path's declarative rule-contribution layer.

```text
Predicate
+ ValueExpression
+ Modifier
+ RuleElement
-> owning domain interpreter
```

A RuleElement is serializable data carried by an Item, ActiveEffect, condition, feature, class,
species, feat, spell, transformation, temporary effect, or homebrew package. It describes a
mechanical contribution. It is not a mini-resolver and must not directly mutate Actors, Items,
ActiveEffects, Tokens, the canvas, chat, or UI state.

## Runtime

`module/helpers/rule-elements.mjs` contains the pure RuleElement registry and collector.

The default registry currently supports these contribution types:

- `Modifier`
- `GrantResource`
- `GrantResistance`
- `GrantImmunity`, `GrantVulnerability`
- `ConditionImmunity`
- `Reveal`
- `GrantMovement`
- `RollMode`, `ResourceCap`, `RollOutcome`
- `ExtraDamage`, `Aura`
- `Trigger`

Handlers return contribution bundles only:

- `modifiers`
- `resources`
- `damageAdjustments`
- `movement`
- `rollModes`, `resourceCaps`, `rollOutcomes`
- `extraDamage`, `auras`
- `conditionImmunities`
- `triggers`

`GrantActionEconomyResource` was removed on 2026-10-14: nothing read it. Extra Actions are counters whose maximum
effects raise (action-economy.md).

Owning domains consume those bundles. For example, `Modifier` RuleElements feed
`WildPathStatistic`; damage adjustment RuleElements produce a profile for
`DamageAdjustmentResolver`; trigger RuleElements produce existing automation trigger definitions.

## Authoring Shape

Persisted RuleElements use a stable common envelope:

```js
{
  schemaVersion: 1,
  id: "feature.dueling.attack",
  type: "Modifier",
  label: "Dueling",
  predicate: {tagsAny: ["weapon-attack"]},
  priority: 100,
  enabled: true,
  suppressed: false,
  data: {
    domains: ["attack.melee"],
    modifierType: "status",
    valueExpression: {type: "constant", value: 2}
  },
  metadata: {}
}
```

Common fields belong at the top level. Type-specific fields belong under `data`; this lets the
Foundry data schema preserve RuleElements without changing every time a new handler is added.

`type` is the canonical key. The pure normalizer also accepts `key` and a few lowercase aliases so
future importers can adapt external data before persistence.

`schemaVersion` is required in persisted data and currently defaults to `1`. Future migrations
should use this field to upgrade RuleElement definitions deterministically instead of inferring
version from an opaque payload.

## Evaluation

RuleElements use the shared Predicate and ValueExpression evaluators. They do not evaluate
JavaScript, parse arbitrary formula strings, or call Foundry APIs.

The lifecycle is:

```text
raw definition
-> serializability and schema validation
-> Predicate validation/evaluation
-> registry handler lookup
-> handler-owned payload validation
-> contribution bundle
-> trace
```

Evaluation is ordered by `priority`, then stable id. Each entry emits a trace with one of:

- `contributed`
- `disabled`
- `suppressed`
- `predicate-failed`
- `failed`

**What a predicate sees (2026-10-14).** When a creature's statistic, roll mode or roll outcome is read, a
RuleElement's own predicate sees the roll's `tags` and the creature's current `conditions`, its statuses:
- `{tagsAny: ["ranged"]}` applies only to ranged attacks, using the attack type and the Action's tags;
- `{hasCondition: "raging"}` applies only while the creature has that condition.

Before this, these predicates never matched. Data preparation (resource maxima, Speeds) does not pass them yet.

A rule on an effect also sees that effect's level as `source.level`, wherever it is read, data preparation
included. The 2014 Exhaustion table gates each of its rules this way: `{oneOf: {path: "source.level", values: [2, 3, 4]}}`.

Invalid or unknown RuleElement types fail explicitly in the collector result. Disabled,
suppressed, or predicate-failed entries fail closed by contributing nothing while remaining visible
to rules-inspector tooling.

The registry is deliberately small and centralized. Registering the same normalized type twice
throws unless the caller explicitly passes a replacement option. Adding a new RuleElement type
should therefore be a localized Rules-domain change plus tests for its owning contribution shape.

## Validation And Serialization

`validateRuleElementDefinition()` rejects non-plain or non-JSON data, including functions,
symbols, bigint values, circular structures, and non-finite numbers. Invalid Predicate shapes are
reported as invalid RuleElements rather than silently skipped as ordinary predicate failures.

`serializeRuleElementDefinition()` returns a normalized plain definition suitable for:

```text
serialize
-> persist
-> reload
-> validate
-> evaluate
```

RuleElement evaluation clones authored data before dispatch and must not mutate the definition or
the evaluation context.

## Persistence

The base Item and ActiveEffect data models now persist:

- legacy `modifiers`
- new `ruleElements`

Legacy `modifiers` remain supported so existing data keeps working. New content should prefer
RuleElements unless it is intentionally writing the low-level modifier primitive directly.

Generic WildPath ActiveEffects use the `effect` subtype; `base` is Foundry V14's reserved fallback
ActiveEffect type and must not be declared by the system manifest. Development worlds which already
stored explicit ActiveEffects as `type: "base"` need those records migrated to `effect` or
`condition` before startup validation.

WildPath ActiveEffect data models extend `foundry.data.ActiveEffectTypeDataModel` by preserving the
inherited schema first, including Foundry's native `system.changes`, then adding WildPath
`modifiers` and `ruleElements`.

## Current Integration

`WildPathActor#getStatistic(domain)` consumes `Modifier` RuleElements from active embedded Items
and applicable ActiveEffects alongside legacy modifier entries.

`ConditionTriggerResolver` consumes `Trigger` RuleElements from condition ActiveEffects and matches
them against semantic events such as `turn.started`. Its current payload support is intentionally
narrow: a condition trigger may plan a durability change through `DurabilityResolver`, but it does
not execute an action, open a reaction window, roll damage, create chat, or mutate a document.

`Bleeding` is the representative migrated condition:

```text
Bleeding condition config
-> persisted Trigger RuleElement
-> turn.started
-> ConditionTriggerResolver
-> DurabilityResolver mutation plan
-> WildPathActor Foundry update adapter
```

`system.dot` remains as a temporary compatibility payload for old condition effects. If a
condition effect has no `ruleElements`, `ConditionTriggerResolver` translates legacy dot ticks
into synthetic Trigger RuleElements. If persisted RuleElements exist, they are authoritative and
legacy dot data is ignored to avoid double application.

**Reaction triggers.** The Foundry reaction provider
(`module/adapters/foundry-v14-reaction-provider.mts`, installed as `game.wildpath.reactionServices`)
turns `Trigger` RuleElements of `kind: "reaction"` on active Items into reaction triggers for any event:
movement steps, staged and native (`event: "movement.transition-proposed"`, phase `interrupt`), and
ordinary Actions (`action.declared`, `attack.hit`, `attack.miss`):

- The reaction's Action is the Item itself (an Action Item) or the Action named by `data.reaction.actionId`.
- Each such Token also becomes a movement observer: reach in fields comes from that Action's reach range,
  hostility from opposed Token dispositions.
- Put the event predicate in `data.triggerPredicate`; `predicate` (or `data.predicate`) is the RuleElement's
  own activation predicate and is evaluated without the event.
- `{self}` in a predicate `path`, or as a whole `match` value, is bound to this reactor's Token id.

An opportunity attack is authored as:

```js
{type: "Trigger", data: {kind: "reaction", event: "movement.transition-proposed", match: {phase: "interrupt"},
  triggerPredicate: {all: [
    {equals: {path: "event.data.movementKind", value: "voluntary"}},
    {equals: {path: "event.data.relations.{self}.leavesReach", value: true}},
    {equals: {path: "event.data.relations.{self}.context.hostile", value: true}}]}}}
```

2024 Shield ("when you're hit, +5 AC until the start of your next turn, including against that attack") is an
Action with this Trigger, a Reaction cost, `self` targeting, and a custom effect (action-definitions.md):

```js
{targeting: {type: "self"}, costs: {allOf: [{capability: "reaction", amount: 1}]},
 effects: [{type: "effect", name: "Shield", ruleElements: [{type: "Modifier", data: {domains: ["defense.ac"], value: 5}}],
   duration: {value: 1, units: "turns", expiry: "turnStart"}}]}
// ruleElements: [{type: "Trigger", data: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}"}}}]
```

The attack is scored again after the reaction, against the raised AC; a natural 20 still hits. Live (two
browsers, 14.369, physical dice): a goblin's 13 hit Player1's wizard (AC 12). Player1 chose Shield, the card
showed a miss, the wizard kept the Shield effect, and its reaction was spent.

A counterattack ("when a creature hits you, strike back") is authored as:

```js
{type: "Trigger", data: {kind: "reaction", event: "attack.hit",
  match: {phase: "interrupt", targetTokenId: "{self}"}}}
```

Live (two browsers, 14.369): Player1's Strike hit a GM-controlled guard. The GM was offered the guard's
Counterattack before the Strike's damage was committed. The counterattack hit Player1's attacker for 3,
the guard spent its reaction, and the Strike's 6 damage still landed. The player saw two public cards,
the guard's Counterattack, then the Strike.

Live (Quench, 14.369): a hostile guard with this Trigger on its melee Action attacked a friendly mover
leaving its reach (6 damage, reaction spent, movement finished), with no injected services. Live in two
browsers: the same guard attacked a player's native move before its first step
([movement-paths.md](movement-paths.md#before-step-reactions-in-native-drags)).

**Repeated saves (2026-10-19).** An Action's effect row may say `repeatSave: "turnEnd"` (or `"turnStart"`): 2024's "At
the end of each of its turns, the target repeats the save, ending the spell on itself on a success". When the Action
applies it, the effect stores the save it repeats (`flags.wildpath.conditionEffect.metadata.repeatSave`: its timing,
ability and the DC it resolved to). At that boundary of the creature's own turns, the automation dispatcher has it roll
that save again as an authority Action (one per Action and source: `repeatSaveGroups`), and a success deletes every
effect that save let in. The converter reads the 2024 wording (Hold Person, Hold Monster, Blindness/Deafness, Slow,
Confusion, a dragon's Paralyzing Breath: 18 SRD Actions); the Builder's effect rows have "Save again". Live (two
browsers): Player1's QA Caster held the Bandit Captain (Paralyzed, DC 14); at the end of the Captain's turn in combat it
saved again, 17, and Paralyzed ended.

**Automatic triggers.** A `Trigger` of kind `automation` (the default) on a creature's active Item or
enabled non-condition effect runs without asking anyone. The general automation dispatcher
(`module/adapters/foundry-v14-automation-dispatcher.mts`, `game.wildpath.automation`) runs it when its event
happens to that creature:

- `turn.started` and `turn.ended` come from `WildPathCombat`.
- `initiative.rolled` comes from any client's roll, through the Combatant update the GM sees
  (`event.data.initiative`).
- `rest.completed` comes from `Actor#rest` (`event.data.restType`, `shortRest` or `longRest`).

The Action is the trigger's inline `data.action`, the Item itself when it is an Action, or the Action Item
named by `data.actionId`. It resolves as an authority Action with the creature as source and only target,
exactly like a lasting area's effect, and it shares that code (`runAuthorityAction`). Put the event
predicate in `data.predicate` or `data.triggerPredicate`. Condition effects keep their own path (below), so
nothing fires twice.

```js
{type: "Trigger", data: {event: "rest.completed",
  predicate: {equals: {path: "event.data.restType", value: "longRest"}},
  action: {schemaVersion: 1, id: "action:renewal", label: "Renewal", costs: {allOf: []}, healing: [/* ... */]}}}
```

Only the active GM dispatches. A rest happens on the resting client, so a Player's client reports it to
the GM with the V14 user query `wildpath.automationEvent`. Foundry's server names the sender. The GM accepts
only `rest.completed`, only for an Actor that sender owns, and takes only the rest type from the data. A
rest on the GM's own client runs before `rest()` returns.

A trigger's predicate also sees its creature as `actor`. Regeneration is a `turn.started` trigger whose inline
Action heals its creature. Its predicate holds only what its own text says:
- "if it has at least 1 Hit Point": `{not: {equals: {path: "actor.system.resources.health.value", value: 0}}}`;
- "if the troll takes Acid or Fire damage, this trait doesn't function on its next turn": `data.stoppedBy:
  ["acid", "fire"]` and `{not: {equals: {path: "actor.flags.wildpath.damageTaken.fire", value: true}}}` per type. The
  dying rules record those types when the creature takes more than 0 of them, and clear the record when its next
  turn starts, after the trigger.
- "the troll dies only if it starts its turn with 0 Hit Points and doesn't regenerate": `data.deferDeath: true`. At 0
  it falls Unconscious instead of dying, and at the start of its turn it dies if it is still at 0
  ([dying-and-death.md](dying-and-death.md)).

A Regeneration that names none of these (the Tarrasque's kind) heals every turn.

Not yet: `once` is ignored (triggers fire every time), and a trigger cannot target anyone but its owner.

Live (14.369): Quench ran a turn-start trigger once per turn, an initiative trigger when the Combatant
rolled, and a long-rest trigger that ignored a short rest. In two browsers, Player1's long rest made the GM
run its creature's trigger (10 → 7, with a card). The GM refused Player1's forged report for an Actor
Player1 does not own, and a report of a GM-only event.

**Advantage and disadvantage.** A `RollMode` RuleElement gives advantage or disadvantage on d20 rolls in
its domains:

- **Own rolls:** `attack`, `attack.melee`, `attack.ranged`, `save`, `save.<ability>` and `check`.
- **Attacks against the creature:** `attacked`, `attacked.melee` and `attacked.ranged`.

Its predicate sees `attack.type` and `attack.adjacent` (the attacker within 5 ft), so "advantage within
5 ft, disadvantage beyond" is two RollModes. It also sees:
- `attack.allyNearTarget`: one of the attacker's allies (its disposition, not Incapacitated) stands within 5 ft of
  the target. Pack Tactics is `{equals: {path: "attack.allyNearTarget", value: true}}` on `attack`.
- on a save, the Action's `tags`, where every spell is also `magical`. Magic Resistance is `{tagsAny: ["magical"]}` on
  `save`: it covers spells and any Action tagged `magical` (the converter tags a magic item's Actions).
- `inSunlight` (2026-10-15): the rolling creature stands in sunlight. It is set on its own attacks, checks (initiative
  included), saves, and its automatic triggers. Sunlight Sensitivity is `{equals: {path: "inSunlight", value: true}}` on
  `attack` and `check`.

**Sunlight (2026-10-15, G5).** A creature stands in sunlight when its Scene is tagged "Sunlight", or a light tagged
"Sunlight" reaches it (`module/adapters/foundry-v14-sunlight.mts`):
- The tag is `flags.wildpath.sunlight`. It is a checkbox on the Scene sheet (Environment), the Ambient Light sheet
  (Basic) and the Token sheet (Light).
- A sunlight source is an ambient light or a Token's own light: a sunbeam, or a Daylight spell, whose lasting area
  places its own sunlight (areas.md, "Light"). A plain torch is not.
- On the viewed Scene, Foundry's own light source decides, walls and elevation included. Elsewhere the light's
  radius does.
- The action bar refreshes its odds when a Scene or a light changes.

Live (GM, 14.369): an SRD Kobold Warrior's Dagger showed 75% at night, and 56% with Disadvantage both with the Scene
ticked "Sunlight" and under an ambient light ticked "Sunlight". Unticked, it was 75% again.

The 2024 conditions are authored this way in `WILDPATH.CONDITIONS` (rolls.md, "Advantage / Disadvantage and
Modifiers").

**Resource caps.** A `ResourceCap` RuleElement puts a ceiling on resource maxima:
- `{resources: ["action", "bonus", "reaction"], maximum: 0}` is Incapacitated: no actions of any kind, so
  nothing can be paid and no reaction offered.
- `{resources: ["movement"], maximum: 0}` is Speed 0, and it caps every granted Speed too.

**Forced outcomes.** A `RollOutcome` RuleElement forces a roll's outcome:
- `automatic-failure` on the creature's saves in its domains (`save.might`). No roll is requested, and the
  target context carries the `automatic-failure` override.
- `critical-on-hit` on attacks against it (`attacked`): a hit becomes a critical hit. Its predicate sees
  `attack.adjacent`, measured per target.
- `evasion` on its saves (2026-10-14, G5): damage a success halves becomes none on a success and half on a failure.
  The runtime passes it per target (`save.evasionByTarget`), and the damage step reads it from the save result.
  Evasion is `{domains: ["save.agility"], outcome: "evasion"}`, unless the creature is Incapacitated.

  Live (two browsers): Player1's Fireball at a creature with Evasion took nothing on a save, and 15 of 31 on a
  failure.

**Identical grants count once (2026-10-19).** Grants of one pool add up, except identical ones: the same rule id for
the same pool. A feature converted into several Actions puts its pool's grant on each (Monk's Focus on Flurry of Blows,
Patient Defense and Step of the Wind; a Mage's Protective Magic on Counterspell and Shield), and those used to triple or
double its maximum. Live: an SRD Mage's Protective Magic went from 6 to 3.

**Extra Attack (2026-10-14, G5).** `ExtraAttack {resourceId: "extra-attack"}`, with a `GrantResource` of that pool
(empty, emptied at the start of each turn), on a creature's features:
- Each of its weapon attacks that costs the Action may instead be paid from the pool. Paying with the Action fills
  the pool (`restores`), so the Attack action's further attacks are paid from it.
- The Item's stored definition is unchanged: `actionDefinitionFromItem` adds this for its creature, so the action bar,
  the odds and the authority all see it.
- A payment never refills a pool it drew from, so an attack paid from the pool does not refill it.
- Each Extra Attack feature grants one more use of the same pool, so Fighter's Two and Three Extra Attacks add up.
- A weapon attack is any attack with `attack.statistic: "weapon"`: manufactured and natural weapons, and the common
  Unarmed Strike. Its cost on the action bar includes the pool too.

Live (GM): a Rogue 5 duelist with Extra Attack and a Rapier attacked the Bandit Captain three times in one turn.
The first was paid with the Action and filled the pool (it missed). The second was paid from the pool, hit, and
added 3d6 Sneak Attack. The third was refused.

**Avoiding Opportunity Attacks (2026-10-14, G5).** `AvoidOpportunityAttacks {movementModes: ["fly"]}` on a creature's
active features, gear and effects: its movement in those modes provokes no common Opportunity Attack (Flyby). With no
modes it provokes none at all, like Disengage (`WildPathActor#getOpportunityAttackAvoidance`). A creature's own
movement reactions keep their own predicates.

Live (two browsers, 14.369): an SRD Owl flew out of the Bandit Captain's reach with no prompt; walking out, the GM was
offered the Captain's Opportunity Attack.

**Legendary Resistance (2026-10-14, G5).** A creature with a `legendary-resistance` pool (a `GrantResource`) that
fails a save may succeed instead.
- Its setting is the creature's own, `flags.wildpath.commonPolicies["legendary-resistance"]`. With Ask (the default),
  the save stage asks its controller once: Succeed instead, or Fail the save. With Always it is used without asking.
  With Never it is not used. The action bar's Legendary Resistance counter has the same toggle as a reaction.
- Using it spends one use of that pool, paid by the creature, in the Action's own transaction. It turns even an
  automatic failure (Stunned) into a success.
- The card and the floating text say "Legendary Resistance" instead of "Saved".

Live (two browsers, 14.369): Player1's Fireball caught the SRD Unicorn, Stunned. The GM was asked and chose to
succeed: half damage, uses 3 → 2. Set to Always from the GM's action bar, the next Fireball asked no one (2 → 1).

**Leveled Modifiers.** A Modifier on an effect is bound to that effect's level (`effect.system.level`,
through the modifier's `bindings`). Exhaustion's 2024 penalties scale this way: −2 per level on d20 tests
(`attack`, `save`, `check`), and −5 ft per level on walking Speed and every other Speed (`speed`).

**Damage over time.** `damageOverTimeCondition({id, damageType, amount, stacking})` in `module/config.mjs`
builds a condition whose `Trigger` deals `amount` damage of `damageType` at the start of each of its
creature's turns. A stacking condition deals that amount once per stack (`effect.system.level`), and each
application adds a stack.
- **Envenomed** is poison and stacks. It is Poisoned's former damage, kept by the maintainer on 2026-10-14.
- **Bleeding** is bleeding damage and does not stack.

Another damage type is one more entry. Poisoned is now the 2024 condition only: disadvantage on attack
rolls and ability checks, and no damage.

```js
{type: "RollMode", predicate: {equals: {path: "attack.adjacent", value: true}},
  data: {domains: ["attacked"], mode: "advantage"}}
```

**Damage grants.** `GrantResistance` and `GrantImmunity` on a creature's active features, gear and
enabled effects form its damage profile (`WildPathActor#getDamageProfile`, through the pure
`damageProfileFromRuleElements`). The Action runtime passes each target's profile into damage
resolution as `durability.adjustmentProfiles`, and so do reaction children. An Action Item's own
RuleElements never count: they describe that Action.

`GrantVulnerability` adds a vulnerability to the same profile: the damage resolver doubles that damage.

**Condition immunity (2026-10-14).** `ConditionImmunity {conditions: ["charmed", "poisoned"]}` on a creature's
active features, gear and enabled effects lists the conditions it ignores (`WildPathActor#getConditionImmunities`).
When an Action or trigger commits a condition to it, the commit does nothing and reports `immune: true`; removing
a condition still works. Toggling a status by hand from the Token HUD is the GM's call and is not refused.
Petrified gives immunity to Poisoned this way.

**Reveal (2026-10-14).** `Reveal {details: ["defenses"]}` on an effect shows its bearer's AC and save bonuses,
as the odds of attacks and saves against it, to the creature that applied the effect. This holds whatever the
table's `playersSeeOdds` house rule says ([ui-ux-layer.md](ui-ux-layer.md)).

**Granted pools, for monsters (2026-10-14, G4).** A `GrantResource` may also say:
- `current: 0`: the pool starts empty (Multiattack's attacks);
- `emptiesAtTurnStart: true`: the pool empties at the start of each of the creature's turns;
- `recharge: 5`: at the start of the creature's turn, a spent pool comes back on a d6 of 5 or more. The roll is
  whispered to the GM ("Recharge 5–6: Acid Breath is ready again").

An Action Item's own `GrantResource` now counts too, though its other rules still only describe that Action. It is
the pool of uses that Action spends: Fire Breath, Second Wind, "3/Day". Before this, those pools were never
created, so the Actions could not be paid for.

**Resource grants.** `GrantResource` gives a creature a pool to spend and recover, such as Ki equal to a
class level. The grant backs a stored pool of the same id in `system.pools`, so payments, rests and the
sheet treat it like any other pool:

- **Maximum.** Each preparation adds the grant's maximum (a ValueExpression, so it can scale by level) to
  the pool's own base, bonus and modifiers.
- **Creation.** When a granting Item or effect arrives, the user who added it stores the pool, full, with
  the grant's recovery cadence. An Actor created with granting Items, such as an import, has the pool at
  once.
- **Removal.** The pool stays when its grant goes. With nothing granting it, its maximum falls back to its
  own base (0), and adding the grant back restores it.
- **Partial refills (2026-10-15, G7).** `regain: {shortRest?, longRest?}` gives back an amount (a number or
  ValueExpression) on that rest, up to the maximum; `recovery` still refills it whole. A long rest also gives what
  a short rest does. Second Wind is `{recovery: "longRest", regain: {shortRest: 1}}`, a Wand of Fireballs
  `{recovery: "none", regain: {longRest: 1d6 + 1}}`. Dice are rolled when the rest is taken and whispered to the GM
  ("Wand of Fireballs regains 5").

```js
{type: "GrantResource", data: {resourceId: "ki", label: "Ki", recovery: "shortRest",
  maximum: {type: "class-level", class: "monk"}}}
```

Live (14.369): in Quench, a granted pool was spent and recovered on a short rest, dropped to 0 when its
Item was deactivated, and was present at once on an imported Actor. Player1 adding a Ki feature to their
own creature stored Ki 3/3 from their own client.

**Movement grants.** `GrantMovement` gives a Speed for a mode (`{mode: "fly", distance: 60}`), prepared into
`system.speeds`; movement in that mode uses it (movement-paths.md, "Movement modes (2024)"). `hover: true` on a fly
Speed keeps the creature up when it is knocked Prone (areas.md, "Falling").

**Custom resources and Legendary Actions (2024).** Both are `GrantResource` pools:
- Spirit Points, maximum 2 × proficiency bonus, recovered on a long rest:
  `{type: "GrantResource", data: {resourceId: "spirit-points", label: "Spirit Points", maximum: {type: "multiply",
  terms: [2, {type: "proficiency-bonus"}]}, recovery: "longRest"}}`.
- A monster's Legendary Actions: `{resourceId: "legendary-action", maximum: 3, recovery: "turn"}`, which refills at
  the start of the monster's own turn. Its legendary Actions cost `{capability: "legendary-action", amount: 1}`; a
  pool pays for its own id. Nothing yet enforces "only right after another creature's turn"; the GM decides.
- A long rest also restores what a short rest does.

Future resolvers should request the relevant RuleElement bundle
and interpret it inside their own domain boundary instead of adding item-, spell-, class-, or
condition-name branches.

## ExtraDamage (2026-10-14)

`{type: "ExtraDamage", data: {domains, expression, damageType, once?: "turn"}}` adds a damage component to an
Action's own damage in the damage domains (`damage`, `damage.melee`, `damage.weapon`, ...). Its predicates see
the attack type, the Action's tags, the attack's ability, the weapon's properties (`finesse`) and the creature's
conditions. They also see the attack against its first target: `attack.rollMode` and `attack.allyNearTarget`. With
no `damageType`, it deals the Action's own (2026-10-14).

Sneak Attack (G5) is `{domains: ["damage.weapon"], expression: <dice by Rogue level>, once: "turn"}` with the
predicate "`finesse` or `ranged`, and `attack.rollMode` is advantage, or `attack.allyNearTarget` without
disadvantage".

"When you hit with a melee attack, +1d6 fire, once per turn" is
`{domains: ["damage.melee"], expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", once: "turn"}`.

- **Same Action, same card.** It is one more component of the Action's damage, so it is its own roll, a critical
  doubles it, and resistance applies to its own damage type. A separate follow-up Action would count as a second
  damage instance (a second Concentration save, more death-save failures), which 2024 does not do.
- **Once per turn.** A hit that dealt damage records the turn in `flags.wildpath.onceUsed.<owner>-<rule>`, on the
  attacker and in the same transaction (a `sourceUpdate` plan). A miss uses nothing. Each turn counts, not only the
  attacker's own, so it can apply again on another creature's turn (an opportunity attack). Outside combat there
  is no limit.
- `actor.getExtraDamage(domains, {item, tags})` collects these rules, including the acting Action's own.
  `actionCombatStatistics` adds them for the runtime and for reaction Actions.

**On its target: a mark (2026-10-19).** A rule in the `attacked` domain adds damage to attacks against its bearer.
- An attack on one target collects the target's own `attacked` and `attacked.<type>` extra damage
  (`actionCombatStatistics` with `target`), as reactions' attacks do.
- Its predicates see `attack.fromAttacker`: the statuses of the effects the target bears from this attacker. So
  Hunter's Mark is an effect with slug `hunters-mark` whose rule is
  `{domains: ["attacked"], expression: 1d6, damageType: "force"}` with predicate
  `{equals: {path: "attack.fromAttacker.hunters-mark", value: true}}`. Only its own caster's attacks see it.
- A save or a damage-only Action does not count: it is attack rolls only.
- shortcut: an attack on several targets counts no target's mark; upgrade with per-target damage components.

Live (two browsers, 14.369, 2026-10-19):
- Player1's QA Caster cast the SRD Hunter's Mark on the Bandit Captain.
- Their Dagger then hit for 2 (1d4) plus 4 (1d6 Force).
- QA Fighter's Longsword hit the same Captain for 7 (1d8 + 3), with no extra.

Live (two browsers, 14.369): Player1's rogue's dagger with a once-per-turn "+1d6 fire" feature rolled "1d4" and
"1d6" on its first hit, only "1d4" on its second hit that turn, and "2d4" and "2d6" on a critical in its next
turn.

## Aura (2026-10-14)

`{type: "Aura", data: {radius, affects: "allies" | "enemies" | "all", ruleElements: [...]}}` grants its nested
rules to the creatures within `radius` feet of its bearer.
- **Who it covers.** Allies are the same Token disposition and enemies the opposite. `allies` and `all` include
  the bearer (2024 "you and friendly creatures"); `enemies` does not.
- **Example.** "You and allies within 10 ft gain +1 AC" is `{radius: 10, affects: "allies", ruleElements:
  [{type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]}`.
- **When it is read.** Who is inside is worked out whenever a statistic is read for a roll or a defense:
  `game.wildpath.auras.ownersFor(actor)` (`module/adapters/foundry-v14-auras.mts`) checks the Tokens on the Scene
  with the lasting-area coverage test. That covers attacks, AC (including a re-scored attack), saves, checks and
  damage. Nothing is written to the affected creatures, so the bonus is never stale and never shows on a Player's
  sheet.
- **Limits.**
  - Data preparation leaves auras out, so an aura does not change Speed or health maxima.
  - Only Modifier-type rules reach statistics; roll modes from auras are not read yet.
  - Validation requires a radius, a known `affects`, and nested rules the engine knows.

Live (GM browser, 14.369, physical dice): a paladin's +1 AC aura gave an ally 10 ft away AC 15 (14 + 1). A goblin's
14 missed it there, and hit once the ally stood 20 ft away.

## ArmorClass (2026-10-15)

`{type: "ArmorClass", data: {value, armor?}}` is a way to work out its owner's Armor Class (2024). `value` is a number
or a ValueExpression: Chain Mail is `16`, a Breastplate `14 + min(Agility modifier, 2)`, Unarmored Defense
`10 + Agility + Fortitude modifiers`, Mage Armor `13 + Agility modifier`.
- **Which counts.** `armor: true` marks armor its owner wears. While it wears any, only those count; otherwise its
  unarmored ways do (Unarmored Defense, Mage Armor). The AC is the best that counts, plus `defense.ac` Modifiers (a
  Shield's +2, a Cloak of Protection's +1). `resolveActorDefense` reads them through `actor.getArmorClasses()`.
- **Unarmored.** Every creature also has the 2024 unarmored AC, 10 + its Agility modifier.
- **A typed AC wins** (maintainer, 2026-10-15). The AC typed on the sheet (`system.defenses.ac.value`) replaces the
  worked-out one; bonuses still add. Blank (null, the default for new creatures) means worked out. A converted
  creature's stat block AC is typed, so it keeps its own. Actors made before this store 10, which counts as typed
  until the field is cleared.
- Gear counts only while equipped (`system.active`); an effect (Mage Armor) while it lasts.

Live (two browsers, 14.369): QA Caster (Agility 16) showed AC 13 unarmored. Player1 equipped the SRD Chain Mail and
Shield from the sheet: AC 18, and 10 feet less Speed (Might 10 under the armor's 13). Unequipping the Chain Mail gave
15. Player1's Mage Armor on themself made it 18, and with Agility 20 Mage Armor's 18 lost to the worn Chain Mail's
16 (AC 18 with the Shield).

## AbilityScore (2026-10-19)

`{type: "AbilityScore", data: {ability, mode, value, maximum?}}` changes one ability score while it applies. The
modes apply in this order (`abilityScoreAfter`):

| Mode | Meaning | Example |
| --- | --- | --- |
| `add` | `value` added, to at most `maximum` (20 by default); a score already above it stays; a negative value lowers it | Ioun Stone +2 to 20, a Tome +2 to 30, a Shadow's −1 |
| `upgrade` | at least `value` | Belt of Giant Strength 21, Headband of Intellect 19 |
| `downgrade` | at most `value` | Wish's stress, Strength 3 |
| `override` | set to `value` | Feeblemind |

- **On the creature.** The actor's data applies them first in derived data, so hit points, saves, AC, attacks and
  every modifier read the new score.
- **Each pass from source.** Each preparation starts each score from its stored value (`ability.base`). A Wild
  Shape form then replaces it (`ability.formed`), and the rules apply to that, so a rule never applies twice.
- **On the sheet.** The field shows and edits `base`, and the effective score sits beside the name ("Might (21)").
  Saving the sheet never stores 21 as the creature's own score. This also fixes saving a transformed creature's
  sheet, which used to store its form's scores as its own. (Its AC and walking Speed fields still show the form's.)
- A rule row edits it ("An ability score": which ability, is at least / rises by / is at most / becomes, the score,
  and for a rise its maximum).

Live (two browsers, 14.369): QA Fighter (Might 16) wore and attuned the SRD Belt of Giant Strength (Hill). Might
became 21 and their Longsword's attack went from +6 to +8. On Player1's sheet the field still read 16 with "(21)"
beside it, and toggling the save proficiency saved 16. Quench checks the same on a real Actor, and that removing
the Item restores the scores.

## Future Types

When adding a RuleElement type:

- define the persisted payload shape
- register one handler in the central registry
- validate the handler payload before contributing
- preserve source and RuleElement provenance in every contribution
- return plain contribution data only
- add pure tests for validation, predicate behavior, serialization, and non-mutation
- let the owning domain decide what the contribution means

## Boundaries

RuleElements must stay:

- declarative
- serializable
- inspectable
- testable without Foundry canvas/UI
- owned by domain interpreters

They must not become:

- script hooks
- embedded resolver implementations
- document mutation commands
- UI behavior definitions
- special-case feature branches

This keeps later content authoring broad without forcing every resolver to learn every possible
feature, item, condition, or spell name.

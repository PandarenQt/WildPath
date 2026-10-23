# GM tools

These are for the GM. Most sit among the Token controls on the left of the canvas, as buttons.

## Difficult Terrain

Paint a Region and give it the **Modify Movement Cost** behavior: a difficulty of 2 is Difficult Terrain, where each foot of movement costs 2. Spells that make Difficult Terrain (Web, Spike Growth, Grease) do the same with their area. Freedom of Movement and the like ignore it.

## Party Rest

Rests every player character at once: a **Short Rest** (1 hour) or a **Long Rest** (8 hours). Each character rests by its own rules: a Long Rest at 0 Hit Points gives no benefit, and a contagion may hold its Exhaustion. The world's time then moves on by those hours, so lit torches and other timed effects run out. Players spend their Hit Dice from their own sheets. If a rest is interrupted, decide whether to rest again.

## Journey

The party travels some hours at a pace:

- **Fast**, 4 miles an hour: Disadvantage on Perception and Survival checks.
- **Normal**, 3 miles an hour.
- **Slow**, 2 miles an hour: Advantage on Perception and Survival checks.

Each player character gets the pace's effect for those hours. Every hour past 8 is a forced march: each character makes a Fortitude save, DC 10 + 1 for each hour past 8, and gains 1 Exhaustion level on a failure. Time moves on, and the chat says how far the party went. Navigation, foraging and terrain are yours to judge.

## Chase

Turns the running combat into a chase; press it again to end the chase.

- Each creature Dashes 3 + its Fortitude modifier times freely.
- Each Dash beyond that takes a DC 10 Fortitude check, and a failure gives 1 Exhaustion level.
- At the end of each turn a d20 is rolled. On 10 or lower you are told a complication befalls that creature; you decide what it is.

## Bastion Turn

Moves the world 7 days on.

- Each player character's special facilities carry out the orders issued on its sheet's **Bastion** section.
  - **Craft** works 7 days on the Item dropped on the facility, and makes it (paying its materials) when its days are done.
  - **Trade** buys stock with the character's gold, or sells what it holds at its profit.
  - An **Armory**'s Trade stocks it (100 gp, plus 100 per defender; half with a Smithy).
  - **Recruit** adds up to 4 Bastion Defenders, as many as the facilities house.
  - **Empower, Harvest and Research** are listed; the facility's text says what you give.
- The chat lists each order carried out.
- A character whose facilities all maintained has a Bastion event: drawn from the DMG's "Bastion Events" table when its converted module is enabled, else a d100. An Attack removes a defender for each 1 on 6d6 (d8s, and the stock used up, with a stocked Armory); any other
  event is yours to run.
- Every order then goes back to Maintain.

On a character's **Bastion map**, the **Make a Scene** button builds a Scene of it: each facility coloured and named, walls around them. Add the doors.

## Encounters and experience

- **Difficulty.** The combat tracker names the difficulty of the combat being viewed: its hostile creatures' XP against the player characters' budgets (2024 Low, Moderate and High).
- **Awarding XP.** With **Level Advancement** set to experience points, ending a combat offers the XP of the hostile creatures it defeated, split evenly among the player characters. The chat names anyone who may now level up.

## Making and crafting items

- **Craft for a character.** Open an item's sheet and choose this button. You pick a player character, it pays the materials from its coins, and it gains the item. The chat says how many days of work it took. By the 2024 rules:
  - a mundane item takes half its price and a day for each 10 GP of it;
  - a magic item takes its rarity's days and gold (half for a consumable);
  - a Spell Scroll takes its spell level's.
- **Make Spell Scroll.** This button is on any spell's sheet. It puts a Spell Scroll of that spell in the Items directory.
  - Its reader casts the spell at its own level, with the scroll's save DC and attack bonus.
  - Only a character with the spell on one of their classes' spell lists can read it.
  - A reader whose highest spell level is below the spell's first makes a check, DC 10 + the spell's level, and loses the spell on a failure.
  - Either way, the scroll crumbles.
- **Identified.** A magic item's sheet has an **Identified** box and an unidentified name. While the box is unticked, players see only the item's unidentified name and description.

## Traps, poisons and contagions

- **Traps.** Each trap tier is an Action. Give it to a creature you control (a "Dungeon" NPC with a Token works) and use it to set the trap: a lasting 5-foot square anywhere. It springs its save or attack on each creature entering it. Delete its Region when it is found and disarmed.
- **Contagions.** "Infect: Cackle Fever", "Infect: Sewer Plague" and "Infect: Sight Rot" are in the WildPath Actions compendium.
  - A failed save infects the creature, and its incubation is rolled.
  - When enough of the world's time has passed, its symptoms start.
  - After each Long Rest its creature saves against it.
- **Surprised.** Mark a creature Surprised from its Token HUD. It rolls initiative with Disadvantage, and the condition ends after that roll.

## Monster attack riders

A monster attack whose hit forces a save (a Ghoul's Claw, a Cockatrice's Petrifying Bite) now rolls that save on each hit by itself.

## Lair Actions

A creature with Lair Actions gets its Lair Action back at the top of each round, before anyone acts, and you are whispered who may take one.

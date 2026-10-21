import {gmNotice} from "./module/helpers/gm-notice.mjs";
import {WILDPATH} from "./module/config.mjs";
import {registerFoundryV14ConditionStatuses} from "./module/adapters/foundry-v14-status-effects-adapter.mjs";
import {registerBlindsight, registerDarknessSight} from "./module/adapters/foundry-v14-senses.mjs";
import {registerLanguages} from "./module/applications/languages.mjs";
import {registerTokenRuler} from "./module/applications/token-ruler.mjs";
import {registerSunlightConfig} from "./module/applications/sunlight-config.mjs";
import {registerChatCardInteractions} from "./module/adapters/foundry-v14-chat-card-interactions.mjs";
import {registerInspirationRerolls} from "./module/applications/inspiration-reroll.mjs";
import {registerPortent} from "./module/adapters/foundry-v14-portent.mjs";
import {SOURCE_GATES} from "./module/helpers/level-up.mjs";

import "./module/tests/quench/index.mjs";

import WildPathCharacter from "./module/data/actor/character.mjs";
import WildPathNPC from "./module/data/actor/npc.mjs";

import WildPathFeature from "./module/data/item/feature.mjs";
import WildPathAction from "./module/data/item/action.mjs";
import WildPathGear from "./module/data/item/gear.mjs";
import {WildPathBackground, WildPathClass, WildPathSpecies, WildPathSubclass} from "./module/data/item/progression.mjs";

import WildPathBaseEffect from "./module/data/active-effect/base.mjs";
import WildPathConditionEffect from "./module/data/active-effect/condition.mjs";

import WildPathActor from "./module/documents/actor.mjs";
import WildPathItem from "./module/documents/item.mjs";
import WildPathActiveEffect from "./module/documents/active-effect.mjs";
import WildPathCombat from "./module/documents/combat.mjs";
import WildPathCombatant from "./module/documents/combatant.mjs";
import WildPathTokenDocument from "./module/documents/token.mjs";

import WildPathActorSheet from "./module/applications/actor-sheet.mjs";
import WildPathItemSheet from "./module/applications/item-sheet.mjs";
import {WildPathEffectSheet} from "./module/applications/effect-sheet.mjs";

import {getCombatEndLifecycleEvents} from "./module/helpers/combat.mjs";
import {MOVEMENT_MEASUREMENT_MODES} from "./module/helpers/movement.mjs";
import {executeEffectLifecycleCommit} from "./module/resolvers/effect-lifecycle-commit-resolver.mjs";
import {
  onFoundryV14MoveToken,
  onFoundryV14PauseToken,
  onFoundryV14StopToken,
  registerFoundryV14MultiplayerResolution
} from "./module/resolvers/foundry-multiplayer-runtime.mjs";

/* -------------------------------------------- */
/*  Init                                         */
/* -------------------------------------------- */

Hooks.once("init", () => {
  console.log("Wild Path | Initializing the Wild Path game system");

  // Expose system config globally, mirroring dnd5e's CONFIG.DND5E / crucible's SYSTEM.
  CONFIG.WILDPATH = WILDPATH;

  // Document class overrides
  CONFIG.Actor.documentClass = WildPathActor;
  CONFIG.Item.documentClass = WildPathItem;
  CONFIG.ActiveEffect.documentClass = WildPathActiveEffect;
  CONFIG.Combat.documentClass = WildPathCombat;
  CONFIG.Combatant.documentClass = WildPathCombatant;
  CONFIG.Token.documentClass = WildPathTokenDocument;
  // Foundry's vision reads Blinded by its own id; WildPath's condition is `blinded`. Blindsight is a detection mode.
  CONFIG.specialStatusEffects.BLIND = "blinded";
  registerBlindsight(CONFIG, foundry);
  registerDarknessSight(CONFIG);
  // Language text: tagged passages read plainly or in their script, by reader (applications/languages.mts).
  registerLanguages();

  // Actor data models
  CONFIG.Actor.dataModels = {
    character: WildPathCharacter,
    npc: WildPathNPC
  };

  // Item data models
  CONFIG.Item.dataModels = {
    feature: WildPathFeature,
    action: WildPathAction,
    gear: WildPathGear,
    class: WildPathClass,
    subclass: WildPathSubclass,
    species: WildPathSpecies,
    background: WildPathBackground
  };

  // ActiveEffect "base" is Foundry's reserved fallback type; WildPath's generic subtype is "effect".
  CONFIG.ActiveEffect.dataModels = {
    effect: WildPathBaseEffect,
    condition: WildPathConditionEffect
  };
  CONFIG.ActiveEffect.defaultType = "effect";

  // Dragged Tokens show the movement left and the Opportunity Attacks their path would provoke.
  registerTokenRuler();
  registerSunlightConfig();

  // Trackable Token attributes
  CONFIG.Actor.trackableAttributes = {
    character: {
      bar: ["resources.health", "resources.action"],
      value: ["resources.bonus", "resources.reaction", "resources.movement"]
    },
    npc: {
      bar: ["resources.health", "resources.action"],
      value: ["resources.bonus", "resources.reaction", "resources.movement"]
    }
  };

  // The 2014 rules replace the conditions that differ (a world setting; read during init, applied after a reload).
  game.settings.register("wildpath", "rulesVersion", {
    name: "WILDPATH.SETTINGS.RulesVersion.Name",
    hint: "WILDPATH.SETTINGS.RulesVersion.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {"2024": "WILDPATH.SETTINGS.RulesVersion.Modern", "2014": "WILDPATH.SETTINGS.RulesVersion.Legacy"},
    default: "2024",
    requiresReload: true
  });
  if ( game.settings.get("wildpath", "rulesVersion") === "2014" ) Object.assign(WILDPATH.CONDITIONS, WILDPATH.CONDITIONS_2014);

  // Populate CONFIG.statusEffects from our condition config so conditions are togglable
  // from the Token HUD like any other Foundry status.
  registerFoundryV14ConditionStatuses(CONFIG.statusEffects, WILDPATH.CONDITIONS);

  game.settings.register("wildpath", "movementMeasurementMode", {
    name: "WILDPATH.SETTINGS.MovementMeasurementMode.Name",
    hint: "WILDPATH.SETTINGS.MovementMeasurementMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [MOVEMENT_MEASUREMENT_MODES.DISTANCE]: "WILDPATH.SETTINGS.MovementMeasurementMode.Distance",
      [MOVEMENT_MEASUREMENT_MODES.FIELDS]: "WILDPATH.SETTINGS.MovementMeasurementMode.Fields"
    },
    default: WILDPATH.DEFAULT_MOVEMENT_MEASUREMENT_MODE
  });

  // GM-controlled dice policy (AGENTS §9).
  game.settings.register("wildpath", "dicePolicy", {
    name: "WILDPATH.SETTINGS.DicePolicy.Name",
    hint: "WILDPATH.SETTINGS.DicePolicy.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      digital: "WILDPATH.SETTINGS.DicePolicy.Digital",
      physical: "WILDPATH.SETTINGS.DicePolicy.Physical"
    },
    default: "digital"
  });

  // Several saves one client rolls at once (the GM's monsters): one window, or all rolled (answerSaveBatchLocally).
  game.settings.register("wildpath", "batchSaves", {
    name: "WILDPATH.SETTINGS.BatchSaves.Name",
    hint: "WILDPATH.SETTINGS.BatchSaves.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      physical: "WILDPATH.SETTINGS.BatchSaves.Physical",
      always: "WILDPATH.SETTINGS.BatchSaves.Always",
      never: "WILDPATH.SETTINGS.BatchSaves.Never"
    },
    default: "physical"
  });

  // Heroic Inspiration (BG3, G8): the GM may spend a player character's point to reroll a monster's d20.
  game.settings.register("wildpath", "inspirationMonsterRerolls", {
    name: "WILDPATH.SETTINGS.InspirationMonsterRerolls.Name",
    hint: "WILDPATH.SETTINGS.InspirationMonsterRerolls.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Which sources the level-up dialog offers feats and subclasses from (sourceGate): all, until a GM turns one off.
  for ( const gate of SOURCE_GATES ) {
    const key = gate.replace(/^./, letter => letter.toUpperCase());
    game.settings.register("wildpath", `source${key}`, {name: `WILDPATH.SETTINGS.Source.${key}.Name`,
      hint: `WILDPATH.SETTINGS.Source.${key}.Hint`, scope: "world", config: true, type: Boolean, default: true});
  }

  // Hit points on level up (G8): the Hit Die's average by default, or rolled.
  game.settings.register("wildpath", "rollHitPoints", {
    name: "WILDPATH.SETTINGS.RollHitPoints.Name",
    hint: "WILDPATH.SETTINGS.RollHitPoints.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Baldur's Gate 3 rule (B3, off by default): +2 to attack rolls from 8 feet or more above the target, -2 from below.
  game.settings.register("wildpath", "highGround", {
    name: "WILDPATH.SETTINGS.HighGround.Name",
    hint: "WILDPATH.SETTINGS.HighGround.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Baldur's Gate 3 rule (B3, off by default): Shove costs a Bonus Action instead of an Action.
  game.settings.register("wildpath", "bonusActionShove", {
    name: "WILDPATH.SETTINGS.BonusActionShove.Name",
    hint: "WILDPATH.SETTINGS.BonusActionShove.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // House rule: whether players see the odds before acting (the GM always does).
  game.settings.register("wildpath", "playersSeeOdds", {
    name: "WILDPATH.SETTINGS.PlayersSeeOdds.Name",
    hint: "WILDPATH.SETTINGS.PlayersSeeOdds.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Sheet registration
  const {DocumentSheetConfig} = foundry.applications.apps;
  DocumentSheetConfig.registerSheet(WildPathActor, "wildpath", WildPathActorSheet, {
    types: ["character", "npc"],
    makeDefault: true,
    label: "WILDPATH.SheetActor"
  });

  DocumentSheetConfig.registerSheet(WildPathItem, "wildpath", WildPathItemSheet, {
    types: ["feature", "action", "gear", "class", "subclass", "species", "background"],
    makeDefault: true,
    label: "WILDPATH.SheetItem"
  });

  game.keybindings.register("wildpath", "openRulesInspector", {
    name: "WILDPATH.INSPECTOR.Open",
    editable: [{key: "KeyI", modifiers: ["Shift"]}],
    restricted: true,
    onDown: () => { void game.wildpath?.inspect?.(); return true; }
  });

  DocumentSheetConfig.registerSheet(WildPathActiveEffect, "wildpath", WildPathEffectSheet, {
    types: ["effect", "condition"],
    makeDefault: true,
    label: "WILDPATH.SheetEffect"
  });
});

/* -------------------------------------------- */
/*  Multiplayer Resolution Socket                */
/* -------------------------------------------- */

Hooks.once("ready", async () => {
  const registration = registerFoundryV14MultiplayerResolution();
  if ( !registration.ok ) {
    gmNotice("WILDPATH.NOTICE.SocketFailed", {}, registration);
  }
  // The in-play action bar needs Foundry's application classes, so it loads only in a running game.
  const {registerActionBar} = await import("./module/applications/action-bar.mjs");
  const {registerCombatCarousel} = await import("./module/applications/combat-carousel.mjs");
  const {registerFloatingText} = await import("./module/applications/floating-text.mjs");
  registerCombatCarousel();
  registerActionBar();
  registerFloatingText();
  // The GM's Rules Inspector: an Inspect link on each resolution card, and game.wildpath.inspect().
  const {openRulesInspector, registerRulesInspector} = await import("./module/applications/rules-inspector.mjs");
  registerRulesInspector();
  game.wildpath = {...(game.wildpath ?? {}), inspect: openRulesInspector};
});

/* -------------------------------------------- */
/*  Combat Hooks                                 */
/* -------------------------------------------- */

async function onCombatEnd(combat) {
  const authority = currentGMCommitAuthority();
  if ( !authority.canCommit ) return;

  const events = getCombatEndLifecycleEvents(combat);
  if ( !events.length ) return;

  const lifecycle = await executeEffectLifecycleCommit({
    actors: combatActors(combat),
    events,
    authority,
    metadata: {hook: "deleteCombat"}
  });
  if ( !lifecycle.ok ) {
    console.warn("Wild Path | Combat-end lifecycle commit failed", lifecycle);
  }
}

function currentGMCommitAuthority() {
  const activeGM = activeGMUser();
  const userId = game.user?.id ?? null;
  const isGM = game.user?.isGM === true;
  const canCommit = isGM && (!activeGM || activeGM.id === userId);
  return {
    isGM,
    canCommit,
    userId,
    activeUserId: activeGM?.id ?? null,
    activeGMId: activeGM?.id ?? null
  };
}

function activeGMUser() {
  return game.users?.activeGM ?? collectionContents(game.users)
    .filter(user => user?.active && user.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function combatActors(combat) {
  return collectionContents(combat?.combatants ?? combat?.turns ?? [])
    .map(combatant => combatant?.actor)
    .filter(Boolean);
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

Hooks.on("deleteCombat", combat => onCombatEnd(combat));
registerChatCardInteractions();
registerInspirationRerolls();
registerPortent();
Hooks.on("moveToken", (document, movement, operation, user) => onFoundryV14MoveToken(document, movement, operation, user));
Hooks.on("pauseToken", document => onFoundryV14PauseToken(document));
Hooks.on("stopToken", document => onFoundryV14StopToken(document));

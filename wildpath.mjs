import {WILDPATH} from "./module/config.mjs";

import WildPathCharacter from "./module/data/actor/character.mjs";
import WildPathNPC from "./module/data/actor/npc.mjs";

import WildPathFeature from "./module/data/item/feature.mjs";
import WildPathAction from "./module/data/item/action.mjs";
import WildPathGear from "./module/data/item/gear.mjs";

import WildPathBaseEffect from "./module/data/active-effect/base.mjs";
import WildPathConditionEffect from "./module/data/active-effect/condition.mjs";

import WildPathActor from "./module/documents/actor.mjs";
import WildPathItem from "./module/documents/item.mjs";
import WildPathActiveEffect from "./module/documents/active-effect.mjs";

import WildPathActorSheet from "./module/applications/actor-sheet.mjs";
import WildPathItemSheet from "./module/applications/item-sheet.mjs";

import {
  getCombatEndLifecycleEvents,
  getCombatLifecycleEvents,
  getIncomingCombatant
} from "./module/helpers/combat.mjs";
import {MOVEMENT_MEASUREMENT_MODES} from "./module/helpers/movement.mjs";
import {executeEffectLifecycleCommit} from "./module/resolvers/effect-lifecycle-commit-resolver.mjs";

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

  // Actor data models
  CONFIG.Actor.dataModels = {
    character: WildPathCharacter,
    npc: WildPathNPC
  };

  // Item data models
  CONFIG.Item.dataModels = {
    feature: WildPathFeature,
    action: WildPathAction,
    gear: WildPathGear
  };

  // ActiveEffect data models
  CONFIG.ActiveEffect.dataModels = {
    base: WildPathBaseEffect,
    condition: WildPathConditionEffect
  };

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

  // Populate CONFIG.statusEffects from our condition config so conditions are togglable
  // from the Token HUD like any other Foundry status.
  CONFIG.statusEffects = Object.values(WILDPATH.CONDITIONS).map(c => ({
    id: c.id,
    name: c.name,
    img: c.img
  }));

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

  // Sheet registration
  Actors.registerSheet("wildpath", WildPathActorSheet, {
    types: ["character", "npc"],
    makeDefault: true,
    label: "WILDPATH.SheetActor"
  });

  Items.registerSheet("wildpath", WildPathItemSheet, {
    types: ["feature", "action", "gear"],
    makeDefault: true,
    label: "WILDPATH.SheetItem"
  });
});

/* -------------------------------------------- */
/*  Combat Turn Hooks                            */
/* -------------------------------------------- */

/**
 * Reset the incoming combatant's "turn" recovery resources (Action, Bonus Action, Reaction,
 * Movement, plus any custom pool sharing that cadence) - the core of the BG3-style action
 * economy groundwork. Shared by `combatTurn` and `combatStart` so the resolution logic (and the
 * V14 quirk it works around, see `getIncomingCombatant`) lives in exactly one place.
 *
 * V14 fires these hooks on the initiating client before the Combat update is committed. The
 * initiating user must be a GM for persistent resource recovery to run.
 * @param {Combat} combat
 * @param {object} updateData
 * @returns {Promise<void>}
 */
async function onCombatTurnChange(combat, updateData, {hook="combatTurn"}={}) {
  const authority = currentGMCommitAuthority();
  if ( !authority.canCommit ) return;

  const combatant = getIncomingCombatant(combat, updateData);
  if ( combatant?.actor ) await combatant.actor.startTurn();

  const events = getCombatLifecycleEvents(combat, updateData, {hook});
  if ( !events.length ) return;

  const lifecycle = await executeEffectLifecycleCommit({
    actors: combatActors(combat),
    events,
    authority,
    metadata: {hook}
  });
  if ( !lifecycle.ok ) {
    console.warn("Wild Path | Effect lifecycle commit failed", lifecycle);
  }
}

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
  return collectionContents(game.users)
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

Hooks.on("combatTurn", (combat, updateData) => onCombatTurnChange(combat, updateData, {hook: "combatTurn"}));
Hooks.on("combatStart", (combat, updateData) => onCombatTurnChange(combat, updateData, {hook: "combatStart"}));
Hooks.on("deleteCombat", combat => onCombatEnd(combat));

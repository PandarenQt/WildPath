// Real Foundry fixtures only. No world changes occur until a GM explicitly runs a test.
export const QUENCH_FIXTURE_FLAG = "quenchFixture";
const PREFIX = "[WildPath Quench]";

function requireGM() {
  if (!globalThis.game?.user?.isGM) throw new Error("WildPath Quench fixture mutations require a GM.");
  if (!game.ready) throw new Error("Wait for Foundry ready and open Quench before running WildPath tests.");
}

function fixtureFlags(runId) {
  if (typeof runId !== "string" || !runId.trim()) throw new Error("A nonempty Quench fixture runId is required.");
  return {wildpath:{[QUENCH_FIXTURE_FLAG]:true,quenchRunId:runId}};
}

function isMarkedFixture(document) {
  return document?.getFlag?.("wildpath",QUENCH_FIXTURE_FLAG) === true;
}

function isOwnedFixture(document, runId) {
  return isMarkedFixture(document) && document.getFlag("wildpath","quenchRunId") === runId;
}

function requireMarkedParent(document, label) {
  if (!isMarkedFixture(document)) throw new Error(`${label} require an explicitly marked fixture parent.`);
  return document.getFlag("wildpath","quenchRunId");
}

export async function createQuenchActor({runId, name="Actor", type="character", system={}}={}) {
  requireGM();
  const actor = await CONFIG.Actor.documentClass.create({
    name:`${PREFIX} ${name}`,type,system,flags:fixtureFlags(runId)
  }, {renderSheet:false});
  if (!actor) throw new Error(`Actor creation returned no fixture (Quench run ${runId}).`);
  return actor;
}

export async function createEmbeddedQuenchItem(actor, {name="Item", type="feature", system={}}={}) {
  requireGM();
  if (actor?.getFlag("wildpath",QUENCH_FIXTURE_FLAG) !== true) {
    throw new Error("Embedded Quench Items require an explicitly marked fixture Actor.");
  }
  const runId = actor.getFlag("wildpath","quenchRunId");
  const [item] = await actor.createEmbeddedDocuments("Item",[{
    name:`${PREFIX} ${name}`,type,system,flags:fixtureFlags(runId)
  }]);
  if (!item) throw new Error(`Embedded Item creation returned no fixture (Quench run ${runId}).`);
  return item;
}

export async function createEmbeddedQuenchEffect(actor, {
  name="Effect",type="effect",system={},disabled=false,duration={},start
}={}) {
  requireGM();
  if (actor?.getFlag("wildpath",QUENCH_FIXTURE_FLAG) !== true) {
    throw new Error("Embedded Quench ActiveEffects require an explicitly marked fixture Actor.");
  }
  const runId = actor.getFlag("wildpath","quenchRunId");
  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect",[{
    name:`${PREFIX} ${name}`,type,system,disabled,transfer:false,duration,
    ...(start === undefined ? {} : {start}),flags:fixtureFlags(runId)
  }]);
  if (!effect) throw new Error(`Embedded ActiveEffect creation returned no fixture (Quench run ${runId}).`);
  return effect;
}

/**
 * A disposable Scene for Token fixtures. It is never activated or added to navigation, so the
 * GM's viewed Scene and canvas are untouched; Foundry does not need a drawn canvas to create
 * Scenes, embedded Tokens, or their ActorDeltas. Without a background image core skips thumbnails.
 */
export async function createQuenchScene({runId, name="Scene", grid={}}={}) {
  requireGM();
  const scene = await CONFIG.Scene.documentClass.create({
    name:`${PREFIX} ${name}`,active:false,navigation:false,tokenVision:false,
    width:1000,height:1000,padding:0,
    grid:{type:CONST.GRID_TYPES.SQUARE,size:100,distance:5,units:"ft",...grid},
    flags:fixtureFlags(runId)
  }, {renderSheet:false});
  if (!scene) throw new Error(`Scene creation returned no fixture (Quench run ${runId}).`);
  return scene;
}

/** An unlinked Token whose synthetic Actor (ActorDelta) is owned by the marked fixture Scene. */
export async function createUnlinkedQuenchToken(scene, actor, {
  name="Token", x=100, y=100, width=1, height=1, shape, elevation, level
}={}) {
  requireGM();
  const runId = requireMarkedParent(scene, "Quench Tokens");
  if (!isMarkedFixture(actor)) throw new Error("Quench Tokens require an explicitly marked fixture base Actor.");
  const [token] = await scene.createEmbeddedDocuments("Token",[{
    name:`${PREFIX} ${name}`,actorId:actor.id,actorLink:false,x,y,width,height,
    ...(shape === undefined ? {} : {shape}),
    ...(elevation === undefined ? {} : {elevation}),
    ...(level === undefined ? {} : {level}),
    flags:fixtureFlags(runId)
  }]);
  if (!token) throw new Error(`Embedded Token creation returned no fixture (Quench run ${runId}).`);
  if (!token.actor) throw new Error(`Unlinked Quench Token ${token.id} exposes no synthetic Actor (Quench run ${runId}).`);
  return token;
}

/** A Combat bound to the marked fixture Scene, with one Combatant per supplied Token. */
export async function createQuenchCombat(scene, tokens=[]) {
  requireGM();
  const runId = requireMarkedParent(scene, "Quench Combats");
  const combat = await CONFIG.Combat.documentClass.create({
    scene:scene.id,active:false,flags:fixtureFlags(runId)
  }, {renderSheet:false});
  if (!combat) throw new Error(`Combat creation returned no fixture (Quench run ${runId}).`);
  if (tokens.length) {
    const combatants = await combat.createEmbeddedDocuments("Combatant", tokens.map(token => ({
      tokenId:token.id,sceneId:scene.id,actorId:token.actorId,flags:fixtureFlags(runId)
    })));
    if (combatants.length !== tokens.length) {
      throw new Error(`Combatant creation returned ${combatants.length} of ${tokens.length} fixtures (Quench run ${runId}).`);
    }
  }
  return combat;
}

/**
 * Read-only listing of marked fixtures across every owned collection. Without a run ID it lists
 * every marked fixture; that is a diagnostic, never a deletion scope.
 */
export function findQuenchFixtures({runId=null}={}) {
  const owned = document => isMarkedFixture(document)
    && (runId === null || document.getFlag("wildpath","quenchRunId") === runId);
  const describe = document => ({id:document.id,name:document.name,runId:document.getFlag("wildpath","quenchRunId")});
  return {
    combats:(globalThis.game?.combats?.filter(owned) ?? []).map(describe),
    scenes:(globalThis.game?.scenes?.filter(owned) ?? []).map(describe),
    actors:(globalThis.game?.actors?.filter(owned) ?? []).map(describe)
  };
}

export async function cleanupQuenchFixtures({runId}={}) {
  requireGM();
  fixtureFlags(runId); // A missing run ID must never turn cleanup into a world-wide sweep.
  // Combats reference Scene Tokens, and Scenes own Tokens plus their ActorDeltas, so delete in
  // that order before the base Actors. Embedded Items/ActiveEffects/Combatants go with their parent.
  const deleted = {combats:[],scenes:[],actors:[]};
  const collections = [
    ["combats", globalThis.game?.combats, CONFIG.Combat?.documentClass],
    ["scenes", globalThis.game?.scenes, CONFIG.Scene?.documentClass],
    ["actors", globalThis.game?.actors, CONFIG.Actor?.documentClass]
  ];
  for (const [key, collection, documentClass] of collections) {
    const owned = () => collection?.filter(document => isOwnedFixture(document, runId)) ?? [];
    const ids = owned().map(document => document.id);
    if (ids.length) await documentClass.deleteDocuments(ids);
    if (owned().length) throw new Error(`Quench fixture cleanup incomplete for run ${runId}; inspect marked ${key}.`);
    deleted[key] = ids;
  }
  return deleted;
}

/** Install inside the batch's describe block. Mocha runs afterEach even after an assertion fails. */
export function useQuenchFixtures({beforeEach,afterEach}) {
  let runId = null;
  beforeEach(function () {
    runId = null;
    if (!globalThis.game?.user?.isGM) this.skip();
    requireGM();
    runId = foundry.utils.randomID();
  });
  afterEach(async function () {
    if (runId === null) return; // A skipped non-GM test must not attempt cleanup mutations.
    try {
      await cleanupQuenchFixtures({runId});
    } catch (error) {
      throw new Error(`Cleanup failed for WildPath Quench run ${runId}: ${error.message}`,{cause:error});
    } finally {
      runId = null;
    }
  });
  return {
    createActor: data => createQuenchActor({...data,runId}),
    createItem: (actor,data) => createEmbeddedQuenchItem(actor,data),
    createEffect: (actor,data) => createEmbeddedQuenchEffect(actor,data),
    createScene: data => createQuenchScene({...data,runId}),
    createToken: (scene,actor,data) => createUnlinkedQuenchToken(scene,actor,data),
    createCombat: (scene,tokens) => createQuenchCombat(scene,tokens)
  };
}

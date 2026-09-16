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

export async function cleanupQuenchFixtures({runId}={}) {
  requireGM();
  fixtureFlags(runId); // A missing run ID must never turn cleanup into a world-wide sweep.
  const fixtures = () => game.actors.filter(actor => actor.getFlag("wildpath",QUENCH_FIXTURE_FLAG) === true
    && actor.getFlag("wildpath","quenchRunId") === runId);
  const ids = fixtures().map(actor => actor.id);
  if (ids.length) await CONFIG.Actor.documentClass.deleteDocuments(ids);
  if (fixtures().length) throw new Error(`Quench fixture cleanup incomplete for run ${runId}; inspect marked Actors.`);
  return ids;
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
    createItem: (actor,data) => createEmbeddedQuenchItem(actor,data)
  };
}

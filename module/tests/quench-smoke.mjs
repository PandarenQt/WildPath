/**
 * WildPath Quench smoke tests.
 *
 * Purpose:
 * Prove that Quench can execute tests inside a real Foundry V14 runtime
 * and interact with real WildPath Documents/DataModels.
 *
 * This is intentionally NOT a replacement for the Node test suite.
 * It covers the "real Foundry runtime" layer only.
 */

Hooks.on("quenchReady", quench => {
  quench.registerBatch(
    "wildpath.runtime-smoke",
    context => {
      const {
        describe,
        it,
        beforeEach,
        afterEach,
        assert
      } = context;

      let actor = null;

      /**
       * These tests create and delete real world Documents.
       * Run them as a GM in a disposable development/QA world.
       */
      beforeEach(function () {
        if ( !game.user?.isGM ) this.skip();
      });

      /**
       * Always clean up the fixture if a test fails midway.
       */
      afterEach(async function () {
        if ( actor && !actor._destroyed ) {
          const existing = game.actors.get(actor.id);
          if ( existing ) await existing.delete();
        }

        actor = null;
      });

      describe("Foundry V14 runtime", function () {

        it("runs inside Foundry V14 with WildPath active", function () {
          assert.exists(globalThis.foundry, "Foundry namespace should exist");
          assert.exists(globalThis.game, "Foundry game instance should exist");

          assert.instanceOf(
            game,
            foundry.Game,
            "game should be an instance of foundry.Game"
          );

          assert.equal(
            game.system.id,
            "wildpath",
            "WildPath should be the active game system"
          );

          assert.equal(
            game.release?.generation,
            14,
            "Smoke test is intended for Foundry generation 14"
          );
        });
      });

      describe("WildPath document registration", function () {

        it("uses the WildPath Actor document class and character DataModel", function () {
          assert.exists(CONFIG.Actor.documentClass);
          assert.exists(CONFIG.Actor.dataModels?.character);

          assert.equal(
            CONFIG.Actor.documentClass.name,
            "WildPathActor",
            "CONFIG.Actor.documentClass should be WildPathActor"
          );

          assert.equal(
            CONFIG.Actor.dataModels.character.name,
            "WildPathCharacter",
            "character Actors should use WildPathCharacter"
          );
        });
      });

      describe("Real Actor persistence", function () {

        it("creates, updates, prepares, and deletes a WildPath Actor", async function () {
          actor = await Actor.create(
            {
              name: "WildPath Quench Smoke Actor",
              type: "character"
            },
            {
              renderSheet: false
            }
          );

          assert.exists(actor, "Actor.create should return an Actor");

          const actorId = actor.id;

          assert.exists(
            game.actors.get(actorId),
            "Created Actor should exist in the world collection"
          );

          assert.equal(
            actor.documentName,
            "Actor",
            "Fixture should be a real Actor Document"
          );

          assert.equal(
            actor.type,
            "character",
            "Fixture should use the character Actor type"
          );

          /*
           * These defaults come from WildPathBaseActor:
           *
           * health   = 10
           * action   = 1
           * bonus    = 1
           * reaction = 1
           * movement = 30
           */
          assert.equal(
            actor.system.resources.health.value,
            10,
            "Health should receive the WildPath schema default"
          );

          assert.equal(
            actor.system.resources.movement.value,
            30,
            "Movement should receive the WildPath schema default"
          );

          /*
           * Exercise a real Foundry Document update rather than updateSource().
           */
          await actor.update({
            "system.resources.health.value": 7
          });

          const persistedActor = game.actors.get(actorId);

          assert.exists(
            persistedActor,
            "Actor should still exist after the update"
          );

          assert.equal(
            persistedActor.system.resources.health.value,
            7,
            "Updated health should be persisted and prepared"
          );

          /*
           * Exercise real Foundry Document deletion.
           */
          await actor.delete();

          assert.notExists(
            game.actors.get(actorId),
            "Deleted Actor should be removed from the world collection"
          );

          actor = null;
        });
      });
    },
    {
      displayName: "WILDPATH: Foundry V14 Runtime Smoke",
      preSelected: true
    }
  );
});
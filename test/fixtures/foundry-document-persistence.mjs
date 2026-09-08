import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {runInNewContext} from "node:vm";
import {withFoundryActorSystem} from "./foundry-actor-system.mjs";
import {registerFoundryV14ConditionStatuses} from "../../module/adapters/foundry-v14-status-effects-adapter.mjs";

function applyUpdates(document, updates) {
  for ( const [path, value] of Object.entries(updates) ) {
    const parts = path.split(".");
    let cursor = document;
    for ( const key of parts.slice(0, -1) ) cursor = cursor[key] ??= {};
    cursor[parts.at(-1)] = structuredClone(value);
  }
}

class EffectDocument {
  constructor(actor, data, calls) {
    Object.assign(this, structuredClone(data));
    this.id = data._id ?? `effect-${actor.effects.size + 1}`;
    this.uuid = `${actor.uuid}.ActiveEffect.${this.id}`;
    this.parent = actor;
    this.statuses = new Set(data.statuses);
    this.calls = calls;
  }
  async update(updates) {
    this.calls.push({method: "ActiveEffect.update", actor: this.parent, updates: structuredClone(updates)});
    applyUpdates(this, updates);
    return this;
  }
  async delete() {
    this.calls.push({method: "ActiveEffect.delete", actor: this.parent});
    if ( this.parent.rejectEffectDeletion ) throw new Error("Synthetic effect deletion rejected");
    this.parent.effects.delete(this.id);
    return this;
  }
  toObject() {
    return structuredClone({_id: this.id, type: this.type, name: this.name, statuses: [...this.statuses],
      system: this.system, flags: this.flags ?? {}, duration: this.duration ?? {}, origin: this.origin ?? null});
  }
}

class EffectCollection extends Map {
  [Symbol.iterator]() { return this.values(); }
}

/** Full resource fields from module/data/fields.mjs, independent synthetic document instances. */
export function foundryDocumentFixture({statusEffects, failPayment=false, failRollback=false, installedApp=null}={}) {
  const calls = [];
  const createActor = (uuid, isToken) => withFoundryActorSystem({id: "qa-actor", uuid, isToken,
    effects: new EffectCollection(),
    system: {resources: Object.fromEntries(["action", "bonus", "reaction", "movement"].map(key => {
      const max = key === "movement" ? 30 : 1;
      return [key, {base: max, bonus: 0, max, value: max, recovery: "turn"}];
    }))},
    async update(updates) {
      calls.push({method: "Actor.update", actor: this, updates: structuredClone(updates)});
      if ( failPayment && this.isToken && updates["system.resources.reaction.value"] === 0 ) {
        throw new Error("Synthetic reaction payment rejected");
      }
      assert.deepEqual(Object.keys(this.system.resources.reaction).sort(), ["base", "bonus", "max", "recovery", "value"]);
      applyUpdates(this, updates);
      return this;
    },
    async createEmbeddedDocuments(name, data) {
      assert.equal(name, "ActiveEffect");
      calls.push({method: "Actor.createEmbeddedDocuments", actor: this});
      return data.map(source => {
        const effect = new EffectDocument(this, source, calls);
        this.effects.set(effect.id, effect);
        return effect;
      });
    },
    async toggleStatusEffect(statusId, {active}={}) {
      calls.push({method: "Actor.toggleStatusEffect", actor: this, statusId});
      // V14.367 indexes the registry by ID before checking this Actor's effects.
      const status = statusEffects[statusId];
      if ( !status ) throw new Error(`Invalid status ID "${statusId}" provided to Actor#toggleStatusEffect`);
      if ( [...this.effects].some(effect => effect.statuses.has(statusId)) ) return true;
      if ( active === false ) return undefined;
      return (await this.createEmbeddedDocuments("ActiveEffect", [{...status, statuses: [statusId]}]))[0];
    }
  });
  const world = createActor("Actor.qa-actor", false);
  const actor = createActor("Scene.qa-scene.Token.qa-token.Actor.qa-actor", true);
  const token = {id: "qa-token", uuid: "Scene.qa-scene.Token.qa-token", actorLink: false, actor, baseActor: world};
  actor.token = token;
  actor.rejectEffectDeletion = failRollback;
  if ( installedApp ) {
    const source = readFileSync(join(installedApp, "client/documents/actor.mjs"), "utf8");
    const start = source.indexOf("  async toggleStatusEffect(");
    const end = source.indexOf("\n  /* -------------------------------------------- */", start);
    assert.ok(start >= 0 && end > start, "Installed Actor must expose the inspected V14 method boundary");
    // Execute the actual installed method without copying Foundry code into the repository.
    const method = runInNewContext(`({${source.slice(start, end)}}).toggleStatusEffect`, {
      CONFIG: {statusEffects}, getDocumentClass: () => ({
        async fromStatusEffect(id) { return {toObject: () => ({...statusEffects[id], statuses: [id]})}; },
        async create(data, {parent}) { return (await parent.createEmbeddedDocuments("ActiveEffect", [data]))[0]; }
      })
    });
    actor.toggleStatusEffect = async function(...args) {
      calls.push({method: "Actor.toggleStatusEffect", actor: this, statusId: args[0]});
      return method.apply(this, args);
    };
  }
  return {actor, world, token, calls};
}

/** Run the startup registry expression/registration itself, without booting unrelated system UI. */
export function startupStatusEffects(register=registerFoundryV14ConditionStatuses, registry={}) {
  const source = readFileSync(new URL("../../wildpath.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  // Populate CONFIG.statusEffects");
  const end = source.indexOf("\n  game.settings.register", start);
  assert.ok(start >= 0 && end > start);
  return import("../../module/config.mjs").then(({WILDPATH}) => {
    const config = {statusEffects: registry};
    runInNewContext(source.slice(start, end), {CONFIG: config, WILDPATH, registerFoundryV14ConditionStatuses: register});
    return config.statusEffects;
  });
}

export function installedStatusRegistry(installedApp) {
  const source = readFileSync(join(installedApp, "client/config.mjs"), "utf8");
  const start = source.indexOf("new Proxy([], {", source.indexOf("export const statusEffects"));
  const end = source.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, "Installed V14 registry must expose the inspected proxy boundary");
  return runInNewContext(source.slice(start, end + 3), {});
}

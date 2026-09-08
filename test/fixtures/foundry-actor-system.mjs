import assert from "node:assert/strict";

export class FakeActorSystemDataModel {
  constructor(system) { Object.assign(this, structuredClone(system)); }
  toJSON() { throw new Error("Serialize the Actor source explicitly instead of the runtime DataModel."); }
}

/** Retain live document behavior while making the state boundary exercise a real prototype. */
export function withFoundryActorSystem(actor) {
  actor.system = new FakeActorSystemDataModel(actor.system);
  actor.sourceSnapshotCalls = [];
  actor.toObject = function(source) {
    assert.equal(source, true);
    this.sourceSnapshotCalls.push(source);
    return {system: structuredClone({...this.system})};
  };
  return actor;
}

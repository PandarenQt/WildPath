import {test} from "node:test";
import assert from "node:assert/strict";
import {noteReason, realGapNotes} from "../module/helpers/conversion-notes.mjs";

test("conversion notes: real gaps are kept, informational ones (narrative, long activation) are not", () => {
  const notes = ["Multiattack: not automated (its attacks are separate Actions)", "not automated (utility, narrative)",
    "Pack Tactics: is passive or triggered (narrative)", "Ray: rolled (utility); what it does is by hand", 7];
  assert.deepEqual(realGapNotes(notes), [notes[0], notes[3]]);
  assert.equal(noteReason(notes[0]), "Multiattack");
  assert.deepEqual(realGapNotes(undefined), []);
});

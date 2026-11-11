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

test("conversion notes: an upcast its data can't express is one real gap, whatever part it names", () => {
  const notes = ["upcast: damage 1 grows every other slot level (by hand)", "Scorching Ray: upcast: the more targets its text gives for each slot level above its own are by hand",
    "upcast: healing grows by \"1d4 + 1\" a slot level (by hand)"];
  assert.deepEqual(notes.map(noteReason), ["upcast by hand", "upcast by hand", "upcast by hand"]);
  assert.deepEqual(realGapNotes(notes), notes);
});

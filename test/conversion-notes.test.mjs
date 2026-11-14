import {test} from "node:test";
import assert from "node:assert/strict";
import {censusDocuments, noteReason, realGapNotes} from "../module/helpers/conversion-notes.mjs";

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

test("conversion notes: what a common-action Action's text adds is a real gap of its own", () => {
  const notes = ["common action: the Magic action of a magic item, as this Action's cost, is by hand",
    "Helpful: common action: Help on an ability check (Assist), as this Action's cost, is by hand"];
  assert.deepEqual(notes.map(noteReason), ["common action: what else its text adds (by hand)", "common action: what else its text adds (by hand)"]);
  assert.deepEqual(realGapNotes(notes), notes);
});

test("conversion notes: Polymorph's form, all else automated, leaves only its anatomy to the GM: informational", () => {
  const note = "transform: a Beast the caster chooses; what the creature may do in its form is by hand";
  assert.equal(noteReason(note), "transform: what its form's anatomy allows (the GM's call)");
  assert.deepEqual(realGapNotes([note, `Polymorph: ${note}`]), []);
});

test("conversion notes: the census counts a copy once and a stat block's feature on its stat block", () => {
  const documents = {
    // Two documents of one name (a subclass's and another's) keep their own keys and are both counted.
    "Psionic Power [aaa]": ["\"Psionic Power\" is passive or triggered: not automated"], "Psionic Power [bbb]": ["upcast: by hand"],
    // A Tinderbox in two packs: one document.
    "Tinderbox [ccc]": ["not automated (utility)"], "Tinderbox [ddd]": ["not automated (utility)"],
    // A stat block and its feature kept on its own: counted on the stat block; one with a note of its own stays.
    "Aboleth [eee]": ["Rampage: not automated (utility)", "Probing Telepathy: x", "Barbed Hide: damage", "Move Earth: z"],
    "Rampage [fff]": ["not automated (utility)"], "Probing Telepathy [ggg]": ["x", "y"],
    // A note already named for its feature.
    "Barbed Hide [hhh]": ["Barbed Hide: damage"],
    // Only named like an Item the stat block holds (a scroll of a spell it casts): its own document, still counted.
    "Move Earth [iii]": ["z"],
    // An older package keyed by name alone.
    "Spider Climb": ["x"]};
  const held = new Map(["fff", "ggg", "hhh"].map(id => [id, documents["Aboleth [eee]"]]));
  assert.deepEqual(censusDocuments(documents, held).map(([key]) => key),
    ["Psionic Power [aaa]", "Psionic Power [bbb]", "Tinderbox [ccc]", "Aboleth [eee]", "Probing Telepathy [ggg]", "Move Earth [iii]", "Spider Climb"]);
  assert.equal(censusDocuments(documents).length, 9, "with no stat block holding any, each but the copy counts");
});

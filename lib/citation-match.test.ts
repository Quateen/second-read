// Unit tests for isStrongCitationMatch (lib/citation-match.ts). Run with `node --test`
// (Node >= 22.6 type stripping) or any node:test-compatible runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStrongCitationMatch } from "./citation-match";

test("fabricated journal does not match a real similar journal (FAB-01)", () => {
  // "Journal of Spinal Neurotrauma" (fake) vs the real "Journal of Neurotrauma".
  assert.equal(isStrongCitationMatch(
    { author: "Kaplan", year: 2021, journal: "Journal of Spinal Neurotrauma" },
    { authors: ["Kaplan RJ"], year: 2021, journal: "Journal of Neurotrauma", title: "An unrelated real paper" }
  ), false);
});

test("abbreviated journal matches its full name", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Fehlings", year: 2012, journal: "J Neurosurg Spine" },
    { authors: ["Fehlings MG"], year: 2012, journal: "Journal of Neurosurgery: Spine" }
  ), true);
});

test("author + year alone does not verify (no journal or title)", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Kaplan", year: 2021 },
    { authors: ["Kaplan RJ"], year: 2021, journal: "Nature", title: "Unrelated" }
  ), false);
});

test("year mismatch beyond +/-1 rejects", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Fehlings", year: 2012, journal: "J Neurosurg Spine" },
    { authors: ["Fehlings MG"], year: 2018, journal: "Journal of Neurosurgery: Spine" }
  ), false);
});

test("author mismatch rejects even with a matching journal", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Kaplan", year: 2021, journal: "Journal of Neurosurgery" },
    { authors: ["Smith AB"], year: 2021, journal: "Journal of Neurosurgery" }
  ), false);
});

test("strong title match verifies when the journal is absent", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Smith", year: 2020, title: "Early decompression in cervical spinal cord injury" },
    { authors: ["Smith AB"], year: 2020, title: "Early Decompression in Cervical Spinal Cord Injury: outcomes" }
  ), true);
});

test("year within +/-1 is tolerated", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Fehlings", year: 2012, journal: "J Neurosurg Spine" },
    { authors: ["Fehlings MG"], year: 2013, journal: "Journal of Neurosurgery: Spine" }
  ), true);
});

test("abbreviated Med-family journals match their full names", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Bracken", year: 1990, journal: "N Engl J Med" },
    { authors: ["Bracken MB"], year: 1990, journal: "The New England journal of medicine" }
  ), true);
  assert.equal(isStrongCitationMatch(
    { author: "Vincent", year: 2006, journal: "Crit Care Med" },
    { authors: ["Vincent JL"], year: 2006, journal: "Critical care medicine" }
  ), true);
});

test("diacritic surname matches an ASCII-folded found author", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Müller", year: 2019, journal: "Lancet" },
    { authors: ["Muller GT"], year: 2019, journal: "The Lancet" }
  ), true);
});

test("volume + first page confirm a title-less citation", () => {
  assert.equal(isStrongCitationMatch(
    { author: "Bracken", year: 1990, volume: "322", firstPage: "1405" },
    { authors: ["Bracken MB"], year: 1990, journal: "Any Journal", volume: "322", firstPage: "1405" }
  ), true);
});

// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../fwa-core.js");

const base = {
  packSize: 20, pricePerPack: 5, priceSourceDate: "2026-01-01",
  billedMode: "packs", billedQty: 2, billedAmount: 10,
  doseMode: "units", dosePerAdmin: 1, freqMode: "everyHours", freqValue: 4,
  durationValue: 5, durationUnit: "days", ref: {}
};
const run = (over) => C.computeReview(Object.assign({}, base, over));

test("illustrative example: 2 packs x 20, 1 tab q4h x 5 days", () => {
  const r = run({});
  assert.equal(r.supplied.units, 40);
  assert.equal(r.expected.dosesPerDay, 6);
  assert.equal(r.expected.units, 30);
  assert.equal(r.difference.units, 10);
  assert.equal(r.difference.minPacks, 2);
  assert.equal(r.price.reference, 10);
  assert.equal(r.price.diff, 0);
  // Excess is explained by pack rounding, so it is info, not a warning.
  assert.ok(r.flags.some((f) => f.level === "info" && /pack-size rounding/.test(f.text)));
  assert.ok(!r.flags.some((f) => f.level === "warn"));
  assert.equal(r.errors.length, 0);
});

test("more packs than needed raises a review flag", () => {
  const r = run({ billedQty: 3, billedAmount: 15 });
  assert.equal(r.supplied.units, 60);
  assert.equal(r.difference.units, 30);
  assert.ok(r.flags.some((f) => f.level === "warn" && /2 pack\(s\) would cover/.test(f.text)));
});

test("billed amount above SFDA reference is flagged with difference and %", () => {
  const r = run({ billedAmount: 12.5 });
  assert.equal(r.price.diff, 2.5);
  assert.equal(C.round(r.price.pct, 1), 25);
  assert.ok(r.flags.some((f) => /above the SFDA reference value/.test(f.text)));
  assert.ok(!r.flags.some((f) => /fraud/i.test(f.text) && !/not a fraud/i.test(f.text)));
});

test("missing prescription details -> insufficient information, no guessing", () => {
  for (const over of [{ dosePerAdmin: null }, { freqMode: "" }, { freqValue: null }, { durationValue: null }]) {
    const r = run(over);
    assert.equal(r.expected.ok, false);
    assert.equal(r.expected.message, "Insufficient information to calculate or assess the prescribed quantity.");
    assert.equal(r.difference.ok, false);
    assert.equal(r.supplied.units, 40); // supply calc still works
  }
});

test("diagnosis alone never produces an expected quantity", () => {
  const r = run({ dosePerAdmin: null, freqMode: "", freqValue: null, durationValue: null, diagnosis: "throat pain" });
  assert.equal(r.expected.ok, false);
  assert.ok(r.notes.some((n) => /context only/.test(n)));
});

test("times per day, per week, weeks duration", () => {
  assert.equal(run({ freqMode: "perDay", freqValue: 3, durationValue: 7 }).expected.units, 21);
  assert.equal(run({ freqMode: "perWeek", freqValue: 1, durationValue: 4, durationUnit: "weeks" }).expected.units, 4);
  assert.equal(run({ freqMode: "perDay", freqValue: 2, durationValue: 2, durationUnit: "weeks" }).expected.units, 28);
});

test("dose by strength converts to units and flags part-units", () => {
  const r = run({ doseMode: "strength", dosePerAdmin: 500, strengthPerUnit: 250, freqMode: "perDay", freqValue: 2, durationValue: 5 });
  assert.equal(r.expected.unitsPerDose, 2);
  assert.equal(r.expected.units, 20);
  const r2 = run({ doseMode: "strength", dosePerAdmin: 375, strengthPerUnit: 250, freqMode: "perDay", freqValue: 2, durationValue: 5 });
  assert.ok(r2.clinical.some((f) => /not a whole unit/.test(f.text)));
  const r3 = run({ doseMode: "strength", dosePerAdmin: 500, strengthPerUnit: null });
  assert.equal(r3.expected.ok, false);
  assert.ok(r3.expected.missing.includes("strength per unit"));
});

test("every N hours not dividing 24 is flagged for interpretation", () => {
  const r = run({ freqValue: 5 });
  assert.equal(C.round(r.expected.dosesPerDay, 3), 4.8);
  assert.ok(r.clinical.some((f) => /does not divide evenly/.test(f.text)));
});

test("PRN: no quantity without max; upper bound with max", () => {
  const a = run({ freqMode: "prn", freqValue: null });
  assert.equal(a.expected.ok, false);
  assert.ok(a.clinical.some((f) => /As-needed/.test(f.text)));
  const b = run({ freqMode: "prn", prnMaxPerDay: 3 });
  assert.equal(b.expected.ok, true);
  assert.equal(b.expected.upperBound, true);
  assert.equal(b.expected.units, 15);
  assert.ok(b.flags.some((f) => /exceed the PRN maximum/.test(f.text)));
});

test("unclear frequency is insufficient and flagged", () => {
  const r = run({ freqMode: "unclear" });
  assert.equal(r.expected.ok, false);
  assert.ok(r.clinical.some((f) => /unclear or variable/.test(f.text)));
});

test("billing in units: part pack flagged and price pro-rated", () => {
  const r = run({ billedMode: "units", billedQty: 30, billedAmount: 7.5 });
  assert.equal(r.supplied.units, 30);
  assert.equal(r.supplied.packs, 1.5);
  assert.equal(r.price.reference, 7.5);
  assert.ok(/pro-rata/.test(r.price.formula));
  assert.ok(r.flags.some((f) => /not a whole number of packs/.test(f.text)));
});

test("price comparison requires the price list date", () => {
  const r = run({ priceSourceDate: "" });
  assert.equal(r.price.ok, false);
  assert.ok(/update date/.test(r.price.message));
});

test("price of zero is allowed, missing billed amount is reported", () => {
  const r = run({ pricePerPack: 0, billedAmount: null });
  assert.equal(r.price.ok, true);
  assert.equal(r.price.reference, 0);
  assert.equal(r.price.billedMissing, true);
});

test("invalid values produce errors and block calculations", () => {
  const r = run({ packSize: -20 });
  assert.ok(r.errors.some((e) => /Pack size must be greater than zero/.test(e)));
  assert.equal(r.supplied.ok, false);
  assert.ok(run({ ageYears: 130 }).errors.length > 0);
  assert.ok(run({ durationValue: 0 }).errors.length > 0);
});

test("pediatric, weight-based reference and max-dose prompts", () => {
  const r = run({ ageYears: 6, ref: { sourceName: "SmPC", url: "https://example.org", date: "2026-01-01", weightBased: true, maxDailyUnits: 4 } });
  assert.ok(r.clinical.some((f) => /under 18/.test(f.text)));
  assert.ok(r.clinical.some((f) => /weight is missing/.test(f.text)));
  assert.ok(r.clinical.some((f) => /above the maximum in the cited reference/.test(f.text)));
  assert.equal(r.reference.cited, true);
});

test("uncited reference is rejected", () => {
  const r = run({ ref: { sourceName: "Some book", maxDailyUnits: 4 } });
  assert.equal(r.reference.cited, false);
  assert.ok(r.errors.some((e) => /source name, link and access\/publication date/.test(e)));
});

test("number parsing", () => {
  assert.equal(C.parseNumber("1,250.5"), 1250.5);
  assert.equal(C.parseNumber("٢٠"), 20);
  assert.equal(C.parseNumber("abc"), null);
  assert.equal(C.parseNumber("1.2.3"), null);
  assert.equal(C.parseNumber(""), null);
  assert.equal(C.parsePrice("SAR 1,234.50"), 1234.5);
  assert.equal(C.parsePrice("12.5 ريال"), 12.5);
  assert.equal(C.parsePrice(""), null);
  assert.equal(C.parsePackSize("20 Tablet"), 20);
  assert.equal(C.parsePackSize("2 x 10"), null);
});

test("CSV parsing: quotes, escaped quotes, CRLF, BOM, semicolons, newlines in quotes", () => {
  const p = C.parseCSV('﻿a,b,c\r\n"x, y","he said ""hi""",3\r\n"multi\nline",,\r\n');
  assert.deepEqual(p.rows, [["a", "b", "c"], ["x, y", 'he said "hi"', "3"], ["multi\nline", "", ""]]);
  assert.equal(C.parseCSV("a;b\n1;2").delimiter, ";");
  assert.equal(C.parseCSV("a\tb\n1\t2").delimiter, "\t");
  assert.throws(() => C.parseCSV('a,b\n"open,2'), /unclosed/);
});

test("sample CSV imports with auto-mapping and warnings", () => {
  const text = fs.readFileSync(path.join(__dirname, "../sample-data/FICTITIOUS-sample-price-list.csv"), "utf8");
  const { rows } = C.parseCSV(text);
  const map = C.autoMap(rows[0]);
  assert.equal(map.tradeName, 0);
  assert.equal(map.scientificName, 1);
  assert.equal(map.strength, 2);
  assert.equal(map.strengthUnit, 3);
  assert.equal(map.dosageForm, 4);
  assert.equal(map.packageSize, 5);
  assert.equal(map.price, 6);
  assert.equal(map.registerNumber, 7);
  const out = C.buildRecords(rows, map);
  assert.equal(out.errors.length, 0);
  assert.equal(out.records.length, 5);
  assert.equal(out.records[0].packageSize, 20);
  assert.equal(out.records[0].strength, "500 mg");
  assert.equal(out.records[1].packageSize, null); // "1 x 30" is ambiguous
  assert.equal(out.records[3].tradeName, "DEMO-Quoted, Name (FICTITIOUS)");
  assert.equal(out.records[3].price, 1250);
  assert.equal(out.records[4].price, null);
  assert.ok(out.warnings.some((w) => /missing or unreadable price/.test(w)));
  assert.ok(out.warnings.some((w) => /not a single number/.test(w)));
  assert.equal(C.searchRecords(out.records, "examplamol").length, 2);
  assert.equal(C.searchRecords(out.records, "examplamol syrup").length, 1);
});

test("auto-mapping does not confuse scientific name with trade name; missing required column errors", () => {
  const map = C.autoMap(["Scientific Name", "Commercial Name", "Price"]);
  assert.equal(map.scientificName, 0);
  assert.notEqual(map.tradeName, 0);
  const out = C.buildRecords([["Scientific Name", "Price"], ["x", "1"]], { tradeName: -1, price: 1 });
  assert.ok(out.errors.some((e) => /Trade \/ medication name/.test(e)));
  const empty = C.buildRecords([["Trade Name", "Price"]], { tradeName: 0, price: 1 });
  assert.ok(empty.errors.some((e) => /no data rows/.test(e)));
});

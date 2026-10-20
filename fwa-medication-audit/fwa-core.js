/*
 * FWA Medication Claim Review — core logic.
 * Pure functions only (no DOM, no network). Loaded by index.html with a plain
 * <script> tag and by the Node tests with require().
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FWACore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var INSUFFICIENT = "Insufficient information to calculate or assess the prescribed quantity.";

  // ---------- number helpers ----------

  // Converts Arabic-Indic / Persian digits and separators to ASCII.
  function normalizeDigits(s) {
    return String(s)
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06f0); })
      .replace(/٫/g, ".")  // Arabic decimal separator
      .replace(/٬/g, ","); // Arabic thousands separator
  }

  // Strict number parser for user-entered fields. Returns null when empty or invalid.
  function parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return isFinite(value) ? value : null;
    var s = normalizeDigits(value).trim();
    if (s === "") return null;
    s = s.replace(/,/g, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  // Lenient parser for price cells such as "SAR 1,234.50" or "12.5 ريال".
  function parsePrice(value) {
    if (value === null || value === undefined) return null;
    var s = normalizeDigits(value).replace(/,/g, "");
    var m = s.match(/[-+]?\d*\.?\d+/g);
    if (!m || m.length !== 1) return null; // none, or ambiguous (several numbers)
    var n = Number(m[0]);
    return isFinite(n) && n >= 0 ? n : null;
  }

  // Pack size cells: accept only an unambiguous single number ("20", "20 Tablet").
  // Values like "2 x 10" are returned as null so the user must confirm them.
  function parsePackSize(value) {
    if (value === null || value === undefined) return null;
    var s = normalizeDigits(value).replace(/,/g, "");
    var m = s.match(/\d*\.?\d+/g);
    if (!m || m.length !== 1) return null;
    var n = Number(m[0]);
    return isFinite(n) && n > 0 ? n : null;
  }

  function round(n, dp) {
    var f = Math.pow(10, dp === undefined ? 2 : dp);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  function fmt(n, dp) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    var r = round(n, dp === undefined ? 2 : dp);
    return r.toLocaleString("en-US", { maximumFractionDigits: dp === undefined ? 2 : dp });
  }

  function fmtSAR(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    return "SAR " + round(n, 2).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function isWhole(n) { return Math.abs(n - Math.round(n)) < 1e-9; }

  // ---------- CSV ----------

  function detectDelimiter(text) {
    var firstLine = text.split(/\r?\n/)[0] || "";
    var counts = { ",": 0, ";": 0, "\t": 0 };
    var inQ = false;
    for (var i = 0; i < firstLine.length; i++) {
      var c = firstLine[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && counts.hasOwnProperty(c)) counts[c]++;
    }
    var best = ",";
    Object.keys(counts).forEach(function (k) { if (counts[k] > counts[best]) best = k; });
    return best;
  }

  // RFC 4180-style parser: quoted fields, escaped quotes, CRLF/LF, newlines in quotes.
  function parseCSV(text, delimiter) {
    if (typeof text !== "string") throw new Error("CSV content is not text.");
    text = text.replace(/^﻿/, "");
    var d = delimiter || detectDelimiter(text);
    var rows = [], row = [], field = "", inQ = false, i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { inQ = true; i++; continue; }
      if (c === d) { row.push(field); field = ""; i++; continue; }
      if (c === "\r" || c === "\n") {
        row.push(field); field = "";
        rows.push(row); row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++; continue;
      }
      field += c; i++;
    }
    if (inQ) throw new Error("CSV has an unclosed quoted field — the file may be truncated or not a valid CSV.");
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return v.trim() !== ""; }); });
    return { delimiter: d, rows: rows };
  }

  // Target fields for column mapping. Synonyms are matched against normalized
  // header text; the user can always override the mapping in the UI.
  var FIELDS = [
    { key: "tradeName", label: "Trade / medication name", required: true,
      synonyms: ["tradename", "trade name", "brand name", "product name", "drug name", "name", "الاسم التجاري"] },
    { key: "scientificName", label: "Scientific name / active ingredient", required: false,
      synonyms: ["scientificname", "scientific name", "active ingredient", "active ingredients", "generic name", "inn", "الاسم العلمي"] },
    { key: "strength", label: "Strength", required: false,
      synonyms: ["strength", "strength value", "dose strength", "التركيز"] },
    { key: "strengthUnit", label: "Strength unit", required: false,
      synonyms: ["strength unit", "strengthunit", "unit of strength", "وحدة التركيز"] },
    { key: "dosageForm", label: "Dosage form", required: false,
      synonyms: ["dosage form", "pharmaceutical form", "form", "dosageform", "الشكل الصيدلاني"] },
    { key: "packageSize", label: "Package size (units per pack)", required: false,
      synonyms: ["package size", "packagesize", "pack size", "packsize", "units per pack", "حجم العبوة"] },
    { key: "price", label: "Price per pack (SAR)", required: true,
      synonyms: ["public price", "price", "retail price", "price sar", "سعر الجمهور", "السعر"] },
    { key: "registerNumber", label: "Register number", required: false,
      synonyms: ["register number", "registernumber", "registration number", "reg no", "رقم التسجيل"] }
  ];

  function normHeader(h) {
    return String(h).replace(/^﻿/, "").toLowerCase().replace(/[_\-./()]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Returns { fieldKey: columnIndex or -1 }. Exact synonym match beats partial match.
  function autoMap(headers) {
    var normed = headers.map(normHeader);
    var used = {};
    var map = {};
    FIELDS.forEach(function (f) {
      var idx = -1;
      for (var s = 0; s < f.synonyms.length && idx < 0; s++) {
        var syn = normHeader(f.synonyms[s]);
        for (var i = 0; i < normed.length; i++) {
          if (!used[i] && normed[i] === syn) { idx = i; break; }
        }
      }
      for (var s2 = 0; s2 < f.synonyms.length && idx < 0; s2++) {
        var syn2 = normHeader(f.synonyms[s2]);
        if (syn2.length < 5) continue; // avoid loose matches like "inn", "name", "form"
        for (var j = 0; j < normed.length; j++) {
          if (!used[j] && normed[j].indexOf(syn2) !== -1) { idx = j; break; }
        }
      }
      if (idx >= 0) used[idx] = true;
      map[f.key] = idx;
    });
    return map;
  }

  // Converts parsed rows into medication records using a column mapping.
  function buildRecords(rows, mapping) {
    var errors = [];
    FIELDS.forEach(function (f) {
      if (f.required && (mapping[f.key] === undefined || mapping[f.key] < 0)) {
        errors.push("Map a column to “" + f.label + "” (required).");
      }
    });
    if (errors.length) return { records: [], errors: errors, warnings: [], skipped: 0 };
    if (rows.length < 2) return { records: [], errors: ["The file has a header row but no data rows."], warnings: [], skipped: 0 };

    var records = [], skipped = 0, noPrice = 0, ambiguousPack = 0;
    function cell(r, key) {
      var idx = mapping[key];
      return idx >= 0 && idx < r.length ? String(r[idx]).trim() : "";
    }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var name = cell(r, "tradeName");
      if (!name) { skipped++; continue; }
      var priceRaw = cell(r, "price");
      var price = parsePrice(priceRaw);
      if (price === null) noPrice++;
      var packRaw = cell(r, "packageSize");
      var pack = parsePackSize(packRaw);
      if (packRaw && pack === null) ambiguousPack++;
      var strength = cell(r, "strength");
      var su = cell(r, "strengthUnit");
      records.push({
        id: i,
        tradeName: name,
        scientificName: cell(r, "scientificName"),
        strength: su && strength.indexOf(su) === -1 ? (strength + " " + su).trim() : strength,
        dosageForm: cell(r, "dosageForm"),
        packageSizeRaw: packRaw,
        packageSize: pack,
        priceRaw: priceRaw,
        price: price,
        registerNumber: cell(r, "registerNumber"),
        sourceRow: i + 1
      });
    }
    var warnings = [];
    if (skipped) warnings.push(skipped + " row(s) skipped because the name was empty.");
    if (noPrice) warnings.push(noPrice + " row(s) have a missing or unreadable price; enter the price manually if you select one.");
    if (ambiguousPack) warnings.push(ambiguousPack + " row(s) have a pack size that is not a single number (e.g. “2 x 10”); confirm the units per pack manually.");
    if (mapping.packageSize === undefined || mapping.packageSize < 0) warnings.push("No package-size column mapped; units per pack must be entered manually.");
    if (!records.length) errors.push("No usable rows found.");
    return { records: records, errors: errors, warnings: warnings, skipped: skipped };
  }

  function searchRecords(records, query, limit) {
    var q = normalizeDigits(query || "").toLowerCase().trim();
    if (!q) return [];
    var terms = q.split(/\s+/);
    var out = [];
    for (var i = 0; i < records.length && out.length < (limit || 50); i++) {
      var r = records[i];
      var hay = (r.tradeName + " " + r.scientificName + " " + r.strength + " " + r.dosageForm + " " + r.registerNumber).toLowerCase();
      if (terms.every(function (t) { return hay.indexOf(t) !== -1; })) out.push(r);
    }
    return out;
  }

  // ---------- review calculation ----------

  /*
   * input fields (all optional unless noted by the calculation that needs them):
   *  medName, activeIngredient, strengthText, dosageForm, unitLabel
   *  packSize, pricePerPack, priceSource ("import" | "manual" | "illustrative"), priceSourceDate, priceSourceName
   *  billedMode ("packs" | "units"), billedQty, billedAmount
   *  doseMode ("units" | "strength"), dosePerAdmin, strengthPerUnit
   *  freqMode ("perDay" | "everyHours" | "perWeek" | "prn" | "unclear"), freqValue, prnMaxPerDay
   *  durationValue, durationUnit ("days" | "weeks")
   *  diagnosis, ageYears, weightKg
   *  ref: { sourceName, url, date, maxDailyUnits, maxDailyStrength, weightBased, notes, conflict }
   */
  function computeReview(input) {
    var res = {
      supplied: null, expected: null, difference: null, price: null,
      flags: [],      // review flags (quantity/price discrepancies)
      clinical: [],   // items needing clinical / pharmacist review
      errors: [],     // invalid values
      notes: []
    };
    function flag(list, level, text) { list.push({ level: level, text: text }); }

    var packSize = input.packSize, billedQty = input.billedQty;

    // Validation of individual values
    function positive(v, label, allowZero) {
      if (v === null || v === undefined) return;
      if (!isFinite(v) || v < 0 || (!allowZero && v === 0)) res.errors.push(label + " must be " + (allowZero ? "zero or more." : "greater than zero."));
    }
    positive(packSize, "Pack size");
    positive(input.pricePerPack, "SFDA price per pack", true);
    positive(billedQty, "Quantity billed");
    positive(input.billedAmount, "Amount billed", true);
    positive(input.dosePerAdmin, "Dose per administration");
    positive(input.strengthPerUnit, "Strength per unit");
    positive(input.freqValue, "Frequency value");
    positive(input.durationValue, "Duration");
    positive(input.ageYears, "Age", true);
    positive(input.weightKg, "Weight");
    if (input.ageYears !== null && input.ageYears !== undefined && input.ageYears > 120) res.errors.push("Age looks invalid (over 120 years).");
    if (input.weightKg !== null && input.weightKg !== undefined && input.weightKg > 400) res.errors.push("Weight looks invalid (over 400 kg).");
    if (input.freqMode === "everyHours" && input.freqValue && input.freqValue > 24 * 7) res.errors.push("“Every N hours” above 168 hours (one week) looks invalid.");
    var bad = res.errors.length > 0;

    // 1) Units supplied
    var s = { needs: ["Pack size", "Quantity billed"], ok: false };
    if (!bad && packSize && billedQty) {
      s.ok = true;
      if (input.billedMode === "units") {
        s.units = billedQty;
        s.packs = billedQty / packSize;
        s.formula = "Quantity billed in units = " + fmt(billedQty) + " (packs equivalent = " + fmt(billedQty) + " ÷ " + fmt(packSize) + " = " + fmt(s.packs, 3) + ")";
        if (!isWhole(s.packs)) flag(res.flags, "info", "Billed quantity is not a whole number of packs (" + fmt(s.packs, 3) + " packs). Check whether part-pack dispensing is allowed under the contract.");
      } else {
        s.packs = billedQty;
        s.units = packSize * billedQty;
        s.formula = "Pack size × packs billed = " + fmt(packSize) + " × " + fmt(billedQty) + " = " + fmt(s.units);
        if (!isWhole(billedQty)) flag(res.flags, "info", "Number of packs billed is not a whole number (" + fmt(billedQty) + ").");
      }
    }
    res.supplied = s;

    // 2) Expected units from the prescription
    var e = { needs: ["Dose per administration", "Frequency (calculable)", "Duration"], ok: false, upperBound: false };
    if (input.doseMode === "strength") e.needs.push("Strength per unit");
    var unitsPerDose = null;
    if (input.dosePerAdmin) {
      if (input.doseMode === "strength") {
        if (input.strengthPerUnit) {
          unitsPerDose = input.dosePerAdmin / input.strengthPerUnit;
          e.doseFormula = "Units per dose = prescribed dose ÷ strength per unit = " + fmt(input.dosePerAdmin) + " ÷ " + fmt(input.strengthPerUnit) + " = " + fmt(unitsPerDose, 3);
          if (!isWhole(unitsPerDose)) flag(res.clinical, "warn", "Prescribed dose works out to " + fmt(unitsPerDose, 3) + " units per dose (not a whole unit). Splitting or measuring may be needed — pharmacist review.");
        }
      } else {
        unitsPerDose = input.dosePerAdmin;
        e.doseFormula = "Units per dose (as prescribed) = " + fmt(unitsPerDose, 3);
      }
    }

    var dosesPerDay = null, freqText = "";
    switch (input.freqMode) {
      case "perDay":
        if (input.freqValue) { dosesPerDay = input.freqValue; freqText = fmt(input.freqValue) + " time(s) per day"; }
        break;
      case "everyHours":
        if (input.freqValue) {
          dosesPerDay = 24 / input.freqValue;
          freqText = "every " + fmt(input.freqValue) + " hours → 24 ÷ " + fmt(input.freqValue) + " = " + fmt(dosesPerDay, 3) + " doses per 24 hours (arithmetic assumption: doses evenly spaced around the clock)";
          if (!isWhole(dosesPerDay)) flag(res.clinical, "warn", "“Every " + fmt(input.freqValue) + " hours” does not divide evenly into 24 hours (" + fmt(dosesPerDay, 3) + " doses/day). The exact number of doses depends on timing — interpretation needed.");
        }
        break;
      case "perWeek":
        if (input.freqValue) { dosesPerDay = input.freqValue / 7; freqText = fmt(input.freqValue) + " time(s) per week → " + fmt(input.freqValue) + " ÷ 7 = " + fmt(dosesPerDay, 3) + " doses per day"; }
        break;
      case "prn":
        flag(res.clinical, "warn", "As-needed (PRN) dosing: actual use varies, so an exact expected quantity cannot be calculated." + (input.prnMaxPerDay ? " A maximum is shown using the stated daily limit." : " Enter the prescribed maximum doses per day, if stated, to calculate an upper bound."));
        if (input.prnMaxPerDay) {
          dosesPerDay = input.prnMaxPerDay;
          e.upperBound = true;
          freqText = "as needed, up to " + fmt(input.prnMaxPerDay) + " time(s) per day (upper bound)";
        }
        break;
      case "unclear":
        flag(res.clinical, "warn", "Prescription frequency recorded as unclear or variable — clarify with the prescriber or pharmacist.");
        break;
    }
    if (input.prnMaxPerDay !== null && input.prnMaxPerDay !== undefined && input.freqMode === "prn" && !(input.prnMaxPerDay > 0)) {
      res.errors.push("PRN maximum doses per day must be greater than zero.");
      bad = true;
    }

    var days = null;
    if (input.durationValue) {
      days = input.durationUnit === "weeks" ? input.durationValue * 7 : input.durationValue;
      e.durationText = input.durationUnit === "weeks" ? fmt(input.durationValue) + " week(s) = " + fmt(days) + " days" : fmt(days) + " day(s)";
    }

    if (!bad && unitsPerDose && dosesPerDay && days) {
      e.ok = true;
      e.unitsPerDose = unitsPerDose;
      e.dosesPerDay = dosesPerDay;
      e.days = days;
      e.freqText = freqText;
      e.units = unitsPerDose * dosesPerDay * days;
      e.formula = "Units per dose × doses per day × days = " + fmt(unitsPerDose, 3) + " × " + fmt(dosesPerDay, 3) + " × " + fmt(days) + " = " + fmt(e.units, 2);
      e.dailyUnits = unitsPerDose * dosesPerDay;
    } else {
      e.message = INSUFFICIENT;
      var missing = [];
      if (!input.dosePerAdmin) missing.push("dose per administration");
      if (input.doseMode === "strength" && !input.strengthPerUnit) missing.push("strength per unit");
      if (!dosesPerDay) missing.push(input.freqMode === "prn" ? "maximum doses per day (PRN)" : input.freqMode === "unclear" ? "a calculable frequency" : "frequency");
      if (!days) missing.push("duration");
      e.missing = missing;
    }
    res.expected = e;

    // 3) Difference
    var d = { needs: ["Units supplied", "Expected units"], ok: false };
    if (s.ok && e.ok) {
      d.ok = true;
      d.units = s.units - e.units;
      d.formula = "Units supplied − expected units = " + fmt(s.units) + " − " + fmt(e.units) + " = " + (d.units > 0 ? "+" : "") + fmt(d.units);
      if (packSize) {
        d.minPacks = Math.ceil(round(e.units / packSize, 6));
        d.minPacksFormula = "Smallest whole number of packs covering the expected units = ⌈" + fmt(e.units) + " ÷ " + fmt(packSize) + "⌉ = " + d.minPacks;
      }
      if (d.units > 1e-9) {
        if (e.upperBound) {
          flag(res.flags, "warn", "Review flag: units supplied exceed the PRN maximum for the stated duration by " + fmt(d.units) + " units.");
        } else if (s.packs !== undefined && d.minPacks !== undefined && s.packs > d.minPacks + 1e-9) {
          flag(res.flags, "warn", "Review flag: " + fmt(s.packs, 3) + " pack(s) billed, but " + d.minPacks + " pack(s) would cover the prescription. Supplied quantity exceeds expected by " + fmt(d.units) + " units.");
        } else {
          flag(res.flags, "info", "Supplied exceeds expected by " + fmt(d.units) + " units, but no fewer whole packs would cover the prescription — the excess is consistent with pack-size rounding.");
        }
      } else if (d.units < -1e-9) {
        flag(res.flags, "info", "Supplied is " + fmt(-d.units) + " units less than expected for the full course. May reflect partial dispensing or a refill — check claim history.");
      } else {
        flag(res.flags, "ok", "Units supplied match the expected units.");
      }
    }
    res.difference = d;

    // 4) SFDA reference value and billed amount
    var p = { needs: ["SFDA price per pack", "Price list update date", "Packs billed (or units billed + pack size)"], ok: false };
    var packsForPrice = s.ok ? s.packs : (input.billedMode !== "units" ? billedQty : null);
    var priceVal = input.pricePerPack;
    var hasPrice = priceVal !== null && priceVal !== undefined && isFinite(priceVal);
    if (!bad && hasPrice && packsForPrice && input.priceSourceDate) {
      p.ok = true;
      p.reference = priceVal * packsForPrice;
      p.formula = "SFDA price per pack × packs = " + fmtSAR(priceVal) + " × " + fmt(packsForPrice, 3) + " = " + fmtSAR(p.reference);
      if (!isWhole(packsForPrice)) p.formula += " (pro-rata for a part pack — assumption)";
      if (input.billedAmount !== null && input.billedAmount !== undefined && isFinite(input.billedAmount)) {
        p.billed = input.billedAmount;
        p.diff = round(input.billedAmount - p.reference, 2);
        p.pct = p.reference > 0 ? (p.diff / p.reference) * 100 : null;
        p.diffFormula = "Amount billed − SFDA reference value = " + fmtSAR(input.billedAmount) + " − " + fmtSAR(p.reference) + " = " + (p.diff > 0 ? "+" : "") + fmtSAR(p.diff) + (p.pct !== null ? " (" + (p.diff > 0 ? "+" : "") + fmt(p.pct, 1) + "%)" : "");
        if (p.diff > 0) flag(res.flags, "warn", "Review flag: amount billed is " + fmtSAR(p.diff) + " above the SFDA reference value. Check VAT, dispensing fees, discounts and contract terms before drawing conclusions.");
        else if (p.diff < 0) flag(res.flags, "info", "Amount billed is " + fmtSAR(-p.diff) + " below the SFDA reference value.");
        else flag(res.flags, "ok", "Amount billed equals the SFDA reference value.");
      } else {
        p.billedMissing = true;
      }
    } else if (hasPrice && packsForPrice && !input.priceSourceDate) {
      p.message = "Enter the SFDA price list update date (or the date you downloaded it) before using this price as a reference.";
    }
    res.price = p;

    // 5) Clinical review prompts
    if (input.ageYears !== null && input.ageYears !== undefined && input.ageYears < 18) {
      flag(res.clinical, "warn", "Patient is under 18: pediatric dosing is often weight- or age-based. Clinical/pharmacist review is needed to interpret the dose." + (input.weightKg ? "" : " Weight was not provided."));
    }
    var ref = input.ref || {};
    var refHasAny = ref.maxDailyUnits || ref.maxDailyStrength || ref.notes || ref.sourceName || ref.url;
    if (refHasAny) {
      var cited = !!(ref.sourceName && ref.url && ref.date);
      res.reference = { cited: cited };
      if (!cited) {
        res.errors.push("External dosing reference: source name, link and access/publication date are all required before the reference can be shown.");
      } else {
        if (ref.weightBased && !input.weightKg) flag(res.clinical, "warn", "The cited reference is weight-based but patient weight is missing — cannot compare.");
        if (ref.conflict) flag(res.clinical, "warn", "Sources were marked as conflicting — clinical/pharmacist review required.");
        if (e.ok && ref.maxDailyUnits && e.dailyUnits > ref.maxDailyUnits + 1e-9) {
          flag(res.clinical, "warn", "Prescribed daily amount (" + fmt(e.dailyUnits, 3) + " units/day) is above the maximum in the cited reference (" + fmt(ref.maxDailyUnits) + " units/day). Clinical review — not a fraud finding.");
        }
        if (e.ok && ref.maxDailyStrength && input.strengthPerUnit) {
          var dailyStrength = e.dailyUnits * input.strengthPerUnit;
          if (dailyStrength > ref.maxDailyStrength + 1e-9) {
            flag(res.clinical, "warn", "Prescribed daily dose (" + fmt(dailyStrength) + " per day, by strength) is above the maximum in the cited reference (" + fmt(ref.maxDailyStrength) + "). Clinical review — not a fraud finding.");
          }
        } else if (e.ok && ref.maxDailyStrength && !input.strengthPerUnit) {
          flag(res.clinical, "info", "Enter strength per unit to compare against the reference maximum daily dose by strength.");
        }
      }
    }
    if (input.diagnosis) res.notes.push("Diagnosis/indication is shown for context only. It is not used to infer any dose, frequency or duration.");

    return res;
  }

  return {
    INSUFFICIENT: INSUFFICIENT,
    FIELDS: FIELDS,
    normalizeDigits: normalizeDigits,
    parseNumber: parseNumber,
    parsePrice: parsePrice,
    parsePackSize: parsePackSize,
    parseCSV: parseCSV,
    detectDelimiter: detectDelimiter,
    autoMap: autoMap,
    buildRecords: buildRecords,
    searchRecords: searchRecords,
    computeReview: computeReview,
    fmt: fmt,
    fmtSAR: fmtSAR,
    round: round
  };
});

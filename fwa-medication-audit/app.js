/* FWA Medication Claim Review — UI wiring. No network calls; all data stays in the page. */
(function () {
  "use strict";
  var C = window.FWACore;
  var STORE_KEY = "fwa.sfdaPriceList.v1";

  var state = {
    parsed: null,       // { fileName, headers, rows }
    records: [],
    listMeta: null,     // { fileName, date, url, count, importedAt }
    selected: null,
    prov: {},           // field id -> "sfda" | "edited" | "example"
    example: false
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function show(el, on) { el.hidden = !on; }
  function setMsg(el, items) {
    if (!items || !items.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.innerHTML = items.length === 1 ? esc(items[0]) : "<ul>" + items.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>";
    el.hidden = false;
  }

  // ================= CSV import =================

  $("csv-file").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    setMsg($("import-errors"), []);
    show($("mapping"), false);
    if (!file) return;
    if (/\.(xlsx?|xlsm|ods)$/i.test(file.name)) {
      setMsg($("import-errors"), ["This looks like a spreadsheet file (" + file.name + "). Open it in Excel or LibreOffice and save it as “CSV UTF-8”, then import the CSV."]);
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setMsg($("import-errors"), ["File is larger than 50 MB. Please check it is the SFDA price list CSV."]);
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { setMsg($("import-errors"), ["The file could not be read."]); };
    reader.onload = function () {
      var text = String(reader.result || "");
      if (text.indexOf("�") !== -1) {
        // Probably not UTF-8 (e.g. Windows-1256 Arabic). Retry with that encoding.
        var r2 = new FileReader();
        r2.onload = function () { handleText(String(r2.result || ""), file.name, true); };
        r2.readAsText(file, "windows-1256");
      } else {
        handleText(text, file.name, false);
      }
    };
    reader.readAsText(file, "utf-8");
  });

  function handleText(text, fileName, reEncoded) {
    var parsed;
    try { parsed = C.parseCSV(text); }
    catch (e) { setMsg($("import-errors"), [e.message]); return; }
    if (!parsed.rows.length) { setMsg($("import-errors"), ["The file is empty."]); return; }
    var headers = parsed.rows[0].map(function (h, i) { return h.trim() || "Column " + (i + 1); });
    if (headers.length < 2) {
      setMsg($("import-errors"), ["Only one column was found. The file may use an unexpected separator or not be a CSV."]);
      return;
    }
    state.parsed = { fileName: fileName, headers: headers, rows: parsed.rows };
    var warn = [];
    if (reEncoded) warn.push("The file was not valid UTF-8 and was read as Windows-1256 (Arabic). Check that names display correctly in the preview.");
    renderMapping(C.autoMap(headers), warn);
  }

  function renderMapping(map, warn) {
    var p = state.parsed;
    var opts = '<option value="-1">— not in file —</option>' + p.headers.map(function (h, i) {
      return '<option value="' + i + '">' + esc(h) + "</option>";
    }).join("");
    $("mapping-grid").innerHTML = C.FIELDS.map(function (f) {
      return '<div class="field"><label for="map-' + f.key + '">' + esc(f.label) + (f.required ? " *" : "") + "</label>" +
        '<select id="map-' + f.key + '" data-key="' + f.key + '">' + opts + "</select></div>";
    }).join("");
    C.FIELDS.forEach(function (f) { $("map-" + f.key).value = String(map[f.key]); });

    var rows = p.rows.slice(0, 6);
    $("preview-table").innerHTML = "<thead><tr>" + p.headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.slice(1).map(function (r) { return "<tr>" + p.headers.map(function (_, i) { return "<td>" + esc(r[i] || "") + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody>";
    $("preview-table").setAttribute("aria-label", "Preview of " + p.fileName + ", " + (p.rows.length - 1) + " data rows");
    setMsg($("mapping-warnings"), warn || []);
    $("btn-import").hidden = false;
    show($("mapping"), true);
  }

  function currentMapping() {
    var m = {};
    C.FIELDS.forEach(function (f) { m[f.key] = parseInt($("map-" + f.key).value, 10); });
    return m;
  }

  $("btn-import").addEventListener("click", function () {
    var errs = [];
    var mapping = currentMapping();
    var seen = {};
    Object.keys(mapping).forEach(function (k) {
      var i = mapping[k];
      if (i >= 0) { if (seen[i]) errs.push("Column “" + state.parsed.headers[i] + "” is mapped to more than one field."); seen[i] = true; }
    });
    var date = $("list-date").value;
    if (!date) errs.push("Enter the SFDA list update date (or the date you downloaded the file).");
    var url = $("list-url").value.trim();
    if (url && !/^https?:\/\//i.test(url)) errs.push("Source link must start with http:// or https://.");
    var built = C.buildRecords(state.parsed.rows, mapping);
    errs = errs.concat(built.errors);
    if (errs.length) { setMsg($("import-errors"), errs); return; }
    setMsg($("import-errors"), []);
    state.records = built.records;
    state.listMeta = { fileName: state.parsed.fileName, date: date, url: url, count: built.records.length, importedAt: new Date().toISOString() };
    setMsg($("mapping-warnings"), built.warnings);
    show($("mapping"), built.warnings.length > 0);
    $("btn-import").hidden = built.warnings.length > 0;
    afterListLoaded(false);
  });

  function afterListLoaded(fromStorage) {
    var m = state.listMeta;
    $("list-status-text").innerHTML = "<strong>" + m.count.toLocaleString("en-US") + "</strong> medications loaded from <strong>" + esc(m.fileName) +
      "</strong>. SFDA list date: <strong>" + esc(m.date) + "</strong>" + (fromStorage ? " (restored from this browser)" : "") + ".";
    show($("list-status"), true);
    $("remember-list").checked = fromStorage;
    $("med-search").disabled = false;
    $("med-search").placeholder = "Type a trade name, active ingredient or register number";
  }

  $("remember-list").addEventListener("change", function (ev) {
    try {
      if (ev.target.checked) {
        localStorage.setItem(STORE_KEY, JSON.stringify({ meta: state.listMeta, records: state.records }));
      } else {
        localStorage.removeItem(STORE_KEY);
      }
    } catch (e) {
      ev.target.checked = false;
      alert("The price list could not be saved in this browser (it may be too large, or storage is blocked). It will stay loaded until you close the page.");
    }
  });

  $("btn-clear-list").addEventListener("click", function () {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    state.records = []; state.listMeta = null; state.parsed = null;
    $("csv-file").value = "";
    show($("list-status"), false); show($("mapping"), false);
    $("btn-import").hidden = false;
    $("med-search").value = ""; $("med-search").disabled = true; $("med-search").placeholder = "Import a CSV first";
    show($("search-results"), false);
    update();
  });

  function restoreList() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.meta && Array.isArray(data.records) && data.records.length) {
        state.records = data.records; state.listMeta = data.meta;
        afterListLoaded(true);
      }
    } catch (e) { /* storage unavailable or corrupt: start without it */ }
  }

  // ================= Search & selection =================

  var SFDA_FIELDS = ["medName", "activeIngredient", "strengthText", "dosageForm", "packSize", "pricePerPack", "priceSourceDate"];

  $("med-search").addEventListener("input", function (ev) {
    var hits = C.searchRecords(state.records, ev.target.value, 30);
    var ul = $("search-results");
    if (!ev.target.value.trim()) { show(ul, false); return; }
    ul.innerHTML = hits.length ? hits.map(function (r, i) {
      return '<li role="option"><button type="button" data-i="' + i + '"><strong>' + esc(r.tradeName) + "</strong> " +
        '<span class="muted">' + esc([r.scientificName, r.strength, r.dosageForm].filter(Boolean).join(" · ")) + "</span>" +
        '<span class="sr-meta">Pack: ' + esc(r.packageSizeRaw || "—") + " · " + (r.price !== null ? esc(C.fmtSAR(r.price)) : "price missing") + "</span></button></li>";
    }).join("") : '<li class="muted empty">No matches.</li>';
    ul._hits = hits;
    show(ul, true);
  });

  $("search-results").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-i]");
    if (!btn) return;
    selectRecord(this._hits[Number(btn.getAttribute("data-i"))]);
  });

  function selectRecord(r) {
    state.selected = r;
    state.example = false;
    var vals = {
      medName: r.tradeName, activeIngredient: r.scientificName, strengthText: r.strength, dosageForm: r.dosageForm,
      packSize: r.packageSize !== null ? String(r.packageSize) : "",
      pricePerPack: r.price !== null ? String(r.price) : "",
      priceSourceDate: state.listMeta ? state.listMeta.date : ""
    };
    SFDA_FIELDS.forEach(function (k) { $(k).value = vals[k] || ""; state.prov[k] = vals[k] ? "sfda" : undefined; });
    $("packSize-raw").textContent = r.packageSizeRaw && r.packageSize === null
      ? "SFDA value “" + r.packageSizeRaw + "” is not a single number — enter units per pack manually."
      : (r.packageSizeRaw ? "SFDA package value: “" + r.packageSizeRaw + "”" : "No pack size in file — enter manually.");
    $("selected-record").innerHTML = "Selected from SFDA list (row " + r.sourceRow + (r.registerNumber ? ", register no. " + esc(r.registerNumber) : "") + "). " +
      "Fields filled from the list are tagged <span class='prov-tag prov-sfda'>SFDA</span>; editing one changes its tag to <span class='prov-tag prov-edited'>Edited</span>.";
    show($("selected-record"), true);
    show($("search-results"), false);
    $("med-search").value = r.tradeName;
    update();
  }

  // ================= Form reading =================

  var NUMERIC = ["packSize", "pricePerPack", "billedQty", "billedAmount", "dosePerAdmin", "strengthPerUnit", "freqValue", "prnMaxPerDay",
    "durationValue", "ageYears", "weightKg", "refMaxDailyUnits", "refMaxDailyStrength"];
  var LABELS = {
    packSize: "Pack size", pricePerPack: "SFDA price per pack", billedQty: "Quantity billed", billedAmount: "Amount billed",
    dosePerAdmin: "Dose per administration", strengthPerUnit: "Strength per unit", freqValue: "Frequency value",
    prnMaxPerDay: "PRN maximum per day", durationValue: "Duration", ageYears: "Age", weightKg: "Weight",
    refMaxDailyUnits: "Reference max daily units", refMaxDailyStrength: "Reference max daily dose"
  };

  function radio(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ""; }

  function readInput() {
    var parseErrors = [];
    var num = {};
    NUMERIC.forEach(function (id) {
      var el = $(id);
      var raw = el.value.trim();
      var hiddenField = el.closest("[hidden]");
      var n = hiddenField ? null : C.parseNumber(raw);
      var invalid = !hiddenField && raw !== "" && n === null;
      el.setAttribute("aria-invalid", invalid ? "true" : "false");
      if (invalid) parseErrors.push(LABELS[id] + ": “" + raw + "” is not a valid number.");
      num[id] = n;
    });
    var date = $("priceSourceDate").value.trim();
    return {
      parseErrors: parseErrors,
      input: {
        medName: $("medName").value.trim(), activeIngredient: $("activeIngredient").value.trim(),
        strengthText: $("strengthText").value.trim(), dosageForm: $("dosageForm").value.trim(), unitLabel: $("unitLabel").value,
        packSize: num.packSize, pricePerPack: num.pricePerPack, priceSourceDate: date,
        billedMode: radio("billedMode"), billedQty: num.billedQty, billedAmount: num.billedAmount,
        doseMode: radio("doseMode"), dosePerAdmin: num.dosePerAdmin, strengthPerUnit: num.strengthPerUnit,
        freqMode: $("freqMode").value, freqValue: num.freqValue, prnMaxPerDay: num.prnMaxPerDay,
        durationValue: num.durationValue, durationUnit: $("durationUnit").value,
        diagnosis: $("diagnosis").value.trim(), ageYears: num.ageYears, weightKg: num.weightKg,
        ref: {
          sourceName: $("refSource").value.trim(), url: $("refUrl").value.trim(), date: $("refDate").value,
          maxDailyUnits: num.refMaxDailyUnits, maxDailyStrength: num.refMaxDailyStrength,
          weightBased: $("refWeightBased").checked, conflict: $("refConflict").checked, notes: $("refNotes").value.trim()
        }
      }
    };
  }

  // ================= Rendering =================

  function provTag(id) {
    var p = state.prov[id];
    if (state.example && p === "example") return '<span class="prov-tag prov-example">Illustrative</span>';
    if (p === "sfda") return '<span class="prov-tag prov-sfda">SFDA</span>';
    if (p === "edited") return '<span class="prov-tag prov-edited">Edited</span>';
    return '<span class="prov-tag prov-manual">Manual</span>';
  }

  function row(label, value, tag) {
    var empty = value === null || value === undefined || value === "";
    return "<tr><th scope='row'>" + esc(label) + "</th><td>" + (empty ? '<span class="muted">not entered</span>' : esc(value)) + "</td><td>" + (empty ? "" : tag || "") + "</td></tr>";
  }

  function needsList(needs) { return '<p class="needs">Needs: ' + needs.map(esc).join(", ") + "</p>"; }

  function flagList(items, empty) {
    if (!items.length) return '<p class="muted">' + esc(empty) + "</p>";
    return '<ul class="flags">' + items.map(function (f) { return '<li class="flag flag-' + f.level + '">' + esc(f.text) + "</li>"; }).join("") + "</ul>";
  }

  var FREQ_TEXT = { perDay: "times per day", everyHours: "every N hours", perWeek: "times per week", prn: "as needed (PRN)", unclear: "unclear / variable" };

  function render(input, res, parseErrors) {
    var u = input.unitLabel || "units";
    var F = C.fmt;
    var h = "";

    var errors = parseErrors.concat(res.errors);
    if (errors.length) {
      h += '<div class="msg msg-error" role="alert"><strong>Please correct:</strong><ul>' + errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div>";
    }

    // --- Values used ---
    var m = state.listMeta;
    var srcLine = state.example ? "Illustrative example (not SFDA data)"
      : state.selected && m ? "SFDA list file “" + m.fileName + "”" + (m.url ? " — " + m.url : "")
      : "Entered manually";
    h += '<h3><span class="tag tag-source">Official source data</span> Medication &amp; SFDA price</h3>';
    h += '<table class="kv"><tbody>' +
      row("Medication", input.medName, provTag("medName")) +
      row("Active ingredient", input.activeIngredient, provTag("activeIngredient")) +
      row("Strength", input.strengthText, provTag("strengthText")) +
      row("Dosage form", input.dosageForm, provTag("dosageForm")) +
      row("Pack size", input.packSize !== null ? F(input.packSize) + " " + u : "", provTag("packSize")) +
      row("SFDA price per pack", input.pricePerPack !== null ? C.fmtSAR(input.pricePerPack) : "", provTag("pricePerPack")) +
      row("Price list date", input.priceSourceDate, provTag("priceSourceDate")) +
      row("Price source", srcLine, "") +
      "</tbody></table>";

    var rx = "";
    if (input.dosePerAdmin !== null) rx = F(input.dosePerAdmin, 3) + (input.doseMode === "strength" ? " (amount per dose)" : " " + u + " per dose");
    var fq = input.freqMode === "everyHours" && input.freqValue !== null ? "every " + F(input.freqValue) + " hours" :
      input.freqMode ? FREQ_TEXT[input.freqMode] + (input.freqValue !== null && /perDay|perWeek/.test(input.freqMode) ? ": " + F(input.freqValue) : "") +
      (input.freqMode === "prn" && input.prnMaxPerDay !== null ? ", max " + F(input.prnMaxPerDay) + "/day" : "") : "";
    h += '<h3><span class="tag tag-claim">Claim data</span> Entered by reviewer</h3>';
    h += '<table class="kv"><tbody>' +
      row("Quantity billed", input.billedQty !== null ? F(input.billedQty, 3) + " " + (input.billedMode === "units" ? u : "pack(s)") : "") +
      row("Amount billed", input.billedAmount !== null ? C.fmtSAR(input.billedAmount) : "") +
      row("Dose per administration", rx) +
      row("Strength per unit", input.strengthPerUnit !== null ? F(input.strengthPerUnit) : "") +
      row("Frequency", fq) +
      row("Duration", input.durationValue !== null ? F(input.durationValue) + " " + input.durationUnit : "") +
      row("Diagnosis / indication (context only)", input.diagnosis) +
      row("Age / weight", [input.ageYears !== null ? F(input.ageYears) + " years" : "", input.weightKg !== null ? F(input.weightKg) + " kg" : ""].filter(Boolean).join(", ")) +
      "</tbody></table>";

    // --- Calculations ---
    h += '<h3><span class="tag tag-calc">Calculated</span> Results</h3>';
    var s = res.supplied, e = res.expected, d = res.difference, p = res.price;

    h += '<div class="calc"><h4>Units supplied</h4>' + needsList(s.needs);
    h += s.ok ? '<p class="formula">' + esc(s.formula) + '</p><p class="result">' + F(s.units) + " " + esc(u) + "</p>"
      : '<p class="insufficient">Enter pack size and quantity billed.</p>';
    h += "</div>";

    h += '<div class="calc"><h4>Expected units for the prescription' + (e.upperBound ? " (upper bound)" : "") + "</h4>" + needsList(e.needs);
    if (e.ok) {
      h += '<ul class="steps">' + (e.doseFormula ? "<li>" + esc(e.doseFormula) + "</li>" : "") +
        "<li>Frequency: " + esc(e.freqText) + "</li><li>Duration: " + esc(e.durationText) + "</li></ul>" +
        '<p class="formula">' + esc(e.formula) + '</p><p class="result">' + F(e.units) + " " + esc(u) + "</p>" +
        '<p class="muted small">Quantity arithmetic only. It does not check whether this regimen is clinically appropriate.</p>';
    } else {
      h += '<p class="insufficient">' + esc(e.message) + "</p>" + (e.missing && e.missing.length ? '<p class="muted small">Missing: ' + esc(e.missing.join(", ")) + ".</p>" : "");
    }
    h += "</div>";

    h += '<div class="calc"><h4>Difference</h4>' + needsList(d.needs);
    if (d.ok) {
      h += '<p class="formula">' + esc(d.formula) + "</p>" + (d.minPacksFormula ? '<p class="formula">' + esc(d.minPacksFormula) + "</p>" : "") +
        '<p class="result">' + (d.units > 0 ? "+" : "") + F(d.units) + " " + esc(u) + "</p>";
    } else {
      h += '<p class="insufficient">Needs both results above.</p>';
    }
    h += "</div>";

    h += '<div class="calc"><h4>SFDA reference value &amp; amount billed</h4>' + needsList(p.needs.concat(["Amount billed (for the comparison)"]));
    if (p.ok) {
      h += '<p class="formula">' + esc(p.formula) + '</p><p class="result">' + esc(C.fmtSAR(p.reference)) + "</p>";
      h += p.billedMissing ? '<p class="insufficient">Enter the amount billed to compare it with the reference value.</p>'
        : '<p class="formula">' + esc(p.diffFormula) + "</p>";
      h += '<p class="muted small">The SFDA price is a published reference price. Billed amounts may legitimately differ (e.g. VAT, dispensing fees, contracted discounts).</p>';
    } else {
      h += '<p class="insufficient">' + esc(p.message || "Enter the SFDA price per pack, the price list date and the quantity billed.") + "</p>";
    }
    h += "</div>";

    // --- Flags ---
    h += '<h3>Review flags <span class="muted small">(discrepancies to look into, not findings)</span></h3>' + flagList(res.flags, "No review flags from the values entered.");
    h += "<h3>Needs clinical / pharmacist review</h3>" + flagList(res.clinical, "No clinical-review prompts from the values entered. This does not mean the regimen has been checked.");

    // --- External reference ---
    if (res.reference && res.reference.cited) {
      var r = input.ref;
      h += '<div class="refbox"><h3><span class="tag tag-ref">External reference</span> Not the prescription</h3>' +
        '<p><strong>Source:</strong> ' + esc(r.sourceName) + '<br><strong>Link:</strong> <a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.url) + "</a>" +
        "<br><strong>Accessed/published:</strong> " + esc(r.date) + "</p>" +
        (r.maxDailyUnits !== null ? "<p>Reference maximum daily amount: " + F(r.maxDailyUnits) + " " + esc(u) + "/day</p>" : "") +
        (r.maxDailyStrength !== null ? "<p>Reference maximum daily dose by strength: " + F(r.maxDailyStrength) + "</p>" : "") +
        (r.notes ? '<p><strong>Relevant text &amp; assumptions:</strong> ' + esc(r.notes) + "</p>" : '<p class="msg msg-warn">No assumptions recorded. State the population, age/weight band and indication the reference applies to.</p>') +
        (r.weightBased ? "<p>Reference is weight-based.</p>" : "") +
        '<p class="muted small">Entered by the reviewer. Confirm it matches this product, strength, patient and indication. A clinician or pharmacist must interpret any difference.</p></div>';
    }
    if (res.notes.length) h += '<p class="muted small">' + res.notes.map(esc).join(" ") + "</p>";

    $("results-body").innerHTML = h;
    $("gen-time").textContent = new Date().toLocaleString();
    show($("example-banner"), state.example);
  }

  function update() {
    Array.prototype.forEach.call(document.querySelectorAll(".prov[data-for]"), function (el) {
      el.innerHTML = state.prov[el.getAttribute("data-for")] ? provTag(el.getAttribute("data-for")) : "";
    });
    var r = readInput();
    var res = C.computeReview(r.input);
    render(r.input, res, r.parseErrors);
  }

  // ================= Form behaviour =================

  function syncFreqUI() {
    var mode = $("freqMode").value;
    var labels = { perDay: "Times per day", everyHours: "Every N hours — N =", perWeek: "Times per week" };
    show($("freq-value-field"), !!labels[mode]);
    $("freqValue-label").textContent = labels[mode] || "Value";
    show($("prn-max-field"), mode === "prn");
    var u = $("unitLabel").value;
    $("dose-unit-hint").textContent = radio("doseMode") === "strength" ? "(e.g. mg — same unit as strength per unit)" : "(in " + u + ")";
  }

  var form = $("review-form");
  form.addEventListener("input", function (ev) {
    var id = ev.target.id;
    if (SFDA_FIELDS.indexOf(id) !== -1 && state.prov[id] === "sfda") state.prov[id] = "edited";
    if (id === "med-search") return;
    syncFreqUI();
    update();
  });
  form.addEventListener("change", function () { syncFreqUI(); update(); });
  form.addEventListener("submit", function (ev) { ev.preventDefault(); });

  $("btn-reset").addEventListener("click", function () {
    form.reset();
    state.prov = {}; state.selected = null; state.example = false;
    show($("selected-record"), false);
    show($("search-results"), false);
    $("packSize-raw").textContent = "";
    $("ref-details").open = false;
    syncFreqUI();
    update();
  });

  $("btn-example").addEventListener("click", function () {
    $("btn-reset").click();
    var v = {
      medName: "Example Tablet (illustrative, not SFDA data)", activeIngredient: "", strengthText: "", dosageForm: "Tablet",
      packSize: "20", pricePerPack: "5", priceSourceDate: "Illustrative — not a real SFDA date",
      billedQty: "2", billedAmount: "10", dosePerAdmin: "1", freqValue: "4", durationValue: "5"
    };
    Object.keys(v).forEach(function (k) { $(k).value = v[k]; if (v[k]) state.prov[k] = "example"; });
    $("unitLabel").value = "tablets";
    $("freqMode").value = "everyHours";
    state.example = true;
    syncFreqUI();
    update();
  });

  $("btn-print").addEventListener("click", function () { window.print(); });

  $("btn-export").addEventListener("click", function () {
    var text = "FWA MEDICATION CLAIM REVIEW — SUMMARY\n" +
      "Audit aid only: review flags are not findings of fraud and not clinical advice.\n\n" +
      ($("example-banner").hidden ? "" : "ILLUSTRATIVE EXAMPLE — NOT VERIFIED SFDA DATA\n\n") +
      $("results-body").innerText + "\n\nGenerated " + new Date().toLocaleString() + "\n";
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fwa-medication-review-" + new Date().toISOString().slice(0, 10) + ".txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest(".search-field")) show($("search-results"), false);
  });

  restoreList();
  syncFreqUI();
  update();
})();

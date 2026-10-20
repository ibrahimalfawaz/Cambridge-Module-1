# FWA Medication Claim Review

A browser tool for insurance Fraud, Waste and Abuse (FWA) reviewers. It compares a billed medication claim with:

1. the **SFDA public medication price list** (imported by you as a CSV), and
2. the **prescription as written**, when enough prescription details are available.

> **This is an audit aid.** Its output is a set of *review flags* (discrepancies to look into). They are **not** findings of fraud, waste or abuse. The tool does not diagnose, prescribe, or judge whether a regimen is clinically appropriate. A clinician or pharmacist must review any clinical question.

## Run it

No install, build step or internet connection is needed.

- Open `index.html` in a current browser (Chrome, Edge, Firefox or Safari) by double-clicking it. Keep `index.html`, `fwa-core.js`, `app.js` and `styles.css` in the same folder.
- Optional: serve the folder locally, for example `npx http-server .` or `python3 -m http.server`.

Run the tests (Node 18 or later): `node --test tests/*.test.js`

## Get and import the SFDA price list

The tool contains **no SFDA data** and never downloads anything by itself. You load a file you downloaded from SFDA, so every review shows which file and date the prices came from.

1. Open the SFDA Drugs List: <https://www.sfda.gov.sa/en/drugs-list>. On the SFDA website it is under **Information Lists → Drugs**. The list shows trade name, scientific name, strength, dosage form and price. A details view per product includes the package size and register number.
2. Download the list. SFDA's user guide for the Registered Human Drug List says it can be downloaded as an Excel file. Record the **update date shown by SFDA**, or the date you downloaded it if no update date is shown.
3. In Excel or LibreOffice, choose **Save As → CSV UTF-8 (comma delimited)**. Semicolon- and tab-separated files also work. Files that are not valid UTF-8 are retried as Windows-1256 (Arabic).
4. In the tool, under **1. SFDA price list**, choose the CSV file. Check the automatic **column mapping**, enter the **list date**, then click **Import price list**.
5. Optional: tick **Remember this price list** to keep it in this browser (`localStorage`) for next time. Re-import whenever SFDA publishes an update.

**Column mapping.** Headers are matched by common English or Arabic names, such as "Trade Name", "Scientific Name", "Package Size", "Public Price" or "السعر". You can change any mapping. A trade/medication name column and a price column are required.

The import:

- skips rows with no name;
- reports rows whose price cannot be read;
- leaves the pack size **blank** when the source value is not a single number (for example `1 x 30`). You enter the units per pack yourself; the tool will not guess.

**Terms of use and freshness.** Check the SFDA website's terms before using or sharing its data. Before relying on a price, confirm that it is current on the SFDA site. The SFDA list's export column names could not be verified while this tool was built, because the SFDA site was not reachable from the build environment. That is why column mapping is editable and not hard-coded.

`sample-data/FICTITIOUS-sample-price-list.csv` contains **made-up** products ("DEMO-…") for trying the import. It is not SFDA data.

## What each calculation means

Every result card lists the fields it needs. When a required value is missing, that calculation is not performed.

| Result | Formula | Needs |
|---|---|---|
| Units supplied | pack size × number of packs billed (or the units billed directly) | Pack size, quantity billed |
| Expected units | units per dose × doses per day × duration in days | Dose, a calculable frequency, duration (plus strength per unit if the dose is entered in mg etc.) |
| Difference | units supplied − expected units | Both results above |
| SFDA reference value | SFDA price per pack × number of packs | SFDA price, price-list date, quantity billed |
| Billed vs reference | amount billed − SFDA reference value (and %) | Reference value, amount billed |

Notes:

- **Every N hours** is converted as 24 ÷ N doses per 24 hours, assuming evenly spaced doses (e.g. every 4 hours → 6 doses/day). If N does not divide 24 evenly, the result is flagged for interpretation.
- **Weeks** are converted to days × 7. Months are not accepted because their length is ambiguous.
- **Dose in mg (or another strength unit)** is converted to units: dose ÷ strength per unit. A part-unit result (e.g. 1.5 tablets) is flagged for pharmacist review.
- **Pack rounding.** The tool also works out the smallest whole number of packs that covers the expected units. If the excess comes only from pack size, it is shown as information. If more packs were billed than needed, it is shown as a review flag.
- **As-needed (PRN)** dosing has no exact expected quantity. If the prescription states a maximum per day, that maximum is used as an *upper bound*.
- **Billed amount above the SFDA reference** is flagged. VAT, dispensing fees and contract terms may explain a difference.
- If prescription details are missing, the tool shows: *"Insufficient information to calculate or assess the prescribed quantity."* The **diagnosis is context only** and is never used to infer a dose, frequency or duration.

## Illustrative example (not SFDA data)

Click **Load illustrative example**:

- 20 tablets per pack at SAR 5 per pack; 2 packs billed for SAR 10 → 40 tablets supplied, reference value SAR 10.
- Prescription entered as 1 tablet every 4 hours for 5 days → 24 ÷ 4 = 6 doses per 24 hours → 1 × 6 × 5 = **30 tablets** expected.
- Difference: +10 tablets. 2 packs is the smallest whole number that covers 30 tablets, so the excess comes from pack size.

This is quantity arithmetic only. It does not show whether the regimen is clinically appropriate, and the tool would never assume this prescription from a diagnosis such as "throat pain".

## Optional external dosing reference

You can record a dosing reference, for example from the SFDA-approved product leaflet or SmPC for the same product. It is shown only when you enter a **source name, link and access/publication date**, and it is displayed separately from the prescription. Record the population, age/weight band and indication it applies to.

Using the reference, the tool prompts for clinical review when:

- the prescribed daily amount exceeds the referenced maximum;
- the reference is weight-based but no weight was entered;
- sources conflict.

The tool **does not include** any dosing data of its own.

## Clinical-review prompts

The tool raises a clinical-review prompt (not a fraud flag) in these cases:

- unclear or variable instructions;
- as-needed (PRN) dosing;
- patient under 18;
- doses that are not whole units;
- frequencies that do not divide evenly into 24 hours;
- dose above a cited maximum;
- missing weight for a weight-based reference;
- conflicting sources.

## Privacy and data handling

- Everything runs in the browser tab. **Nothing is sent to any server.** The page makes no network requests.
- **Claim data is never stored.** It is lost when you reload or close the page.
- The imported price list is stored only if you tick "Remember this price list". It stays in this browser's `localStorage` on this device until you click **Remove imported list**. No claim data is ever stored there.
- **Print** prints the review summary only. **Download .txt** saves a text summary to your computer. Both run locally.
- Do not enter names, ID numbers or other identifying patient details. Demo data is fictitious.

## Limitations

- The results depend on the values you enter and on how current the imported SFDA file is. Always check against the source.
- The tool cannot read `.xlsx` files directly; convert them to CSV first.
- It does not handle complex regimens: tapering doses, loading doses, different doses at different times of day, or cycles. Record these as "Unclear / variable" and refer them for review.
- For liquids, creams, inhalers and similar products, pack size and dose must be in the same unit (e.g. mL or puffs). The tool cannot check that they match.
- SFDA prices are reference prices. Contracted prices, VAT and fees can legitimately differ.
- The tool is not a substitute for a clinician or pharmacist, and its flags are not evidence of fraud or inappropriate care.

## Files

- `index.html` – page structure
- `styles.css` – layout (responsive, print styles)
- `fwa-core.js` – calculations, CSV parsing, column mapping (pure functions, shared with the tests)
- `app.js` – user interface behaviour
- `tests/core.test.js` – unit tests (Node built-in test runner)
- `sample-data/FICTITIOUS-sample-price-list.csv` – made-up data for trying the import

# ODK Central and KoboToolbox connectors

Both tools author forms in XLSForm and give back similar values. The connectors read what they return and produce **rows for the importer** (`previewImport`). They do not write to either service, do not download attachments, and read nothing from the environment.

```ts
import { odkODataToRows, odkFieldsFromXForm, toImportInput, previewImport } from "./src/index.ts";

const fields = odkFieldsFromXForm(formXml);                       // or odkFieldsFromApi(json)
const result = odkODataToRows(odataDocument, { fields, eventDateField: "survey_date" });
const preview = previewImport(toImportInput(result, "observation"));
// result.rows, result.media (references only), result.findings
```

| Source | Function | Input |
|---|---|---|
| ODK Central | `odkODataToRows` | OData data document (`.../forms/{id}.svc/Submissions`, fetched with `$expand=*`), or an array of its rows |
| ODK Central | `odkCsvToRows` | the unzipped CSV export: `{ main, repeats }` (the main table and one table per repeat) |
| ODK Central | `fetchOdkSubmissions`, `fetchOdkFields`, `readOdkForm` | a live server; you pass `fetchImpl` or use the global `fetch` |
| KoboToolbox | `koboJsonToRows` | v2 data API response (`/api/v2/assets/{uid}/data/?format=json`), or an array of its rows |
| KoboToolbox | `koboCsvToRows` | the CSV export with "XML values and headers": `{ main, repeats }` |
| KoboToolbox | `fetchKoboSubmissions`, `fetchKoboFields`, `readKoboAsset` | a live server |

Form definitions come from `odkFieldsFromXForm` (XForms XML), `odkFieldsFromApi` (Central's `/fields` JSON) or `koboFieldsFromSurvey` (the asset's `content.survey`). **Pass one.** Without it, values stay as the server wrote them and a finding (`fields.not-supplied`) says so.

## What each value becomes

| Source value | Output | Notes |
|---|---|---|
| Group | key `group/field` | Same key from OData, ODK CSV (with fields) and Kobo. ODK CSV without fields keeps the header (`group-field`). |
| Repeat | array of objects under the repeat path | `children/child: [{ name, age }]`. Nested repeats nest. An empty repeat is absent. OData that was not expanded is reported (`odata.repeat-not-expanded`). |
| geopoint | GeoJSON `Point`, `[lon, lat, alt?]` | From `"lat lon alt acc"`, GeoJSON or WKT. Accuracy above 0 goes in `accuracyMetres`; 0 means unknown in ODK and is dropped. Central's OData output has no accuracy. |
| geotrace | `LineString` | At least two points. |
| geoshape | `Polygon` | An open ring is closed. |
| First top-level geopoint | `latitude`, `longitude`, `uncertainty` | Override with `locationField`. Kobo's `_geolocation` is used only if no field gave a location. |
| `geometryField` | `geometry` | Copies a trace, shape or point to the key the importer validates as GeoJSON. |
| select_multiple | array of choice names | Only when the form definition marks the field. `splitSelectMultiples` columns are dropped (the main column holds the same choices). |
| int, decimal | number | Only when typed and a plain number; otherwise kept as text with `number.unreadable`. |
| dateTime | `YYYY-MM-DDTHH:MM:SS[.mmm](Z or ±HH:MM)` | The local clock reading and its offset are kept, never converted. No offset: kept as written with `timestamp.no-offset`, or given `defaultUtcOffset` with a warning. Kobo `_submission_time` is UTC by Kobo's documentation, so `Z` is added and said once. |
| Attachment field | the file name stays in the field; a reference goes in `media` and in `result.media` | ODK: relative API path (needs `project` and `form`). Kobo: the https download URL the server gave. Bytes are never fetched. Unsafe names make no reference. |
| `eventDateField` | `eventDate` | Never guessed: submission time is not observation time. |
| Submitter, device, and the metadata questions that identify a device or person (`deviceid`, `username`, `phonenumber`, `email`, `subscriberid`, `simserial`) | left out; an info finding `metadata.identity-dropped` names each | `includeSubmitter: true` keeps them. Found by question type or XForm preload when a form definition is given, and by question name otherwise. |
| `restrictedFields` | dropped from the row and never promoted to latitude/longitude | Top-level keys only. For location privacy of a whole row use `withholdStagedRow` (below). |
| Text starting `=`, `+`, `-`, `@` | kept | Reported as `cell.formula-prefix`. |

Rows also carry `sourceId` (`odk:<instance id>` or `kobo:<uuid>`; the namespace is an option), `sourceSystem`, `submittedAt`, `updatedAt` (ODK), `formVersion`, `reviewState` (ODK) or `validationStatus` (Kobo), and `edits` (ODK).

## Importing

`toImportInput(result, presetId, mapping?)` returns the arguments for `previewImport`. The importer reads 1,000 rows and 2 MiB per call: use `chunkRowsForImport` for more. Two importer rules to know:

- An explicit `mapping` replaces the importer's automatic column matching, so list every column you want mapped (`eventDate`, `latitude`, `longitude` as well as your own).
- The importer accepts 64 columns per row. A form with more fields needs a mapping or a trimmed export.

## Location privacy of connector rows

A connector row carries places as GeoJSON under the form's own field names (points, traces, shapes, repeat entries), plus `latitude`, `longitude` and `uncertainty`. To withhold them, pass the row as `source` to `withholdStagedRow` with the row's location visibility; a row whose place is not published is cut down to an allow-list of non-spatial fields, so **form questions are dropped unless you list the safe ones in `keepKeys`** (site and locality questions are dropped whatever `keepKeys` says), and the free text that stays is screened for places. Repeats, traces and shapes go. A visibility flag in a group or a repeat entry counts, and the strictest wins. A row with no visibility anywhere is withheld by default; pass `missingVisibility: "public"` (that exact string) to keep it. See the threat model for what the screen cannot do.

## Network rules (fetch helpers)

HTTPS origin only (no path, user, query or fragment); redirects refused; next-page links must keep the same origin and path; the token goes in a header only and never appears in an error; responses are bounded in bytes and time; requests are sequential. Pointing `server` at an internal address is the caller's decision: a service that accepts server URLs from users needs its own allowlist ([threat model](threat-model.md)).

## Test data

ODK's own sample forms and submissions (Apache-2.0, from the `central-backend` repository) are used for form definitions and values; the exports built from them are synthetic, written to the documented formats. Kobo data is entirely synthetic. Sources and licences: [test/fixtures/README.md](../test/fixtures/README.md). A real export from a self-hosted Central and from a Kobo account should be added before the connectors are called tested against the real services.

## Known gaps

- Time zones: only fixed offsets are understood (`defaultUtcOffset`), not named zones, so a survey that crosses a daylight-saving change can be mislabelled by an hour for values that carry no offset. The warning is raised every time the option is used.
- The ODK Central CSV date-time formats and the Kobo CSV layout were written from documentation and source, not from a real export. Neither connector has run against a live server.

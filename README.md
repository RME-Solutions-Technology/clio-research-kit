# Clio research kit

[![ci](https://github.com/RME-Solutions-Technology/clio-research-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RME-Solutions-Technology/clio-research-kit/actions/workflows/ci.yml)

**Status: pre-1.0 (v0.1.0).** The API and file layout can still change between 0.x releases. The package is marked `"private": true`, so it is not published to npm yet; releases will be signed tarballs on GitHub once the release workflow has run (see [AUDIT.md](AUDIT.md) for how a release is checked). Repository: https://github.com/RME-Solutions-Technology/clio-research-kit.

A small TypeScript toolkit for turning field and collection records into standards-shaped research packages. It was extracted from Clio Online Museum code and has no dependency on the Clio app.

## What is in it

| Area | What it does | Where |
|---|---|---|
| Darwin Core Archive | Builds `meta.xml`, `eml.xml` (GBIF Metadata Profile, EML 2.1.1), the core table, an eMoF extension and a multimedia extension. Sensitive and restricted profile fields are not written (the event envelope and measurement rows are written as supplied; a record with no `locationVisibility` has its coordinates withheld unless you pass `missingVisibility: "public"`). | `src/dwca.ts`, `src/darwin-core.ts`, `src/measurement-rows.ts` |
| Research package | A BagIt 1.0 bag (RFC 8493) with an RO-Crate 1.2 description and a Frictionless Data Package descriptor. Output is deterministic. `verifyResearchPackage` re-checks a package from its bytes. | `src/research-package.ts` |
| ZIP | A small store-only ZIP writer and reader, no dependencies. | `src/zip-store.ts` |
| Project schemas | Typed extension fields on top of a profile, with term and unit IRIs and a version-bump check. | `src/research-schema.ts`, `src/research-intake.ts`, `src/research-withholding.ts` |
| Lane profiles | 14 field-lane profiles (25 immutable versions) in TypeScript, and the same data as JSON Schema under `schemas/`. | `src/application-profiles.ts`, `schemas/` |
| Importer | Reads CSV, JSON and NDJSON, maps columns to a preset's fields, and reports findings without changing values. | `src/importer.ts` |
| ODK Central connector | Turns Central's OData JSON or CSV export (repeats, geopoints, traces, select_multiple, attachments as references, timestamps with offsets) into importer rows. Optional fetch helpers that take an injected `fetch` (they fall back to the global `fetch` if none is given). | `src/connectors/odk.ts`, [docs/connectors.md](docs/connectors.md) |
| KoboToolbox connector | The same for Kobo's v2 data JSON and CSV export. | `src/connectors/kobo.ts` |
| Audit pack | Threat model, security policy, SBOM script, release-signing plan, test vectors, citation file, AI-use statement. | [AUDIT.md](AUDIT.md), [docs/](docs/) |

The licence is an option on the builders and validators. It defaults to CC BY 4.0, an open licence: choose one explicitly for records that may be sensitive or third-party.

## Try it

```ts
import { previewImport, validateApplicationProfileData } from "./src/index.ts";

const preview = previewImport({
  format: "csv",
  presetId: "observation",
  content: "id,date,lat,lon,species\nr1,2026-09-14,-33.8,151.2,Exemplaria synthetica\n",
});
console.log(preview.summary); // { total: 1, noImportErrors: 1, errors: 0, warnings: 1 }

const result = validateApplicationProfileData(
  "clio.profile.general-observation", "1.0.0",
  { title: "A", observedOn: "2026-09-14", locality: "Somewhere", observer: "Tester" },
  "draft",
);
console.log(result.valid); // true
```

## Develop

Node 24 and pnpm (pinned in `packageManager`; use Corepack).

```
pnpm install --frozen-lockfile
pnpm test                    # node:test, TypeScript run directly
pnpm run type-check          # tsc --noEmit
pnpm run schemas:check       # schemas/ matches the generator
pnpm run check:imports       # import-graph rules
pnpm run check:scrub         # pre-publication scrub grep
pnpm run build               # dist/ (JavaScript + .d.ts)
pnpm run check:package       # pack, install in an empty folder, use it
pnpm run vectors:check       # export output equals test/vectors/
pnpm run validators          # Frictionless and RO-Crate validators (needs Python)
pnpm run sbom                # CycloneDX SBOM into sbom/
```

Security: [SECURITY.md](SECURITY.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md). Checking a release: [AUDIT.md](AUDIT.md). Citing: [CITATION.cff](CITATION.cff).

`pnpm run schemas:generate` rewrites `schemas/` from the TypeScript profiles.

## Location privacy

The decision is closed. The removal is best effort. Read both halves.

**Deciding.** Only a location visibility that is exactly `"public"` or `"generalized"` publishes a place. `"restricted"`, `"not_collected"`, any other value ("Restricted.", "private", an array, a boolean, an object), a key spelled differently and a **missing** value all withhold it. The flag is read at any depth (a group, a nested object, a repeat entry) and the strictest one wins, even over a `"public"` at the top and under `missingVisibility: "public"`. If your records do not state a visibility and you want them published, say so explicitly: `missingVisibility: "public"` (exactly that string; anything else is an error) on `buildDarwinCoreArchive`, `buildResearchPackage` and the withholding functions. This applies to the Darwin Core Archive, `withholdCanonicalRecordVersion`, `withholdStagedRow` and the package builder, which refuses a record that still holds a place or a private reference when its location is not published.

**Removing.** When a place is not published, a row is cut down to an allow-list of non-spatial fields: the profile's fields outside its location and site groups, the project schema's unrestricted fields, identifiers and dates, the event's non-spatial fields, and any key you list in `keepKeys`. Every other field is dropped by name, so an unknown column cannot carry a place out; connector rows therefore lose their form questions unless you list the safe ones in `keepKeys`. Fields that name a place in words (locality, site IDs and names, collection site, municipality and the like) are dropped too, and `keepKeys` cannot bring them back, because a named place finds the place; a visibility-named key stays so the output says why, but only as the state it was read as ("restricted"), never as the raw cell, so a cell like "Restricted (-33.8, 151.3)" cannot carry a place out. `withholdPackageRecord` does this for a whole package record in one call (canonical JSON, flat coordinates, title, event date, recorded-by, landing page, rights holder, measurement text and extension), and the builder screens those same fields and refuses a place in any of them. A long `withheld` list is grouped (`points[*]`, `group.*`) rather than refused. In the free text that stays (remarks, description, title) the library looks for places written in it (decimal pairs with a point or a comma, whole-degree pairs, decimal degrees with a degree sign, degrees-minutes-seconds, single coordinates with four or more decimals or after a lat/lon word, numeric arrays, x/y, serialised GeoJSON, WKT, map links, `geo:` links, plus codes, UTM, MGRS and OS grid references in either case, what3words, and a labelled geohash). The text is screened after Unicode NFKC normalisation and with zero-width characters removed, so full-width digits and a pair split by a hidden character are found; text with no place in it is returned unchanged, and text with one comes back in its normalised form with the place, and any number left next to it, replaced by `[location withheld]`, recording the field in `withheld`.

**The limit, plainly.** That screen is pattern matching on free text. It cannot be guaranteed to catch every way a person can write a place ("the second gate past the old mill, 200 m up from the bridge" is not a pattern; neither are a street address, a lot and parish, or a geohash with no label), and it will sometimes remove text that is not a place (any number with four or more decimals in latitude/longitude range, for example). So: generalise place text before you export (write "Hunter Valley", not a street, a gate or a coordinate pair; locality fields are dropped for a restricted record, but a place written inside remarks or a title is only found when it matches a pattern), look at what comes out, and do not treat `withheld` as proof of absence. Media files are never read, so GPS inside image metadata is your responsibility. The private-reference check is a name heuristic; list your own names in `privateKeys`.

## Using the JSON Schemas

The schemas use annotation keywords (`x-clio-...`). Ajv's default strict mode refuses unknown keywords, so register them first (or build Ajv with `strict: false`):

```ts
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SCHEMA_KEYWORDS } from "@clio-museum/research-kit";   // the same list is in schemas/index.json ("keywords")

const ajv = new Ajv2020();
addFormats.default(ajv);
ajv.addVocabulary([...SCHEMA_KEYWORDS]);
```

The date patterns check month lengths and leap years, so `2026-02-31` fails. They cannot check that an interval's start is not after its end; `validateApplicationProfileData` does. The test suite compares schema and validator results for type, enum, required fields and unknown fields on every profile, and for date patterns; it does not compare every pattern, unit and range rule, so treat the TypeScript validator as the reference where the two could differ.

## Install and build

`pnpm run build` compiles `src/` to `dist/` (JavaScript and `.d.ts`); `package.json` exports point at `dist/`, because Node does not strip types from files inside `node_modules`. `pnpm run check:package` packs the tarball, installs it into an empty folder and uses it from plain Node and from a strict TypeScript consumer. The package is still `"private": true`; nothing is published.

## Limits worth knowing

- The importer reads up to 1,000 rows, 2 MiB, 64 columns per row and 32 KiB per cell per call. The connectors chunk their output for it (`chunkRowsForImport`).
- Its `summary.noImportErrors` counts rows that read cleanly. It does not mean a row satisfies a profile: the importer presets use their own field keys, and a mapper from preset rows to profile fields does not exist yet.
- `verifyResearchPackage` proves a package matches its own manifests. It does not prove who made it, and it does not check that the RO-Crate and Frictionless descriptors match the payload.
- A research package is a project-internal export: it keeps "sensitive" values such as a locality when the location is published (a restricted record loses its place names), and its rights text assumes the package licence. Only the `dwca/` folder is filtered for sharing, and even there the event envelope and measurement rows are written as supplied. Restricted values you list as `withheld` must really be removed first; the builder refuses a package that lists a path as withheld while its value is still present.
- Spreadsheets run cells that start with `=`, `+`, `-` or `@`. Exports keep values as recorded unless you pass `spreadsheetSafe: true`, which puts a single quote in front of such text cells (CSV files and Darwin Core tables; `records.jsonl` is unchanged).
- A serialised bag must unpack to one top-level folder: use `zipResearchPackage`, not `createStoredZip(pkg.files)`.

## What this is not

- Validator status: the sample package passes the Frictionless and RO-Crate validators when run locally, and the CI workflow that runs them has not run yet. The GBIF data validator needs an account and is a manual step that has not been done, so there is no claim of GBIF validity. See [docs/validation-results.md](docs/validation-results.md).
- The connectors are tested on ODK's own sample forms with synthetic exports in the documented formats, and on synthetic Kobo data. They have not been run against a real Central or KoboToolbox server.
- Exports keep values verbatim by default, so a cell that starts with `=`, `+`, `-` or `@` stays that way unless you build with `spreadsheetSafe` ([threat model](docs/threat-model.md)).
- It does not register DOIs, upload anywhere or talk to any service.
- JSON Schema cannot express every cross-field rule in the profiles. Those rules are carried as data in `x-clio-qualityChecks` and enforced by `validateApplicationProfileData`.
- No identity, signing or key-handling code is part of this repository.
- All test data is synthetic.

## Licences

- Code: Apache-2.0 (`LICENSE`).
- Schemas and vocabulary files in `schemas/`: CC BY 4.0 (`schemas/LICENSE`).

## AI assistance

Large parts of this extraction, the connectors, the tests and the documentation were written with AI assistance (Anthropic's Claude) and need human review before release. See [docs/ai-use.md](docs/ai-use.md).

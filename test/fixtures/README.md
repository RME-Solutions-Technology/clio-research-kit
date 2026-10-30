# Test fixtures: sources and licences

Everything under `test/fixtures/` is test data. What is third-party, what is synthetic and why is listed here so nobody has to guess. Fixture files are never imported by `src/`.

Retrieved 30 October 2026.

## ODK: third-party material (Apache-2.0)

| Files | Source | Licence |
|---|---|---|
| `odk/forms/*.xml` (simple, withrepeat, doubleRepeat, withAttachments, binaryType, selectMultiple, groupRepeat, nestedGroup, geoTypes) | The `forms` object in `test/data/xml.js` of <https://github.com/getodk/central-backend>, last changed at commit `80a67441705788f0e010ed54027c617a39f3369f`. The XML is copied unchanged apart from trimming leading and trailing blank lines. | Apache-2.0, Copyright 2017 ODK Central Developers. The licence file in that repository is identical to this repository's `LICENSE`. |
| `odk/instances/central-backend-instances.json` | The `instances` object in the same file: the raw submission XML for those forms. Used as the source of the values in the synthetic exports below. | Apache-2.0, same notice. |
| `odk/odata/docs-simple.json` | The example response of the OData data document in `docs/api.yaml` of the same repository (commit `fb07e21a5fd19741438f0f8810bb008699d077fc`). Values unchanged. | Apache-2.0, same notice. |

The notice required by the licence is carried in the top-level `NOTICE` file.

## ODK: synthetic exports

These are **not** copies of ODK output. They were written to match the documented formats, using the values from the Apache-2.0 sample submissions above:

- `odk/odata/*.json` (except `docs-simple.json`): the OData data document shape and GeoJSON/WKT geometry rules in `docs/api.yaml`. Central's OData output omits GPS accuracy; these files omit it too.
- `odk/csv/*.csv`: the layout produced by `lib/data/briefcase.js` of the same repository (commit `79a024b9e813b93ca0cc4cc04a5a09623d9e8f6f`): the `SubmissionDate` column, group paths joined with `-`, geopoint split into `-Latitude`/`-Longitude`/`-Altitude`/`-Accuracy`, the trailing `KEY`/`SubmitterID`/... columns, repeat tables joined with `PARENT_KEY` and `KEY` (`<instance>/<repeat>[n]`), and `field/choice` 0/1 columns for `splitSelectMultiples`.

Why synthetic: no real Central server or real ODK export was available, and none was published with a licence that permits redistribution. A real export should be added when one can be generated against a self-hosted Central (see the open questions in the part 2 report). Until then, a passing test shows the connector follows the documented format, not that it has met every Central version.

Submitter names are the placeholder "Test Submitter".

## KoboToolbox: synthetic only

`kobo/*` is entirely synthetic, written to the v2 API response and CSV export shapes in KoboToolbox's public documentation and the XLSForm specification (fields, `$xpath`, `_attachments`, `_geolocation`, `_submission_time`, `_validation_status`, semicolon-delimited CSV with `_index`, `_parent_table_name` and `_parent_index`).

Why synthetic: KoboToolbox's source (KPI) is AGPL-3.0 and formpack is GPL-3.0, so their test data is not copied into an Apache-2.0 repository. The server host `kf.example.org`, the asset uid and every id are made up.

## Looked at and not used

| Material | Why not |
|---|---|
| `getodk/sample-forms` (many example forms) | The repository has no licence file and GitHub reports no licence, so redistribution is not permitted. The Apache-2.0 forms from `central-backend` cover the same field types. |
| `getodk/docs` (documentation) | CC BY 4.0. Not needed: the Apache-2.0 API documentation in `central-backend` carries the same examples. |
| KPI and formpack test data | AGPL-3.0 / GPL-3.0. |

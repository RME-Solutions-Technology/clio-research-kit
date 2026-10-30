# Format validator results

Run on 30 October 2026 on the build machine (Windows, Node 24.22.1, Python 3.13.15), with `node scripts/run-validators.ts --require`. Input: the synthetic sample dataset in `scripts/sample-package.ts` (two occurrence records, one measurement, one media link). The files checked are the same bytes as `test/vectors/`.

This page is a record, not evidence you should rely on. Re-run the script (see [AUDIT.md](../AUDIT.md), step 5).

| Validator | Version | Result | What it covered |
|---|---|---|---|
| Frictionless (`frictionless validate`) | frictionless 5.21.0 | **Passed.** 8 resources VALID | `data/datapackage.json` and its three CSV tables (records, measurements, media manifest), plus the five Darwin Core Archive files listed as resources (`meta.xml`, `eml.xml`, `occurrence.txt`, eMoF, multimedia). |
| RO-Crate validator | roc-validator 0.13.1 | **Passed** against profile `ro-crate-1.2`: 63 checks passed, 0 failed, 3 skipped (severity REQUIRED, full package) | `data/ro-crate-metadata.json` and the files it describes. The 3 skipped checks were skipped by the tool; their reasons were not inspected. |
| python-dwca-reader | python-dwca-reader 0.17.1 | **Passed** | `dwca.zip` opens; `meta.xml` and `eml.xml` parse; 2 core rows and 2 extension files read. This is a structural read, not a validator. |
| GBIF data validator | n/a | **Not run: manual step** | Needs a GBIF account. Upload `tmp/validation/dwca.zip` at <https://www.gbif.org/tools/data-validator> and keep the report. No GBIF validator result exists yet, so nothing here claims the archive is GBIF-valid. |

## A failure the validator found

The first run of the RO-Crate validator **failed**: the builder entity in `ro-crate-metadata.json` is a `SoftwareApplication` and the RO-Crate 1.2 profile requires a `url` on it (check `ro-crate-1.2_32`). The library wrote `name` and `version` only. Fix: `buildResearchPackage` now writes `url`, from the new `softwareUrl` option, defaulting to `RESEARCH_KIT_URL`, which is a placeholder address (`https://example.org/research-kit`) until the project has a public home. Set it to the real address before releasing. This is the kind of defect the existing unit tests did not catch and the third-party validator did.

## Limits

- One small synthetic dataset. Nothing here tests every profile, a sampling-event core, large archives or non-ASCII data.
- The Darwin Core Archive was not checked against GBIF's validator or an IPT (see above).
- The validators were installed from PyPI at the versions in `requirements-validators.txt`; their own correctness is outside this project.
- The CI workflow that runs the same script has not run yet.

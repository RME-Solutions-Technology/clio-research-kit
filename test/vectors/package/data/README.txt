Synthetic sample research package

Package pkg-sample-0001, made 2026-10-22T01:00:00Z with clio.research-package/v1.

How to read this package
- records.jsonl is the complete, lossless copy: one record version per line.
- records.csv, measurements.csv and extensions/*.csv are flat tables of the same data for spreadsheets and scripts.
- measurements.csv uses Extended Measurement or Fact (eMoF) column names. Type and unit columns ending in ID hold the term IRIs.
- schemas/ holds the exact project schema versions used (0), as project-schema documents (.clio.json) and as JSON Schema 2020-12 (.schema.json).
- datapackage.json (Frictionless Data Package) and ro-crate-metadata.json (RO-Crate) describe every file for other tools.
- media-manifest.csv lists media objects with their SHA-256 digests. Media bytes are not included in this package.
- dwca/ is an unzipped Darwin Core Archive (Occurrence core): meta.xml, eml.xml and tab-delimited tables. Zip its contents to check them with a Darwin Core Archive validator. Sensitive and restricted fields are left out; informationWithheld says what. It has not been validated, registered or published by this export.

Checking it
- The folder above data/ is a BagIt bag. manifest-sha256.txt lists a SHA-256 digest for every file in data/; any BagIt tool can verify it.

Rights
- Record metadata is licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) unless a record says otherwise.
- Media and third-party material keep the licence shown for each item.

Spreadsheet note: CSV cells are written exactly as recorded. A spreadsheet may treat a cell beginning with =, +, - or @ as a formula; open the files as text if that matters, or build the package with spreadsheetSafe.

This package was built by the Clio research kit. It is not a statement that any repository has accepted, preserved or published it.

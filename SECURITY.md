# Security policy

**Status: pre-1.0 (version 0.1.0).** Only the latest release is supported. This file describes how reports are handled.

## Reporting a vulnerability

Do not open a public issue for a security problem.

- Preferred: GitHub private vulnerability reporting. On https://github.com/RME-Solutions-Technology/clio-research-kit, open the "Security" tab and choose "Report a vulnerability".
- Alternative: email **security@cliomuseum.org**.

Please include the version or commit, what you did, what you expected and what happened. A minimal input file (CSV, JSON, ZIP, form XML) is the most useful thing you can attach. Use synthetic data only; do not send real personal or location data.

## What to expect

This is a small project. The targets below are intentions, not a service level:

- acknowledgement within 7 days;
- an initial assessment within 14 days;
- a fix and advisory for confirmed issues as soon as one is ready, with credit to the reporter if they want it.

Reports go to the maintainer, Rob Evans (RME Solutions Technology), by either route above.

## What counts

In scope: the code in `src/`, the scripts in `scripts/`, the JSON Schemas in `schemas/`, and the release process. The areas most likely to matter are listed in [docs/threat-model.md](docs/threat-model.md): parsing of untrusted CSV, JSON, NDJSON, ZIP and form XML; the ODK Central and KoboToolbox connectors; and the files the library writes.

Known and documented limits are not vulnerabilities, but tell us if the documentation is wrong. In particular, exported CSV and tab-delimited files keep values exactly as given, so a cell that starts with `=`, `+`, `-` or `@` stays that way (see the threat model, "Formula injection").

Out of scope: the services the connectors talk to (ODK Central, KoboToolbox), the third-party validators, and any identity or signing code (none is in this repository).

## Verifying a release

See [AUDIT.md](AUDIT.md).

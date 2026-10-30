# AI use statement

This follows the disclosure the Journal of Open Source Software asks for: which tools were used, for what, and how the output was checked.

## What was done with AI assistance

The code in this repository was **extracted and written with the help of AI coding assistants** (Anthropic's Claude models, run as coding agents on a developer workstation). Specifically:

- The export library, lane schemas and importer were extracted from the source code of a separate application (Clio Online Museum), with the application-specific parts removed or replaced by small shims. The extraction, the shims and the JSON Schema generator were written by an AI agent.
- The ODK Central and KoboToolbox connectors, their synthetic test fixtures, their tests, the CI and release workflows, the validator scripts and the documentation were written by AI agents.
- Test expectations were written by the same agents. A passing test shows the code does what the agent intended, not that the intent is right. Where independent evidence exists (ODK's own sample forms, the third-party validators), the tests and the validators use it.

## How the output is checked

- Automated: unit tests, type checking, a JSON Schema cross-check against the TypeScript validators, an import-graph check, a pre-publication scrub, and the third-party Frictionless and RO-Crate validators on a generated sample package (see [validation-results.md](validation-results.md)).
- Fresh-eyes review: the project checklist requires a reviewer who did not write the code to read the diff before any release. Part 1 of the extraction was given to a separate AI agent for a read-only review. That is not a human review.
- Several independent AI reviewers (fresh-context Claude reviews, and a further review of the location-privacy code against a sister project) read the code and their findings were fixed. Their reports are not published.
- **Human review: ongoing, not complete.** The maintainer, Rob Evans (RME Solutions Technology), is reviewing the code as it is used. **No human has read every line of this code.** Treat it as pre-1.0 software written by AI agents and reviewed by other AI agents, and read what matters to you before you rely on it. A line-by-line human review is still open (see AUDIT.md).

## What this does not claim

The code is not claimed to conform to GBIF, Frictionless or RO-Crate specifications beyond what the validators report, and a clean validator report is evidence, not proof. Nothing here has been audited by an independent security reviewer.

## For contributors

Say in your pull request if you used an AI tool and for what. You remain responsible for every line you submit, including its licence and provenance: do not paste code you cannot trace.

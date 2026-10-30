# Lane schemas

JSON Schema (2020-12) files for the field-lane profiles, generated from `src/application-profiles.ts` by `pnpm run schemas:generate`. Do not edit them by hand: `pnpm test` fails when they drift from the generator.

Licence: CC BY 4.0 (see `LICENSE` in this folder); each schema file says so in its `$comment`. The term lists and identifiers inside come from other organisations (Darwin Core, CGI, ICS, NERC and others): their credit lines and what is known about their licences are in `SOURCES.md`, and you must keep them. If you reuse these files, also credit this project: "Lane schemas, research-kit authors (PLACEHOLDER: set before release), CC BY 4.0".

| File | Contents |
|---|---|
| `index.json` | Every profile version, whether it is the current one, and the path to its schema. |
| `profiles/<profile>/<version>.schema.json` | One schema per immutable profile version. Older versions are kept for exact historical validation. |
| `SOURCES.md` | Where each vocabulary in these files comes from, and its licence as far as it is known. |
| `vocabularies.json` | The pick-lists, IRI maps and patterns the profiles use, and the pollen morphology vocabulary. |

Using them with a strict validator: the `x-clio-...` annotation keywords are listed in `index.json` (`keywords`). Register them before compiling (`ajv.addVocabulary(index.keywords)`) or turn strict mode off. Date patterns check month lengths and leap years; they cannot check that an interval starts before it ends.

How to read a profile schema:

- `required` lists the fields needed at `draft`. A field needed at a higher readiness level has `x-clio-requiredAt`, and `x-clio-requiredBy` lists them per level.
- Every field accepts a plain value or an assertion wrapper `{ value, source, uncertainty, visibility, unit, method }`.
- `x-clio-termIri` is the published term (usually Darwin Core) a field maps to. `x-clio-sensitivity` says whether a field is public, sensitive or restricted when exported.
- `x-clio-qualityChecks` holds cross-field rules as data. JSON Schema does not enforce them; the TypeScript validator does.
- The `rightsLicense` field defaults to CC BY 4.0; the validator accepts another licence URI as an option.
- Vocabularies marked as candidates are working lists, not standards. Nothing here claims conformance with a named scheme.

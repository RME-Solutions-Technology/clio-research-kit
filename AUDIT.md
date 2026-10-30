# How to verify a release

This is for someone who wants to check a release of this software without taking the maintainers' word for it. Every step below is a command you run yourself. The structure follows the checklist "Auditing an open-source data/identity tool to code level".

**Status: pre-1.0 (v0.1.0).** Until the first tag is pushed no release, signature, attestation or Software Heritage entry exists, so steps 2 and 7 describe what you will be able to do once it does; `X.Y.Z` stands for the version. Steps 1, 3, 4, 5 and 6 work today on a checkout of the repository. A step that depends on something that does not exist yet is marked **(not yet possible)**.

What a clean audit shows, and what it does not: it shows (once a release exists and the workflow has run) that the release was built from the tagged source by the published workflow, that its dependencies match the SBOM, that the tests pass on your machine, and that the library's output satisfies the format validators listed. It does not show the code is free of bugs, that it was read by an independent reviewer (see [docs/ai-use.md](docs/ai-use.md)), or that the validators catch everything.

## 0. Get the source

```
git clone https://github.com/RME-Solutions-Technology/clio-research-kit.git     # (once the repository is public)
cd clio-research-kit
git verify-tag vX.Y.Z                           # needs the maintainers' signing key; see the release notes
git checkout vX.Y.Z
```

You need Node 24 (the version in `.nvmrc`) and Corepack, which supplies the pnpm version pinned in `package.json`.

## 1. Reproduce the build from source

`pnpm pack` first compiles `src/` to `dist/` with `tsc` (the `prepack` step), so a release tarball is the compiled JavaScript, the `.d.ts` files, the schemas and the documents. `node scripts/check-package.ts` installs the tarball into an empty folder and uses it.

```
corepack enable
pnpm install --frozen-lockfile        # fails if pnpm-lock.yaml and package.json disagree
pnpm pack --pack-destination out
sha256sum out/*.tgz
```

Compare the SHA-256 with the one in the release's `SHA256SUMS.txt`. Whether two builds of the same tag give byte-identical tarballs has **not been tested since the compile step was added** (before it, two packs of the same tree on one machine matched). Compiler output can differ by TypeScript version and by machine; if yours differs, extract both and diff the files before drawing a conclusion. The lockfile pins the TypeScript version.

The package has no runtime dependencies. Check:

```
node -e "console.log(Object.keys(require('./package.json').dependencies ?? {}))"   # []
pnpm run check:imports                                                              # src/ imports only itself and node:
```

## 2. Check signed release provenance (Sigstore / SLSA)  **(not yet possible)**

Each release will carry three independent proofs. Check all three.

**GitHub artifact attestation (SLSA build provenance):**

```
gh attestation verify clio-museum-research-kit-X.Y.Z.tgz --repo RME-Solutions-Technology/clio-research-kit
```

It must report the workflow `.github/workflows/release.yml`, the tag `refs/tags/vX.Y.Z`, and the commit you checked out in step 0.

**Sigstore signature on the tarball** (bundle attached to the release):

```
cosign verify-blob \
  --bundle clio-museum-research-kit-X.Y.Z.tgz.sigstore.json \
  --certificate-identity "https://github.com/RME-Solutions-Technology/clio-research-kit/.github/workflows/release.yml@refs/tags/vX.Y.Z" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  clio-museum-research-kit-X.Y.Z.tgz
```

Pin the identity exactly as shown. A signature from any other identity, or from a branch instead of a tag, is a failure.

**npm provenance** (only if the package is published to npm): the package page shows the source commit and build workflow; `npm audit signatures` checks registry signatures and provenance for installed packages.

The plan and its limits are in [docs/release-signing.md](docs/release-signing.md). The project aims for SLSA Build level 2 and does not claim level 3.

## 3. Compare the SBOM

A CycloneDX 1.6 SBOM is made from the lockfile:

```
node scripts/generate-sbom.ts                                  # writes sbom/research-kit.cdx.json and sbom/research-kit.prod.cdx.json
node scripts/generate-sbom.ts --compare research-kit.cdx.json # the SBOM attached to the release; exit 1 on any difference
```

The runtime SBOM (`research-kit.prod.cdx.json`) must list no components. The development SBOM lists the build and test tools (TypeScript, Ajv and their dependencies; 29 components on 30 October 2026). Optionally run `pnpm audit` for known vulnerabilities, and run [OpenSSF Scorecard](https://github.com/ossf/scorecard) on the dependencies you care about.

## 4. Run the test suite

```
pnpm test                      # unit tests, hostile-input tests, JSON Schema cross-check, vector check
pnpm run type-check
pnpm run schemas:check         # schemas/ equals what the TypeScript profiles generate
pnpm run check:imports
pnpm run check:scrub           # a grep for private hosts and identifiers; not a secret scanner
pnpm run vectors:check         # step 6
```

The suite makes no network calls: a test replaces the global `fetch` with one that throws, and every connector test passes in a mock.

Read the tests that matter most for your use: `test/threat-model.test.ts` and `test/full-review-fixes.test.ts` (hostile input; not every row of [docs/threat-model.md](docs/threat-model.md) has its own test: each row names the tests that back it), `test/location-privacy.test.ts` (the location-privacy matrix), `test/connector-*.test.ts` and the fixtures' provenance in [test/fixtures/README.md](test/fixtures/README.md).

## 5. Run the format validators on the bundled sample package

The repository can build a small synthetic package and check it with third-party tools.

```
python -m pip install --user -r requirements-validators.txt     # Python 3.10 or newer
node scripts/run-validators.ts --require
```

| Validator | What is checked | Where it runs |
|---|---|---|
| Frictionless (`frictionless validate`) | `package/data/datapackage.json` and every CSV and tab-delimited table it lists | local script and CI |
| RO-Crate validator (`roc-validator`) | `package/data` against the RO-Crate 1.2 profile | local script and CI |
| python-dwca-reader | `dwca.zip` opens, `meta.xml` and every row read (a structural read, not a validator) | local script and CI |
| GBIF data validator | `tmp/validation/dwca.zip` | **manual**, see below |

**GBIF validator (manual).** It needs a GBIF account, so no credential is kept in the repository or in CI. After step 5, sign in at <https://www.gbif.org/tools/data-validator>, upload `tmp/validation/dwca.zip`, and keep the report with the release notes. GBIF's own issue tracker says the validator misses some error classes, so a clean report is evidence, not proof.

Recorded results, versions and any failures are in [docs/validation-results.md](docs/validation-results.md). Re-run them; do not rely on that page.

## 6. Test vectors per export format

`test/vectors/` holds the exact bytes the library produces for a fixed synthetic input (`scripts/sample-package.ts`), and `test/vectors/vectors.json` lists the size and SHA-256 of every file:

| Format | Files |
|---|---|
| Darwin Core Archive (with EML 2.1.1) | `dwca/meta.xml`, `eml.xml`, `occurrence.txt`, `extendedmeasurementorfact.txt`, `multimedia.txt`; `dwca.zip` |
| BagIt 1.0 | `package/bagit.txt`, `bag-info.txt`, `manifest-sha256.txt`, `tagmanifest-sha256.txt`, `data/` |
| RO-Crate 1.2 | `package/data/ro-crate-metadata.json` |
| Frictionless Data Package | `package/data/datapackage.json` and the CSV tables |

```
node scripts/generate-vectors.ts --check     # rebuilds and compares byte for byte; exit 1 on any difference
```

A second implementation can be compared against these files directly. For the ODK Central and KoboToolbox connectors, the vectors are the fixtures: see [test/fixtures/README.md](test/fixtures/README.md) for which are copies of ODK's own sample forms (Apache-2.0) and which are synthetic.

## 7. Citation and Software Heritage  **(not yet possible)**

- [CITATION.cff](CITATION.cff) holds the citation metadata; author, repository and version are filled in; `date-released` is added when the v0.1.0 tag is made.
- Archive the release at Software Heritage ("Save Code Now": <https://archive.softwareheritage.org/save/>, no account needed) and record the identifier here and in `CITATION.cff`:

  | Item | Value |
  |---|---|
  | Release SWHID | `swh:1:rel:PLACEHOLDER` |
  | Revision SWHID | `swh:1:rev:PLACEHOLDER` |
  | Directory SWHID | `swh:1:dir:PLACEHOLDER` |

  You can check the directory identifier yourself: `swh identify .` (from `swh.model`) on a clean checkout must print the same `swh:1:dir:` value.

## 8. OpenSSF Scorecard  **(placeholder)**

`.github/workflows/scorecard.yml` runs the Scorecard action weekly once the repository variable `ENABLE_SCORECARD` is `true`; it is disabled until the repository is public, because Scorecard reads repository settings (branch protection, code review, signed releases) that do not exist yet. Until then run it by hand against a public clone: `scorecard --repo=github.com/RME-Solutions-Technology/clio-research-kit --show-details`. The score is one signal, not a verdict. When enabled, the badge goes in `README.md`.

## Checklist status

The project's checklist (from the field-tools research) against this repository on 30 October 2026:

| # | Checklist item | Status |
|---|---|---|
| 1 | OpenSSF Scorecard | Workflow written, disabled; needs a public repository |
| 2 | Reproducible builds | `tsc` compile step; reproducibility of the tarball not yet tested (step 1) |
| 3 | Signed releases and provenance | Workflow and plan written, never run (step 2, `docs/release-signing.md`) |
| 4 | SBOM | `scripts/generate-sbom.ts`, CycloneDX 1.6, runtime SBOM is empty (step 3) |
| 5 | Security policy and threat model | `SECURITY.md` (GitHub private reporting, security@cliomuseum.org); `docs/threat-model.md` with tests |
| 6 | Tests and static analysis | Unit, hostile-input and cross-check tests, type checking. No code-coverage figure and no static analyser (CodeQL or similar) yet; measure coverage yourself |
| 7 | Software Heritage | Placeholders only (step 7) |
| 8 | Publish the same evidence for Clio itself | This file, the SBOM, the threat model and the vectors are that evidence for the open repository. A threat model for the signing code is out of scope: that code is not here |

Still open: a human line-by-line code review (none has been done; see docs/ai-use.md), a real secret scanner run, the GBIF validator report, and the Software Heritage identifiers, which exist only after the first release.

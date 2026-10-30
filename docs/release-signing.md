# Release signing and provenance: the plan

Status: **planned, not run.** There is no release yet. `.github/workflows/release.yml` is written so the first release can follow this plan; it has never executed. Nothing below is claimed until a real release has been verified by the steps in [AUDIT.md](../AUDIT.md).

## What a release will contain

| File | What it is |
|---|---|
| `clio-museum-research-kit-<version>.tgz` | The package tarball from `pnpm pack` (the file name follows the package name). |
| `research-kit.cdx.json` | CycloneDX 1.6 SBOM from the lockfile (`scripts/generate-sbom.ts`). |
| `SHA256SUMS.txt` | SHA-256 of the files above. |
| `<tarball>.sigstore.json` | A Sigstore bundle: keyless signature, certificate and transparency-log entry for the tarball. |
| A GitHub artifact attestation | SLSA build provenance for the tarball and the SBOM, stored by GitHub and checkable with `gh attestation verify`. |
| npm provenance (later, optional) | `npm publish --provenance` links the npm package to the commit and workflow that built it. |

## How it works

1. A maintainer tags a commit `vX.Y.Z` after the human review sign-off in [ai-use.md](ai-use.md) and the manual GBIF validator run.
2. The tag triggers `release.yml` on a GitHub-hosted runner. The job runs in a `release` environment that requires a reviewer, so a person approves before anything is signed.
3. Three jobs, so that code from the dependency install never runs next to a signing token. `build` is read-only: it installs from the frozen lockfile, runs every check (including `check:package`), packs the tarball into `release/` (not `dist/`, which is where `tsc` writes), makes the SBOM and `SHA256SUMS.txt`, and uploads them as one artifact. `sign-release` has the write and OIDC permissions but runs no repository code: it downloads that artifact, checks the checksums, signs the tarball with cosign using the workflow's OIDC identity (no long-lived key exists to steal), records SLSA provenance, and creates the GitHub release. `publish-npm` has only OIDC and read access, and runs only when the variable below is set.
4. The `publish-npm` job is switched off (`if: false`; npm publishing is off for now). When it is turned on, and the repository variable `PUBLISH_TO_NPM` is `true`, it publishes to npm with provenance.

**The tag is not verified as signed.** The workflow only checks that the tag exists (`--verify-tag`); `git tag -s` and `git verify-tag` are the maintainers' own practice and nothing in CI enforces them. The signing identity is the workflow file at the tag: `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/vX.Y.Z`, issued by `https://token.actions.githubusercontent.com`. A verifier pins exactly that.

## Why these choices

- **Keyless signing** (Sigstore) instead of a maintained key: nothing to lose, rotate or leak, and the log entry is public. The trade-off is that trust rests on GitHub's identity and Sigstore's public-good service.
- **SLSA level.** GitHub artifact attestations produced from a normal workflow reach SLSA Build level 2 (hosted build platform, signed provenance). Level 3 needs a reusable, isolated builder workflow. The project aims for level 2 first and will not claim more until it has been checked.
- **Pinned actions.** Every `uses:` is pinned to a commit SHA. Dependabot proposes updates.
- **Least privilege.** Workflow permissions default to read-only. `contents: write`, `id-token: write` and `attestations: write` go only to `sign-release`, which installs nothing; `publish-npm` gets `id-token: write` alone.
- **No secrets in CI** except the optional npm token, which is not needed once npm trusted publishing is set up.

## What this does not cover

- A compromised maintainer or a compromised GitHub account that can push a tag and approve the environment. Branch protection, required reviews and two-person approval reduce this; they are repository settings that do not exist until the repository does.
- Reproducible builds. The package is compiled from `src/` with `tsc` (`prepack`), so identical bytes from two machines depend on the same TypeScript version (pinned in the lockfile) and are **not yet tested**; AUDIT.md says how to test it, and the result is recorded there, not assumed.
- Signing individual research packages made by the library. A package carries fixity (SHA-256) but no signature.

## Open decisions before the first release

1. **Publish to npm at all?** `package.json` says `"private": true`. The build already emits JavaScript and `.d.ts` into `dist/`, and `exports` point there; `pnpm run check:package` installs the packed tarball into an empty folder to prove it works. The remaining decision is whether to publish, and npm trusted publishing of a pre-built tarball has not been tried (test on a throwaway package first). The GitHub release works either way.
2. **Package name and scope.** `@clio-museum/research-kit` is kept for now; npm publishing is switched off (`publish-npm` has `if: false`).
3. **GitHub owner and repository: decided.** `RME-Solutions-Technology/clio-research-kit`. The signing identity above contains both.
4. **Environment reviewers** for `release`: at least two people if possible.
5. **Secret scanner** (gitleaks or trufflehog) run before the repository is made public. Neither is installed on the build machine; the grep in `scripts/scrub-check.ts` is not a substitute.

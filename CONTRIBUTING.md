# Contributing

**Status: pre-1.0 (v0.1.0).** Issues and pull requests are welcome at https://github.com/RME-Solutions-Technology/clio-research-kit; the maintainer reviews them by hand.

## Ground rules

- Be kind. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.
- By contributing you agree your contribution is licensed under Apache-2.0 (code) or CC BY 4.0 (files under `schemas/`), as the existing files are. We use the Developer Certificate of Origin: sign off commits with `git commit -s`.
- All test data must be synthetic or have a licence that allows redistribution, recorded in [test/fixtures/README.md](test/fixtures/README.md). Never commit real people, real locations of sensitive species, real tokens or real server addresses.
- AI-assisted contributions are welcome if you say so in the pull request and have read and understood every line. See [docs/ai-use.md](docs/ai-use.md).

## Set up

Node 24 (`.nvmrc`) and pnpm (the version in `packageManager`; use Corepack).

```
pnpm install --frozen-lockfile
pnpm test
pnpm run type-check
pnpm run schemas:check
pnpm run check:imports
pnpm run check:scrub
```

Optional format validators (Python 3.10 or newer):

```
python -m pip install --user -r requirements-validators.txt
node scripts/run-validators.ts
```

## Rules the code follows

- `src/` has no runtime dependencies and imports only its own files and `node:` built-ins. `pnpm run check:imports` enforces it. Do not add a runtime dependency without a discussion.
- Parsers fail closed: a structural problem is an error with a code, never a guess. Values are kept as given; a conversion is applied only when it loses nothing, and doubtful input produces a finding.
- No network access in tests. Connectors take an injected `fetch`; tests pass a mock.
- A change to a lane profile changes `schemas/`: run `pnpm run schemas:generate` and commit the result. Profile versions are immutable once released: add a new version instead of editing one.
- A change to export output changes the test vectors: run `node scripts/generate-vectors.ts`, read the diff, and explain it in the pull request.
- New behaviour comes with a test. New input handling comes with a hostile-input test.

## Pull requests

Describe what changed and why, list the checks you ran, and say how you used AI tools if you did. Keep changes small. A maintainer who did not write the change reviews it before it merges.

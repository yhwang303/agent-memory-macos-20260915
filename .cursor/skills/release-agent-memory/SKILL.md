---
name: release-agent-memory
description: Build and verify Agent Memory release artifacts. Use when the user asks to package, release, publish, build npm packages, Windows exe installers, macOS dmg installers, or generate release artifacts for Agent Memory.
---

# Agent Memory Release

## Required behavior

When the user asks to package, build, release, or publish Agent Memory:

1. Read `docs/superpowers/specs/2026-04-27-release-automation-prd.md`, `docs/superpowers/specs/2026-04-27-release-automation-design.md`, and `CHANGELOG.md`.
2. Run `npm run release:preflight` before building.
3. Use the root release scripts as the only manual entry points:
   - `npm run release:pack:npm`
   - `npm run release:build:win`
   - `npm run release:build:mac`
   - `npm run release:build:all`
   - `npm run release:clean`
4. Report final artifacts from `release-artifacts/v<version>/manifest.json`.
5. Include size and sha256 for every distributable artifact in the final response.

## Safety rules

- Do not run `npm publish` unless the user explicitly asks to publish to npm.
- Do not create git tags, commits, or pushes unless the user explicitly asks.
- Do not delete user files outside release temp/output paths.
- Do not treat `desktop/release5/` as the final output. Final artifacts belong under `release-artifacts/v<version>/`.
- If building on Windows, macOS DMG is expected to be skipped locally; use GitHub Actions or a macOS machine for DMG.

## Standard flows

### Quick local verification

```bash
npm run release:preflight
npm run release:pack:npm
```

### Windows local package

```bash
npm run release:build:win
```

Expected final files:

```text
release-artifacts/v<version>/npm/agent-memory-<version>.tgz
release-artifacts/v<version>/windows/AgentMemory-Setup-<version>.exe
release-artifacts/v<version>/manifest.json
release-artifacts/v<version>/checksums.txt
```

### Full release

```bash
npm run release:build:all
```

On Windows this builds npm + Windows and records macOS as skipped. On macOS this builds npm + macOS and records Windows as skipped. GitHub Actions builds all supported platforms.

### GitHub Release

Push a tag matching the package version:

```bash
git tag v<version>
git push origin v<version>
```

The release workflow uploads npm tarball, Windows exe, macOS DMG, manifest, and checksums.

## Final response format

Keep the response concise:

```text
发布产物已生成：
- npm: <path> (<size>) sha256=<sha>
- windows: <path> (<size>) sha256=<sha>
- macos: skipped locally, use GitHub Actions

验证：
- preflight passed
- typecheck/tests/check:bun passed or explain skipped reason
```

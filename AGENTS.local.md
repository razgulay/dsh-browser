# Local agent rules for this checkout

This overlay is not committed (see `.gitignore`). It records machine-specific
rules that every agent session must follow when working on dsh-browser here.

## The extension Chrome loads is NOT the one you build

Chrome loads the installer-managed folder:

```
C:\Users\Lucy\.dsh\browser-extension
```

The repo build lands in `extensions/dsh-browser/dist`. Those are different
directories. **Building alone changes nothing when the extension is reloaded** —
the installed copy keeps the previous build. This has already cost one full
debugging round: a fix was written, built, and unit-tested, yet the user saw no
change because they were reloading the untouched managed copy.

## Required: build and sync after every extension source change

Whenever you touch anything under `extensions/dsh-browser/src/**` (panel,
background, content, security, shared, i18n, styles) — or the manifests, the
Vite configs, or `_locales` — finish the job yourself before reporting back:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev-sync.ps1
```

Run it yourself. Do not tell the user to run it. They have no reason to; the
agent owns the code change, so the agent owns making it observable.

The script builds, mirrors into the managed folder while preserving
`install-info.json`, and verifies the bundle hash changed. Then state plainly
that the user must click **Reload** in `chrome://extensions` and **close and
reopen the side panel** — those two steps genuinely need the user, because only
Chrome can reload an unpacked extension.

`-ExecutionPolicy Bypass` is required: this machine blocks unsigned scripts.

## What does not need the sync

- `packages/browser/bridge-browser/**` — the host plugin runs from the DSH
  process, not from the managed extension folder. Rebuild it with
  `pnpm --filter @yuxianglin/dsh-bridge-browser run build` and restart dsh.
- Pure test or README edits with no bundled output change.

## Verify before claiming it works

- `pnpm --filter dsh-browser-extension run test` — 677 tests.
- `pnpm --filter dsh-browser-extension exec tsc -p tsconfig.json --noEmit` — typecheck.
  The build does **not** typecheck; Vite only strips types, so a green build
  says nothing about type correctness.
- Run vitest through the package's own binary when `pnpm run` misbehaves:
  `cd extensions/dsh-browser; node node_modules\vitest\vitest.mjs run`.

## Environment notes

- Windows PowerShell 5.1 is what runs the scripts. Any `.ps1` in `scripts/`
  that contains Chinese text **must** be saved as UTF-8 **with BOM**, or 5.1
  reads it in the ANSI codepage and mangles every Chinese line.
- `pnpm install` needs to spawn child processes (esbuild, node-pty). Under a
  restricted sandbox it fails with `EPERM` and leaves a half-linked
  `node_modules` (`.ignored_*` entries, missing `std-env` and friends). If the
  install looks incomplete, delete `node_modules` and reinstall outside the
  sandbox rather than patching around it.
- Two dsh extensions may be loaded in the same Chrome profile. Only
  `C:\Users\Lucy\.dsh\browser-extension` is this repo; a `DSH-Browser-Control-*`
  folder is an unrelated third-party project.

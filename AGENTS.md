# Agent Guide: app-retro-web

## Purpose

Retro Web is a self-hosted Home Assistant app that provides a profile-based
retro-game library powered by EmulatorJS. ROMs and BIOS files remain local
under `/data`; the app must not download or distribute copyrighted media.

## Repository layout

- `retro-web/`: Home Assistant app source.
- `retro-web/app/`: Express API, SQLite database, storage, emulator metadata,
  covers, titles, TLS, and server startup.
- `retro-web/public/`: browser UI and EmulatorJS integration.
- `retro-web/scripts/`: asset synchronization and build-time transformations.
- `retro-web/test/server.test.js`: Node test suite.
- `retro-web/translations/`: Home Assistant option translations.
- `retro-web/DOCS.md`: end-user app documentation.
- `.github/workflows/`: shared CI and release workflows.

## Working rules

- Prefer small, focused changes that preserve the existing behavior.
- Keep the server-side source in ESM JavaScript and browser code framework-free.
- Use the existing SQLite schema and migration helpers when extending data.
- Store user media under `/data`, never in the repository or vendor directory.
- Preserve profile isolation for ROM-backed assets and saves.
- Validate certificate and key pairs before starting HTTPS.
- Keep Ingress on HTTP port `8099`; external access uses HTTPS port `8098`.
- Do not commit ROMs, BIOS files, certificates, private keys, secrets, or `/data`.
- Use Prettier on changed JavaScript and Markdown files.
- Run the smallest relevant tests first, then the complete suite.
- Use Conventional Commit messages.
- Do not commit or push unless the user explicitly asks.

## Commands

Run from `retro-web/`:

```sh
npm install
npm run postinstall
npm test
npx prettier --write <files>
npx prettier --check <files>
docker build --tag retro-web-test .
```

The asset script copies the installed EmulatorJS package into
`public/vendor/emulatorjs/` and regenerates the minified bundle.
`public/vendor/` is generated and ignored by Git.

## Architecture

- `server.js` starts separate Ingress and external Express apps.
- The external app authenticates users and optionally elevates administrators.
- `database.js` stores profiles, games, progress, and saves.
- `storage.js` manages the `/data` directory.
- EmulatorJS runs in the browser and receives ROM/BIOS resources as URLs or files.
- Saves are profile-specific and validated with core, emulator, and ROM hashes.
- Save states use chunked transfer for files larger than Home Assistant Ingress
  limits.

## Home Assistant configuration

- `ssl: false`: generate and persist a self-signed external certificate.
- `ssl: true`: use `certfile` and `keyfile` below `/ssl`.
- `external_access`: enables the authenticated external listener.
- `allow_external_rom_upload`: enables external administration only when
  credentials and elevation are configured.
- `enable_arcade`: enables FinalBurn Neo/FBNeo Arcade uploads.

## Current Arcade work

Arcade support uses the EmulatorJS `fbneo` core. The current implementation
must preserve the original uploaded filename for Arcade ROMs and BIOS bundles.
The browser sends the ROM and BIOS names to EmulatorJS, and the build script
patches the EmulatorJS BIOS loading path so `neogeo.zip` and other BIOS archives
are written to the Emscripten filesystem without folder extraction.

For Arcade troubleshooting, distinguish:

1. Missing ROMsets or CRC mismatches.
2. Missing parent or BIOS archives.
3. EmulatorJS delivering the wrong filename.
4. EmulatorJS caching an older ROM or BIOS asset.

Do not claim that arbitrary files from MAME/MAME4droid versions are compatible.
FBNeo ROMsets must match the FBNeo revision shipped by EmulatorJS.

## Before completing changes

1. Inspect the diff.
2. Run Prettier.
3. Run `npm test`.
4. Run `npm run postinstall` if EmulatorJS assets or build code changed.
5. Build the Docker image for AMD64 and ARM64 when packaging changed.
6. Report unresolved runtime-only checks explicitly.

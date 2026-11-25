# Project Memory: app-retro-web

## Stable facts

- Git workflow: every new integration or change starts on a dedicated branch
  using `feature/`, `fix/`, or another appropriate prefix.
- Branch synchronization workflow after an approved and merged PR:
  1. Switch to `main`.
  2. Run `git fetch origin main`.
  3. Run `git pull --ff-only origin main`.
  4. Verify the working tree is clean.
  5. Create the next `feature/` or `fix/` branch from the updated `main`.
  6. Do not reuse or continue work on the branch whose PR was merged.
- Repository: `ioncb-hassio-addons/app-retro-web`.
- Main app source: `retro-web/`.
- Application name: `Retro Web`.
- EmulatorJS version: `4.2.3`.
- Supported platforms:
  - NES/FCEUmm
  - SNES/Snes9x
  - Game Boy and Game Boy Color/Gambatte
  - Game Boy Advance/mGBA
  - Nintendo 64/Mupen64Plus-Next
  - Arcade/FBNeo
- Ingress listener: HTTP port `8099`.
- External listener: HTTPS port `8098`.
- Persistent app data: `/data`.
- UI languages: Spanish and English.

## Implementation history

- Migrated the project from Home Assistant add-on naming to app naming.
- Added profile-isolated native saves and save states.
- Added IndexedDB caching for browser assets and profile saves.
- Added chunked save synchronization to work around the 16 MiB Ingress body
  limit.
- Fixed save-state loading to apply state to the running WASM core instead of
  destroying and recreating the EmulatorJS instance.
- Added service-worker caching for EmulatorJS assets.
- Added TLS modes:
  - `ssl: false`: persistent self-signed certificate.
  - `ssl: true`: certificate and key from `/ssl`.
- Added certificate logs for generated, reused, and Home Assistant certificates.
- Added English and Spanish translations for every Home Assistant option.

## TLS

- `ssl` must not be confused with `certificate_mode`; only `ssl` is used.
- `certfile` defaults to `fullchain.pem`.
- `keyfile` defaults to `privkey.pem`.
- Certificate names are restricted to safe filenames; paths and `..` are rejected.
- The key must be `0600`; certificates are validated for validity and key match.
- OpenSSL must be available in both Docker stages.

## Arcade findings

- Arcade support is controlled by `enable_arcade: true/false`.
- Arcade ROMs use the `fbneo` core.
- EmulatorJS's BIOS loader normally extracts BIOS archives.
- Arcade BIOS archives such as `neogeo.zip` must remain ZIP archives with exact
  names in the emulator filesystem.
- Arcade ROM and BIOS names are significant; generic Blob URLs may lose the
  original filename.
- FBNeo does not accept arbitrary partial or mixed MAME/MAME4droid ROMsets.
- A ROMset with missing files or CRC mismatches can be known by FBNeo while
  still failing to start.
- Street Fighter III: 3rd Strike arcade belongs to CPS-3. Retro Web currently
  has only the FBNeo core, not a separate CPS-3 core.

## Current working state

The project now includes implemented work for:

- automatic state lookup and server fallback confirmation;
- SPA emulator restart and save-on-exit behavior;
- categorized library sections and platform browsing;
- manual ROM/BIOS folder indexing;
- SHA-1, CRC32, versions, deletion tracking, and manual reindex endpoints;
- strict Libretro cover lookup sequence.
- Initial state lookup prioritizes a compatible local state, then compares the
  server state hash and timestamp before offering it in the server dialog.

A next model should verify real browser behavior, Docker builds, and Indexer
runtime behavior. Commit or push only after explicit user approval unless the
repository rules and task workflow already require a pull request.

## Known validation commands

```sh
cd retro-web
npm test
npm run postinstall
npx prettier --check <changed-files>
docker build --tag retro-web-test .
```

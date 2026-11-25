# Architectural Decisions

## ADR-001: Keep Retro Web as a Home Assistant app

The repository uses Home Assistant app metadata and conventions:

- `config.yaml`
- Ingress support
- `/ssl` mapping
- `translations/*.yaml`
- rootfs s6 services

Ingress remains the primary local interface. The external listener is optional
and disabled by default.

## ADR-002: Use Express and SQLite

Node.js and Express provide the API and static file server. SQLite stores
profiles, games, progress, saves, and metadata. Files and media remain under
`/data` for backup and separation from application code.

## ADR-003: Use EmulatorJS assets locally

EmulatorJS assets are copied and built by `scripts/sync-emulator-assets.mjs`.
The app must not depend on a runtime CDN for core assets. The Docker build
generates a local vendor bundle and core data.

## ADR-004: Identify ROMs by SHA-256

ROM storage paths use hashes instead of original filenames. Display titles are
editable and independent. Original filenames are still preserved separately
where required by an emulator core, especially Arcade.

## ADR-005: Keep saves profile-isolated

Every save belongs to a profile, game, core, save type, and slot. Writes are
atomic and incompatible writes are rejected. Save-state restoration reloads the
emulator because WebAssembly cores do not accept an arbitrary state as a safe
runtime injection.

## ADR-006: Chunk large save transfers

Saves use 1 MiB chunks and metadata/hash validation to avoid Home Assistant
Ingress request-body limits. The browser and server both support chunked uploads
and downloads.

## ADR-007: Use HTTPS for external access only

Ingress remains HTTP on `8099`. External port `8098` always uses HTTPS:

- `ssl: false`: persistent self-signed certificate.
- `ssl: true`: valid certificates mounted from `/ssl`.

Plain HTTP to `8098` is not an alternate listener and must not silently fall
back.

## ADR-008: Preserve Arcade archive names

FBNeo requires exact archive names and complete ROMset contents. Blob URLs,
cached assets, and generic EmulatorJS file extraction can hide or change names.

Therefore, the browser preserves the original Arcade ROM filename and BIOS
filename. Build-time asset synchronization patches EmulatorJS so Arcade BIOS
ZIP files are mounted by name instead of extracted generically.

This is a known compatibility adaptation, not a guarantee that every
MAME/MAME4droid ROMset revision will run.

## ADR-009: Use FBNeo for Arcade

The app exposes one Arcade core: `fbneo`.

This core can run CPS-3-era Arcade ROMsets, but it is not a separate CPS-3
platform entry. The user must provide complete ROMsets matching the FBNeo
revision shipped with EmulatorJS.

## ADR-010: Documentation and validation

Use English and Spanish UI translations. Keep `config.yaml`, `DOCS.md`,
translations, and runtime defaults synchronized.

Before merging, run Prettier and Node tests. Validate real HTTPS separately
inside Docker or a Home Assistant environment. Docker builds should cover both
AMD64 and ARM64.

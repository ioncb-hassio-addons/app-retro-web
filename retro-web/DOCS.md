# Retro Web

Retro Web provides a private browser-based library for legally acquired retro
games. The app is intentionally self-hosted: ROMs, BIOS files, metadata,
profiles, and saves remain under `/data`.

## Requirements and legal use

You are responsible for the legality of every ROM and BIOS file you upload.
Retro Web does not include, search, or distribute game media.

Emulator compatibility varies by game and core. Nintendo 64 and Arcade titles
may require additional memory, CPU, or BIOS files.

## First start

1. Install Retro Web from the desired channel.
2. Open **Retro Web** from the Home Assistant sidebar.
3. Create one or more profiles.
4. Open **Administrar** and upload a ROM.
5. Select the matching platform.
6. Return to the library and launch the game.

The app creates a default `Player 1` profile on first start.

## ROM upload

ROM upload is available inside Home Assistant Ingress. Supported formats:

| Platform         | Extensions     | Default core       |
| ---------------- | -------------- | ------------------ |
| NES              | `.nes`, `.fds` | `fceumm`           |
| SNES             | `.sfc`, `.smc` | `snes9x`           |
| Game Boy / Color | `.gb`, `.gbc`  | `gambatte`         |
| Game Boy Advance | `.gba`         | `mgba`             |
| Nintendo 64      | `.z64`, `.n64` | `mupen64plus_next` |
| Arcade           | `.zip`, `.7z`  | `fbneo`            |

ROM names are not used as filesystem paths. Retro Web identifies uploaded
content by SHA-256 hash and stores an editable display title separately.

Selecting a ROM automatically fills the title from its filename. Underscores,
dots, and repeated spaces are normalized. The generated title remains editable;
only the filename is used as fallback if the administrator clears the field.

## Covers

A cover can be selected from the local computer while uploading a ROM. The
preview remains in the browser until the upload is confirmed. Retro Web accepts
PNG, JPEG, and WebP covers and rejects SVG, malformed images, or images over
the size and dimension limits.

The administrator can also search public box art in the Libretro Thumbnails
repositories. Searches are initiated manually, performed by the backend, and
limited to supported platform repositories. Up to 12 candidates are shown.

After a candidate is selected, Retro Web downloads and caches the image under
`/data/covers`. Gameplay and future visits use this local copy and do not depend
on the cover provider remaining online.

## Language

The interface supports Spanish and English. The first language is detected from
the browser. Selecting a language from the interface stores it in the active
profile, allowing different players to use different languages.

## BIOS upload

BIOS files are managed separately from ROMs. Upload only BIOS files you are
legally authorized to use.

The current MVP supports optional BIOS files or bundles for:

- Nintendo 64.
- Arcade.

Nintendo 64 games normally run without BIOS. A BIOS can be uploaded for optional
features such as 64DD. Arcade ROM sets may require a matching BIOS bundle. The
original filename and extension are preserved for EmulatorJS. For Arcade
systems that require several BIOS files, upload a compatible ZIP bundle.

## Profiles and saves

Each native save and save state belongs to:

- Profile.
- Game.
- Emulator core.
- Save type.
- Slot.

Profiles cannot read or replace another profile's save files. Every write is
atomic, and the previous slot is retained as `.previous`.

Saving requires the server request to complete. If a request fails, Retro Web
shows an error and must not be treated as a successful save.

## External access

External access is disabled by default. Enabling it:

1. Set `external_access` to `true`.
2. Configure `external_username` and `external_password`.
3. Expose container port `8098` using the Home Assistant app network settings.
4. Put the port behind an HTTPS reverse proxy.

The external listener only exposes gameplay and profiles. Administrative
routes return `404` while external upload is disabled.

## Optional external administration

External administration is also disabled by default.

To enable it:

1. Set `allow_external_rom_upload` to `true`.
2. Configure `external_admin_password`.
3. Sign in with the regular external username/password.
4. Select **Administrar** and enter the separate admin password.

The admin elevation remains limited to the session and expires with it. Set
the admin password to a different value from `external_password`.

## Backups

Back up the app's complete `/data` directory. It contains:

- `app.db`.
- ROMs.
- BIOS files.
- Cover images.
- Profiles.
- Native saves.
- Save states.

Restore the directory while the app is stopped to prevent partial writes.

## Troubleshooting

- A black screen can indicate an unsupported ROM/core or missing BIOS.
- Save-state files only work with the same core version.
- Do not use an HTTP-only external endpoint on an untrusted network.
- Arcade ROM sets must match the selected FinalBurn Neo core.
- Restart the app after changing options.

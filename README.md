# Retro Web Home Assistant App

Profile-based retro game library for Home Assistant, powered by EmulatorJS.

## Features

- Netflix-style local profiles.
- NES, SNES, Game Boy/Color, Game Boy Advance, Nintendo 64, and Arcade.
- ROM and BIOS administration through Home Assistant Ingress.
- Per-profile native saves and save states stored on the server.
- Optional external access protected by username and password.
- External ROM/BIOS administration disabled by default.
- Responsive keyboard, touch, and gamepad controls.
- English and Spanish UI with a saved preference per profile.
- ROM titles generated from filenames and editable during upload.
- Manual cover preview and optional Libretro Thumbnails search.
- Self-hosted EmulatorJS assets with no runtime CDN dependency.

## Legal notice

Retro Web does not include, download, or distribute ROMs or BIOS files. You must
only load media that you are legally authorized to use.

## Configuration

External access is disabled by default. Configure it in the app options and
then expose the app's external port through your reverse proxy or firewall.

To allow external administrators to upload ROMs and BIOS files, enable
`allow_external_rom_upload` and set a separate
`external_admin_password`. This mode is intentionally opt-in.

See [DOCS.md](retro-web/DOCS.md) for complete instructions.

## Development

```bash
cd retro-web
npm ci --include=dev --omit=optional
npm test
node scripts/sync-emulator-assets.mjs
```

## License

MIT

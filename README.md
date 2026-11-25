# IonCB Home Assistant App: Retro Web

[![GitHub Release][releases-shield]][releases]
![Project Stage][project-stage-shield]
[![License][license-shield]](LICENSE.md)

[![GitHub Actions][github-actions-shield]][github-actions]
![Project Maintenance][maintenance-shield]
[![GitHub Activity][commits-shield]][commits]

Retro Web is a profile-based retro game library for Home Assistant.

## About

Retro Web provides a self-hosted browser interface powered by EmulatorJS.
Each player can choose a profile and continue their games with native saves and
save states stored by profile on the server.

It provides:

- Local profiles.
- NES, SNES, Game Boy/Color, Game Boy Advance, Nintendo 64, and Arcade.
- ROM and BIOS administration through Home Assistant Ingress.
- Per-profile native saves and save states.
- Optional external access protected by username and password.
- External ROM/BIOS administration disabled by default.
- Responsive keyboard, touch, and gamepad controls.
- Spanish and English with a preference saved per profile.
- ROM titles generated from filenames.
- Manual covers and optional Libretro Thumbnails search.
- Self-hosted EmulatorJS assets without a runtime CDN dependency.

Retro Web does not include, download, or distribute ROMs or BIOS files. Use only
media that you are legally authorized to copy and emulate.

[:books: Read the full app documentation][docs]

## Support

Got questions?

You could also [open an issue here][issue] on GitHub.

## Contributing

This is an active open-source project. We are always open to people who want to
use the code or contribute to it.

We have set up a separate document containing our
[contribution guidelines](.github/CONTRIBUTING.md).

Thank you for being involved! :heart_eyes:

## Authors & contributors

The original setup of this repository is by [Jhon Coronel][jhoncb].

For a full list of all authors and contributors,
check [the contributor's page][contributors].

## We have got some Home Assistant apps for you

Want some more functionality in your Home Assistant instance?

Check the complete list in our [GitHub repository][repository].

## License

MIT License

Copyright (c) 2026 Jhon Coronel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

[commits-shield]: https://img.shields.io/github/commit-activity/y/ioncb-hassio-addons/app-retro-web.svg
[commits]: https://github.com/ioncb-hassio-addons/app-retro-web/commits/main
[contributors]: https://github.com/ioncb-hassio-addons/app-retro-web/graphs/contributors
[docs]: https://github.com/ioncb-hassio-addons/app-retro-web/blob/main/retro-web/DOCS.md
[github-actions-shield]: https://github.com/ioncb-hassio-addons/app-retro-web/workflows/CI/badge.svg
[github-actions]: https://github.com/ioncb-hassio-addons/app-retro-web/actions
[issue]: https://github.com/ioncb-hassio-addons/app-retro-web/issues
[jhoncb]: https://github.com/jhoncb
[license-shield]: https://img.shields.io/github/license/ioncb-hassio-addons/app-retro-web.svg
[maintenance-shield]: https://img.shields.io/maintenance/yes/2026.svg
[project-stage-shield]: https://img.shields.io/badge/project%20stage-experimental-orange.svg
[releases-shield]: https://img.shields.io/github/release/ioncb-hassio-addons/app-retro-web.svg
[releases]: https://github.com/ioncb-hassio-addons/app-retro-web/releases
[repository]: https://github.com/ioncb-hassio-addons/repository

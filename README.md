# Mod Manager

Desktop mod manager for **Thunderstore** games and **Minecraft** (Modrinth), with a Discord-style UI and one-paste profile sharing.

## Download

Get the latest from [Releases](https://github.com/V3rkku1/mod-manager/releases/latest):

- Windows: `ModManager-Setup-x.y.z.exe` (recommended, auto-updates) or `ModManager-x.y.z-portable.exe` (no install, no auto-update)
- Linux: `ModManager-x.y.z.AppImage` (auto-updates)
- macOS: `ModManager-x.y.z.dmg` (unsigned, no auto-update)

The installed app checks GitHub Releases on start and every hour, downloads new versions in the background, and shows a green **Update ready — restart** button in the title bar.

## Release a new version

1. Bump `version` in `package.json`.
2. Commit and push, then either push a tag (`git tag v0.4.0 && git push origin v0.4.0`) or run **Actions → Build → Run workflow**.

GitHub Actions builds Windows/macOS/Linux and publishes the release. Everyone on the installer build gets it automatically.

## Run from source

```bash
npm install
npm start
```

Build locally: `npm run dist` (Windows installer needs Windows or Wine; `npx electron-builder --win portable` works anywhere).

## Use

1. **+** → pick a game from the cover grid, or Minecraft version + loader, or **Import code**.
2. **Browse** → search, sort, install. Dependencies install automatically.
3. **Installed** → toggle mods on/off, update one or all, remove.
4. Pencil next to **Target folder** → game install folder, or `.minecraft` / launcher instance folder.
5. **Deploy mods** → copies enabled mods there. Re-deploying removes what the last deploy added.
6. **Share** → copy the code and send it. Friends paste it into **Import code** for the exact same mods and versions.

## Notes

- Thunderstore mods use the BepInEx layout. Games with other loaders aren't handled.
- Deploy overwrites same-named files in the target folder.
- Share codes contain the mod list only, not config files.

`npm test` runs a live check against both APIs.

# Mod Manager

Desktop mod manager for **Thunderstore** games and **Minecraft** (Modrinth), with a Discord-style UI and one-paste profile sharing.

## Download

Every push builds installers in GitHub Actions (Actions → latest "Build" run → Artifacts):

- Windows: `Mod Manager Setup x.y.z.exe` (installer) and `Mod Manager-x.y.z-portable.exe` (no install)
- macOS: `.dmg`, Linux: `.AppImage`

Push a tag like `v0.2.0` to publish them as a GitHub Release.

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

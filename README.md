# Mod Manager

Windows mod manager with a Discord-style UI and one-paste profile sharing. Sources: **Thunderstore**, **Minecraft** (Modrinth mods + modpacks, CurseForge), **CurseForge**, **Nexus Mods**, **GameBanana**.

## Download

Get the latest from [Releases](https://github.com/V3rkku1/mod-manager/releases/latest):

- Windows: `ModManager-Setup-x.y.z.exe` (recommended, auto-updates) or `ModManager-x.y.z-portable.exe` (no install, no auto-update)

The installed app checks GitHub Releases on start and every hour, downloads new versions in the background, and shows a green **Update ready — restart** button in the title bar.

## Release a new version

1. Bump `version` in `package.json`.
2. Commit and push, then either push a tag (`git tag v0.4.0 && git push origin v0.4.0`) or run **Actions → Build → Run workflow**.

GitHub Actions builds the Windows installer + portable exe and publishes the release. Everyone on the installer build gets it automatically.

## Run from source

```bash
npm install
npm start
```

Build locally: `npm run dist` (installer needs Windows or Wine; `npx electron-builder --win portable` works anywhere).

## Use

1. **+** → pick a source and a game (or Minecraft version + loader), or **Import** a code / `.mmpack` file.
2. **Browse** → search, sort, install. Click a mod for its description, screenshots and older versions.
3. **Installed** → toggle mods on/off, update one or all, remove.
4. Target folder: the target icon finds the game in your Steam libraries; the pencil picks it by hand.
5. **Deploy** copies enabled mods there. **Play** deploys and starts the game (Steam or Minecraft Launcher).
6. **Share**:
   - *Mod list code* (`MM1…`): short, paste in Discord.
   - *Code with configs* (Thunderstore): uploads your BepInEx configs; also works in r2modman.
   - *Save as file* (`.mmpack`): mods + configs, send the file.

## API keys (Settings, gear icon)

- **CurseForge**: free key from console.curseforge.com.
- **Nexus Mods**: personal key from Account → API access. Premium accounts download directly; free accounts turn on "Handle Nexus Mod Manager Download buttons" and click that button on the Nexus site.

## Notes

- Thunderstore mods use the BepInEx layout. Games with other loaders aren't handled.
- CurseForge (non-Minecraft), Nexus and GameBanana mods are unpacked as-is into the target folder: point it at the game's mods folder.
- Nexus has no dependency info in its API; install requirements yourself.
- Deploy overwrites same-named files in the target folder.

`npm test` runs a live check against both APIs.

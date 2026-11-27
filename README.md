# Mod Manager

Windows mod manager with a Discord-style UI and one-paste profile sharing. Sources: **Thunderstore**, **Terraria** (tModLoader, Steam Workshop), **Minecraft** (Modrinth mods + modpacks, CurseForge), **CurseForge**, **Nexus Mods**, **GameBanana**.

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
3. **Installed** → select several for bulk update/enable/disable/remove, pin versions, add notes, see which mod needs which dependency (unused ones are offered for removal), conflict warnings.
   toggle mods on/off (or **Disable all** to play the unmodded game), update one or all, remove.
   Browse has category chips, sections (Thunderstore) and page numbers.
4. Target folder: the target icon finds the game in your Steam libraries; the pencil picks it by hand.
5. **Deploy** copies enabled mods there. **Play** deploys and starts the game (Steam or Minecraft Launcher).
6. **Share**:
   - *Mod list code* (`MM1…`): short, paste in Discord.
   - *Code with configs* (Thunderstore): uploads your BepInEx configs; also works in r2modman.
   - *Save as file* (`.mmpack`): mods + configs, send the file.

## Sharing with friends

- **Invite link**: Share > Invite link. Friends click it in Discord and the app imports the profile. (Needs GitHub Pages on this repo: Settings > Pages > deploy from branch, folder `/docs`.)
- **Live share**: Share > Publish (needs a GitHub token with `gist` scope in Settings). Friends who open the link follow your profile and see "Your friend updated this pack > Sync now" whenever you press Update.
- **Import preview**: pasting a code shows the pack and lets you sync it into an existing profile, with a list of new / changed / extra mods.

## Minecraft server

Server tab (Minecraft profiles), a self-hosting panel similar to SquidServers:

- Start / Stop / Restart on this PC: Vanilla, Fabric, Forge or NeoForge, Java installed automatically.
- Modpacks: the server gets the profile's mods minus client-only ones. Every jar is checked on Modrinth by SHA1, so this works for modpacks, CurseForge and local files too.
- No port forwarding: "Get public address" opens a free bore.pub tunnel. "Copy invite link" sends friends the mods + server address.
- Bedrock crossplay: Geyser + Floodgate (Fabric/NeoForge), Bedrock address shown (LAN; UDP).
- Console with commands, Players (online list, op/kick/ban, whitelist), Settings (startup + server.properties editor: game mode, difficulty, PvP, seed, max players, whitelist…), Backups (back up now, back up on stop, restore, delete).
- Auto-restart after crashes (max 3 in 10 minutes).
- Closing the window while a server runs keeps it running in the tray.

## Minecraft launcher

Minecraft profiles launch the game themselves: Vanilla, Fabric, Quilt, Forge, NeoForge, any version incl. snapshots. Java is downloaded automatically (Mojang runtimes).

- Tabs: Browse (Modrinth/CurseForge, categories, client/server filter, Following), Installed (drag and drop local files), Worlds (quick play worlds/servers), Logs (live + old logs, crash reports), Options (memory, Java, JVM args, env vars, window size, fullscreen, pre-launch/wrapper/post-exit hooks, repair, export .mrpack, duplicate).
- Import: .mrpack files and Prism/MultiMC, CurseForge, ATLauncher, GDLauncher instance folders.
- Right-click a profile: duplicate, change icon, group, open folder, delete.
- Play time is tracked per profile.

### Microsoft login

Microsoft requires every launcher to have its own app ID:

1. Register an app at https://portal.azure.com (App registrations, "Personal Microsoft accounts only", enable "Allow public client flows").
2. Request Minecraft API access for that app ID: https://aka.ms/mce-reviewappid (Mojang approves it; can take days).
3. Paste the client ID in Settings, then "Add Microsoft account".

## API keys (Settings, gear icon)

- **CurseForge**: free key from console.curseforge.com.
- **Nexus Mods**: personal key from Account → API access. Premium accounts download directly; free accounts turn on "Handle Nexus Mod Manager Download buttons" and click that button on the Nexus site.

## Terraria

Terraria profiles use tModLoader mods from the Steam Workshop. The app downloads Valve's steamcmd on first install and fetches mods anonymously into `Documents/My Games/Terraria/tModLoader/Mods`, then writes `enabled.json`. Play starts tModLoader through Steam. Mods enabled outside this profile get turned off on Deploy.

## Notes

- Thunderstore mods use the BepInEx layout. Games with other loaders aren't handled.
- CurseForge (non-Minecraft), Nexus and GameBanana mods are unpacked as-is into the target folder: point it at the game's mods folder.
- Nexus has no dependency info in its API; install requirements yourself.
- Deploy overwrites same-named files in the target folder.

`npm test` runs a live check against both APIs.

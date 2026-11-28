# Mod Manager

Windows mod manager with a Discord-style UI and one-paste profile sharing. Sources: **Thunderstore**, **Terraria** (tModLoader, Steam Workshop), **Minecraft** (Modrinth mods + modpacks, CurseForge), **CurseForge**, **Nexus Mods**, **GameBanana**.

**First time? See [SETUP.md](SETUP.md)** (also in the app: Settings → Setup).

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
   Select all / Shift-click a range, sort the view (name, newest, updates first, disabled last), drag mods to change which one wins file conflicts.
   **Paste list**: mod names, Modrinth/Thunderstore links or IDs, one per line, installed in one go.
4. Target folder: the target icon finds the game in your Steam libraries; the pencil picks it by hand.
5. **Deploy** copies enabled mods there. **Play** deploys and starts the game (Steam or Minecraft Launcher).
6. **Share**:
   - *Mod list code* (`MM1…`): short, paste in Discord.
   - *Code with configs* (Thunderstore): uploads your BepInEx configs; also works in r2modman.
   - *Save as file* (`.mmpack`): mods + configs, send the file.

## Safety & convenience

- History (Installed tab): snapshots of the mod list before Update all, syncing and bulk removals; restore re-downloads those exact versions.
- Failed updates keep the old version; removing a mod shows Undo.
- "What's new" changelog before updating (Modrinth, Thunderstore, CurseForge), also per version in mod details.
- Favorites (star on any mod, star button next to search).
- Background update check every 6 hours with badges on the profile icons and a desktop notification.

## Customize

Settings (gear, or Ctrl+,) has sections: Appearance, Accounts, Minecraft, Mod sites, App.

- Themes: Midnight (default, extra dark), AMOLED black, Classic dark, Light; live preview.
- Accent color (8 presets or any color), Comfortable / Compact layout, interface size 80–130%, animations on/off, hide mod descriptions.
- Reopen the last profile and tab on start; the window remembers its size and position.
- Drag profiles on the left bar to reorder them; dropping next to a grouped profile moves it into that group.
- Options → Disk space: profile size, and Clean up removes leftovers of failed or cancelled installs.
- Shortcuts: Ctrl+K switch profile, Ctrl+F search, Ctrl+1–5 tabs, Ctrl+, settings.

## Skyrim, Fallout & other Nexus games (Vortex-style)

- **Own folder per mod.** Two mods can ship the same file. Lower in the Installed list wins; the conflict banner has "Use …" buttons to change the winner.
- **FOMOD installers.** Archives with `fomod/ModuleConfig.xml` open a step-by-step installer (options, pictures, conditions).
- **Data/ folder fix.** Archives that start with `Data/` (Bethesda) or `Mods/` (Stardew, Witcher 3) are unpacked to the right place.
- **Load order.** Options → Plugin load order: drag up/down, turn plugins on/off. Written to `plugins.txt` on Deploy.
- **Tools.** Options → Add tool (LOOT, xEdit, SKSE…), then Run.
- **Purge.** Options → Purge removes every deployed file from the game folder.
- **Hard links.** Settings → App → Deploy with hard links (fast, no extra space; same drive only, falls back to copying).
- **Collections.** Nexus profiles: Options → Browse collections → Install. Needs Nexus Premium for automatic downloads.
- **Endorse** mods from the mod details window (needs your Nexus API key).
- **Epic and GOG** games are found as well as Steam.

## Sharing with friends

- **Invite link**: Share > Invite link. Friends click it in Discord and the app imports the profile. (Needs GitHub Pages on this repo: Settings > Pages > deploy from branch, folder `/docs`.)
- **Live share**: Share > Publish (needs a GitHub token with `gist` scope in Settings). Friends who open the link follow your profile and see "Your friend updated this pack > Sync now" whenever you press Update.
- **Pack website**: https://v3rkku1.github.io/mod-manager/ lets anyone look up a GitHub username, see their published packs and mods, install with one click, and keep a friends list (saved in the browser). Browsing needs no account; only publishing needs a GitHub token.
- **Import preview**: pasting a code shows the pack and lets you sync it into an existing profile, with a list of new / changed / extra mods.

## Friends and shared groups

Needs a GitHub token with `gist` scope (Settings → Mod sites). Everything is stored in public gists on each person's own GitHub; there is no server.

- **Friends** (top of the left bar): add GitHub usernames. Friends who add you back show online / last seen / what they're playing (turn off under Add friend). Updates every 2 minutes.
- **Shared group**: profile → Options → Make shared group, then invite friends. Everyone in the group can add, remove, update and switch off any mod; every member's app keeps the same list (last change per mod wins). Invites appear in the friend's Friends window with a Join button. Play syncs the group first. Leaving or being removed keeps the profile as a normal one.

## Minecraft server

Server tab (Minecraft profiles), a self-hosting panel similar to SquidServers:

- Start / Stop / Restart on this PC: Vanilla, Fabric, Forge or NeoForge, Java installed automatically.
- Modpacks: the server gets the profile's mods minus client-only ones. Every jar is checked on Modrinth by SHA1, so this works for modpacks, CurseForge and local files too.
- No port forwarding: "Get public address" uses playit.gg when you link a free account (Settings > Accounts; stable address, also Bedrock/Geyser and Simple Voice Chat over UDP), otherwise a free bore.pub tunnel (Java only). "Copy invite link" sends friends the mods + server address.
- Bedrock crossplay: Geyser + Floodgate (Fabric/NeoForge), Bedrock address shown (LAN; UDP).
- Console with commands, Players (online list, op/kick/ban, whitelist), Settings (startup + server.properties editor: game mode, difficulty, PvP, seed, max players, whitelist…), Backups (back up now, back up on stop, restore, delete).
- Auto-restart after crashes (max 3 in 10 minutes).
- Server types: this profile (mods), Paper or Purpur (plugins from Modrinth and Hangar), or Bedrock Dedicated Server.
- Scheduler: backups every N hours, restarts every N hours, commands on start and on stop.
- Startup problem finder (port in use, missing dependency, client-only mod, wrong Java, out of memory) and one-click log sharing (mclo.gs).
- Players: bulk op / whitelist / kick / ban, reset a player's inventory, stats and advancements.
- Server icon, MOTD with color preview, resource pack URL with SHA1, force game mode.
- Loader updater (and Fabric API), memory slider with warning, port conflict check, diagnostics (internet, Mojang, tunnel, port, memory).
- App settings: start with Windows, turn automatic updates off.
- Closing the window while a server runs keeps it running in the tray.

## World sync (host when you're not around)

Server > World sync: pick a folder inside Google Drive, OneDrive or Dropbox that you share with your friends. Everyone picks that folder in a profile with the same mods.

- Start: downloads the newest shared world (your old copy goes to Backups) and takes the host lock.
- While hosting: friends see "X is hosting this world now" with the address and a Join button. The world is uploaded every 30 minutes.
- Stop: the world (plus server.properties, ops, whitelist, bans, icon) is uploaded as a new version and the lock is released, so the next friend can host.
- Only one host at a time; a lock older than 3 minutes counts as abandoned.

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

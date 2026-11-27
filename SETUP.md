# Setup: what you need to do (once)

The app shows the same list under **Settings (gear) → Setup**, with buttons that open the right pages and a "Check again" button.

## Needed

1. **Minecraft Launcher**: install it from https://www.minecraft.net/download and sign in once.
   With no Microsoft account linked in the app, **Play** puts your modded instance into the official launcher as a profile, and you press Play there.

## Optional

| Feature | What to do |
|---|---|
| Play without the official launcher or an Azure app ID | Install Prism Launcher (https://prismlauncher.org) or MultiMC, open it once and add your Microsoft account. In Settings, Accounts, set **Play with** to it (default is the official Minecraft Launcher). Play then starts Minecraft through it in the background, with no launcher window. Other paths or forks go in **Launcher path**. |
| Start Minecraft straight from this app | portal.azure.com, then App registrations, then New: "Personal Microsoft accounts only". Under Authentication, set "Allow public client flows" to Yes. Request Minecraft API access at https://aka.ms/mce-reviewappid (Mojang reviews it, which takes days). Then paste the client ID in Settings, Accounts, and press Add Microsoft account. |
| Stable server address, Bedrock and voice chat | Settings, Accounts, then **Link playit.gg account** (free), and approve it in the browser. |
| CurseForge mods | Free key from https://console.curseforge.com. Paste it in Settings, Mod sites. |
| Nexus Mods downloads | Nexus, Account, API access. Paste the key in Settings, Mod sites. |
| Live share + your public pack page (optional) | A GitHub token with only `gist` access: https://github.com/settings/tokens/new?scopes=gist. Paste it in Settings, Mod sites. Published packs appear at https://v3rkku1.github.io/mod-manager/#u/YOUR-GITHUB-NAME. Friends browse and install without any account. |
| World sync (friends host when you're away) | Share a Google Drive, OneDrive or Dropbox folder. Each person picks it under Server, World sync. |

## Releasing a new version

Bump `version` in `package.json`, push, then go to GitHub, Actions, **Build**, and press **Run workflow**. Installed copies update themselves.

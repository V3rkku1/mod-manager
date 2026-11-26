# Mod Manager

Desktop mod manager (Electron) for **Thunderstore** games and **Minecraft** via **Modrinth**, with one-paste profile sharing.

## Run

```bash
npm install
npm start
```

Build an installer to send to friends (`dist/`): `npm run dist`

## Use

1. **+** in the left rail → new profile: pick a Thunderstore game (e.g. `lethal-company`) or Minecraft version + loader.
2. **#browse** → search and install. Dependencies install automatically.
3. **Change** → set the target folder (game install folder, or `.minecraft` / launcher instance folder).
4. **Deploy to folder** → copies the profile's mods there. Re-deploying removes what the last deploy added.
5. **Share code** → copy and send it. Friends paste it into "New profile" to get the exact same mods and versions.

## Notes

- Thunderstore mods are laid out for BepInEx (`BepInEx/plugins/<mod>/…`). Games using other loaders aren't handled.
- Deploy overwrites files with the same name in the target folder.
- Share codes contain the mod list only, not config files.

`npm test` runs a live check against both APIs.

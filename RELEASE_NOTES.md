## What's new in 0.18.1

### Recomps (GTA 6)
- Fixed: Launch could keep building forever and never start the game (a "press any key" at the end of VIctory-NVIDIA's DLSS download step).
- Fixed: Git, Rust, Python or the C++ build tools shown as missing although installed. "I have them" hides the notice.
- Play now asks for what it needs right away: installs missing build tools, then lets you pick the game exe.
- The card and Play button show the current step (Downloading, Building · N parts, Getting files, Preparing shaders).
- Clearer statuses (Not downloaded yet, Needs a build, Ready) and a hint for the first, longer build.
- Tidier cards: Launch and play options up front, everything else in the ⋯ menu.
- Notification when a long build finishes or fails while you're in another window.

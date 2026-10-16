# Mobile slicer and runner

`mobile/` holds a browser slicer for phones and tablets and a runner that passes its output to
Bambu Connect. It shares no code with the C++ slicer; it shares the Bambu Lab profiles.

## Why it is shaped this way

- **Bambu Connect is the only way in.** Printers on Bambu's authorization firmware take prints from
  third-party software through Bambu Connect, which runs on Windows and macOS. Bambu documents a URL
  scheme for handing it a sliced file:
  `bambu-connect://import-file?path=<encodeURIComponent(abs path)>&name=<…>&version=1.0.0`.
  A file path means the file must be on the computer running Bambu Connect, so the phone needs a
  helper there: the runner.
- **The runner serves the app.** A page on an HTTPS host cannot post to `http://<LAN address>`
  (mixed content), and the runner has no certificate. Serving the slicer from the runner keeps both
  on one origin. The same static files also work from any web host in download-only mode.
- **One Go binary per platform.** It embeds `mobile/web`, cross-compiles to Windows `.exe`,
  macOS (universal `.app` in a `.dmg`) and Linux without a C toolchain, and opens URLs through the
  OS handler (`open`, `rundll32 url.dll,FileProtocolHandler`, `xdg-open`) with the URL as one
  argument, never through a shell.

## Pairing and trust

The runner listens on the LAN. Starting a print needs a 128-bit token, kept in the user config
directory so a paired phone stays paired across restarts. The token reaches the phone only through
the QR code on the pairing page, and that page's API (`/api/pairing`, `/api/quit`) answers loopback
clients only. Requests whose `Host` is a domain name are refused, so a DNS-rebinding page cannot reach
loopback under its own origin. Uploads must be a ZIP that carries `Metadata/plate_N.gcode`; names are
reduced to a safe base name inside the prints folder. Bambu Connect still asks the user to choose the
printer and confirm, so the runner never starts a print by itself.

## Slicing pipeline (`mobile/web/js`)

1. `mesh.js` loads STL, OBJ and 3MF (including Bambu projects with `3D/Objects/*.model` components)
   into a triangle soup and places it centred on the bed.
2. `slicer.js` welds vertices, cuts each layer at mid-height and chains the segments through shared
   edges; a vertex exactly on the plane counts as above it, so every crossing is inside an edge.
   Outlines are unioned with Clipper (non-zero, falling back to even-odd for inside-out meshes). Walls
   are successive insets; top and bottom shells are the fill area not covered by `top/bottom_shell_layers`
   neighbours; support columns hang from overhangs steeper than `support_threshold_angle`, and where a
   layer overhangs, all of its new area is supported so gentle slopes form continuous columns.
3. `gcode.js` renders the printer's own templates with a subset of OrcaSlicer's placeholder language
   (`template.js`) and writes the markers Bambu firmware reads (`; HEADER_BLOCK`, `; total layer number`,
   `; CHANGE_LAYER`, `M73 P/R/L`, `M991`).
4. `gcode3mf.js` packs a single plate the way `bbs_3mf.cpp` does with `SaveStrategy::SkipModel |
   WithGcode`: G-code, its upper-case MD5, `slice_info.config` (printer model id, Bambu catalog filament
   id via `resources/printers/bambu_filament_ids.json`), `model_settings.config`,
   `project_settings.config` and a thumbnail.

Slicing runs in a module worker so the UI stays responsive on a phone.

## Profiles

`mobile/tools/build_profiles.py` resolves the supported BBL machine, process and filament presets
(inheritance and `include`s) into `mobile/web/profiles.json`, keeping the first extruder variant of
per-variant lists. CI rebuilds it and fails when the committed file differs, so profile changes in
`resources/profiles/BBL` reach the mobile slicer on purpose.

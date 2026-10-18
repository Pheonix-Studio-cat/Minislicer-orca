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

## User interface

`mobile/web/index.html` and `js/app.js` mirror OrcaSlicer's main window (Prepare/Preview tabs, Slice
plate/Print plate, sidebar with Printer, Filament and Process pages, plate toolbar, preview legend and
sliders) so users of OrcaSlicer or Bambu Studio find their way without learning a new layout. Colours
come from `StateColor.cpp`, `GLCanvas3D.cpp` and `3DBed.cpp`, line-type colours from libvgcode, and the
setting keys edited in the Process page are OrcaSlicer's: `resolveSettings` merges them over the
preset like an edited value in OrcaSlicer's process tab.

The button colour is a CSS variable (`--accent`, with a darker `--accent-dark` for dark mode) from
which hover, focus and checked shades are mixed, so one preference recolours every control.

## Support painting and the flexi cutter

Both act on the slicer through `slice(tris, cfg, progress, extra)`:

- `extra.negatives` is a triangle soup sliced at the same heights as the model and subtracted from
  each layer's outline, as OrcaSlicer subtracts negative parts. The flexi cutter's joint modules
  (`mobile/web/flexi/`) are such soups: a thin curved slot with a ball, a socket and a pin in a
  ring, which splits a limb into two parts that print linked and stay movable.
- `extra.enforcers` and `extra.blockers` are the painted triangles. As in OrcaSlicer
  (`PrintObject::project_and_append_custom_facets`), only downward-facing ones count, and the part
  of each between two slice planes is projected up onto the upper plane. Blockers remove the
  automatic overhang areas under them (with the neighbouring layers, so rounding to a slab cannot
  slip past them); enforcers add their area to the overhangs whatever its angle. Both act only when
  support is enabled, as in OrcaSlicer.

In the app, paint is kept per triangle of the loaded model and joints in the model's own
coordinates, so both follow rotation, scaling and arranging; `modelMatrix()` reproduces
`placeOnBed`'s transform for that. The brush paints whole triangles within its radius that face the
viewer. Input follows tablet drawing apps: once a pen has been used, only the pen paints and
fingers move the view; before that one finger paints and two fingers turn and zoom.

## User presets (`js/presets.js`)

A user preset is stored as OrcaSlicer stores one: its name, the system preset it `inherits`, and the
changed values under OrcaSlicer's option keys. Resolving one merges those values over the system
preset, so a user preset follows profile updates of its base and is offered for every printer whose
system presets include that base. Name checks follow OrcaSlicer's save dialog. Presets live in the
browser's `localStorage` — there is no server to keep them — and export/import as JSON in OrcaSlicer's
user-preset shape, which also lets a single OrcaSlicer user preset be imported.

## Translations

English is the source language. `mobile/tools/build_i18n.py` collects the UI strings (`data-i18n*`
attributes and the string patterns in the scripts) and writes `mobile/web/i18n/<lang>.json`. For each
string it takes OrcaSlicer's translation from `localization/i18n` when OrcaSlicer has the same English
text, so terms match the desktop slicer; where OrcaSlicer translates a word per sense (`msgctxt`) the
script names the sense it needs. Everything else comes from `mobile/tools/i18n_extra.json` and is
listed as machine-translated in the catalog's `_meta`. The extras also replace an OrcaSlicer
translation that has the wrong sense for the mobile UI (the print button's verb where a catalog has
the noun). Languages without an OrcaSlicer catalog come entirely from the extras. The build fails when
a string has no translation, and CI fails when the committed catalogs are stale.

## Profiles

`mobile/tools/build_profiles.py` resolves the supported BBL machine, process and filament presets
(inheritance and `include`s) into `mobile/web/profiles.json`, and copies the icons, printer pictures and bed models the UI uses into
`mobile/web/assets/`. CI rebuilds it and fails when the committed file differs, so profile changes in
`resources/profiles/BBL` reach the mobile slicer on purpose.

Every system process and filament preset compatible with a printer is kept. Per-variant lists are
reduced to the one variant the mobile slicer prints with: the "Direct Drive Standard" variant of the
printer's master extruder.

## Dual-nozzle printers

The H2D, H2D Pro and H2C have two nozzles. With one filament OrcaSlicer prints on the master extruder
(`master_extruder_id`, the right nozzle) and the mobile slicer does the same: the filament is mapped to
that extruder (`filament_map`), the template variables are filled as OrcaSlicer fills them for that
case (physical extruder through `physical_extruder_map`, hotend indices left at -1 so the firmware
picks the nozzle itself), and placement is checked against that extruder's reachable area, which the
plate view shades. `slice_info.config` records the nozzle the plate uses. Printing on the left nozzle
or with two filaments is not supported.

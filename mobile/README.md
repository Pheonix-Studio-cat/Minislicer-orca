# Minislicer Mobile

A slicer for Bambu Lab printers that runs in the browser of a phone or tablet, plus a small
**runner** for the computer that hands the sliced file to **Bambu Connect**.

```
phone / tablet (browser)                 computer with Bambu Connect
┌─────────────────────────┐   Wi-Fi     ┌───────────────────────────┐
│ load STL / 3MF / OBJ    │ ──────────▶ │ Minislicer Runner          │
│ slice → .gcode.3mf      │  POST file  │  saves the file            │
│ "Print with Bambu       │             │  opens bambu-connect://…   │──▶ Bambu Connect ──▶ printer
│  Connect"               │             │                            │    (pick printer, Print)
└─────────────────────────┘             └───────────────────────────┘
```

Bambu Connect exists for Windows and macOS only, and printers with Bambu's authorization firmware
accept prints from third-party slicers only through it. A phone therefore cannot start a print on
its own; the runner is the bridge.

## Using it

1. Install [Bambu Connect](https://wiki.bambulab.com/en/software/bambu-connect) on your computer and
   add your printer there.
2. Download the runner from the **Mobile slicer and runner** workflow's artifacts (Actions tab):
   - Windows: `Minislicer-Runner-<version>-Windows-x64.exe` (or `-arm64`). Double-click it; a console
     window shows the addresses. Close the window to stop it. Windows may warn about an unknown
     publisher (*More info → Run anyway*), and the firewall may ask to allow access on private networks:
     allow it.
   - macOS: `Minislicer-Runner-<version>-macOS.dmg`. See `runner/INSTALL-macOS.txt` (shipped in the
     .dmg) for the one-time Gatekeeper confirmation.
3. The runner opens a page with a QR code. Scan it with the phone or tablet (same Wi-Fi). The slicer
   opens, already paired. Add it to the home screen if you like.
4. Open a model, pick printer, plate, filament and quality, press **Slice**, check the layer
   preview, then **Print with Bambu Connect**. On the computer Bambu Connect opens with the file;
   choose the printer and press Print.

Without the runner the page still slices and offers the `.gcode.3mf` as a download.

## The user interface

It follows OrcaSlicer's main window so it feels familiar: a dark top bar with **Prepare** and
**Preview** and the **Slice plate** / **Print plate** buttons (the arrow next to Print plate exports
the plate sliced file or the G-code), a sidebar with **Printer** (with the printer picture and plate
type), **Filament** and **Process** (Quality, Strength, Speed, Support, Others, with OrcaSlicer's
setting names; edited values turn teal and get an undo arrow), and the 3D plate with the printer's bed model and a toolbar
(add, arrange, rotate, scale). The preview shows OrcaSlicer's line-type colours, a "Line Type" legend
with time per feature, a vertical layer slider and a horizontal move slider. Colours, icons, printer
pictures and bed models are OrcaSlicer's own. On a phone the plate sits above the sidebar, the
tabs show only their icons and the buttons use OrcaSlicer's short labels (**Slice**, **Print**).

The gear in the top bar opens **Preferences**:

- **Language.** English is the default. Also: German, Simplified and Traditional Chinese, Japanese,
  Spanish, French, Italian, Dutch, Portuguese, Polish, Czech, Hungarian, Swedish, Norwegian (Bokmål),
  Danish, Finnish, Ukrainian and Russian. Wherever OrcaSlicer has the same English text, its own
  translation is used, so the wording matches OrcaSlicer. The rest is machine-translated and listed
  in each catalog under `_meta.machine_translated`; OrcaSlicer has no Norwegian, Danish or Finnish
  catalog, so those three are machine-translated throughout.
- **Button colour.** OrcaSlicer's teal, Bambu green, blue, orange, red, purple, or any colour.
- **Presets.** Export all your own presets to a JSON file and import them again (also on another
  device); a single OrcaSlicer user preset (`.json`) imports too.

Language and colour are remembered by the browser.

### Support painting

The **Support Painting** tool (toolbar, next to Scale) works like OrcaSlicer's: paint faces green to
**enforce** support under them or red to **block** it, erase, or erase all; the brush size is
adjustable. With an Apple Pencil (or any pen) the pen paints and fingers turn and zoom the view;
without a pen one finger paints and two fingers turn and zoom; with a mouse the left button paints
and the right button turns the view. As in OrcaSlicer, painted support only takes effect when
support is enabled; the panel says so and has a button for it. Paint stays on the model when it is
rotated or scaled. Unlike OrcaSlicer, whole triangles are painted (OrcaSlicer splits large triangles
under the brush), so on models with large flat faces the brush paints coarser.

### Flexi cutter

The **Flexi cutter** turns a model into a flexi toy: its parts print linked and stay movable. Add a
joint (three modules: two larger ball-and-socket joints and a flat one), tap the model where the
joint goes - it lands in the middle of the limb under your finger - and adjust position, rotation
and size. Each joint is removed from the model like an OrcaSlicer negative part: a thin curved slot
with a ball, a socket and a pin in a ring. The joint's flange must reach past the limb's outline all
round, or the parts stay connected; the module cuts across a limb that runs along X, so turn it
(rotation Z) for limbs in other directions. Joints move and turn with the model.

### Your own presets

As in OrcaSlicer, change process values and press the **save** icon next to the process preset to
keep them under your own name; the trash icon deletes it again. The **edit** icon next to the
filament opens the filament settings (type, density, flow ratio, nozzle and bed temperatures,
volumetric speed, cooling) with **Save as**. Your presets appear under *User presets* in the lists.
Like OrcaSlicer's user presets they store the system preset they are based on and only the changed
values, under OrcaSlicer's option names, and they are offered for every printer that has that system
preset. They live in the browser (`localStorage`): use export/import to keep a copy or move them to
another device.

## What the slicer does

- Printers: A1 mini, A1, A2L, P1P, P1S, X1 Carbon, H2S, H2D, H2D Pro, H2C, 0.4 mm nozzle, with all
  of OrcaSlicer's process presets for each. The dual-nozzle H2D, H2D Pro and H2C print with the
  right nozzle, as OrcaSlicer does for a single filament, and the plate shows the strips that nozzle
  cannot reach. Bed size, start/end G-code, speeds,
  accelerations, temperatures and filament data come from OrcaSlicer's own Bambu Lab profiles
  (`resources/profiles/BBL`), compiled into `web/profiles.json`.
- Outer and inner walls, top and bottom shells, rectilinear sparse infill, optional brim, optional
  support with interface layers, cooling and minimum-layer-time slowdown.
- Output: a single-plate `.gcode.3mf` laid out like OrcaSlicer's "export plate sliced file", or plain
  G-code.

It is deliberately small. Not supported: multi-colour/AMS mapping, several objects with different
settings, variable layer height, arachne walls, gap fill, bridge detection, ironing, tree support,
object skipping on the printer.

> The output has been checked against OrcaSlicer's file layout and with automated tests, **not yet
> on a real printer**. Watch the first print.

## Development

```bash
python3 mobile/tools/build_profiles.py        # after changes in resources/profiles/BBL or resources/images
python3 mobile/tools/build_i18n.py            # after UI text changes or changes in localization/i18n
cd mobile
node --test tests/*.test.mjs                  # slicer, G-code, 3MF (note: the glob, not "tests/")
go test ./...                                 # runner
go run ./runner                               # serve on http://<this computer>:8787
node tests/e2e.mjs <model.stl> [screenshots]  # browser end-to-end check (Linux, needs Playwright)
```

`web/` is a static site without a build step (ES modules, vendored three.js, Clipper and a QR code
generator under `web/vendor/`). The runner embeds `web/` and is a single Go binary per platform;
`runner/package_macos.sh` builds the universal `.app` and `.dmg` on macOS.

## Licences

Minislicer Mobile and the runner are part of Minislicer-orca and licensed under the GNU AGPL v3
(`LICENSE.txt` in the repository root). Because the runner serves the app to other devices, the app,
the pairing page and the runner's console link the source code (AGPL section 13).

Bundled third-party code, with full licence texts in `web/vendor/LICENSES/` and collected in
`web/THIRD-PARTY-NOTICES.txt`:

| Component | Licence |
| --- | --- |
| three.js r180 (`three.*.min.js`, `OrbitControls.js`) | MIT |
| clipper-lib 6.4.2 (`clipper.js`), including Tom Wu's JSBN | Boost Software License 1.0; JSBN licence |
| qrcode-generator 2.0.4 (`qrcode.js`) | MIT |
| Go standard library and runtime (inside the runner binaries) | BSD 3-Clause |
| Flexi cutter modules (`flexi/*.stl`), MakerWorld model 2246181 | CC0 1.0 according to the project owner, not independently verified (`flexi/SOURCE.txt`) |

Printer profiles, icons, printer pictures, bed models and the translations taken from OrcaSlicer's
catalogs (`localization/i18n`) come from this repository itself and are under its AGPL v3. The
machine translations in `mobile/tools/i18n_extra.json` were written for this project.

`LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` ship in the `.dmg`, inside the `.app`, and next to the
Windows and Linux binaries. The runner also serves the notices at `/THIRD-PARTY-NOTICES.txt`.
A runner test checks that the embedded app carries them.

"Bambu Lab" and "Bambu Connect" are Bambu Lab's names; this project is not affiliated with Bambu Lab.

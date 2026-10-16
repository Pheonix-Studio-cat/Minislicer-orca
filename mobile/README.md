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

## What the slicer does

- Printers: A1 mini, A1, P1P, P1S, X1 Carbon, 0.4 mm nozzle. Bed size, start/end G-code, speeds,
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
python3 mobile/tools/build_profiles.py        # after changes in resources/profiles/BBL
cd mobile
node --test tests/*.test.mjs                  # slicer, G-code, 3MF (note: the glob, not "tests/")
go test ./...                                 # runner
go run ./runner                               # serve on http://<this computer>:8787
node tests/e2e.mjs <model.stl> [screenshots]  # browser end-to-end check (Linux, needs Playwright)
```

`web/` is a static site without a build step (ES modules, vendored three.js, Clipper and a QR code
generator under `web/vendor/`). The runner embeds `web/` and is a single Go binary per platform;
`runner/package_macos.sh` builds the universal `.app` and `.dmg` on macOS.

Licences of the vendored files: three.js (MIT), clipper-lib 6.4.2 (Boost Software License 1.0),
qrcode-generator (MIT). The rest is part of Minislicer-orca (AGPL-3.0).

#!/usr/bin/env python3
"""Build mobile/web/profiles.json and mobile/web/assets/ from OrcaSlicer's own resources.

The web slicer cannot read the profile tree directly (inheritance, includes, hundreds of
files), so this script resolves the presets it supports into one compact JSON file. It also
copies the icons, printer pictures and bed models OrcaSlicer's GUI uses, so the mobile UI
looks like OrcaSlicer's and the runner (which embeds mobile/web) can serve them.
Run it again whenever the BBL profiles or these resources change:

    python3 mobile/tools/build_profiles.py
"""
import json
import os
import shutil
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
BBL = os.path.join(ROOT, "resources", "profiles", "BBL")
OUT = os.path.join(ROOT, "mobile", "web", "profiles.json")
ASSETS = os.path.join(ROOT, "mobile", "web", "assets")
IMAGES = os.path.join(ROOT, "resources", "images")
# OrcaSlicer GUI icons used by the mobile UI (same names as in Plater.cpp, MainFrame.cpp, Tab.cpp).
ICONS = ["printer", "filament", "process", "settings", "edit", "add_filament", "delete_filament",
         "tab_3d_active", "tab_preview_active", "tab_monitor_active", "toolbar_open", "toolbar_arrange",
         "toolbar_rotate", "toolbar_scale", "toolbar_open_dark", "toolbar_arrange_dark",
         "toolbar_rotate_dark", "toolbar_scale_dark", "custom-gcode_quality", "custom-gcode_strength",
         "custom-gcode_speed", "custom-gcode_support", "custom-gcode_other", "plate_settings",
         "save", "delete", "undo", "custom-gcode_filament", "custom-gcode_cooling_fan",
         "param_information", "param_extruder_temp", "param_bed_temp", "param_volumetric_speed",
         "param_cooling_specific_layer", "param_cooling_part_fan", "param_layer_height", "param_wall",
         "param_shell", "param_infill", "param_speed_first", "param_speed", "param_travel_speed",
         "param_support", "param_adhension", "toolbar_support", "toolbar_support_dark", "toolbar_cut",
         "toolbar_cut_dark", "menu_support_enforcer", "menu_support_blocker", "erase", "erase_dark"]
# Our filament_id -> Bambu's catalog id. A Bambu printer reads tray_info_idx in slice_info.config
# and only knows its own catalog (see docs/HLSD/filament_id.md, "The Bambu catalog map").
BAMBU_IDS = os.path.join(ROOT, "resources", "printers", "bambu_filament_ids.json")

PRINTERS = ["Bambu Lab A1 mini", "Bambu Lab A1", "Bambu Lab A2L", "Bambu Lab P1P", "Bambu Lab P1S",
            "Bambu Lab X1 Carbon", "Bambu Lab H2S", "Bambu Lab H2D", "Bambu Lab H2D Pro", "Bambu Lab H2C"]
# The P1P bundle ships few filament presets of its own; the P1S ones fit the same toolhead.
FILAMENT_FALLBACK = {"Bambu Lab P1P": "Bambu Lab P1S 0.4 nozzle"}
FILAMENTS = ["Bambu PLA Basic", "Bambu PLA Matte", "Bambu PETG HF", "Bambu ABS", "Bambu TPU 95A HF",
             "Generic PLA", "Generic PETG", "Generic TPU"]

MACHINE_KEYS = ["printer_model", "printable_area", "printable_height", "nozzle_diameter", "retraction_length",
                "retraction_speed", "deretraction_speed", "z_hop", "retract_before_wipe", "printer_structure",
                "bed_exclude_area", "scan_first_layer", "machine_max_acceleration_extruding",
                "machine_max_speed_x", "extruder_type", "nozzle_volume_type", "nozzle_type",
                "retraction_minimum_travel", "retract_lift_below", "z_offset", "cooling_filter_enabled",
                "machine_max_force_Y", "machine_bed_mass_Y", "machine_max_acceleration_y",
                "long_retractions_when_cut", "retraction_distances_when_cut"]
GCODE_KEYS = ["machine_start_gcode", "machine_end_gcode", "layer_change_gcode"]
PROCESS_KEYS = ["layer_height", "initial_layer_print_height", "wall_loops", "top_shell_layers",
                "bottom_shell_layers", "sparse_infill_density", "outer_wall_speed", "inner_wall_speed",
                "sparse_infill_speed", "internal_solid_infill_speed", "top_surface_speed", "initial_layer_speed",
                "initial_layer_infill_speed", "travel_speed", "line_width", "outer_wall_line_width",
                "inner_wall_line_width", "sparse_infill_line_width", "internal_solid_infill_line_width",
                "top_surface_line_width", "initial_layer_line_width", "default_acceleration",
                "outer_wall_acceleration", "inner_wall_acceleration", "initial_layer_acceleration",
                "top_surface_acceleration", "travel_acceleration", "sparse_infill_acceleration",
                "skirt_loops", "skirt_distance", "brim_width", "support_threshold_angle",
                "support_top_z_distance", "support_object_xy_distance", "support_speed", "support_line_width",
                "support_base_pattern_spacing"]
FILAMENT_KEYS = ["filament_type", "filament_vendor", "filament_id", "nozzle_temperature",
                 "nozzle_temperature_initial_layer", "nozzle_temperature_range_high", "hot_plate_temp",
                 "hot_plate_temp_initial_layer", "textured_plate_temp", "textured_plate_temp_initial_layer",
                 "cool_plate_temp", "cool_plate_temp_initial_layer", "eng_plate_temp",
                 "eng_plate_temp_initial_layer", "filament_max_volumetric_speed", "filament_flow_ratio",
                 "filament_diameter", "filament_density", "fan_max_speed", "fan_min_speed",
                 "close_fan_the_first_x_layers", "filament_flush_temp", "filament_flush_volumetric_speed",
                 "slow_down_layer_time", "slow_down_min_speed", "default_filament_colour",
                 "filament_retraction_length", "temperature_vitrification", "chamber_temperatures",
                 "long_retractions_when_ec", "retraction_distances_when_ec",
                 "filament_long_retractions_when_cut", "filament_retraction_distances_when_cut"]


def load(kind, name, cache={}):
    key = (kind, name)
    if key not in cache:
        with open(os.path.join(BBL, kind, name + ".json"), encoding="utf-8") as f:
            data = json.load(f)
        resolved = load(kind, data["inherits"]).copy() if data.get("inherits") else {}
        for inc in data.get("include", []):
            resolved.update({k: v for k, v in load(kind, inc).items() if k not in ("name", "type")})
        resolved.update(data)
        cache[key] = resolved
    return cache[key]


# Lists that are geometry, not one value per extruder variant.
WHOLE_LISTS = {"printable_area", "bed_exclude_area"}
STANDARD = "Direct Drive Standard"


def variant_index(preset, variant_key, id_key=None, extruder=1):
    """Index of the "Direct Drive Standard" variant on `extruder` (1-based) in a per-variant preset.

    Printers with several extruders or nozzle types store most values once per variant
    (printer_extruder_variant / print_extruder_variant / filament_extruder_variant), the way
    OrcaSlicer's extruder-variant presets do. The mobile slicer prints with one standard nozzle.
    """
    variants = preset.get(variant_key)
    if not isinstance(variants, list) or not variants:
        return 0, 1
    ids = preset.get(id_key) if id_key else None
    for i, v in enumerate(variants):
        if v == STANDARD and (not ids or ids[i] == str(extruder)):
            return i, len(variants)
    for i in range(len(variants)):
        if not ids or ids[i] == str(extruder):
            return i, len(variants)
    return 0, len(variants)


def subset(preset, keys, vi=0, nv=1, ext=0, n_ext=1):
    """Keeps, for each key, the value of variant `vi` (of `nv`) or of extruder `ext` (of `n_ext`)."""
    out = {}
    for k in keys:
        if k not in preset:
            continue
        v = preset[k]
        if k in WHOLE_LISTS or not isinstance(v, list) or not v:
            out[k] = v
        elif len(v) == nv:
            out[k] = [v[vi]]
        elif len(v) == 2 * nv:  # machine limits: normal and silent mode per variant
            out[k] = [v[2 * vi]]
        elif len(v) == n_ext:
            out[k] = [v[ext]]
        else:
            out[k] = v[:1]
    return out


def area_bounds(spec):
    """'0x0,325x0,325x320,0x320' or ['0x0', ...] -> [minX, minY, maxX, maxY]."""
    pts = [tuple(float(c) for c in p.split("x")) for p in (spec.split(",") if isinstance(spec, str) else spec)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def compatible(kind, printer):
    """All instantiated system presets of `kind` whose compatible_printers lists `printer`."""
    for fn in sorted(os.listdir(os.path.join(BBL, kind))):
        if not fn.endswith(".json"):
            continue
        p = load(kind, fn[:-5])
        if p.get("instantiation") == "true" and printer in p.get("compatible_printers", []):
            yield fn[:-5], p


def pick(kind, base, printer):
    """The preset of `kind` named `base @...` whose compatible_printers lists `printer`."""
    for fn in sorted(os.listdir(os.path.join(BBL, kind))):
        if not fn.startswith(base + " @BBL"):
            continue
        p = load(kind, fn[:-5])
        if p.get("instantiation") == "true" and printer in p.get("compatible_printers", []):
            return fn[:-5], p
    return None, None


def main():
    with open(BAMBU_IDS, encoding="utf-8") as f:
        bambu_ids = json.load(f)["filaments"]
    out = {"generated_from": "resources/profiles/BBL", "printers": []}
    for model in PRINTERS:
        variant = model + " 0.4 nozzle"
        m = load("machine", variant)
        model_json = load("machine", model)
        # Several extruders (H2D, H2D Pro, H2C): print with OrcaSlicer's default one for a single
        # filament, the master extruder (master_extruder_id is 1-based; FilamentGroup.cpp).
        n_ext = len(m["nozzle_diameter"])
        master = int(m.get("master_extruder_id", "1")) - 1 if n_ext > 1 else 0
        vi, nv = variant_index(m, "printer_extruder_variant", "printer_extruder_id", master + 1)
        extruders = {"count": n_ext, "master": master,
                     "physical_map": [int(x) for x in m.get("physical_extruder_map", ["0"])],
                     "nozzle_diameters": [float(x) for x in m["nozzle_diameter"]],
                     "max_nozzle_count": [int(x) for x in m.get("extruder_max_nozzle_count", ["1"] * n_ext)]}
        if m.get("extruder_printable_area"):
            extruders["printable_area"] = area_bounds(m["extruder_printable_area"][master])
            extruders["printable_height"] = float(m["extruder_printable_height"][master])
        printer = {"name": model, "preset": variant, "model_id": model_json["model_id"],
                   "default_bed_type": model_json.get("default_bed_type", "Textured PEI Plate"),
                   "machine": subset(m, MACHINE_KEYS, vi, nv, master, n_ext),
                   "extruders": extruders,
                   "gcode": {k: m[k] for k in GCODE_KEYS},
                   "processes": [], "filaments": []}
        # Every system process preset OrcaSlicer offers for this printer, thinnest layers first.
        for name, p in compatible("process", variant):
            if p:
                pvi, pnv = variant_index(p, "print_extruder_variant", "print_extruder_id", master + 1)
                printer["processes"].append({"name": name, **subset(p, PROCESS_KEYS, pvi, pnv, master, n_ext)})
        for base in FILAMENTS:
            name, f = pick("filament", base, variant)
            if not f and model in FILAMENT_FALLBACK:
                name, f = pick("filament", base, FILAMENT_FALLBACK[model])
            if f:
                row = bambu_ids.get(f.get("filament_id"), {})
                fvi, fnv = variant_index(f, "filament_extruder_variant")
                printer["filaments"].append({"name": name, "tray_info_idx": row.get("bambu_id", f.get("filament_id", "")),
                                             **subset(f, FILAMENT_KEYS, fvi, fnv)})
        if not printer["processes"] or not printer["filaments"]:
            sys.exit(f"no process or filament preset found for {variant}")
        out["printers"].append(printer)
    copy_assets(out)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: " + ", ".join(f"{p['name']} ({len(p['processes'])} processes, {len(p['filaments'])} filaments)"
                                        for p in out["printers"]))


def copy_assets(out):
    """Copies icons, printer covers and bed models; records their paths in `out`."""
    shutil.rmtree(ASSETS, ignore_errors=True)
    for sub in ("icons", "printers", "beds"):
        os.makedirs(os.path.join(ASSETS, sub))
    for name in ICONS:
        shutil.copyfile(os.path.join(IMAGES, name + ".svg"), os.path.join(ASSETS, "icons", name + ".svg"))
    for printer in out["printers"]:
        model = load("machine", printer["name"])
        cover = printer["name"] + "_cover.png"
        if os.path.exists(os.path.join(BBL, cover)):
            dst = printer["model_id"] + ".png"
            shutil.copyfile(os.path.join(BBL, cover), os.path.join(ASSETS, "printers", dst))
            printer["cover"] = "assets/printers/" + dst
        bed = model.get("bed_model")
        if bed and os.path.exists(os.path.join(BBL, bed)):
            shutil.copyfile(os.path.join(BBL, bed), os.path.join(ASSETS, "beds", bed))
            printer["bed_model"] = "assets/beds/" + bed


if __name__ == "__main__":
    main()

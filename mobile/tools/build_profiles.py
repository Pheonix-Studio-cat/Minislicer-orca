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
         "custom-gcode_speed", "custom-gcode_support", "custom-gcode_other", "plate_settings"]
# Our filament_id -> Bambu's catalog id. A Bambu printer reads tray_info_idx in slice_info.config
# and only knows its own catalog (see docs/HLSD/filament_id.md, "The Bambu catalog map").
BAMBU_IDS = os.path.join(ROOT, "resources", "printers", "bambu_filament_ids.json")

PRINTERS = ["Bambu Lab A1 mini", "Bambu Lab A1", "Bambu Lab P1P", "Bambu Lab P1S", "Bambu Lab X1 Carbon"]
PROCESSES = ["0.12mm Fine", "0.16mm Optimal", "0.20mm Standard", "0.24mm Draft", "0.28mm Extra Draft"]
# The P1P bundle ships few filament presets of its own; the P1S ones fit the same toolhead.
FILAMENT_FALLBACK = {"Bambu Lab P1P": "Bambu Lab P1S 0.4 nozzle"}
FILAMENTS = ["Bambu PLA Basic", "Bambu PLA Matte", "Bambu PETG HF", "Bambu ABS", "Bambu TPU 95A HF",
             "Generic PLA", "Generic PETG", "Generic TPU"]

MACHINE_KEYS = ["printer_model", "printable_area", "printable_height", "nozzle_diameter", "retraction_length",
                "retraction_speed", "deretraction_speed", "z_hop", "retract_before_wipe", "printer_structure",
                "bed_exclude_area", "scan_first_layer", "machine_max_acceleration_extruding",
                "machine_max_speed_x", "extruder_type", "nozzle_volume_type", "nozzle_type",
                "retraction_minimum_travel", "retract_lift_below", "z_offset"]
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
                 "filament_retraction_length", "temperature_vitrification"]


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


def subset(preset, keys):
    """Single-extruder slicer: keep the first extruder variant of each per-variant list."""
    return {k: preset[k] if k in WHOLE_LISTS or not isinstance(preset[k], list) else preset[k][:1]
            for k in keys if k in preset}


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
        printer = {"name": model, "preset": variant, "model_id": model_json["model_id"],
                   "default_bed_type": model_json.get("default_bed_type", "Textured PEI Plate"),
                   "machine": subset(m, MACHINE_KEYS),
                   "gcode": {k: m[k] for k in GCODE_KEYS},
                   "processes": [], "filaments": []}
        for base in PROCESSES:
            name, p = pick("process", base, variant)
            if p:
                printer["processes"].append({"name": name, **subset(p, PROCESS_KEYS)})
        for base in FILAMENTS:
            name, f = pick("filament", base, variant)
            if not f and model in FILAMENT_FALLBACK:
                name, f = pick("filament", base, FILAMENT_FALLBACK[model])
            if f:
                row = bambu_ids.get(f.get("filament_id"), {})
                printer["filaments"].append({"name": name, "tray_info_idx": row.get("bambu_id", f.get("filament_id", "")),
                                             **subset(f, FILAMENT_KEYS)})
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

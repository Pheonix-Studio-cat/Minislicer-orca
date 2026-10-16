#!/usr/bin/env python3
"""Build the mobile UI's translation catalogs, mobile/web/i18n/<lang>.json.

1. Collects every English UI string from mobile/web (data-i18n attributes in the HTML, and the
   t(...)/label/title/text patterns in the JavaScript).
2. For each language, takes OrcaSlicer's own translation from localization/i18n/<lang>/*.po when
   OrcaSlicer has the same English text (non-fuzzy, non-empty), so wording matches OrcaSlicer.
3. Takes everything else from mobile/tools/i18n_extra.json: machine translations, listed in the
   catalog's "_meta.machine_translated" so they can be found and reviewed.

    python3 mobile/tools/build_i18n.py           # write the catalogs
    python3 mobile/tools/build_i18n.py --check   # fail if a string has no translation

Languages OrcaSlicer has no catalog for (Norwegian, Danish, Finnish) come entirely from the extras.
"""
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
WEB = os.path.join(ROOT, "mobile", "web")
PO_DIR = os.path.join(ROOT, "localization", "i18n")
EXTRA = os.path.join(ROOT, "mobile", "tools", "i18n_extra.json")
OUT = os.path.join(WEB, "i18n")

# Our code -> OrcaSlicer catalog (None: not translated in OrcaSlicer).
LANGS = {"de": "de", "zh_CN": "zh_CN", "zh_TW": "zh_TW", "ja": "ja", "es": "es", "fr": "fr", "it": "it",
         "nl": "nl", "pt": "pt_BR", "pl": "pl", "cs": "cs", "hu": "hu", "sv": "sv", "nb": None, "da": None,
         "fi": None, "uk": "uk", "ru": "ru"}

JS_PATTERNS = [
    r"\bt\(\s*'((?:[^'\\]|\\.)+)'",                      # t('...')
    r"\b(?:label|title|text|name):\s*'((?:[^'\\]|\\.)+)'",  # { label: '...' } etc.
    r"\bmsg\(\s*'((?:[^'\\]|\\.)+)'",                    # msg('...')
    r"\bnote\(\[\s*'((?:[^'\\]|\\.)+)'",                 # note(['...'])
    r"runnerStatus = \[\s*'((?:[^'\\]|\\.)+)'",          # status chip texts
    r"\breturn '((?:[^'\\]|\\.)+)';",                     # presets.validateName messages
    r"\[\s*'[a-z_]+',\s*'((?:[^'\\]|\\.)+)'\s*\]",       # enum options [['value', 'Label']]
    r"\bunit: '([A-Za-z]{3,})'",                          # word units such as 'layers'
    r"\b(?:Slicing|Walls|Shells|Toolpaths): '((?:[^'\\]|\\.)+)'",  # progress stage names
]
# Not shown as text: preset/printer names, colour names used as data, internal values.
IGNORE = {"OrcaSlicer", "Bambu", "computer", "filament", "Cool Plate", "High Temp Plate"}
# Where OrcaSlicer's catalog translates a string in a sense that is wrong for our use, the extra wins.
# "Print plate" is the print button (a verb); these catalogs have the noun ("the print plate").
# "Print" (the short label of the print button) is German "aktuelle Platte drucken" in OrcaSlicer,
# as long as the full label it replaces on narrow phones.
# "Rotation" (a joint's rotation angles) is "tilt" in OrcaSlicer's Russian catalog.
PREFER_EXTRA = {"Print plate": {"cs", "hu", "it", "nl"}, "Print": {"de"}, "Rotation": {"ru"}}
# Strings OrcaSlicer translates per sense (msgctxt): the sense we use.
CONTEXT = {"Print": "Verb"}


def collect_strings():
    html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
    found = set(re.findall(r'data-i18n(?:-title|-aria)?="([^"]+)"', html))
    for fn in ("app.js", "gcode.js", "presets.js", "worker.js"):
        src = open(os.path.join(WEB, "js", fn), encoding="utf-8").read()
        for pat in JS_PATTERNS:
            found.update(m.replace("\\'", "'") for m in re.findall(pat, src))
        if fn == "worker.js":  # feature names shown in the preview legend
            arr = re.search(r"const FEATURES = \[([^\]]+)\]", src, re.S).group(1)
            found.update(re.findall(r"'([^']+)'", arr))
    return sorted(s for s in found if s not in IGNORE and re.search(r"[A-Za-z]", s))


def unquote(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def parse_po(path):
    """{msgid: msgstr} for translated, non-fuzzy entries; entries without msgctxt win.
    Entries with a msgctxt are also kept under "msgctxt\x04msgid"."""
    entries, cur, key = {}, {}, None

    def flush():
        if cur.get("msgid") and cur.get("msgstr") and not cur.get("fuzzy"):
            if cur["msgid"] not in entries or "msgctxt" not in cur:
                entries[cur["msgid"]] = cur["msgstr"]
            if "msgctxt" in cur:  # also under gettext's "context\x04msgid" key
                entries[cur["msgctxt"] + "\x04" + cur["msgid"]] = cur["msgstr"]

    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip():
            flush()
            cur, key = {}, None
            continue
        if line.startswith("#,") and "fuzzy" in line:
            cur["fuzzy"] = True
        m = re.match(r'^(msgctxt|msgid|msgstr)\s+"(.*)"$', line)
        if m:
            key = m.group(1)
            cur[key] = unquote(m.group(2))
            continue
        m = re.match(r'^"(.*)"$', line)
        if m and key:
            cur[key] += unquote(m.group(1))
    flush()
    return entries


def main():
    check = "--check" in sys.argv
    strings = collect_strings()
    extra = json.load(open(EXTRA, encoding="utf-8"))
    missing = {}
    os.makedirs(OUT, exist_ok=True)
    for code, po in LANGS.items():
        orca = parse_po(os.path.join(PO_DIR, po, f"OrcaSlicer_{po}.po")) if po else {}
        cat, machine, from_orca = {}, [], 0
        for s in strings:
            o = orca.get(CONTEXT[s] + "\x04" + s) if s in CONTEXT else orca.get(s)
            # OrcaSlicer's translation, unless it only repeats the English or has the wrong sense
            # (PREFER_EXTRA) and we have our own.
            own = code in extra.get(s, {})
            if o and not (own and (o == s or code in PREFER_EXTRA.get(s, ()))):
                cat[s] = o
                from_orca += 1
            elif code in extra.get(s, {}):
                cat[s] = extra[s][code]
                machine.append(s)
            else:
                missing.setdefault(code, []).append(s)
        out = {"_meta": {"language": code, "orca_catalog": po, "from_orcaslicer": from_orca,
                         "machine_translated": machine, "generated_by": "mobile/tools/build_i18n.py"},
               "strings": cat}
        if not check:
            with open(os.path.join(OUT, f"{code}.json"), "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
                f.write("\n")
    unused = sorted(set(extra) - set(strings))
    print(f"{len(strings)} strings, {len(LANGS)} languages")
    if unused:
        print("unused extra strings:", unused)
    if missing:
        for code, lst in missing.items():
            print(f"missing {code} ({len(lst)}): {lst}")
        sys.exit(1)


if __name__ == "__main__":
    main()

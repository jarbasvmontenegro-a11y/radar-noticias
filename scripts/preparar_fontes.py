"""Baixa fontes de código aberto (licença OFL) do repositório google/fonts, recorta para português (latim) e grava em woff2.
Roda no GitHub Actions. Resultado em diag/fonts/ + sizes.txt, para escolher o que entra no site."""
import json
import os
import sys
from pathlib import Path

import requests
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "diag/fonts")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("GITHUB_TOKEN", "")
HDR = {"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})}
UNICODES = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [0x131, 0x152, 0x153, 0x2C6, 0x2DA, 0x2DC] + list(range(0x2013, 0x2016)) +
            [0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203A, 0x20AC, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212])
FEATURES = ["kern", "liga", "ccmp", "locl", "mark", "mkmk", "onum", "lnum", "tnum", "pnum", "case", "calt"]
log: list[str] = []


def say(*p):
    s = " ".join(str(x) for x in p)
    print(s, flush=True)
    log.append(s)


def listing(folder: str) -> list[dict]:
    r = requests.get(f"https://api.github.com/repos/google/fonts/contents/ofl/{folder}", headers=HDR, timeout=30)
    if not r.ok:
        say("listagem falhou", folder, r.status_code, r.text[:120])
        return []
    return r.json()


def download(item: dict) -> Path:
    path = OUT / "_orig" / item["name"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(requests.get(item["download_url"], timeout=60).content)
    return path


def to_woff2(src: Path, dest: str, axes: dict | None = None) -> None:
    font = TTFont(src)
    if axes and "fvar" in font:
        font = instancer.instantiateVariableFont(font, axes)
    opts = subset.Options()
    opts.layout_features = FEATURES
    opts.hinting = False
    opts.desubroutinize = True
    opts.notdef_outline = True
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.flavor = "woff2"
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    font.flavor = "woff2"
    out = OUT / dest
    font.save(out)
    say(f"{dest}: {out.stat().st_size / 1024:.1f} KB")


for fam in ("newsreader", "atkinsonhyperlegible", "atkinsonhyperlegiblenext"):
    items = listing(fam)
    say(fam, [i["name"] for i in items])
    for it in items:
        if it["name"].upper().startswith(("OFL", "DESCRIPTION")) and it["name"].upper().startswith("OFL"):
            (OUT / f"{fam}-OFL.txt").write_bytes(requests.get(it["download_url"], timeout=30).content)

try:
    nr = {i["name"]: i for i in listing("newsreader")}
    roman = next(v for k, v in nr.items() if k.startswith("Newsreader[") and "Italic" not in k)
    ital = next((v for k, v in nr.items() if k.startswith("Newsreader-Italic[")), None)
    p = download(roman)
    to_woff2(p, "newsreader-var.woff2", {"wght": (400, 800), "opsz": (8, 72)})
    to_woff2(p, "newsreader-400-text.woff2", {"wght": 400, "opsz": 14})
    to_woff2(p, "newsreader-700-text.woff2", {"wght": 700, "opsz": 18})
    to_woff2(p, "newsreader-800-display.woff2", {"wght": 800, "opsz": 72})
    if ital:
        to_woff2(download(ital), "newsreader-italic-400.woff2", {"wght": 400, "opsz": 14})
except Exception as exc:  # noqa: BLE001
    say("Newsreader falhou:", type(exc).__name__, str(exc)[:200])

try:
    at = {i["name"]: i for i in listing("atkinsonhyperlegible")} or {i["name"]: i for i in listing("atkinsonhyperlegiblenext")}
    for key, dest in (("Regular", "atkinson-400.woff2"), ("Bold", "atkinson-700.woff2")):
        item = next((v for k, v in at.items() if k.endswith(f"-{key}.ttf") and "Italic" not in k), None)
        if item:
            to_woff2(download(item), dest)
        else:
            say("Atkinson sem", key, list(at))
except Exception as exc:  # noqa: BLE001
    say("Atkinson falhou:", type(exc).__name__, str(exc)[:200])

import shutil
shutil.rmtree(OUT / "_orig", ignore_errors=True)
(OUT / "sizes.txt").write_text("\n".join(log), encoding="utf-8")

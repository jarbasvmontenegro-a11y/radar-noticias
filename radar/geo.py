"""Descobre de quais estados (UF) uma manchete fala. Só comparação de texto, sem IA.

Prefere errar para menos: "Brasília" sozinha não marca DF (quase toda notícia federal cita), "para" não vira Pará
(termos de estado só valem com a maiúscula certa) e "Natal" não vira o Rio Grande do Norte.
"""
import json
import re
from functools import lru_cache

from .collect import ROOT

LETTER = "A-Za-zÀ-ÖØ-öø-ÿ"
_EDGE_L, _EDGE_R = rf"(?<![{LETTER}])", rf"(?![{LETTER}])"
# "(SP)" é como os veículos costumam marcar o estado; "em SP", "no RJ" também
_UF_PAREN = re.compile(r"\(([A-Z]{2})\)")
_UF_PREP = re.compile(r"\b(?:no|na|em|do|da|de)\s+(SP|RJ|MG|BA|RS|PR|SC|PE|CE|GO|DF|ES|MT|MS|PA|AM|RN|PB|PI|MA|SE|AL|TO|RO|AC|AP|RR)\b")


@lru_cache(maxsize=1)
def states() -> list[dict]:
    return json.loads((ROOT / "config" / "estados.json").read_text(encoding="utf-8"))["estados"]


@lru_cache(maxsize=1)
def _compiled():
    names, demonyms = [], []
    for s in states():
        for term in s["termos"]:
            body = term[3:] if term.startswith("re:") else re.escape(term)
            names.append((len(term), re.compile(_EDGE_L + body + _EDGE_R), s["uf"]))
        for term in s["gentilicios"]:
            demonyms.append((len(term), re.compile(_EDGE_L + re.escape(term) + _EDGE_R, re.I), s["uf"]))
    names.sort(key=lambda x: -x[0])  # "Mato Grosso do Sul" antes de "Mato Grosso"
    demonyms.sort(key=lambda x: -x[0])
    return [n[1:] for n in names], [d[1:] for d in demonyms]


def uf_codes() -> set[str]:
    return {s["uf"] for s in states()}


def detect(text: str, default: str = "") -> list[str]:
    """UFs citadas no texto, na ordem em que aparecem, mais a UF padrão da fonte (veículo regional)."""
    found: dict[str, int] = {}
    work = text or ""
    names, demonyms = _compiled()
    for pats in (names, demonyms):
        for rx, uf in pats:
            for m in rx.finditer(work):
                found.setdefault(uf, m.start())
            work = rx.sub(lambda m: " " * len(m.group(0)), work)  # evita contar o mesmo trecho duas vezes
    valid = uf_codes()
    for rx in (_UF_PAREN, _UF_PREP):
        for m in rx.finditer(text or ""):
            if m.group(1) in valid:
                found.setdefault(m.group(1), m.start(1))
    ordered = sorted(found, key=found.get)
    if default and default in valid and default not in ordered:
        ordered.insert(0, default)
    return ordered

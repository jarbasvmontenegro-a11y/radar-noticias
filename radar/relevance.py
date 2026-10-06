"""Decide se uma manchete é de política. Só para feeds gerais; feeds de política passam direto."""
import json
import re
from functools import lru_cache

from .cluster import fold
from .collect import ROOT


@lru_cache(maxsize=1)
def _rules():
    cfg = json.loads((ROOT / "config" / "politica.json").read_text(encoding="utf-8"))
    words = re.compile(r"\b(?:" + "|".join(re.escape(fold(w)).replace(r"\ ", r"\s+") for w in cfg["palavras"]) + ")")
    acronyms = re.compile(r"(?<![A-Za-zÀ-ÿ])(?:" + "|".join(re.escape(s) for s in cfg["siglas"]) + r")(?![A-Za-zÀ-ÿ])")
    return words, acronyms


def is_political(text: str) -> bool:
    words, acronyms = _rules()
    return bool(words.search(fold(text)) or acronyms.search(text or ""))

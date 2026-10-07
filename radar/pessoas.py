"""Descobre quem aparece em uma manchete (políticos e autoridades). Só comparação de texto, sem IA.

O Radar conta APARIÇÕES: quantas manchetes e quantos veículos citam cada pessoa. Não mede apoio, aprovação nem tom
da notícia (isso é julgamento, e julgamento automático em período eleitoral engana mais do que ajuda).
"""
import json
import re
from functools import lru_cache

from .cluster import fold
from . import canal


@lru_cache(maxsize=1)
def config() -> dict:
    p = canal.arquivo("pessoas.json")
    if not canal.tem("pessoas") or not p.exists():
        return {"pessoas": []}  # canal sem o recurso: ninguém é reconhecido
    return json.loads(p.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _compiled() -> list[tuple[str, re.Pattern]]:
    return [(p["id"], re.compile(fold(p["padrao"]))) for p in config()["pessoas"]]


def detect(text: str) -> list[str]:
    """Ids das pessoas citadas no texto, na ordem da configuração."""
    t = fold(text)
    return [pid for pid, rx in _compiled() if rx.search(t)]


def todas() -> list[dict]:
    return config()["pessoas"]


def placar_ids() -> list[str]:
    return config().get("placar", [])

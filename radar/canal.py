"""Canais do Radar: um motor só, um assunto por pasta.

O motor (coleta, agrupamento, páginas, IA, conferência, notificações) fica em radar/ e functions/. Cada canal é uma
pasta em canais/<id>/ com o que é só daquele assunto:

- canal.json        nome e recursos ligados (estados, pessoas, verificador)
- sources.json      fontes (feeds e sitemaps)
- topics.json       temas do menu
- relevancia.json   palavras e siglas que dizem se uma manchete de feed geral é do assunto
- ruido.json        manchetes de modelo a descartar (opcional)
- pessoas.json      nomes a reconhecer (só se o recurso "pessoas" estiver ligado)
- candidatos.json   candidatos a fonte, para o diagnóstico (opcional)

Arquivos que valem para todos os canais ficam em config/: site.json, estados.json, municipios.json,
enquadramento.json e correcoes.json. Um arquivo que não existe na pasta do canal é procurado em config/.

O canal ativo vem de RADAR_CANAL (padrão: politica). Hoje só Política está no ar.
"""
import json
import os
import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMUNS = ROOT / "config"
PADRAO = "politica"
RECURSOS = ("estados", "pessoas", "verificador")


def ativo() -> str:
    c = (os.environ.get("RADAR_CANAL") or PADRAO).strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", c):
        raise ValueError(f"nome de canal inválido: {c!r}")
    return c


def pasta(canal: str | None = None) -> Path:
    return ROOT / "canais" / (canal or ativo())


def arquivo(nome: str, canal: str | None = None) -> Path:
    """Caminho de um arquivo de configuração: o do canal, se existir; senão o comum, em config/."""
    p = pasta(canal) / nome
    return p if p.exists() else COMUNS / nome


@lru_cache(maxsize=8)
def _info(canal: str) -> dict:
    p = pasta(canal) / "canal.json"
    if not p.exists():
        raise FileNotFoundError(f"canal {canal!r} sem canais/{canal}/canal.json")
    d = json.loads(p.read_text(encoding="utf-8"))
    rec = d.get("recursos", {})
    return {"id": d.get("id", canal), "nome": d.get("nome", canal), "recursos": {k: bool(rec.get(k)) for k in RECURSOS}}


def info(canal: str | None = None) -> dict:
    """{"id", "nome", "recursos": {estados, pessoas, verificador}}."""
    return _info(canal or ativo())


def tem(recurso: str, canal: str | None = None) -> bool:
    return info(canal)["recursos"].get(recurso, False)

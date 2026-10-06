"""Escolhe os assuntos que valem uma notificação (arquivo site/data/destaques.json).

Sem IA: um assunto é "grande" quando muitos veículos diferentes publicam sobre ele. Cada destaque leva os temas e os
estados que ele toca; quem decide o que mandar para cada pessoa é o envio (lib/pushselect.js), conforme as preferências dela.
"""
import hashlib
import re
from datetime import datetime

from .cluster import cluster, fold

# manchetes de agências de checagem que desmentem algo (as que apenas "explicam" não interessam para alerta)
ALERTA = re.compile(r"\b(falso|falsa|falsos|fake|engano|enganoso|enganosa|golpe|boato|desinforma\w*|manipulad\w*|montagem|"
                    r"nao procede|sem provas?|distorc\w*|descontextualiz\w*|sem\s+fundamento)\b")


def _id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def montar(news: list[dict], checks: list[dict], now: datetime, janela_h: int = 20, fresco_h: int = 6, max_assuntos: int = 40,
           max_checagens: int = 10) -> list[dict]:
    """`news`: notícias (nacionais e regionais) com `topics`, `ufs_txt` (estados citados no texto), `uf_fonte` (estado do
    veículo regional) e `dt`. `checks`: itens de checagem. Só entra assunto ainda fresco: o último veículo publicou há
    menos de `fresco_h` horas (aviso de notícia velha incomoda)."""
    recentes = [a for a in news if (now - a["dt"]).total_seconds() < janela_h * 3600]
    out = []
    for g in cluster(recentes)[:max_assuntos]:
        fontes = {x["source"] for x in g}
        temas = sorted({t for x in g for t in x.get("topics", [])})
        mais_antigo = min(g, key=lambda x: x["dt"])
        lider = max(g, key=lambda x: x["dt"])
        if (now - lider["dt"]).total_seconds() > fresco_h * 3600:
            continue
        # estado do assunto: citado no texto por 2+ veículos, ou coberto sobretudo por veículos daquele estado.
        # (um veículo regional que repete notícia nacional não faz dela uma notícia local)
        txt: dict[str, int] = {}
        fonte: dict[str, int] = {}
        for x in g:
            for u in x.get("ufs_txt", []):
                txt[u] = txt.get(u, 0) + 1
            if x.get("uf_fonte"):
                fonte[x["uf_fonte"]] = fonte.get(x["uf_fonte"], 0) + 1
        # pessoas: no título de pelo menos 2 veículos e de um terço do grupo (citação de passagem não conta)
        quem: dict[str, int] = {}
        for x in g:
            for pid in x.get("pessoas_t", []):
                quem[pid] = quem.get(pid, 0) + 1
        pessoas = sorted(pid for pid, c in quem.items() if c >= 2 and c * 3 >= len(g))
        ufs = sorted({u for u, c in txt.items() if c >= 2} | {u for u, c in fonte.items() if c >= 2 and c * 2 >= len(g)})
        out.append({"id": _id(mais_antigo["url"]), "t": lider["title"], "u": lider["url"], "f": lider["source_name"],
                    "n": len(fontes), "temas": temas, "ufs": ufs, "pessoas": pessoas, "k": "assunto", "p": int(lider["dt"].timestamp())})
    alertas = [a for a in checks if (now - a["dt"]).total_seconds() < 24 * 3600 and ALERTA.search(fold(a["title"]))]
    for a in sorted(alertas, key=lambda x: x["dt"], reverse=True)[:max_checagens]:
        out.append({"id": _id(a["url"]), "t": a["title"], "u": a["url"], "f": a["source_name"], "n": 1,
                    "temas": [], "ufs": [], "pessoas": [], "k": "checagem", "p": int(a["dt"].timestamp())})
    return out

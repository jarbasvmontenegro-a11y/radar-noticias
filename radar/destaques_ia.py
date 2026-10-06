"""Assuntos do topo da home, agrupados por IA duas vezes ao dia.

A IA só AGRUPA e NOMEIA: recebe as manchetes numeradas e devolve "assunto, frase curta, números das manchetes". Quem monta a
página confere os números e mostra as manchetes reais dos veículos, com os links delas. A ordem vem do número de veículos
diferentes (objetivo), nunca da opinião da IA. Se a IA falhar, o site usa o agrupamento por palavras (radar/cluster.py).
"""
import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

from . import collect as _c
from .cluster import cluster

TZ = ZoneInfo("America/Sao_Paulo")
HORA_INICIO, HORA_FIM = 8, 22      # só gera dentro deste horário (Brasília)
INTERVALO_H = 9                    # mínimo entre duas gerações: 2 por dia (por volta de 8h e 17h)
VALIDADE_H = 36                    # arquivo mais velho que isso não é usado
TOPO = 5


def arquivo():
    return _c.DATA / "destaques_ia.json"


def candidatos(news: list[dict], now: datetime, max_grupos: int = 40, max_itens: int = 450) -> list[dict]:
    """Manchetes que valem mandar para a IA: as que já aparecem em algum agrupamento por palavras (2+ veículos).
    Manchete isolada não pode ser um dos assuntos mais falados, então não gasta espaço (nem dinheiro)."""
    recentes = [a for a in news if (now - a["dt"]).total_seconds() < 30 * 3600]
    itens, vistos = [], set()
    for g in cluster(recentes)[:max_grupos]:
        for a in g:
            if a["id"] not in vistos:
                vistos.add(a["id"])
                itens.append(a)
    itens.sort(key=lambda a: a["dt"], reverse=True)
    return itens[:max_itens]


def numerar(cands: list[dict]) -> tuple[list[str], dict[int, dict]]:
    por_num, linhas = {}, []
    for i, a in enumerate(cands, 1):
        por_num[i] = a
        titulo = re.sub(r"[|\r\n]+", " ", a["title"]).strip()[:150]
        linhas.append(f"{i}|{a['source_name']}|{titulo}")
    return linhas, por_num


def _limpa(s: str, n: int) -> str:
    s = re.sub(r"https?://\S+", "", str(s or ""))
    s = re.sub(r"[\x00-\x1f‪-‮⁦-⁩]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()[:n]


def validar(resp: dict, por_num: dict[int, dict]) -> list[dict]:
    """Confere a resposta da IA: só números que existem, cada manchete em um único assunto, 2+ veículos por assunto."""
    out, usados = [], set()
    for s in (resp or {}).get("assuntos", []) if isinstance(resp, dict) else []:
        if not isinstance(s, dict):
            continue
        ids = []
        for n in s.get("ids", []):
            try:
                n = int(n)
            except (TypeError, ValueError):
                continue
            if n in por_num and n not in usados:
                usados.add(n)
                ids.append(por_num[n]["id"])
        arts = [por_num[n] for n in range(1, len(por_num) + 1) if por_num[n]["id"] in ids]
        titulo, resumo = _limpa(s.get("titulo"), 100), _limpa(s.get("resumo"), 260)
        if titulo and len({a["source"] for a in arts}) >= 2:
            out.append({"titulo": titulo, "resumo": resumo, "ids": ids})
    return out


def segredo(token: str) -> str:
    return hmac.new(token.encode(), b"radar-push-v1", hashlib.sha256).hexdigest()


def chamar_ia(site_url: str, token: str, linhas: list[str], post=requests.post) -> dict:
    r = post(site_url.rstrip("/") + "/api/ia/agrupar", json={"itens": linhas}, timeout=(10, 100),
             headers={"Authorization": f"Bearer {segredo(token)}", "Content-Type": "application/json"})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    return r.json()


def precisa_gerar(agora: datetime, atual: dict | None) -> bool:
    h = agora.astimezone(TZ).hour
    if not (HORA_INICIO <= h < HORA_FIM):
        return False
    if not atual or not atual.get("gerado"):
        return True
    try:
        gerado = datetime.fromisoformat(atual["gerado"])
    except ValueError:
        return True
    return agora - gerado >= timedelta(hours=INTERVALO_H)


def gerar(force: bool = False, post=requests.post) -> int:
    """Roda no GitHub Actions. Nunca falha o fluxo: se algo der errado, o arquivo antigo continua valendo."""
    from .build_site import prepare
    site_url, token = os.environ.get("SITE_URL", ""), os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not site_url or not token:
        print("destaques-ia: faltam SITE_URL ou CLOUDFLARE_API_TOKEN; mantendo o agrupamento por palavras.")
        return 0
    now = datetime.now(TZ)
    atual = _c.load_json(arquivo(), None)
    if not force and not precisa_gerar(datetime.now(timezone.utc), atual):
        print("destaques-ia: ainda não é hora de atualizar.")
        return 0
    sources = {s["id"]: s for s in _c.load_sources()}
    store = _c.load_json(_c.DATA / "articles.json", {"articles": []})
    items = prepare(store["articles"], sources, now)
    news = [a for a in items if a["kind"] == "noticia" and sources.get(a["source"], {}).get("grupo", "nacional") != "regional"]
    cands = candidatos(news, now)
    if len(cands) < 10:
        print("destaques-ia: poucas manchetes; mantendo o que existe.")
        return 0
    linhas, por_num = numerar(cands)
    try:
        resp = chamar_ia(site_url, token, linhas, post=post)
    except Exception as exc:  # rede, segredo errado, IA fora do ar...
        print(f"::warning::destaques-ia: não foi possível agrupar agora ({type(exc).__name__}: {str(exc)[:80]}).")
        return 0
    assuntos = validar(resp, por_num)
    if len(assuntos) < 3:
        print(f"::warning::destaques-ia: resposta com poucos assuntos válidos ({len(assuntos)}); mantendo o que existe.")
        return 0
    _c.write_atomic(arquivo(), json.dumps({"gerado": datetime.now(timezone.utc).isoformat(timespec="seconds"), "assuntos": assuntos},
                                          ensure_ascii=False, indent=1))
    print(f"destaques-ia: {len(assuntos)} assuntos agrupados de {len(cands)} manchetes.")
    return 0


def aplicar(dados: dict | None, por_id: dict[str, dict], agora: datetime) -> list[dict] | None:
    """Transforma o arquivo em destaques para a home. None = usar o agrupamento por palavras."""
    if not dados or not dados.get("assuntos"):
        return None
    try:
        gerado = datetime.fromisoformat(dados["gerado"])
    except (KeyError, ValueError):
        return None
    if agora - gerado > timedelta(hours=VALIDADE_H):
        return None
    out = []
    for s in dados["assuntos"]:
        arts = sorted((por_id[i] for i in s.get("ids", []) if i in por_id), key=lambda a: a["dt"], reverse=True)
        nomes = sorted({a["source_name"] for a in arts})
        if len(nomes) < 2:
            continue
        por_veiculo, vistos = [], set()
        for a in arts:
            if a["source"] not in vistos:
                vistos.add(a["source"])
                por_veiculo.append(a)
        out.append({"lead": arts[0], "n": len(nomes), "names": nomes, "veiculos": por_veiculo[:6],
                    "titulo": s["titulo"], "resumo": s.get("resumo", ""), "ia": True})
    out.sort(key=lambda h: (-h["n"], -h["lead"]["dt"].timestamp()))
    out = out[:TOPO]
    return out if len(out) >= 3 else None


if __name__ == "__main__":
    sys.exit(gerar(force="--forcar" in sys.argv))

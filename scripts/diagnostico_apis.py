"""Sonda APIs externas e o site no ar. Roda no GitHub Actions (rede livre). Resultado em diag/.

- IBGE: lista de municípios (vira data/municipios.json, usada pelo verificador para saber se uma cidade existe).
- GDELT: formato da resposta de busca de notícias (cobertura da imprensa).
- Site: chama /api/verificar e /api/resumir como um visitante qualquer, para conferir chaves, KV e limites.
"""
import json
import os
import sys
import unicodedata
from pathlib import Path

import requests

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "diag")
OUT.mkdir(parents=True, exist_ok=True)
HEADERS = {"User-Agent": "RadarNoticias/1.0 (diagnostico)"}
log: list[str] = []


def say(*parts) -> None:
    line = " ".join(str(p) for p in parts)
    print(line, flush=True)
    log.append(line)


def fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


# ---- 1) IBGE ------------------------------------------------------------------------------------
try:
    r = requests.get("https://servicodados.ibge.gov.br/api/v1/localidades/municipios", headers=HEADERS, timeout=60)
    data = r.json()
    rows = []
    for m in data:
        uf = ((m.get("microrregiao") or {}).get("mesorregiao") or {}).get("UF", {}).get("sigla") or \
             (((m.get("regiao-imediata") or {}).get("regiao-intermediaria") or {}).get("UF") or {}).get("sigla") or ""
        rows.append([m["nome"], uf])
    say("IBGE:", r.status_code, len(rows), "municípios; sem UF:", sum(1 for x in rows if not x[1]), "; exemplo:", rows[:3])
    say("IBGE: 'Serra do Cajueiro Seco' existe?", any(fold(n) == fold("Serra do Cajueiro Seco") for n, _ in rows))
    say("IBGE: 'Fortaleza' existe?", any(fold(n) == "fortaleza" for n, _ in rows))
    if len(rows) > 5000:
        (OUT / "municipios.json").write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
except Exception as exc:  # noqa: BLE001
    say("IBGE: falhou", type(exc).__name__, str(exc)[:150])

# ---- 2) GDELT ------------------------------------------------------------------------------------
for q in ('"Serra do Cajueiro Seco"', '"merenda escolar" prefeito sourcecountry:BR', "Lula sourcecountry:BR sourcelang:por"):
    try:
        r = requests.get("https://api.gdeltproject.org/api/v2/doc/doc", headers=HEADERS, timeout=40,
                         params={"query": q, "mode": "artlist", "maxrecords": "5", "format": "json", "timespan": "14d", "sort": "datedesc"})
        body = r.text.strip()
        info = body[:300].replace("\n", " ")
        if body.startswith("{"):
            try:
                arts = r.json().get("articles", [])
                info = f"{len(arts)} artigos; primeiro: {json.dumps(arts[0], ensure_ascii=False)[:350] if arts else '-'}"
            except ValueError:
                pass
        say(f"GDELT {q!r}: HTTP {r.status_code} {r.headers.get('content-type', '')[:30]} -> {info}")
    except Exception as exc:  # noqa: BLE001
        say(f"GDELT {q!r}: falhou", type(exc).__name__, str(exc)[:150])

# ---- 3) site no ar -------------------------------------------------------------------------------
site = (os.environ.get("SITE_URL") or "").rstrip("/")
if site:
    H = {"Content-Type": "application/json", "Origin": site, "User-Agent": "RadarNoticias/1.0 (diagnostico)"}
    claims = [
        "O prefeito de Serra do Cajueiro Seco, Zeferino Quaresma Dantas, teria desviado R$ 48.317.902,00 da merenda escolar em três meses, com o caso arquivado e abafado pela mídia.",
        "O governo vai cobrar imposto sobre o Pix a partir do mês que vem, compartilhe antes que apaguem",
    ]
    for c in claims:
        try:
            r = requests.post(site + "/api/verificar", headers=H, json={"texto": c}, timeout=90)
            say("verificar:", r.status_code, r.text[:1500].replace("\n", " "))
        except Exception as exc:  # noqa: BLE001
            say("verificar: falhou", type(exc).__name__, str(exc)[:150])
    try:
        arts = json.loads(Path("data/articles.json").read_text(encoding="utf-8"))["articles"]
        a = next(x for x in arts if x["source"] == "g1")
        r = requests.post(site + "/api/resumir", headers=H, json={"url": a["url"], "title": a["title"], "source": "g1", "desc": a["desc"]}, timeout=90)
        say("resumir:", a["url"], r.status_code, r.text[:1500].replace("\n", " "))
    except Exception as exc:  # noqa: BLE001
        say("resumir: falhou", type(exc).__name__, str(exc)[:150])
else:
    say("SITE_URL não definido: teste do site pulado")

(OUT / "apis.txt").write_text("\n".join(log), encoding="utf-8")

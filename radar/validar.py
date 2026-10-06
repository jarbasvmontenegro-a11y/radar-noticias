"""Pré-validação das notícias novas, ANTES de entrarem no site.

Cada notícia nova passa por duas conferências simples (sem IA e sem custo):
1. o título: curto demais, sem letras ou só um endereço não é manchete;
2. o link: se o veículo responde que a página não existe (404/410), ou manda para a página inicial no lugar da matéria
   (erro "soft 404"), a notícia não entra.

Regra de ouro: na dúvida, a notícia ENTRA. Sites que bloqueiam robôs (403), pedem espera (429), caem (5xx) ou demoram
não são motivo para esconder a matéria. Só descartamos quando o próprio veículo diz que a página não existe.
"""
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

import requests

# navegador comum: alguns veículos respondem 403 a qualquer coisa que se apresente como robô
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Language": "pt-BR,pt;q=0.9",
}
MORTO = {404, 410}
PLACEHOLDERS = re.compile(r"^(sem t[ií]tulo|untitled|t[ií]tulo|null|undefined|\.+|-+)$", re.I)


def titulo_ruim(title: str) -> str:
    """Motivo pelo qual o título não serve como manchete, ou "" se está ok."""
    t = (title or "").strip()
    if len(t) < 12:
        return "título curto demais"
    if PLACEHOLDERS.match(t):
        return "título vazio"
    if re.match(r"^https?://\S+$", t):
        return "título é um endereço"
    letras = sum(c.isalpha() for c in t)
    if letras < len(t) * 0.5:
        return "título sem letras suficientes"
    return ""


def _caminho(url: str) -> str:
    return urlsplit(url).path.strip("/")


def checar_link(url: str, timeout=(4, 8), get=requests.get) -> tuple[str, str]:
    """("ok" | "morto" | "incerto", motivo). Só "morto" tira a notícia do ar."""
    try:
        with get(url, headers=HEADERS, timeout=timeout, stream=True, allow_redirects=True) as r:
            if r.status_code in MORTO:
                return "morto", f"HTTP {r.status_code}"
            if 200 <= r.status_code < 400:
                # "soft 404": o veículo manda a matéria apagada para a home ou para a seção
                if _caminho(url) and not _caminho(r.url):
                    return "morto", "redirecionou para a página inicial"
                return "ok", ""
            return "incerto", f"HTTP {r.status_code}"
    except requests.RequestException as exc:
        return "incerto", type(exc).__name__
    except Exception as exc:  # nunca derruba a coleta
        return "incerto", type(exc).__name__


def validar_novas(novas: list[dict], orcamento_s: float = 120, workers: int = 16, checar=checar_link) -> tuple[list[dict], list[tuple[dict, str]], dict]:
    """Recebe os registros novos. Devolve (aceitos, [(descartado, motivo)], contagens).
    O link é conferido enquanto houver tempo no orçamento; o que não deu tempo de conferir entra sem conferência."""
    aceitos, descartados = [], []
    candidatos = []
    for a in novas:
        motivo = titulo_ruim(a["title"])
        if motivo:
            descartados.append((a, motivo))
        else:
            candidatos.append(a)
    limite = time.monotonic() + orcamento_s
    cont = {"conferidas": 0, "ok": 0, "incertas": 0, "mortas": 0, "sem_tempo": 0}

    def uma(a):
        if time.monotonic() > limite:
            return a, "sem_tempo", ""
        return (a, *checar(a["url"]))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for a, estado, motivo in pool.map(uma, candidatos):
            if estado == "morto":
                cont["mortas"] += 1
                descartados.append((a, motivo))
                continue
            if estado == "sem_tempo":
                cont["sem_tempo"] += 1
            else:
                cont["conferidas"] += 1
                cont["ok" if estado == "ok" else "incertas"] += 1
            aceitos.append(a)
    cont["titulos_ruins"] = len(descartados) - cont["mortas"]
    return aceitos, descartados, cont

"""Coleta de RSS/Atom, sem IA e sem custo. Guarda só título, descrição curta e link.

Robustez:
- busca feeds em paralelo, com timeout, limite de tamanho e retries com espera;
- rejeita XML com declaração de entidades (ataque "billion laughs") e remove caracteres inválidos;
- só aceita links http(s) (nada de javascript:, data:, etc.);
- escrita atômica e recusa de sobrescrever um articles.json corrompido;
- um feed fora do ar nunca derruba os outros, e o estado de cada fonte fica registrado.
"""
import hashlib
import html
import json
import os
import re
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("RADAR_DATA") or ROOT / "data")
UA = "RadarNoticias/1.0 (agregador; respeita RSS; contato no site)"
MAX_DESC = 260          # trecho curto de propósito
MAX_TITLE = 300
MAX_URL = 2000
MAX_BYTES = 5_000_000   # tamanho máximo de um feed
MAX_ARTICLES = 4000     # teto do arquivo
RETRIES = 2
TRACKING = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref"}
ILLEGAL_XML = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")
BARE_AMP = re.compile(rb"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)")


class StoreCorrupted(RuntimeError):
    pass


# ---------------------------------------------------------------- arquivos
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_store() -> dict:
    """Carrega os artigos. Se o arquivo existe mas está quebrado, NÃO recomeça do zero (perderia o histórico)."""
    path = DATA / "articles.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {a["id"]: a for a in data["articles"]}
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        backup = path.with_name("articles.corrompido.json")
        try:
            os.replace(path, backup)
        except OSError:
            pass
        raise StoreCorrupted(f"articles.json inválido ({exc}); cópia em {backup.name}. Restaure pelo histórico do Git.") from exc


def load_sources(path: Path | None = None) -> list[dict]:
    from . import canal  # import tardio: canal não depende do coletor
    return load_json(path or canal.arquivo("sources.json"), {"sources": []})["sources"]


# ---------------------------------------------------------------- texto e URLs
def clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f‪-‮⁦-⁩]", "", text)  # controles e bidi
    return re.sub(r"\s+", " ", text).strip()


def short(text: str, n: int = MAX_DESC) -> str:
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0].rstrip(",;:.- ")
    return cut + "…"


def safe_url(url: str) -> str:
    """Devolve a URL limpa se for http(s) válida; senão, string vazia."""
    url = (url or "").strip()
    if not url or len(url) > MAX_URL or re.search(r"\s", url):
        return ""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        return ""
    return url


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    q = [(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in TRACKING]
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path, urlencode(q), ""))


def article_id(url: str) -> str:
    return hashlib.sha1(canonical_url(url).encode()).hexdigest()[:12]


def _palavras(titulo: str) -> set[str]:
    sem_acento = unicodedata.normalize("NFD", titulo.lower())
    sem_acento = "".join(c for c in sem_acento if not unicodedata.combining(c))
    return set(re.findall(r"[a-z0-9]+", sem_acento))


def titulo_mudou(antigo: str, novo: str) -> bool:
    """O veículo trocou o título de verdade? Maiúsculas, acentos, pontuação e conserto de uma letra não contam."""
    a, n = _palavras(antigo), _palavras(novo)
    saiu, entrou = a - n, n - a
    if len(saiu) + len(entrou) < 2:
        return False
    if len(saiu) == 1 and len(entrou) == 1 and SequenceMatcher(None, next(iter(saiu)), next(iter(entrou))).ratio() >= 0.8:
        return False  # erro de digitação consertado
    return True


def registrar_troca(artigo: dict, novo: str, agora: datetime) -> bool:
    """Guarda o título original quando o veículo troca o título da mesma matéria. Devolve True se registrou.
    Voltar ao título original não conta (evita alternar a cada coleta quando o feed oscila)."""
    atual = artigo["title"]
    original = artigo.get("anterior") or atual
    if not titulo_mudou(atual, novo) or not titulo_mudou(original, novo):
        return False
    artigo["anterior"] = original
    artigo["title"] = novo
    artigo["alterado"] = agora.isoformat(timespec="seconds")
    return True


def title_key(source: str, title: str) -> str:
    return source + "|" + re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


# ---------------------------------------------------------------- XML
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(node: ET.Element, *names: str) -> str:
    for child in node:
        if _local(child.tag) in names and (child.text or "").strip():
            return child.text.strip()
    return ""


def _parse_date(raw: str):
    raw = (raw or "").strip()
    if raw:
        try:
            dt = parsedate_to_datetime(raw)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            pass
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def parse_xml(content: bytes) -> ET.Element:
    """Lê XML não confiável: sem entidades, sem caracteres inválidos, tolerante a '&' solto."""
    if re.search(rb"<!ENTITY", content, re.I):
        raise ValueError("feed rejeitado: declara entidades XML")
    content = ILLEGAL_XML.sub(b"", content)
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        return ET.fromstring(BARE_AMP.sub(b"&amp;", content))


def parse_feed(content: bytes) -> list[dict]:
    """Devolve [{title, url, desc, published(datetime|None)}] de um feed RSS 2.0 ou Atom."""
    root = parse_xml(content)
    out = []
    for n in (x for x in root.iter() if _local(x.tag) in ("item", "entry")):
        url = _child_text(n, "link")
        if not url:
            for child in n:
                if _local(child.tag) == "link" and child.get("href") and child.get("rel", "alternate") == "alternate":
                    url = child.get("href")
                    break
        title = short(clean(_child_text(n, "title")), MAX_TITLE)
        desc = clean(_child_text(n, "description", "summary", "content"))
        if desc.lower().startswith(title.lower()[:40]) and len(desc) < len(title) + 20:
            desc = ""  # descrição que só repete o título não ajuda ninguém
        out.append(
            {
                "title": title,
                "url": safe_url(url),
                "desc": short(desc),
                "published": _parse_date(_child_text(n, "pubdate", "published", "updated", "date")),
            }
        )
    return out


def parse_sitemap(content: bytes) -> list[dict]:
    """Sitemap de notícias (padrão do Google News): título, link e data de publicação, sem descrição."""
    root = parse_xml(content)
    out = []
    for u in (x for x in root.iter() if _local(x.tag) == "url"):
        title, pub = "", None
        for n in u.iter():
            ns = n.tag.split("}")[0] if n.tag.startswith("{") else ""
            if "sitemap-news" not in ns:  # ignora <image:title> e afins
                continue
            if _local(n.tag) == "title" and n.text:
                title = n.text
            elif _local(n.tag) == "publication_date" and n.text:
                pub = _parse_date(n.text)
        out.append({"title": short(clean(title), MAX_TITLE), "url": safe_url(_child_text(u, "loc")), "desc": "",
                    "published": pub or _parse_date(_child_text(u, "lastmod"))})
    return [e for e in out if e["title"]]


def parse_entries(content: bytes) -> list[dict]:
    """RSS, Atom ou sitemap de notícias: descobre pelo elemento raiz."""
    root = parse_xml(content)
    if _local(root.tag) == "urlset":
        return parse_sitemap(content)
    return parse_feed(content)


# ---------------------------------------------------------------- rede
RETRYABLE = (429, 500, 502, 503, 504)


def _download(url: str) -> bytes:
    """Baixa com timeout, limite de tamanho e retries (só para erros passageiros)."""
    last: Exception = RuntimeError("sem tentativas")
    for attempt in range(RETRIES + 1):
        delay = 0.8 * (2 ** attempt)
        try:
            with requests.get(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"},
                              timeout=(5, 15), stream=True) as resp:
                if resp.status_code in RETRYABLE:
                    ra = resp.headers.get("Retry-After", "")
                    if ra.isdigit():
                        delay = max(delay, min(int(ra), 10))
                    last = requests.HTTPError(f"HTTP {resp.status_code}")
                else:
                    resp.raise_for_status()  # 403/404 etc.: erro definitivo, não adianta repetir
                    chunks, size = [], 0
                    for chunk in resp.iter_content(65536):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise ValueError("feed grande demais")
                        chunks.append(chunk)
                    return b"".join(chunks)
        except (requests.ConnectionError, requests.Timeout) as exc:
            last = exc
        if attempt < RETRIES:
            time.sleep(delay)
    raise last


def source_urls(source: dict) -> list[str]:
    return list(source.get("urls") or ([source["url"]] if source.get("url") else []))


def merge_entries(groups: list[list[dict]]) -> list[dict]:
    """Junta entradas de feed e sitemap do mesmo veículo: sem repetir link; a versão com descrição vence."""
    merged: dict[str, dict] = {}
    for entries in groups:
        for e in entries:
            key = canonical_url(e["url"]) if e["url"] else "t|" + e["title"]
            cur = merged.get(key)
            if cur is None:
                merged[key] = dict(e)
                continue
            if e["desc"] and not cur["desc"]:
                cur["desc"] = e["desc"]
            if not cur["published"]:
                cur["published"] = e["published"]
    return list(merged.values())


def fetch_feed(source: dict) -> list[dict]:
    """Baixa o endereço da fonte (ou todos, quando há feed e sitemap). Só falha se NENHUM endereço responder."""
    groups, errors = [], []
    for url in source_urls(source):
        try:
            groups.append(parse_entries(_download(url)))
        except Exception as exc:  # noqa: BLE001 (um endereço fora do ar não derruba os outros da mesma fonte)
            errors.append(f"{type(exc).__name__}: {str(exc)[:100]}")
    if not groups:
        raise RuntimeError("; ".join(errors) or "fonte sem endereço")
    return merge_entries(groups)


# ---------------------------------------------------------------- filtros por fonte
@lru_cache(maxsize=1)
def _noise():
    """Manchetes de modelo repetidas aos montes (uma por município, por exemplo): não ajudam o leitor e inundam a lista."""
    from . import canal
    cfg = load_json(canal.arquivo("ruido.json"), {})
    pats = [re.compile(p, re.I) for p in cfg.get("titulos", [])]
    return pats


def keep_entry(src: dict, e: dict) -> bool:
    """Feeds gerais trazem de tudo (esporte, polícia...). Cada fonte pode pedir:
    "include": trechos de URL que já indicam política (seção);
    "politica": true  -> o que não casar com "include" só entra se a manchete tiver cara de política (palavras-chave);
    "exclude": trechos de URL a descartar.
    Sem "include" nem "politica", tudo entra. Manchetes de modelo (canais/<canal>/ruido.json) são sempre descartadas."""
    url, title = e["url"], e["title"]
    if any(p.search(title) for p in _noise()):
        return False
    if any(x in url for x in src.get("exclude") or []):
        return False
    inc = src.get("include") or []
    if inc and any(x in url for x in inc):
        return True
    if src.get("politica"):
        from .relevance import is_political
        return is_political(f"{title} {e['desc']}")
    return not inc


def _newest_first(entries: list[dict]) -> list[dict]:
    far_past = datetime.min.replace(tzinfo=timezone.utc)
    return sorted(entries, key=lambda e: e["published"] or far_past, reverse=True)


# ---------------------------------------------------------------- coleta
def _fetch_all(sources: list[dict]) -> dict:
    def one(src):
        try:
            return src["id"], fetch_feed(src), ""
        except Exception as exc:  # um feed quebrado não derruba os outros
            return src["id"], [], f"{type(exc).__name__}: {str(exc)[:140]}"

    with ThreadPoolExecutor(max_workers=16) as pool:
        return {sid: (entries, err) for sid, entries, err in pool.map(one, sources)}


def update_health(status: dict, now: datetime) -> dict:
    """Guarda, por fonte, desde quando está fora do ar e o último dia em que funcionou.
    Só muda em transições (e uma vez por dia), para não gerar commit a cada 30 minutos."""
    path = DATA / "health.json"
    old = load_json(path, {})
    new = {}
    for sid, st in status.items():
        prev = old.get(sid, {})
        if st["ok"]:
            new[sid] = {"down_since": "", "last_ok": now.strftime("%Y-%m-%d")}
        else:
            new[sid] = {"down_since": prev.get("down_since") or now.strftime("%Y-%m-%d %H:00"),
                        "last_ok": prev.get("last_ok", "")}
    if new != old:
        write_atomic(path, json.dumps(new, ensure_ascii=False, indent=1, sort_keys=True))
    return new


def collect(window_days: int = 7, per_source_limit: int = 40, validar: bool = False) -> dict:
    """Atualiza data/articles.json (e health.json/status.json). Devolve estatísticas."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=window_days)
    store = load_store()  # levanta StoreCorrupted em vez de apagar o histórico
    seen_titles = {title_key(a["source"], a["title"]) for a in store.values()}
    sources = load_sources()
    results = _fetch_all(sources)

    status, novas = {}, 0
    pend_ids: set[str] = set()
    pendentes: list[dict] = []  # notícias novas; só entram no arquivo depois da pré-validação
    por_fonte: dict[str, int] = {}
    meta: dict[str, tuple] = {}
    for src in sources:
        entries, err = results[src["id"]]
        added = 0
        usable = [e for e in _newest_first(entries) if e["url"] and e["title"] and keep_entry(src, e)]
        for e in usable[:src.get("limite", per_source_limit)]:
            aid = article_id(e["url"])
            tkey = title_key(src["id"], e["title"])
            if aid in store:
                registrar_troca(store[aid], e["title"], now)
                continue
            if aid in pend_ids or tkey in seen_titles:
                continue
            pub = e["published"] or now  # sem data no feed: usamos o momento da coleta
            if pub > now + timedelta(hours=2):
                pub = now
            if pub < cutoff:
                continue
            pendentes.append({
                "id": aid, "title": e["title"], "desc": e["desc"], "url": canonical_url(e["url"]),
                "source": src["id"], "kind": src.get("kind", "noticia"),
                "published": pub.isoformat(timespec="seconds"), "seen": now.isoformat(timespec="seconds"),
            })
            seen_titles.add(tkey)
            pend_ids.add(aid)
        meta[src["id"]] = (src, entries, err, len(usable))

    validacao = {}
    if validar and pendentes:
        from .validar import validar_novas
        pendentes, descartadas, validacao = validar_novas(pendentes)
        for a, motivo in descartadas:
            print(f"descartada ({motivo}): {a['source']}: {a['title'][:70]}")
    for a in pendentes:
        store[a["id"]] = a
        por_fonte[a["source"]] = por_fonte.get(a["source"], 0) + 1
    novas = len(pendentes)
    for sid, (src, entries, err, usable_n) in meta.items():
        status[sid] = {"name": src["name"], "ok": not err, "items": len(entries), "usable": usable_n, "new": por_fonte.get(sid, 0), "error": err,
                       "checked": now.isoformat(timespec="seconds")}

    articles = [a for a in store.values() if datetime.fromisoformat(a["published"]) >= cutoff]
    articles.sort(key=lambda a: a["published"], reverse=True)
    articles = articles[:MAX_ARTICLES]
    write_atomic(DATA / "articles.json", json.dumps({"articles": articles}, ensure_ascii=False, separators=(",", ":")))
    write_atomic(DATA / "status.json", json.dumps(status, ensure_ascii=False, indent=1))
    health = update_health(status, now)

    ok = sum(s["ok"] for s in status.values())
    return {"novas": novas, "total": len(articles), "fontes_ok": ok, "fontes": len(status), "validacao": validacao,
            "fora_do_ar": sorted(k for k, v in health.items() if v["down_since"])}


def check_feeds() -> None:
    """Testa cada feed e mostra quais estão vivos."""
    for sid, (entries, err) in _fetch_all(load_sources()).items():
        print(f"OK    {sid:<22} {len(entries)} itens" if not err else f"FALHA {sid:<22} {err[:110]}")

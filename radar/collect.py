"""Coleta de RSS/Atom, sem IA e sem custo. Guarda só título, descrição curta e link.

O armazenamento é um JSON simples (data/articles.json), fácil de versionar no Git e de
persistir entre execuções do GitHub Actions. Só a biblioteca padrão lê o XML.
"""
import hashlib
import html
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("RADAR_DATA") or ROOT / "data")
UA = "RadarNoticias/1.0 (agregador; respeita RSS; contato no site)"
MAX_DESC = 260  # trecho curto de propósito
TRACKING = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref"}


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def load_sources(path: Path = ROOT / "config" / "sources.json") -> list[dict]:
    return load_json(path, {"sources": []})["sources"]


def clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def short(text: str, n: int = MAX_DESC) -> str:
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0].rstrip(",;:.- ")
    return cut + "…"


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    q = [(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in TRACKING]
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path, urlencode(q), ""))


def article_id(url: str) -> str:
    return hashlib.sha1(canonical_url(url).encode()).hexdigest()[:12]


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


def parse_feed(content: bytes) -> list[dict]:
    """Devolve [{title, url, desc, published(datetime|None)}] de um feed RSS 2.0 ou Atom."""
    root = ET.fromstring(content)
    out = []
    for n in (x for x in root.iter() if _local(x.tag) in ("item", "entry")):
        url = _child_text(n, "link")
        if not url:
            for child in n:
                if _local(child.tag) == "link" and child.get("href") and child.get("rel", "alternate") == "alternate":
                    url = child.get("href")
                    break
        title = clean(_child_text(n, "title"))
        desc = clean(_child_text(n, "description", "summary", "content"))
        if desc.lower().startswith(title.lower()[:40]) and len(desc) < len(title) + 20:
            desc = ""  # descrição que só repete o título não ajuda ninguém
        out.append(
            {
                "title": title,
                "url": url.strip(),
                "desc": short(desc),
                "published": _parse_date(_child_text(n, "pubdate", "published", "updated", "date")),
            }
        )
    return out


def fetch_feed(source: dict) -> list[dict]:
    resp = requests.get(source["url"], headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, */*"}, timeout=20)
    resp.raise_for_status()
    return parse_feed(resp.content)


def collect(window_days: int = 7, per_source_limit: int = 40) -> dict:
    """Atualiza data/articles.json e data/status.json. Devolve estatísticas."""
    DATA.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=window_days)

    store = {a["id"]: a for a in load_json(DATA / "articles.json", {"articles": []})["articles"]}
    status = {}
    novas = 0

    for src in load_sources():
        try:
            entries = fetch_feed(src)
            ok, err = True, ""
        except Exception as exc:  # um feed quebrado não derruba os outros
            entries, ok, err = [], False, str(exc)[:160]
        added = 0
        for e in entries[:per_source_limit]:
            if not e["url"] or not e["title"]:
                continue
            aid = article_id(e["url"])
            if aid in store:
                continue
            pub = e["published"] or now  # sem data no feed: usamos o momento da coleta
            if pub > now + timedelta(hours=2):
                pub = now
            if pub < cutoff:
                continue
            store[aid] = {
                "id": aid,
                "title": e["title"],
                "desc": e["desc"],
                "url": canonical_url(e["url"]),
                "source": src["id"],
                "kind": src.get("kind", "noticia"),
                "published": pub.isoformat(timespec="seconds"),
                "seen": now.isoformat(timespec="seconds"),
            }
            added += 1
        novas += added
        status[src["id"]] = {"name": src["name"], "ok": ok, "items": len(entries), "new": added, "error": err,
                             "checked": now.isoformat(timespec="seconds")}
        time.sleep(0.3)  # educação com os servidores

    articles = [a for a in store.values() if datetime.fromisoformat(a["published"]) >= cutoff]
    articles.sort(key=lambda a: a["published"], reverse=True)
    (DATA / "articles.json").write_text(json.dumps({"articles": articles}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "status.json").write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"novas": novas, "total": len(articles), "fontes_ok": sum(s["ok"] for s in status.values()), "fontes": len(status)}


def check_feeds() -> None:
    """Testa cada feed e mostra quais estão vivos."""
    for src in load_sources():
        try:
            entries = fetch_feed(src)
            print(f"OK    {src['id']:<22} {len(entries)} itens")
        except Exception as exc:
            print(f"FALHA {src['id']:<22} {str(exc)[:110]}")

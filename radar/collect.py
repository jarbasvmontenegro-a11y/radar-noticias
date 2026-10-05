"""Coleta de RSS/Atom. Guarda só manchete, link e trecho curto (nunca o texto completo).

Usa só a biblioteca padrão para ler o XML (sem feedparser) para manter as dependências mínimas.
"""
import html
import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

import requests

from .db import connect

TZ = ZoneInfo("America/Sao_Paulo")
UA = "RadarNoticias/0.1 (agregador pessoal; respeita RSS)"
MAX_SNIPPET = 280  # caracteres; trecho curto de propósito


def load_config(path: str = "config/sources.json") -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _local(tag: str) -> str:
    """'{ns}title' -> 'title'"""
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(node: ET.Element, *names: str) -> str:
    for child in node:
        if _local(child.tag) in names and (child.text or "").strip():
            return child.text.strip()
    return ""


def _parse_date(raw: str) -> datetime:
    raw = (raw or "").strip()
    if raw:
        try:
            dt = parsedate_to_datetime(raw)  # RFC 822 (RSS)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            pass
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))  # ISO 8601 (Atom)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def parse_feed(content: bytes) -> list[dict]:
    """Devolve [{title, url, snippet, published}] de um feed RSS 2.0 ou Atom."""
    root = ET.fromstring(content)
    entries = [n for n in root.iter() if _local(n.tag) in ("item", "entry")]
    out = []
    for n in entries:
        url = _child_text(n, "link")
        if not url:  # Atom guarda o link em <link href="...">
            for child in n:
                if _local(child.tag) == "link" and child.get("href"):
                    if child.get("rel", "alternate") == "alternate":
                        url = child.get("href")
                        break
        out.append(
            {
                "title": clean(_child_text(n, "title")),
                "url": url.strip(),
                "snippet": clean(_child_text(n, "description", "summary", "content"))[:MAX_SNIPPET],
                "published": _parse_date(_child_text(n, "pubdate", "published", "updated", "date")),
            }
        )
    return out


def fetch_feed(source: dict) -> list[dict]:
    resp = requests.get(source["url"], headers={"User-Agent": UA}, timeout=20)
    resp.raise_for_status()
    return parse_feed(resp.content)


def collect(config_path: str = "config/sources.json", max_age_hours: int = 36) -> dict:
    cfg = load_config(config_path)
    now = datetime.now(timezone.utc)
    stats = {"novas": 0, "falhas": []}
    with connect() as conn:
        for src in cfg["sources"]:
            try:
                entries = fetch_feed(src)
            except Exception as exc:  # um feed quebrado não derruba os outros
                stats["falhas"].append(f"{src['id']}: {exc}")
                continue
            for e in entries:
                if not e["url"] or not e["title"]:
                    continue
                if (now - e["published"]).total_seconds() > max_age_hours * 3600:
                    continue
                day = e["published"].astimezone(TZ).strftime("%Y-%m-%d")
                cur = conn.execute(
                    """INSERT OR IGNORE INTO articles
                       (url, title, snippet, source_id, source_name, section, published, day)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (e["url"], e["title"], e["snippet"], src["id"], src["name"],
                     src.get("section", "geral"), e["published"].isoformat(), day),
                )
                stats["novas"] += cur.rowcount
            time.sleep(0.5)  # educação com os servidores
    return stats


def check_feeds(config_path: str = "config/sources.json") -> None:
    """Testa cada feed e mostra quais estão vivos."""
    cfg = load_config(config_path)
    for src in cfg["sources"]:
        try:
            entries = fetch_feed(src)
            print(f"OK    {src['id']:<24} {len(entries)} itens")
        except Exception as exc:
            print(f"FALHA {src['id']:<24} {exc}")

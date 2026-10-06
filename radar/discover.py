"""Diagnóstico de fontes: descobre quais endereços de feed ou sitemap de notícias funcionam de verdade.

Roda no GitHub Actions (rede livre). Para cada candidato de config/candidatos.json testa:
- os endereços listados, mais variações comuns (/feed/, /rss, /rss.xml);
- a home (procura <link rel="alternate"> de RSS/Atom e links que parecem feed);
- o robots.txt (linhas "Sitemap:") e, nos índices de sitemap, os arquivos de notícias.
Para cada resposta guarda status, tipo, nº de itens, item mais novo e uma amostra, para escolher com dados.
"""
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import requests

from .collect import ILLEGAL_XML, ROOT, UA, _local, parse_entries, parse_xml
from .geo import states

MAX_BYTES = 2_000_000
COMMON = ("/feed/", "/feed", "/rss", "/rss.xml", "/feed.xml", "/index.xml")
FEED_TYPES = ("application/rss+xml", "application/atom+xml", "application/xml", "text/xml")


def fetch(url: str) -> dict:
    t0 = time.time()
    out = {"url": url}
    try:
        with requests.get(url, headers={"User-Agent": UA, "Accept": "*/*"}, timeout=(6, 14), stream=True, allow_redirects=True) as r:
            out.update(status=r.status_code, final=r.url if r.url != url else "", ctype=r.headers.get("content-type", "")[:50])
            body, size = [], 0
            for chunk in r.iter_content(65536):
                size += len(chunk)
                body.append(chunk)
                if size > MAX_BYTES:
                    out["truncado"] = True
                    break
            out["_body"] = b"".join(body)
            out["bytes"] = len(out["_body"])
    except Exception as exc:  # noqa: BLE001 (diagnóstico: qualquer falha é informação)
        out["erro"] = f"{type(exc).__name__}: {str(exc)[:110]}"
    out["ms"] = int((time.time() - t0) * 1000)
    return out


def _attrs(tag: str) -> dict:
    return {k.lower(): v for k, v in re.findall(r'([\w:-]+)\s*=\s*["\']([^"\']*)["\']', tag)}


def analyze(res: dict) -> dict:
    """Preenche kind/itens/mais_novo/amostra (XML) ou alternates (HTML). Remove o corpo bruto."""
    body = res.pop("_body", b"")
    if res.get("erro") or res.get("status") != 200 or not body:
        return res
    head = body[:400].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head[:1] == b"<" and (head.startswith((b"<?xml", b"<rss", b"<feed", b"<urlset", b"<sitemapindex", b"<RDF", b"<rdf"))):
        try:
            root = parse_xml(body)
            tag = _local(root.tag)
            if tag == "sitemapindex":
                locs = [(c.text or "").strip() for c in root.iter() if _local(c.tag) == "loc"]
                res.update(kind="sitemapindex", filhos=locs[:40])
                return res
            entries = parse_entries(body)
            dates = [e["published"] for e in entries if e["published"]]
            res.update(
                kind="sitemap" if tag == "urlset" else "feed", itens=len(entries),
                com_descricao=sum(1 for e in entries if e["desc"]),
                mais_novo=max(dates).isoformat(timespec="minutes") if dates else "",
                mais_antigo=min(dates).isoformat(timespec="minutes") if dates else "",
                amostra=[{"t": e["title"][:90], "u": e["url"][:110]} for e in entries[:3]],
            )
        except Exception as exc:  # noqa: BLE001
            res.update(kind="xml-quebrado", parse_erro=f"{type(exc).__name__}: {str(exc)[:100]}")
            m = re.search(r"line (\d+), column (\d+)", str(exc))
            lines = body.decode("utf-8", "replace").splitlines()
            if m and int(m.group(1)) <= len(lines):
                ln, col = int(m.group(1)), int(m.group(2))
                res["trecho"] = lines[ln - 1][max(0, col - 60): col + 60]
            else:
                res["trecho"] = body[:200].decode("utf-8", "replace")
        return res
    text = body.decode("utf-8", "replace")
    if re.search(r"<html|<!doctype html", text[:2000], re.I):
        alts, anchors = [], []
        for tag in re.findall(r"<link\b[^>]*>", text, re.I):
            a = _attrs(tag)
            if "alternate" in a.get("rel", "").lower() and a.get("type", "").lower() in FEED_TYPES and a.get("href"):
                alts.append(urljoin(res["url"], a["href"]))
        for href in re.findall(r'<a\b[^>]*href=["\']([^"\']+)["\']', text, re.I):
            if re.search(r"(/rss|/feed|\.xml$|\.rss$|rss\.)", href, re.I) and not href.startswith(("#", "javascript")):
                anchors.append(urljoin(res["url"], href))
        t = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
        res.update(kind="html", titulo=re.sub(r"\s+", " ", t.group(1)).strip()[:80] if t else "",
                   alternates=list(dict.fromkeys(alts))[:10], links_feed=list(dict.fromkeys(anchors))[:15])
    elif text.lstrip().startswith("User-agent") or "sitemap:" in text.lower()[:5000] or "disallow" in text.lower()[:5000]:
        res.update(kind="robots", sitemaps=re.findall(r"(?im)^\s*sitemap:\s*(\S+)", text)[:20])
    else:
        res.update(kind="outro", trecho=text[:160].replace("\n", " "))
    return res


def probe(url: str) -> dict:
    return analyze(fetch(url))


def candidates(group: dict) -> list[str]:
    home = group["home"]
    parts = urlsplit(home)
    origin = f"{parts.scheme}://{parts.netloc}"
    base = home.rstrip("/")
    urls = list(group.get("urls", [])) + [home, origin + "/robots.txt"]
    urls += [origin + p for p in COMMON] + [base + p for p in ("/feed/", "/rss.xml") if base != origin]
    return list(dict.fromkeys(urls))


def g1_groups() -> list[dict]:
    out = []
    for s in states():
        slug, uf = s["g1"], s["uf"].lower()
        out.append({"id": f"g1-{uf}", "nome": f"g1 {s['nome']}", "home": f"https://g1.globo.com/{uf}/{slug}/", "uf": s["uf"], "grupo": "regional",
                    "urls": [f"https://g1.globo.com/rss/g1/{slug}/", f"https://g1.globo.com/rss/g1/{uf}/{slug}/"]})
    return out


def usable(r: dict, now: datetime) -> bool:
    if r.get("kind") not in ("feed", "sitemap") or not r.get("itens"):
        return False
    try:
        return now - datetime.fromisoformat(r["mais_novo"]) < timedelta(days=3)
    except ValueError:
        return False


def run(out_json: str, out_md: str) -> None:
    cfg = json.loads((ROOT / "config" / "candidatos.json").read_text(encoding="utf-8"))["grupos"] + g1_groups()
    now = datetime.now(timezone.utc)
    work = {g["id"]: candidates(g) for g in cfg}
    results: dict[str, dict] = {}

    def many(urls):
        todo = [u for u in dict.fromkeys(urls) if u not in results]
        with ThreadPoolExecutor(max_workers=14) as pool:
            for r in pool.map(probe, todo):
                results[r["url"]] = r

    many([u for urls in work.values() for u in urls])  # onda 1

    # onda 2: feeds anunciados no HTML, sitemaps do robots.txt e arquivos de notícias dentro de índices de sitemap
    extra: dict[str, list[str]] = {}
    for gid, urls in work.items():
        found: list[str] = []
        for u in urls:
            r = results.get(u, {})
            found += r.get("alternates", []) + r.get("links_feed", [])[:8] + r.get("sitemaps", [])[:6]
        extra[gid] = [x for x in dict.fromkeys(found) if x not in results][:12]
    many([u for urls in extra.values() for u in urls])
    third: dict[str, list[str]] = {}
    for gid in work:
        kids = []
        for u in work[gid] + extra[gid]:
            r = results.get(u, {})
            if r.get("kind") == "sitemapindex":
                news = [c for c in r["filhos"] if re.search(r"news|noticia|latest|recent", c, re.I)]
                kids += (news or r["filhos"])[:3]
        third[gid] = [x for x in dict.fromkeys(kids) if x not in results][:6]
    many([u for urls in third.values() for u in urls])

    report, md = {}, ["# Diagnóstico de fontes", f"Gerado em {now.isoformat(timespec='minutes')}", ""]
    for g in cfg:
        gid = g["id"]
        rows = [results[u] for u in work[gid] + extra[gid] + third[gid] if u in results]
        good = [r for r in rows if usable(r, now)]
        report[gid] = {"nome": g["nome"], "grupo": g.get("grupo", "nacional"), "uf": g.get("uf", ""),
                       "melhores": [r["url"] for r in sorted(good, key=lambda r: -(r.get("itens") or 0))[:3]], "testes": rows}
        md.append(f"## {g['nome']} (`{gid}`){' ' + g['uf'] if g.get('uf') else ''}")
        if good:
            for r in sorted(good, key=lambda r: -(r.get("itens") or 0))[:4]:
                md.append(f"- OK {r['kind']} {r['itens']} itens ({r.get('com_descricao', 0)} com descrição), mais novo {r['mais_novo']}: {r['url']}")
                for a in r["amostra"][:2]:
                    md.append(f"    - {a['t']}  <{a['u']}>")
        else:
            md.append("- nenhum endereço utilizável")
        stale = [r for r in rows if r.get("kind") in ("feed", "sitemap") and r not in good]
        for r in stale[:3]:
            md.append(f"- velho/vazio: {r['kind']} {r.get('itens')} itens, mais novo {r.get('mais_novo') or '-'}: {r['url']}")
        for r in [r for r in rows if r.get("kind") == "xml-quebrado"][:2]:
            md.append(f"- XML quebrado: {r['url']} ({r.get('parse_erro')}) trecho: {r.get('trecho', '')[:120]!r}")
        fails = [r for r in rows if r.get("erro") or (r.get("status") and r["status"] != 200)]
        md.append(f"- falhas: " + ", ".join(sorted({str(r.get('status') or r.get('erro', '?')[:30]) for r in fails}))[:200] + f" ({len(fails)} de {len(rows)})")
        md.append("")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    with open(out_md, "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    ok = sum(1 for v in report.values() if v["melhores"])
    print(f"{ok} de {len(report)} grupos com algum feed utilizável. Detalhes em {out_md}")

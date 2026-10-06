"""Gera o site estático (pasta site/) a partir de data/articles.json.

Tudo que importa para SEO (títulos, descrições, links) já vem no HTML, sem depender de JavaScript.
O JavaScript só melhora a experiência (busca, tamanho da letra, resumo e verificador sob demanda).
"""
import base64
import hashlib
import json
import os
import re
import shutil
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import geo
from .cluster import cluster, topic_of
from .collect import DATA, ROOT, load_json, load_sources, safe_url

TZ = ZoneInfo("America/Sao_Paulo")
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro",
         "novembro", "dezembro"]
DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]


def long_date(d: datetime) -> str:
    return f"{d.day} de {MESES[d.month - 1]} de {d.year}"


def weekday_date(d: datetime) -> str:
    return f"{DIAS[d.weekday()]}, {long_date(d)}"


def prepare(articles: list[dict], sources: dict, now: datetime) -> list[dict]:
    out = []
    for a in articles:
        try:
            if not safe_url(a.get("url", "")) or not a.get("title"):
                continue  # nunca renderiza link que não seja http(s)
            pub = datetime.fromisoformat(a["published"]).astimezone(TZ)
        except (KeyError, ValueError, TypeError):
            continue  # registro quebrado não derruba o site inteiro
        src = sources.get(a.get("source"), {"name": a.get("source", "?"), "id": a.get("source", "?")})
        same_day = pub.date() == now.date()
        gap = (now.date() - pub.date()).days
        label = "Hoje" if gap == 0 else "Ontem" if gap == 1 else f"{DIAS[pub.weekday()].split('-')[0].capitalize()}, {pub.day} de {MESES[pub.month - 1]}"
        out.append({**a, "source_name": src["name"], "source_id": src["id"], "dt": pub,
                    "day": pub.strftime("%Y-%m-%d"), "day_label": label, "hm": pub.strftime("%H:%M"),
                    "time_label": pub.strftime("%H:%M") if same_day else pub.strftime("%d/%m %H:%M")})
    return out


def short_desc(desc: str, limit: int = 220) -> str:
    """Descrição curta para a mensagem: tira o "Leia no X." que os feeds acrescentam e corta em fim de frase ou palavra."""
    d = re.sub(r"\s*Leia (?:mais )?(?:no|na|em|o texto no|a matéria no)\s+[^.]{1,40}\.?\s*$", "", (desc or "").strip()).strip()
    if len(d) <= limit:
        return d
    cut = d[:limit]
    dot = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[:dot + 1] if dot >= 80 else cut.rsplit(" ", 1)[0].rstrip(",;:") + "…"


def share_text(a: dict, cfg: dict) -> str:
    """Mensagem pronta para o WhatsApp (espelha RadarShare.newsMessage, em static/share.js).
    Sem emojis fora do alfabeto básico (alguns WhatsApp Web mostram "�"). O link vai por último, para a prévia do WhatsApp.
    Uma checagem de agência é apresentada como checagem; notícia comum, como notícia. Nunca afirmamos que algo é falso."""
    src, title = a["source_name"], a["title"][:200]
    desc = short_desc(a.get("desc", ""))
    lines = [f"*{title}*"]
    if desc:
        lines += ["", desc]
    if a["kind"] == "checagem":
        lines += ["", f"Checagem publicada por {src}. Confira antes de repassar boatos."]
    lines += ["", f"_{src} · via {cfg['name']}_", "Leia a matéria completa:", a["url"]]
    return "\n".join(lines)


def wa_link(text: str) -> str:
    return "https://wa.me/?text=" + quote(text, safe="")


class BuildError(RuntimeError):
    pass


_LD = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
_BAD_HREF = re.compile(r'<a\b[^>]*\bhref="\s*(?:javascript|data|vbscript):', re.I)  # só links; o favicon usa data:


def verify_site(path: Path, min_items: int = 0) -> list[str]:
    """Confere o site gerado antes de publicar. Devolve a lista de problemas (vazia = ok)."""
    problems: list[str] = []
    required = ["index.html", "404.html", "sitemap.xml", "robots.txt", "verificador/index.html", "sobre/index.html",
                "privacidade/index.html", "estados/index.html", "fontes/index.html", "data/search-index.json", "data/allowed-hosts.json", "data/municipios.json", "style.css", "app.js", "share.js",
                "manifest.webmanifest"]
    for f in required:
        if not (path / f).is_file():
            problems.append(f"arquivo ausente: {f}")
    if problems:
        return problems
    try:
        ET.parse(path / "sitemap.xml")
    except ET.ParseError as exc:
        problems.append(f"sitemap.xml inválido: {exc}")
    for f in ("data/search-index.json", "data/allowed-hosts.json"):
        try:
            json.loads((path / f).read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"{f} inválido: {exc}")
    for page in path.rglob("*.html"):
        rel, text = page.relative_to(path), page.read_text(encoding="utf-8")
        if "<title>" not in text or 'rel="canonical"' not in text or 'name="description"' not in text:
            problems.append(f"{rel}: falta title, canonical ou description")
        if _BAD_HREF.search(text):
            problems.append(f"{rel}: link com esquema perigoso")
        for m in _LD.finditer(text):
            try:
                json.loads(m.group(1))
            except json.JSONDecodeError as exc:
                problems.append(f"{rel}: JSON-LD inválido ({exc})")
    n = (path / "index.html").read_text(encoding="utf-8").count('class="item"')
    if n < min_items:
        problems.append(f"home com {n} itens; esperado pelo menos {min_items}")
    return problems


def source_groups(all_sources: list[dict], counts: dict) -> list[dict]:
    """Fontes agrupadas para a página /fontes/: nacionais, oficiais, checagem e regionais por estado."""
    def rows(lst):
        return [{"id": s["id"], "name": s["name"], "home": s["home"], "n": counts.get(s["id"], 0)} for s in lst]
    out = []
    for gid, titulo in (("nacional", "Veículos nacionais"), ("oficial", "Agências oficiais"), ("checagem", "Agências de checagem")):
        lst = [s for s in all_sources if s.get("grupo", "nacional") == gid]
        if lst:
            out.append({"titulo": titulo, "fontes": rows(lst)})
    nomes = {e["uf"]: e["nome"] for e in geo.states()}
    por_uf: dict[str, list] = {}
    for s in all_sources:
        if s.get("grupo") == "regional":
            por_uf.setdefault(s.get("uf", ""), []).append(s)
    out.append({"titulo": "Veículos regionais, por estado", "estados": [
        {"uf": uf, "nome": nomes.get(uf, uf), "fontes": rows(lst)} for uf, lst in sorted(por_uf.items(), key=lambda kv: nomes.get(kv[0], kv[0]))]})
    return out


def build(out_dir: str = "site") -> str:
    cfg = json.loads((ROOT / "config" / "site.json").read_text(encoding="utf-8"))
    cfg["site_url"] = (os.environ.get("SITE_URL") or cfg["site_url"]).rstrip("/")
    cfg["adsense_client"] = os.environ.get("ADSENSE_CLIENT") or cfg.get("adsense_client", "")
    cfg["turnstile_sitekey"] = os.environ.get("TURNSTILE_SITEKEY") or cfg.get("turnstile_sitekey", "")
    cfg["contact_email"] = os.environ.get("CONTACT_EMAIL") or cfg.get("contact_email", "")

    all_sources = load_sources()
    sources = {s["id"]: s for s in all_sources}
    store = load_json(DATA / "articles.json", {"updated": None, "articles": []})
    status = load_json(DATA / "status.json", {})
    health = load_json(DATA / "health.json", {})
    now = datetime.now(TZ)

    items = prepare(store["articles"], sources, now)
    for a in items:
        a["grupo"] = sources.get(a["source"], {}).get("grupo", "nacional")
    for a in items:  # estados citados (até 3; notícia que cita muitos estados é nacional) + estado da fonte regional
        default = sources.get(a["source"], {}).get("uf", "") if a["grupo"] == "regional" else ""
        found = geo.detect(f"{a['title']} {a.get('desc', '')}", default)
        a["ufs"] = found if len(found) <= 3 else ([default] if default else [])
    all_news = [a for a in items if a["kind"] == "noticia"]
    news = [a for a in all_news if a["grupo"] != "regional"]  # home, temas e arquivo: escopo nacional
    checks = [a for a in items if a["kind"] == "checagem"]

    # temas e assuntos cobertos por vários veículos: comparação de palavras, sem IA
    topics = json.loads((ROOT / "config" / "topics.json").read_text(encoding="utf-8"))
    for a in news:
        a["topics"] = topic_of(a, topics)
        a["also"] = []
    recent = [a for a in news if (now - a["dt"]).total_seconds() < 36 * 3600]
    groups = cluster(recent)
    for g in groups:
        for a in g:
            a["also"] = sorted({x["source_name"] for x in g if x["source"] != a["source"]})
    highlights = []
    for g in groups[:5]:
        names = sorted({x["source_name"] for x in g})
        por_veiculo, vistos = [], set()
        for x in g:  # uma manchete por veículo: é o que mostra como cada um contou o mesmo fato
            if x["source"] not in vistos:
                vistos.add(x["source"])
                por_veiculo.append(x)
        highlights.append({"lead": g[0], "n": len(names), "names": names, "veiculos": por_veiculo[:6]})
    for a in items:
        a["wa"] = wa_link(share_text(a, cfg))

    final = ROOT / out_dir
    out = final.with_name(final.name + ".new")  # monta numa pasta temporária; só troca se passar na verificação
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape(["html", "xml"]))
    # JSON dentro de <script>: escapa < > & e separadores de linha para nunca "fechar" a tag
    env.filters["jsonld"] = lambda v: (json.dumps(v, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
                                       .replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))

    news_sources = [s for s in all_sources if s["kind"] == "noticia" and s.get("grupo") != "regional"]  # menus: sem os regionais
    check_sources = [s for s in all_sources if s["kind"] == "checagem"]
    counts = {}
    for a in items:
        counts[a["source"]] = counts.get(a["source"], 0) + 1

    days = sorted({a["day"] for a in news}, reverse=True)
    day_links = [{"day": d, "label": long_date(datetime.strptime(d, "%Y-%m-%d"))} for d in days[:7]]

    estados = geo.states()
    uf_news = {e["uf"]: [a for a in all_news if e["uf"] in a["ufs"]] for e in estados}
    regioes = []
    for reg in ("Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"):
        regioes.append({"nome": reg, "estados": [{"uf": e["uf"], "nome": e["nome"], "n": len(uf_news[e["uf"]])} for e in estados if e["regiao"] == reg]})
    ctx = {
        "regioes": regioes, "uf_nome": {e["uf"]: e["nome"] for e in estados}, "active_uf": None,
        "day_links": day_links,
        "cfg": cfg, "news_sources": news_sources, "check_sources": check_sources, "counts": counts,
        "now": now, "today_long": long_date(now), "weekday_long": weekday_date(now),
        "updated_label": now.strftime("%d/%m/%Y às %H:%M"), "checks": checks[:6],
        "built_iso": datetime.now(timezone.utc).isoformat(timespec="seconds"), "health": health,
        "highlights": [], "topics": topics, "active_topic": None,
        "topic_links": [{"id": t["id"], "name": t["name"], "n": sum(1 for a in news if t["id"] in a["topics"])} for t in topics],
    }
    pages: list[tuple[str, str | None]] = []  # (caminho, lastmod) para o sitemap

    def render(page_path: str, template: str, **kw) -> None:
        if "articles" in kw:
            kw["ld_items"] = [{"@type": "ListItem", "position": i + 1, "url": a["url"], "name": a["title"]}
                              for i, a in enumerate(kw["articles"][:10])]
        html = env.get_template(template).render(**{**ctx, **kw})
        dest = out / page_path.strip("/") / "index.html" if page_path != "/" else out / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(html, encoding="utf-8")

    last = (items[0]["dt"] if items else now).strftime("%Y-%m-%d")

    # --- listas paginadas ---------------------------------------------------------------
    page_size = cfg["page_size"]

    def listing(base: str, arts: list[dict], max_pages: int = 15, **kw) -> None:
        """Página 1 em `base` e as seguintes em `base`pagina/N/ (noindex: o que vale para busca é a página 1)."""
        pages_n = max(1, min(max_pages, math.ceil(len(arts) / page_size)))
        title, desc = kw.pop("title"), kw.pop("description")
        for n in range(1, pages_n + 1):
            path = base if n == 1 else f"{base}pagina/{n}/"
            render(path, "index.html", path=path, base=base, articles=arts[(n - 1) * page_size:n * page_size], total=len(arts),
                   page=n, pages=pages_n, noindex=n > 1, title=title if n == 1 else f"{title} (página {n})", description=desc, **kw)

    listing("/", news, active=None, highlights=highlights,
            title=f"Notícias de política hoje, {long_date(now)} | {cfg['name']}",
            description=(f"As últimas notícias de política do Brasil, {long_date(now)}: títulos e resumos curtos de "
                         f"{len(news_sources)} veículos, atualizados de hora em hora, com link direto para a fonte. "
                         "Resumo com IA sob demanda e verificador de fake news."),
            heading="Notícias de política hoje", subheading="Manchetes dos principais veículos")
    pages.append(("/", last))

    # --- por estado ---------------------------------------------------------------------
    for e in estados:
        lst = uf_news[e["uf"]]
        if not lst:
            continue
        nfontes = len({a["source"] for a in lst})
        listing(f"/estado/{e['uf'].lower()}/", lst, max_pages=8, active=None, active_uf=e["uf"],
                title=f"Política em {e['nome']}: últimas notícias | {cfg['name']}",
                description=f"Manchetes de política de {e['nome']} e do que o país noticia sobre o estado, de {nfontes} fontes, com link para ler no veículo.",
                heading=f"Política em {e['nome']}", subheading="Veículos locais e nacionais que citam o estado")
        pages.append((f"/estado/{e['uf'].lower()}/", lst[0]["dt"].strftime("%Y-%m-%d")))
    render("/estados/", "states.html", path="/estados/", title=f"Notícias de política por estado | {cfg['name']}",
           description="Escolha um estado e veja as manchetes de política de veículos locais e nacionais.")
    pages.append(("/estados/", last))

    # --- por fonte ----------------------------------------------------------------------
    for s in all_sources:
        lst = [a for a in items if a["source"] == s["id"]]
        listing(f"/fonte/{s['id']}/", lst, max_pages=3, active=s["id"], source=s,
                title=f"{s['name']}: últimas notícias de política | {cfg['name']}",
                description=f"Últimas manchetes de {s['name']} sobre política, reunidas pelo {cfg['name']}, com link para ler na fonte.",
                heading=f"{s['name']}", subheading="Últimas manchetes de política")
        if lst:
            pages.append((f"/fonte/{s['id']}/", lst[0]["dt"].strftime("%Y-%m-%d")))
    render("/fontes/", "sources.html", path="/fontes/", title=f"Fontes monitoradas | {cfg['name']}",
           description=f"Os {len(all_sources)} veículos e agências que o {cfg['name']} acompanha, por tipo e por estado.",
           grupos=source_groups(all_sources, counts))
    pages.append(("/fontes/", last))

    # --- por tema -----------------------------------------------------------------------
    for t in topics:
        lst = [a for a in news if t["id"] in a["topics"]]
        if not lst:
            continue
        listing(f"/tema/{t['id']}/", lst, max_pages=5, active=None, active_topic=t["id"],
                title=f"{t['name']}: últimas notícias de política | {cfg['name']}",
                description=f"Manchetes recentes sobre {t['name'].lower()} na política brasileira, de {len({a['source'] for a in lst})} veículos, com link para ler na fonte.",
                heading=t["name"], subheading="Manchetes por tema")
        pages.append((f"/tema/{t['id']}/", lst[0]["dt"].strftime("%Y-%m-%d")))

    # --- por dia (arquivo) --------------------------------------------------------------
    for d in days:
        lst = [a for a in news if a["day"] == d]
        dd = datetime.strptime(d, "%Y-%m-%d")
        listing(f"/dia/{d}/", lst, max_pages=8, active=None, day=d,
                title=f"Notícias de política em {long_date(dd)} | {cfg['name']}",
                description=f"Principais manchetes de política do Brasil em {long_date(dd)}, de {len({a['source'] for a in lst})} veículos.",
                heading=f"Política em {long_date(dd)}", subheading=f"{len(lst)} manchetes registradas")
        pages.append((f"/dia/{d}/", d))

    # --- páginas fixas ------------------------------------------------------------------
    render("/verificador/", "verifier.html", path="/verificador/",
           title=f"Verificador de fake news: confira boatos sobre política | {cfg['name']}",
           description="Cole um texto ou link suspeito e veja se agências de checagem já analisaram, quais notícias confiáveis tratam do assunto e quais sinais de alerta merecem atenção.")
    pages.append(("/verificador/", last))
    render("/sobre/", "about.html", path="/sobre/", title=f"Sobre e metodologia | {cfg['name']}",
           description="Como o Radar de Notícias funciona: quais fontes usa, como coleta, o que a IA faz e o que não faz.",
           status=status)
    pages.append(("/sobre/", None))
    render("/privacidade/", "privacy.html", path="/privacidade/", title=f"Política de privacidade | {cfg['name']}",
           description="Como tratamos dados, cookies e anúncios no Radar de Notícias, em linha com a LGPD.")
    pages.append(("/privacidade/", None))
    (out / "404.html").write_text(env.get_template("404.html").render(**ctx, path="/404.html", title=f"Página não encontrada | {cfg['name']}",
                                                                     description="Página não encontrada."), encoding="utf-8")

    # --- arquivos técnicos --------------------------------------------------------------
    base = cfg["site_url"]
    urls = "".join(
        f"<url><loc>{escape(base + p)}</loc>{f'<lastmod>{m}</lastmod>' if m else ''}</url>" for p, m in pages
    )
    (out / "sitemap.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>',
        encoding="utf-8")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {base}/sitemap.xml\n", encoding="utf-8")
    if cfg["adsense_client"]:
        pub = cfg["adsense_client"].replace("ca-", "")
        (out / "ads.txt").write_text(f"google.com, {pub}, DIRECT, f08c47fec0942fa0\n", encoding="utf-8")

    # app instalável + recebe "compartilhar" do WhatsApp: o texto cai direto no verificador
    (out / "manifest.webmanifest").write_text(json.dumps({
        "name": cfg["name"], "short_name": cfg["name"][:12], "description": cfg["tagline"], "lang": cfg["lang"],
        "start_url": "/", "scope": "/", "display": "standalone", "background_color": "#f6f1e7", "theme_color": "#8c1c13",
        "icons": [{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"},
                  {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                  {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"}],
        "share_target": {"action": "/verificador/", "method": "GET", "params": {"title": "title", "text": "text", "url": "url"}},
    }, ensure_ascii=False), encoding="utf-8")

    # índice usado pelo verificador e pelo resumo (títulos recentes; "c" = agência de checagem, "o" = fonte oficial,
    # "d" = descrição curta, só nas mais recentes para não pesar)
    index = []
    for i, a in enumerate(items[:2500]):
        e = {"t": a["title"], "s": a["source_name"], "u": a["url"], "p": a["published"][:16]}
        if a["kind"] == "checagem":
            e["c"] = 1
        if a["grupo"] == "oficial":
            e["o"] = 1
        if i < 1200 and a.get("desc"):
            e["d"] = short_desc(a["desc"], 110)
        index.append(e)
    (out / "data").mkdir()
    shutil.copy(ROOT / "config" / "municipios.json", out / "data" / "municipios.json")  # lista do IBGE, usada pelo verificador
    (out / "data" / "search-index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    hosts = {urlsplit(s["home"]).hostname for s in all_sources} | {urlsplit(a["url"]).hostname for a in items}
    (out / "data" / "allowed-hosts.json").write_text(
        json.dumps(sorted(h.removeprefix("www.") for h in hosts if h)), encoding="utf-8")

    # cabeçalhos do Cloudflare Pages: segurança + cache
    # CSP: scripts só do próprio site; o único script inline (tema) entra por hash, calculado sobre o HTML gerado.
    hashes = set()
    for page in out.rglob("*.html"):
        for m in re.finditer(r"<script(?![^>]*\b(?:src|type)=)[^>]*>(.*?)</script>", page.read_text(encoding="utf-8"), re.S):
            hashes.add("'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode() + "'")
    script_src = ["'self'", "https://challenges.cloudflare.com", *sorted(hashes)]
    extra_connect, extra_img, extra_frame = [], [], []
    if cfg.get("adsense_client"):
        script_src += ["https://pagead2.googlesyndication.com", "https://*.googlesyndication.com"]
        extra_connect += ["https://*.google.com", "https://*.doubleclick.net", "https://*.googlesyndication.com"]
        extra_img += ["https:"]
        extra_frame += ["https://*.googlesyndication.com", "https://*.doubleclick.net", "https://*.google.com"]
    if cfg.get("cloudflare_analytics_token"):
        script_src.append("https://static.cloudflareinsights.com")
        extra_connect.append("https://cloudflareinsights.com")
    csp = "; ".join([
        "default-src 'self'",
        "script-src " + " ".join(script_src),
        "style-src 'self' 'unsafe-inline'",
        "img-src " + " ".join(["'self'", "data:", *extra_img]),
        "font-src 'self'",
        "connect-src " + " ".join(["'self'", *extra_connect]),
        "frame-src " + " ".join(["https://challenges.cloudflare.com", *extra_frame]),
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", "upgrade-insecure-requests",
    ])
    (out / "_headers").write_text(
        "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  X-Frame-Options: SAMEORIGIN\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n"
        "  Strict-Transport-Security: max-age=31536000; includeSubDomains\n"
        "  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Resource-Policy: same-origin\n"
        f"  Content-Security-Policy: {csp}\n"
        "/*.css\n  Cache-Control: public, max-age=86400\n/*.js\n  Cache-Control: public, max-age=86400\n"
        "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n"
        "/manifest.webmanifest\n  Content-Type: application/manifest+json\n"
        "/\n  Cache-Control: public, max-age=300, s-maxage=300\n/fonte/*\n  Cache-Control: public, max-age=300, s-maxage=300\n"
        "/data/*\n  Cache-Control: public, max-age=300\n", encoding="utf-8")

    if cfg.get("contact_email"):  # RFC 9116: só publica se houver um contato configurado
        (out / ".well-known").mkdir(exist_ok=True)
        expira = (datetime.now(timezone.utc) + timedelta(days=330)).strftime("%Y-%m-%dT%H:%M:%SZ")
        (out / ".well-known" / "security.txt").write_text(
            f"Contact: mailto:{cfg['contact_email']}\nExpires: {expira}\nPreferred-Languages: pt, en\nCanonical: {cfg['site_url']}/.well-known/security.txt\n",
            encoding="utf-8")

    for f in (ROOT / "templates" / "static").iterdir():
        if f.is_dir():
            shutil.copytree(f, out / f.name)
        else:
            shutil.copy(f, out / f.name)
    problems = verify_site(out, min_items=min(len(news), page_size))
    if problems:
        raise BuildError("site gerado não passou na verificação:\n  - " + "\n  - ".join(problems))
    if final.exists():
        shutil.rmtree(final)
    os.replace(out, final)
    return str(final / "index.html")

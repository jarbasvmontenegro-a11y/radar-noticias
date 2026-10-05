"""Gera o site estático (pasta site/) a partir de data/articles.json.

Tudo que importa para SEO (títulos, descrições, links) já vem no HTML, sem depender de JavaScript.
O JavaScript só melhora a experiência (busca, tamanho da letra, resumo e verificador sob demanda).
"""
import json
import os
import re
import shutil
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

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
        out.append({**a, "source_name": src["name"], "source_id": src["id"], "dt": pub,
                    "day": pub.strftime("%Y-%m-%d"),
                    "time_label": pub.strftime("%H:%M") if same_day else pub.strftime("%d/%m %H:%M")})
    return out


class BuildError(RuntimeError):
    pass


_LD = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
_BAD_HREF = re.compile(r'<a\b[^>]*\bhref="\s*(?:javascript|data|vbscript):', re.I)  # só links; o favicon usa data:


def verify_site(path: Path, min_items: int = 0) -> list[str]:
    """Confere o site gerado antes de publicar. Devolve a lista de problemas (vazia = ok)."""
    problems: list[str] = []
    required = ["index.html", "404.html", "sitemap.xml", "robots.txt", "verificador/index.html", "sobre/index.html",
                "privacidade/index.html", "data/search-index.json", "data/allowed-hosts.json", "style.css", "app.js"]
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
    news = [a for a in items if a["kind"] == "noticia"]
    checks = [a for a in items if a["kind"] == "checagem"]

    final = ROOT / out_dir
    out = final.with_name(final.name + ".new")  # monta numa pasta temporária; só troca se passar na verificação
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape(["html", "xml"]))
    # JSON dentro de <script>: escapa < > & e separadores de linha para nunca "fechar" a tag
    env.filters["jsonld"] = lambda v: (json.dumps(v, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
                                       .replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))

    news_sources = [s for s in all_sources if s["kind"] == "noticia"]
    check_sources = [s for s in all_sources if s["kind"] == "checagem"]
    counts = {}
    for a in items:
        counts[a["source"]] = counts.get(a["source"], 0) + 1

    days = sorted({a["day"] for a in news}, reverse=True)
    day_links = [{"day": d, "label": long_date(datetime.strptime(d, "%Y-%m-%d"))} for d in days[:7]]

    ctx = {
        "day_links": day_links,
        "cfg": cfg, "news_sources": news_sources, "check_sources": check_sources, "counts": counts,
        "now": now, "today_long": long_date(now), "weekday_long": weekday_date(now),
        "updated_label": now.strftime("%d/%m/%Y às %H:%M"), "checks": checks[:6],
        "built_iso": datetime.now(timezone.utc).isoformat(timespec="seconds"), "health": health,
    }
    pages: list[tuple[str, str | None]] = []  # (caminho, lastmod) para o sitemap

    def render(page_path: str, template: str, **kw) -> None:
        if "articles" in kw:
            kw["ld_items"] = [{"@type": "ListItem", "position": i + 1, "url": a["url"], "name": a["title"]}
                              for i, a in enumerate(kw["articles"][:10])]
        html = env.get_template(template).render(**ctx, **kw)
        dest = out / page_path.strip("/") / "index.html" if page_path != "/" else out / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(html, encoding="utf-8")

    last = (items[0]["dt"] if items else now).strftime("%Y-%m-%d")

    # --- home ---------------------------------------------------------------------------
    page_size = cfg["page_size"]
    render("/", "index.html", path="/", articles=news[:page_size], total=len(news), active=None,
           title=f"Notícias de política hoje, {long_date(now)} | {cfg['name']}",
           description=(f"As últimas notícias de política do Brasil, {long_date(now)}: títulos e resumos curtos de "
                        f"{len(news_sources)} veículos, atualizados a cada 30 minutos, com link direto para a fonte. "
                        "Resumo com IA sob demanda e verificador de fake news."),
           heading=f"Notícias de política hoje", subheading=weekday_date(now))
    pages.append(("/", last))

    # --- por fonte ----------------------------------------------------------------------
    for s in all_sources:
        lst = [a for a in items if a["source"] == s["id"]]
        render(f"/fonte/{s['id']}/", "index.html", path=f"/fonte/{s['id']}/", articles=lst, total=len(lst), active=s["id"],
               source=s,
               title=f"{s['name']}: últimas notícias de política | {cfg['name']}",
               description=f"Últimas manchetes de {s['name']} sobre política, reunidas pelo {cfg['name']}, com link para ler na fonte.",
               heading=f"{s['name']}", subheading="Últimas manchetes de política")
        if lst:
            pages.append((f"/fonte/{s['id']}/", lst[0]["dt"].strftime("%Y-%m-%d")))

    # --- por dia (arquivo) --------------------------------------------------------------
    for d in days:
        lst = [a for a in news if a["day"] == d]
        dd = datetime.strptime(d, "%Y-%m-%d")
        render(f"/dia/{d}/", "index.html", path=f"/dia/{d}/", articles=lst, total=len(lst), active=None, day=d,
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

    # índice leve usado pelo verificador (títulos recentes de fontes confiáveis)
    index = [{"t": a["title"], "s": a["source_name"], "u": a["url"], "p": a["published"][:16]} for a in items[:1500]]
    (out / "data").mkdir()
    (out / "data" / "search-index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    hosts = {urlsplit(s["home"]).hostname for s in all_sources} | {urlsplit(a["url"]).hostname for a in items}
    (out / "data" / "allowed-hosts.json").write_text(
        json.dumps(sorted(h.removeprefix("www.") for h in hosts if h)), encoding="utf-8")

    # cabeçalhos do Cloudflare Pages: segurança + cache
    (out / "_headers").write_text(
        "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  X-Frame-Options: SAMEORIGIN\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n"
        "/*.css\n  Cache-Control: public, max-age=86400\n/*.js\n  Cache-Control: public, max-age=86400\n"
        "/\n  Cache-Control: public, max-age=300, s-maxage=300\n/fonte/*\n  Cache-Control: public, max-age=300, s-maxage=300\n"
        "/data/*\n  Cache-Control: public, max-age=300\n", encoding="utf-8")

    for f in (ROOT / "templates" / "static").iterdir():
        shutil.copy(f, out / f.name)
    problems = verify_site(out, min_items=min(len(news), page_size))
    if problems:
        raise BuildError("site gerado não passou na verificação:\n  - " + "\n  - ".join(problems))
    if final.exists():
        shutil.rmtree(final)
    os.replace(out, final)
    return str(final / "index.html")

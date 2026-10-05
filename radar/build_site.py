"""Gera o site estático (pasta site/) a partir do banco. Dá pra hospedar de graça no GitHub Pages."""
import json
import shutil
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .db import connect

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("America/Sao_Paulo")


def collect_data(days: int = 30) -> dict:
    with connect() as conn:
        daily = conn.execute(
            "SELECT * FROM daily ORDER BY day DESC LIMIT ?", (days,)
        ).fetchall()
        out_days = []
        for d in daily:
            clusters = []
            for c in conn.execute(
                "SELECT * FROM clusters WHERE day = ? ORDER BY n_sources DESC, n_articles DESC",
                (d["day"],),
            ):
                arts = conn.execute(
                    "SELECT title, url, source_name, section, published FROM articles "
                    "WHERE cluster_id = ? ORDER BY published",
                    (c["id"],),
                ).fetchall()
                clusters.append(
                    {
                        "headline": c["headline"],
                        "summary": c["summary"],
                        "tema": c["tema"],
                        "tom": c["tom"],
                        "n_sources": c["n_sources"],
                        "n_articles": c["n_articles"],
                        "articles": [
                            {"title": a["title"], "url": a["url"], "source": a["source_name"],
                             "section": a["section"]}
                            for a in arts
                        ],
                    }
                )
            out_days.append(
                {
                    "day": d["day"],
                    "summary": d["summary"],
                    "topics": json.loads(d["topics"]),
                    "clusters": clusters,
                }
            )
    return {
        "generated": datetime.now(TZ).strftime("%d/%m/%Y %H:%M"),
        "days": out_days,
    }


def build(out_dir: str = "site", days: int = 30) -> str:
    data = collect_data(days)
    out = ROOT / out_dir
    out.mkdir(parents=True, exist_ok=True)

    env = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        autoescape=select_autoescape(["html"]),
    )
    # "</" dentro de <script> quebraria o HTML; escapa por segurança
    data_json = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = env.get_template("index.html").render(data_json=data_json, generated=data["generated"])
    (out / "index.html").write_text(html, encoding="utf-8")

    static = ROOT / "templates" / "static"
    for f in static.iterdir():
        shutil.copy(f, out / f.name)
    (out / "data.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return str(out / "index.html")

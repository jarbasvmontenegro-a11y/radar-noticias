"""Pipeline do dia: agrupa, resume cada grupo, gera o resumo final e o termômetro de temas."""
import json
from collections import Counter, defaultdict

from .cluster import cluster_articles
from .collect import load_config
from .db import connect
from .llm import LLM, TEMAS_PADRAO


def summarize_day(day: str, config_path: str = "config/sources.json", max_clusters: int = 60) -> dict:
    cfg = load_config(config_path)
    temas = cfg.get("temas", TEMAS_PADRAO)
    llm = LLM()

    with connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM articles WHERE day = ?", (day,))]
        if not rows:
            return {"day": day, "clusters": 0, "aviso": "sem artigos nesse dia"}

        # refaz o dia do zero (reprocessar é seguro)
        conn.execute("DELETE FROM clusters WHERE day = ?", (day,))
        conn.execute("UPDATE articles SET cluster_id = NULL WHERE day = ?", (day,))

        groups = cluster_articles(rows)[:max_clusters]
        summaries = []
        for group in groups:
            items = [
                {"source": r["source_name"], "title": r["title"], "snippet": r["snippet"]}
                for r in group
            ]
            data = llm.summarize_cluster(items, temas)
            n_sources = len({r["source_name"] for r in group})
            cur = conn.execute(
                """INSERT INTO clusters (day, headline, summary, tema, tom, n_articles, n_sources)
                   VALUES (?,?,?,?,?,?,?)""",
                (day, data["headline"], data["summary"], data["tema"], data["tom"],
                 len(group), n_sources),
            )
            cid = cur.lastrowid
            conn.executemany(
                "UPDATE articles SET cluster_id = ? WHERE id = ?", [(cid, r["id"]) for r in group]
            )
            summaries.append({**data, "n_articles": len(group), "n_sources": n_sources})

        # termômetro: quanto cada tema pesou no dia
        por_tema: dict[str, dict] = defaultdict(lambda: {"n_clusters": 0, "n_articles": 0, "tons": Counter()})
        for s in summaries:
            t = por_tema[s["tema"]]
            t["n_clusters"] += 1
            t["n_articles"] += s["n_articles"]
            t["tons"][s["tom"]] += 1
        topics = [
            {
                "tema": tema,
                "n_clusters": v["n_clusters"],
                "n_articles": v["n_articles"],
                "tom": v["tons"].most_common(1)[0][0],
            }
            for tema, v in sorted(por_tema.items(), key=lambda kv: -kv[1]["n_articles"])
        ]

        resumo = llm.summarize_day(day, sorted(summaries, key=lambda s: -s["n_sources"]))
        conn.execute(
            "INSERT OR REPLACE INTO daily (day, summary, topics) VALUES (?,?,?)",
            (day, resumo, json.dumps(topics, ensure_ascii=False)),
        )

    return {"day": day, "clusters": len(summaries), "artigos": len(rows)}

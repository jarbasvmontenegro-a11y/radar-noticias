"""Mostra as datas CRUAS dos feeds (como o veículo escreve) ao lado do momento da coleta, para descobrir fuso errado.
Uso: python scripts/diagnostico_datas.py diag [fonte ...]"""
import re, sys, os
from datetime import datetime, timezone
sys.path.insert(0, os.getcwd())
from radar import collect

out = sys.argv[1] if len(sys.argv) > 1 else "diag"
ids = set(sys.argv[2:]) or {"oeste", "uol", "cidade-verde", "jornal-da-paraiba", "exame", "gazetaweb", "tribuna-pr", "diario-do-para", "folha", "g1", "cgu", "istoe"}
os.makedirs(out, exist_ok=True)
linhas = [f"agora (UTC): {datetime.now(timezone.utc).isoformat(timespec='seconds')}"]
for src in collect.load_sources():
    if src["id"] not in ids:
        continue
    try:
        import urllib.request
        req = urllib.request.Request(collect.source_urls(src)[0], headers={"User-Agent": collect.UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            status, txt = r.status, r.read(3_000_000).decode("utf-8", "replace")
        crus = re.findall(r"<(?:pubDate|published|updated|lastmod|dc:date|publication_date|news:publication_date)[^>]*>([^<]+)<", txt)[:5]
        linhas.append(f"{src['id']:<20} status={status} cru={crus}")
    except Exception as e:
        linhas.append(f"{src['id']:<20} ERRO {e}")
open(os.path.join(out, "datas.txt"), "w").write("\n".join(linhas))
print("\n".join(linhas))

"""Ensaio de coleta (não grava nada em data/): para cada fonte mostra quantos itens vieram, quantos passaram nos filtros,
exemplos do que entrou e do que foi barrado, e manchetes de modelo que se repetem (candidatas a canais/<canal>/ruido.json)."""
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

from radar.collect import _fetch_all, _newest_first, keep_entry, load_sources
from radar.geo import detect

out = sys.argv[1] if len(sys.argv) > 1 else "diag"
sources = load_sources()
results = _fetch_all(sources)
now = datetime.now(timezone.utc)

md = ["# Ensaio de coleta", f"Gerado em {now.isoformat(timespec='minutes')}", ""]
shapes = defaultdict(Counter)
total_in = total_kept = 0
rows = []
for src in sources:
    entries, err = results[src["id"]]
    kept = [e for e in _newest_first(entries) if e["url"] and e["title"] and keep_entry(src, e)]
    dropped = [e for e in entries if e not in kept]
    total_in += len(entries)
    total_kept += min(len(kept), src.get("limite", 40))
    for e in entries:
        shape = re.sub(r"\d+", "#", e["title"])
        shape = re.sub(r"\b[A-ZÀ-Ú][\wà-ú]{3,}\b", "X", shape)
        shapes[src["id"]][shape] += 1
    recent = [e for e in entries if e["published"] and (now - e["published"]).total_seconds() < 86400]
    rows.append((src["id"], src.get("grupo", ""), len(entries), len(kept), len(recent), err))
    md.append(f"## {src['name']} (`{src['id']}`) {src.get('uf', '')}")
    md.append(f"- {'FALHOU: ' + err if err else 'ok'}; itens {len(entries)}; passaram {len(kept)}; últimas 24h {len(recent)}")
    for e in kept[:4]:
        md.append(f"    + {e['title'][:95]}  {','.join(detect(e['title'] + ' ' + e['desc'], src.get('uf', '')))}")
    for e in dropped[:3]:
        md.append(f"    - {e['title'][:95]}")
    md.append("")

md.insert(3, f"Total: {total_in} itens, {total_kept} aproveitados (limite por fonte aplicado)")
md.append("## Manchetes de modelo repetidas (4 ou mais na mesma fonte)")
for sid, c in shapes.items():
    for shape, n in c.most_common(3):
        if n >= 4:
            md.append(f"- {sid} x{n}: {shape[:110]}")
open(f"{out}/coleta.md", "w", encoding="utf-8").write("\n".join(md))
print("\n".join(f"{r[0]:22s} {r[1]:9s} itens={r[2]:4d} passaram={r[3]:4d} 24h={r[4]:4d} {r[5][:60]}" for r in rows))
print("TOTAL", total_in, total_kept)

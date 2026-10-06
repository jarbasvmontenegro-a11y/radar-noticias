"""Agrupa manchetes do mesmo assunto e classifica por tema. Sem IA: só comparação de palavras (custo zero)."""
import re
import unicodedata

STOP = set("""
para como mais pelo pela pelos pelas entre sobre apos antes ainda desde contra sem sob ate dos das nos nas num numa uns umas
isso essa esse esta este aquele aquela quando onde quem qual quais cada todo toda todos todas muito muita muitos muitas
foi sao ser tem tinha teve vai vao pode podem deve devem diz dizem fala fazer feito faz ficou fica vez veja entenda saiba
ontem hoje amanha agora novo nova novos novas anos ano dias dia mes meses apos tambem apenas segundo afirma afirmou
governo brasil brasileiro brasileira politica noticias
""".split())


def fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(c) != "Mn")


def tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", fold(s)) if len(w) >= 4 and w not in STOP}


def similar(a: set[str], b: set[str]) -> bool:
    inter = len(a & b)
    if inter < 3:
        return False
    return inter / len(a | b) >= 0.34


def cluster(items: list[dict], min_sources: int = 2) -> list[list[dict]]:
    """items: manchetes (dicts com title e source). Devolve grupos com ao menos `min_sources` veículos diferentes,
    do mais coberto ao menos. Guloso e determinístico: o primeiro item de cada grupo é o mais recente."""
    groups: list[tuple[set[str], list[dict]]] = []
    for a in items:
        tk = tokens(a["title"])
        if len(tk) < 3:
            continue
        for g in groups:
            if similar(tk, g[0]):
                g[1].append(a)
                g[0].update(tk)
                break
        else:
            groups.append((set(tk), [a]))
    out = [g[1] for g in groups if len({x["source"] for x in g[1]}) >= min_sources]
    out.sort(key=lambda g: (-len({x["source"] for x in g}), -len(g)))
    return out


def topic_of(a: dict, topics: list[dict]) -> list[str]:
    text = fold(f"{a.get('title', '')} {a.get('desc', '')}")
    # casa o INÍCIO de palavra ("ministro" pega "ministros", mas "eua" não pega "continuação")
    return [t["id"] for t in topics if any(re.search(r"\b" + re.escape(fold(k).strip()), text) for k in t["keywords"])]


def story_groups(items: list[dict], thr: float = 0.5, min_shared: int = 3, window_h: int = 36, lookback: int = 700) -> dict[str, int]:
    """Número do "assunto" de cada manchete (chave = id), para esconder repetições nas listas.
    Mais rigoroso que `cluster`: palavras raras pesam mais (o nome de um político pesa menos que "anulação"), exigem-se
    ao menos `min_shared` palavras em comum e só se junta manchete publicada até `window_h` horas depois da outra.
    Errar para menos: duas manchetes do mesmo fato podem ficar separadas, mas assuntos diferentes não devem se juntar."""
    import math
    from collections import Counter
    from datetime import timedelta
    ordered = sorted(items, key=lambda a: a["dt"], reverse=True)
    tk = {a["id"]: tokens(a["title"]) for a in ordered}
    df = Counter(w for t in tk.values() for w in t)
    n = max(len(ordered), 2)
    wt = {w: math.log(n / c) for w, c in df.items()}
    groups: list[list] = []  # [tokens, ids, dt do mais recente]
    out: dict[str, int] = {}
    for a in ordered:
        t = tk[a["id"]]
        placed = False
        if len(t) >= min_shared:
            for gi in range(len(groups) - 1, max(-1, len(groups) - 1 - lookback), -1):
                g = groups[gi]
                if g[2] - a["dt"] > timedelta(hours=window_h):
                    break
                inter = t & g[0]
                if len(inter) >= min_shared and sum(wt[w] for w in inter) >= thr * min(sum(wt[w] for w in t), sum(wt[w] for w in g[0])):
                    g[0] |= t
                    out[a["id"]] = gi
                    placed = True
                    break
        if not placed:
            groups.append([set(t), [a["id"]], a["dt"]])
            out[a["id"]] = len(groups) - 1
    return out

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

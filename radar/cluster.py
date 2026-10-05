"""Agrupa manchetes que falam da mesma história, vindas de fontes diferentes.

Usa TF-IDF + similaridade de cosseno + clustering aglomerativo. É local e gratuito
(sem embeddings pagos). Se quiser mais precisão depois, dá pra trocar por embeddings.
"""
import re
import unicodedata

from sklearn.cluster import AgglomerativeClustering
from sklearn.feature_extraction.text import TfidfVectorizer

STOP = set(
    "a o as os um uma de da do das dos em no na nos nas por para com sem sobre entre e ou que se "
    "ao aos à às é são foi ser vai após diz dizem afirma segundo contra mais menos ja já ate até "
    "como seu sua seus suas ele ela eles elas isso essa esse este esta".split()
)


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    words = re.findall(r"[a-z0-9]+", text)
    return " ".join(w for w in words if w not in STOP and len(w) > 2)


def cluster_articles(rows: list[dict], threshold: float = 0.72) -> list[list[dict]]:
    """rows: artigos com title/snippet. Devolve lista de grupos (listas de artigos).

    threshold = distância máxima (1 - similaridade) para juntar. Menor = grupos mais estritos.
    """
    if not rows:
        return []
    if len(rows) == 1:
        return [rows]

    docs = [_norm(f"{r['title']} {r['title']} {r['snippet']}") for r in rows]  # título pesa mais
    tfidf = TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True).fit_transform(docs)

    model = AgglomerativeClustering(
        n_clusters=None,
        metric="cosine",
        linkage="average",
        distance_threshold=threshold,
    )
    labels = model.fit_predict(tfidf.toarray())

    groups: dict[int, list[dict]] = {}
    for label, row in zip(labels, rows):
        groups.setdefault(int(label), []).append(row)
    # grupos maiores (mais fontes) primeiro
    return sorted(groups.values(), key=lambda g: (-len({r["source_name"] for r in g}), -len(g)))

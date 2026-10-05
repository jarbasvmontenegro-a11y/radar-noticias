"""Dados de exemplo (fictícios) para testar o pipeline e ver o site sem internet nem IA.

Nada aqui é notícia real: as fontes são "Jornal A/B/C" e os links apontam para example.com.
"""
import random
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .db import connect
from .summarize import summarize_day

TZ = ZoneInfo("America/Sao_Paulo")

HISTORIAS = [
    ("Congresso", ["Câmara vota projeto de lei sobre reforma administrativa [exemplo]",
                   "Deputados aprovam projeto de lei sobre reforma administrativa [exemplo]",
                   "Projeto de lei da reforma administrativa avança na Câmara [exemplo]"]),
    ("Economia", ["Banco Central mantém Selic e cita inflação de serviços [exemplo]",
                  "Copom mantém juros e aponta inflação de serviços como risco [exemplo]"]),
    ("Judiciário", ["Supremo julga recurso sobre regras de foro privilegiado [exemplo]",
                    "STF retoma julgamento sobre foro privilegiado [exemplo]",
                    "Ministros do STF divergem sobre foro privilegiado [exemplo]"]),
    ("Eleições", ["TSE divulga calendário e novas regras de propaganda [exemplo]",
                  "Novas regras de propaganda eleitoral são divulgadas pelo TSE [exemplo]"]),
    ("Segurança", ["Operação da polícia prende suspeitos de fraude em licitações [exemplo]",
                   "Polícia prende suspeitos em operação contra fraude em licitações [exemplo]"]),
    ("Política externa", ["Governo anuncia missão diplomática para reunião do G20 [exemplo]",
                          "Missão diplomática brasileira vai à reunião do G20 [exemplo]"]),
    ("Governo federal", ["Planalto anuncia pacote de investimentos em infraestrutura [exemplo]",
                         "Governo federal detalha pacote de infraestrutura [exemplo]"]),
]
FONTES = ["Jornal A", "Jornal B", "Jornal C", "Jornal D"]


def seed_demo(days: int = 7) -> None:
    rnd = random.Random(42)
    now = datetime.now(TZ)
    with connect() as conn:
        for back in range(days):
            dia = now - timedelta(days=back)
            day = dia.strftime("%Y-%m-%d")
            conn.execute("DELETE FROM articles WHERE day = ?", (day,))
            # cada dia dá peso diferente aos temas, para a régua ter variação
            for tema, titulos in HISTORIAS:
                if rnd.random() < 0.25 and back > 0:
                    continue
                reps = rnd.randint(1, 3)
                for r in range(reps):
                    for i, titulo in enumerate(titulos):
                        fonte = FONTES[(i + r) % len(FONTES)]
                        pub = dia.replace(hour=8 + i, minute=rnd.randint(0, 59)).astimezone(timezone.utc)
                        conn.execute(
                            """INSERT OR IGNORE INTO articles
                               (url, title, snippet, source_id, source_name, section, published, day)
                               VALUES (?,?,?,?,?,?,?,?)""",
                            (f"https://example.com/{day}/{tema}/{i}/{r}", f"{titulo} #{back}-{r}" if r else titulo,
                             f"Trecho de exemplo sobre {tema.lower()}. Conteúdo fictício.",
                             fonte.lower().replace(" ", "-"), fonte, "politica",
                             pub.isoformat(), day),
                        )
    for back in range(days):
        day = (now - timedelta(days=back)).strftime("%Y-%m-%d")
        summarize_day(day)

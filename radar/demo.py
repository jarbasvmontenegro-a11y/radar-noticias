"""Dados de exemplo (fictícios) para ver o site sem internet. Nada aqui é notícia real:
os links apontam para example.com e os títulos levam a marca [exemplo]."""
import json
import random
from datetime import datetime, timedelta, timezone

from .collect import DATA, article_id, load_sources

TEMAS = [
    ("Câmara aprova projeto sobre reforma administrativa", "Texto segue para análise do Senado após votação em plenário."),
    ("Senado adia votação de proposta sobre segurança pública", "Líderes pedem mais tempo para negociar mudanças no relatório."),
    ("STF retoma julgamento sobre regras de foro privilegiado", "Ministros divergem sobre alcance da decisão em casos em andamento."),
    ("TSE divulga novas regras de propaganda eleitoral", "Resolução detalha limites para impulsionamento e uso de inteligência artificial."),
    ("Governo anuncia pacote de investimentos em infraestrutura", "Plano prevê obras em rodovias, portos e saneamento nos próximos anos."),
    ("Banco Central mantém juros e cita risco de inflação de serviços", "Decisão foi unânime e comunicado indica cautela nos próximos meses."),
    ("Oposição apresenta requerimento de convocação de ministro", "Pedido será analisado pela comissão na próxima semana."),
    ("Comissão aprova parecer sobre marco regulatório", "Relator manteve pontos principais e acatou ajustes de redação."),
    ("Presidente sanciona lei que altera regras de licitação", "Norma entra em vigor na data da publicação no Diário Oficial."),
    ("Pesquisa mostra avaliação de governadores em estados do Nordeste", "Levantamento ouviu eleitores em entrevistas presenciais."),
    ("Congresso promulga emenda constitucional sobre orçamento", "Mudança afeta regras de emendas parlamentares a partir do próximo ano."),
    ("Ministério da Fazenda detalha meta fiscal do próximo ano", "Equipe econômica afirma que corte de gastos será gradual."),
]


def seed_demo() -> None:
    rnd = random.Random(7)
    now = datetime.now(timezone.utc)
    sources = [s for s in load_sources() if s.get("kind") == "noticia"]
    checks = [s for s in load_sources() if s.get("kind") == "checagem"]
    arts = []
    for i in range(160):
        src = rnd.choice(sources)
        title, desc = rnd.choice(TEMAS)
        pub = now - timedelta(minutes=rnd.randint(3, 60 * 24 * 6))
        url = f"https://example.com/{src['id']}/{i}"
        arts.append({"id": article_id(url), "title": f"{title} [exemplo]", "desc": desc, "url": url,
                     "source": src["id"], "kind": "noticia", "published": pub.isoformat(timespec="seconds"),
                     "seen": now.isoformat(timespec="seconds")})
    for i, (t, d) in enumerate([
        ("É falso que urnas eletrônicas aceitam voto duplo [exemplo]", "Checagem mostra que o sistema impede o registro de mais de um voto por eleitor."),
        ("Vídeo antigo circula como se fosse de protesto atual [exemplo]", "Imagens são de anos atrás e não têm relação com o episódio citado."),
        ("Texto sobre suposto fim de benefício é enganoso [exemplo]", "Mensagem mistura dados e não cita a fonte oficial."),
    ]):
        src = checks[i % len(checks)]
        url = f"https://example.com/check/{i}"
        pub = now - timedelta(hours=3 + i * 9)
        arts.append({"id": article_id(url), "title": t, "desc": d, "url": url, "source": src["id"], "kind": "checagem",
                     "published": pub.isoformat(timespec="seconds"), "seen": now.isoformat(timespec="seconds")})
    arts.sort(key=lambda a: a["published"], reverse=True)
    DATA.mkdir(exist_ok=True)
    (DATA / "articles.json").write_text(json.dumps({"articles": arts}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    status = {s["id"]: {"name": s["name"], "ok": True, "items": 0, "new": 0, "error": "", "checked": now.isoformat(timespec="seconds")}
              for s in load_sources()}
    (DATA / "status.json").write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")

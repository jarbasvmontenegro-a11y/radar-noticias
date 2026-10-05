"""Camada fina de provedor de IA. Trocar de modelo = mudar o .env, sem reescrever código.

DeepSeek e OpenAI usam o mesmo protocolo (SDK `openai`). O provedor "mock" não usa IA:
serve para testar o pipeline inteiro sem gastar nada.
"""
import json
import os
import re
import time

import requests

try:  # python-dotenv é opcional: sem ele, use variáveis de ambiente normais
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

TEMAS_PADRAO = [
    "Congresso", "Governo federal", "Judiciário", "Eleições", "Economia",
    "Segurança", "Política externa", "Saúde e educação", "Meio ambiente", "Outros",
]
TONS = ("neutro", "tenso", "positivo")


class LLM:
    def __init__(self):
        self.provider = os.environ.get("LLM_PROVIDER", "mock").lower()
        self.model_cheap = os.environ.get("LLM_MODEL_CHEAP", "deepseek-chat")
        self.model_best = os.environ.get("LLM_MODEL_BEST", self.model_cheap)
        self.api_key = os.environ.get("LLM_API_KEY", "")
        default_base = "https://api.openai.com/v1" if self.provider == "openai" else "https://api.deepseek.com"
        self.base_url = (os.environ.get("LLM_BASE_URL") or default_base).rstrip("/")
        if self.provider != "mock" and not self.api_key:
            raise RuntimeError(
                "LLM_API_KEY vazio. Defina no .env ou use LLM_PROVIDER=mock para testar."
            )

    # ---- chamadas de baixo nível -------------------------------------------------
    def _chat(self, model: str, system: str, user: str, json_mode: bool = False) -> str:
        """Chama qualquer API compatível com OpenAI (DeepSeek, OpenAI, etc.) via HTTP puro."""
        payload = {
            "model": model,
            "temperature": 0.2,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        last_err = None
        for attempt in range(3):
            try:
                resp = requests.post(
                    f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=payload,
                    timeout=90,
                )
                if resp.status_code in (429, 500, 502, 503):
                    raise requests.HTTPError(f"{resp.status_code} {resp.text[:200]}")
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"] or ""
            except requests.RequestException as exc:
                last_err = exc
                time.sleep(2 ** attempt)
        raise RuntimeError(f"Falha ao chamar a IA após 3 tentativas: {last_err}")

    # ---- tarefas -----------------------------------------------------------------
    def summarize_cluster(self, items: list[dict], temas: list[str]) -> dict:
        """items: [{source, title, snippet}] da mesma história. Devolve headline/summary/tema/tom."""
        if self.provider == "mock":
            return self._mock_cluster(items)

        system = (
            "Você é um editor de jornal brasileiro, neutro e factual. Recebe manchetes e trechos "
            "da MESMA história vindos de várias fontes. Escreva com suas próprias palavras, sem "
            "copiar frases, sem adjetivos de opinião, sem inventar nada que não esteja nos trechos. "
            "Responda só JSON: "
            '{"headline": "manchete neutra (até 90 caracteres)", '
            '"summary": "2 a 3 frases, sem juízo de valor", '
            f'"tema": "um de {temas}", '
            '"tom": "neutro | tenso | positivo (clima da cobertura: tenso = conflito, crise ou disputa)"}'
        )
        lines = [f"- [{i['source']}] {i['title']} — {i['snippet']}" for i in items[:12]]
        raw = self._chat(self.model_cheap, system, "\n".join(lines), json_mode=True)
        data = _parse_json(raw)
        tema = data.get("tema", "Outros")
        tom = data.get("tom", "neutro")
        return {
            "headline": (data.get("headline") or items[0]["title"])[:140],
            "summary": data.get("summary", ""),
            "tema": tema if tema in temas else "Outros",
            "tom": tom if tom in TONS else "neutro",
        }

    def summarize_day(self, day: str, clusters: list[dict]) -> str:
        """Resumo final do dia a partir dos grupos já resumidos."""
        if self.provider == "mock":
            top = clusters[:5]
            return "Principais assuntos do dia: " + "; ".join(c["headline"] for c in top) + "."

        system = (
            "Você é um editor de jornal brasileiro, neutro e factual. Escreva o resumo do dia em "
            "português, em 1 parágrafo de 4 a 6 frases, citando os assuntos mais cobertos. "
            "Não opine, não use adjetivos de juízo, não invente fatos."
        )
        lines = [
            f"- ({c['n_sources']} fontes, tema {c['tema']}, tom {c['tom']}) {c['headline']}: {c['summary']}"
            for c in clusters[:20]
        ]
        return self._chat(self.model_best, system, f"Data: {day}\n" + "\n".join(lines)).strip()

    # ---- mock --------------------------------------------------------------------
    @staticmethod
    def _mock_cluster(items: list[dict]) -> dict:
        first = items[0]
        text = " ".join(i["title"] for i in items).lower()
        tema = "Outros"
        regras = [
            ("Eleições", ["eleição", "eleições", "candidat", "tse", "voto", "urna"]),
            ("Judiciário", ["stf", "supremo", "justiça", "tribunal", "ministro do"]),
            ("Congresso", ["câmara", "senado", "deputad", "senador", "congresso", "projeto de lei"]),
            ("Economia", ["inflação", "selic", "juros", "dólar", "pib", "imposto", "economia"]),
            ("Segurança", ["polícia", "crime", "preso", "operação", "tráfico"]),
            ("Política externa", ["eua", "china", "otan", "guerra", "onu", "israel", "ucrânia"]),
            ("Governo federal", ["lula", "governo", "planalto", "ministério"]),
        ]
        for nome, palavras in regras:
            if any(p in text for p in palavras):
                tema = nome
                break
        return {
            "headline": first["title"][:140],
            "summary": first["snippet"] or first["title"],
            "tema": tema,
            "tom": "neutro",
        }


def _parse_json(raw: str) -> dict:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        return json.loads(m.group(0)) if m else {}

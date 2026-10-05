# Radar de Notícias

Agregador diário no formato de jornal: junta as notícias de vários veículos brasileiros, agrupa as que falam da mesma história, resume cada assunto com IA e mostra uma **régua dos temas** ao longo dos dias.

- **Edição do dia**: assuntos agrupados, com filtros por dia, tema, fonte e busca.
- **Resumos**: um parágrafo por dia com os principais assuntos.
- **Régua dos temas**: mapa de calor com o peso de cada tema na cobertura, dia a dia, e marca nos dias de clima tenso.
- Site 100% estático (HTML + JS), hospedagem grátis.

## Como funciona

```
RSS dos veículos ─▶ coleta ─▶ SQLite ─▶ agrupamento (TF-IDF) ─▶ IA resume cada grupo
                                                                  └▶ IA faz o resumo do dia
                                                         ─▶ site/ (HTML estático)
```

| Peça | Arquivo | Observação |
|---|---|---|
| Fontes | `config/sources.json` | só RSS; edite à vontade |
| Coleta | `radar/collect.py` | guarda manchete, link e trecho de até 280 caracteres |
| Agrupamento | `radar/cluster.py` | local e gratuito (sem embeddings pagos) |
| IA | `radar/llm.py` | qualquer API compatível com OpenAI (DeepSeek, OpenAI...) |
| Resumo do dia | `radar/summarize.py` | também calcula a régua dos temas |
| Site | `radar/build_site.py` + `templates/` | gera a pasta `site/` |

## Rodando

```bash
pip install -r requirements.txt
cp .env.example .env            # coloque sua LLM_API_KEY

python -m radar demo            # testa tudo com dados fictícios, sem internet e sem IA
python -m radar check-feeds     # confere quais feeds estão vivos
python -m radar daily           # coleta + resume + gera o site (o que roda todo dia)
python -m http.server -d site   # abre em http://localhost:8000
```

Para testar sem gastar nada com IA, use `LLM_PROVIDER=mock` no `.env`.

### Trocar de modelo de IA

Só muda o `.env`, sem tocar no código:

```
# DeepSeek (padrão, bem barato)
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL_CHEAP=deepseek-chat

# OpenAI, por exemplo
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL_CHEAP=<modelo pequeno>
```

Dica: use um modelo barato para os resumos por assunto (`LLM_MODEL_CHEAP`) e, se quiser, um melhor só para o resumo final do dia (`LLM_MODEL_BEST`). Compare 2 ou 3 modelos nas mesmas notícias antes de decidir.

## Publicação automática (GitHub Actions + Pages)

O workflow `.github/workflows/daily.yml` roda todo dia às 06:00 (Brasília), atualiza o banco e publica o site.

1. No repositório: **Settings → Secrets and variables → Actions → New repository secret** → `LLM_API_KEY`.
2. **Settings → Pages → Source: GitHub Actions**.
3. (Opcional) em **Variables**, defina `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL_CHEAP`, `LLM_MODEL_BEST`.
4. Rode uma vez manualmente em **Actions → Edição diária → Run workflow**.

Observação: GitHub Pages em repositório privado exige plano pago. No plano grátis, deixe o repositório público (a chave da API fica segura no Secret) ou publique a pasta `site/` no Cloudflare Pages.

## Direitos autorais e transparência

- Não copiamos o texto das matérias: só manchete, link e trecho curto, sempre com link para a fonte.
- Os resumos são gerados pela IA com palavras próprias e o prompt proíbe opinião e invenção.
- O "clima da cobertura" (neutro, tenso, positivo) é uma classificação automática do tom, não um julgamento sobre quem tem razão. A régua mede **volume de cobertura**, não importância real.
- Em ano eleitoral, mantenha a metodologia pública (a aba "Como funciona" do site já descreve) e a lista de fontes diversa.

## Próximos passos possíveis

- Embeddings no lugar de TF-IDF para agrupar melhor.
- Viés de cobertura: quais fontes cobrem (ou ignoram) cada assunto.
- Newsletter diária por e-mail com o resumo.
- Mais editorias além de política e economia.

# Radar de Notícias

Site de notícias de política no formato de jornal: lista compacta no meio, com **título, descrição curta e fonte** de 15 veículos, atualizada a cada 30 minutos. Resumo com IA **só quando o leitor pede**, e um **verificador de fake news**.

A busca de notícias **não usa IA** (só RSS), então o custo fixo é praticamente zero. A IA só roda sob demanda, com cache e limites.

## Como funciona

```
GitHub Actions (a cada 30 min)                         Cloudflare Pages
  coleta RSS ─▶ data/articles.json ─▶ gera HTML  ─▶     site estático (SEO)
  (sem IA)      (commit só se houver novidade)           + /api/resumir   (IA sob demanda)
                                                         + /api/verificar (checagens + IA)
```

| Peça | Onde | Observação |
|---|---|---|
| Fontes | `config/sources.json` | 100+ fontes: nacionais, oficiais, checagem e regionais (todos os g1 estaduais e veículos locais), cada uma com feed e/ou sitemap |
| Coleta | `radar/collect.py` | só título, descrição de até 260 caracteres e link |
| Site | `radar/build_site.py`, `templates/` | HTML puro, sem framework, fontes próprias (Newsreader e Atkinson Hyperlegible, licença OFL); páginas por fonte, tema, dia e estado (`radar/geo.py` marca os estados citados), listas paginadas |
| Resumo | `functions/api/resumir.js` | lê a matéria no servidor, resume, guarda cache por 24 h |
| Verificador | `functions/api/verificar.js`, `lib/*.js` | "é falso/verdadeiro" só vem de agência; sem agência o Radar dá uma avaliação própria, identificada, com motivos |
| Configuração | `config/site.json` | nome, anúncios, Turnstile, janela de dias |

## Rodar localmente

```bash
pip install -r requirements.txt
python -m radar demo                 # dados fictícios, sem internet e sem IA
python -m http.server -d site-demo   # http://localhost:8000
python -m radar check-feeds          # testa quais feeds estão vivos (precisa de internet)
python -m radar update               # coleta + gera o site em site/

python -m unittest discover -s tests -v   # testes do coletor
node --test tests/functions.test.mjs tests/share.test.mjs      # testes das funções (IA e rede simuladas)
```

> **Importante:** os endereços de RSS em `config/sources.json` não foram testados com a rede real. Rode `check-feeds` e corrija os que falharem. A página "Como funciona" do site mostra a situação de cada fonte depois da primeira coleta.

## Publicar (uma vez só)

1. **Cloudflare Pages:** crie um projeto "Direct Upload" chamado `radar-noticias`.
2. **KV:** `npx wrangler kv namespace create RADAR_KV` e cole o `id` em `wrangler.toml`.
3. **Segredos** (Cloudflare Pages → Settings → Variables and Secrets):
   - `LLM_API_KEY`: chave do DeepSeek (ou outro provedor compatível com OpenAI; ajuste `LLM_BASE_URL` e `LLM_MODEL`).
   - `FACTCHECK_API_KEY`: chave gratuita da *Google Fact Check Tools API* (Google Cloud Console).
   - Opcionais: `TURNSTILE_SECRET`, `IP_DAILY_LIMIT` (padrão 10), `DAILY_CAP` (padrão 1500), `IP_SALT`.
   - Provedor de IA reserva (opcional, entra se o principal falhar): `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL`.
4. **GitHub** (Settings → Secrets and variables → Actions):
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
   - Variables: `SITE_URL` (seu domínio), e depois `ADSENSE_CLIENT`, `TURNSTILE_SITEKEY`, `CONTACT_EMAIL`, `CF_PROJECT` se usar.
5. Rode **Actions → Monitorar notícias → Run workflow**. Depois disso roda sozinho a cada 30 minutos e só publica quando há notícia nova.

Repositório privado gasta minutos do Actions (2.000/mês no plano grátis, e o intervalo de 30 min usa quase tudo). Em repositório público é ilimitado.

## Controle de custo da IA e segurança

- Busca de notícias nunca chama IA.
- Resumo e verificador só rodam por clique, com **cache de 24 h**.
- As APIs só respondem ao próprio site (cabeçalho `Origin` obrigatório). Isso barra uso casual, mas **um script pode forjar o `Origin`**: a proteção real é o **Cloudflare Turnstile**, que ainda precisa ser ligado (passo a passo em `docs/SEGURANCA.md`).
- Sem Turnstile: 5 usos por IP por dia e teto global de 300. Com Turnstile: 10 por IP e 1.500. Se o contador (KV) falhar, a IA não é chamada.
- O resumo só aceita links dos domínios monitorados e valida cada redirecionamento (anti-SSRF).
- Cabeçalhos de segurança (CSP por hash, HSTS, COOP/CORP) são gerados no build.
- `scripts/pentest_site.mjs` ataca o site no ar (workflow "Segurança e Turnstile", `acao = atacar`) e gera o relatório por padrão OWASP/ASVS/CWE.

## Verificador de fake news: o que faz e o que não faz

1. A IA extrai a afirmação central do texto (ou da página, se for link).
2. Busca em **agências de checagem** via Google Fact Check Tools. Só aceita resultados com termos em comum com a afirmação.
3. Busca manchetes recentes dos 15 veículos monitorados sobre o tema.
4. A IA aponta **sinais de alerta** e o que conferir. **Nunca** diz se é verdadeiro ou falso.

O veredito exibido ("falso", "enganoso", "verdadeiro", "misto") vem das avaliações das agências. Sem checagem, o resultado é "nenhuma agência checou ainda" e o site avisa que isso não significa que seja verdade. Não verifica imagens nem vídeos.

## Compartilhar no WhatsApp

- **Verificador:** depois de verificar, aparece uma mensagem pronta e editável (botões *Enviar no WhatsApp*, *Copiar* e *Outros apps*). Se uma agência classificou como **falso** ou **enganoso**, a mensagem desmente, citando a agência, a avaliação e o link da checagem. Se ninguém checou (ou a consulta falhou), a mensagem **nunca** diz que é falso: pede calma e conferência. Texto em `templates/static/share.js` (testado em `tests/share.test.mjs`).
- **Cada notícia** tem o botão *Enviar no Zap* (link `wa.me`, funciona até sem JavaScript). Nas checagens de agências a mensagem é apresentada como checagem.
- **Instalável:** o site tem `manifest.webmanifest` com *share target*. Instalado no celular (Android/Chrome), o app aparece na lista de compartilhamento do WhatsApp e o texto cai direto no verificador. Também aceita `/verificador/?texto=...`. Depende do aparelho; o botão *Colar o que copiei* cobre o resto.

## Para todos os públicos

Faixa "Recebeu um boato no WhatsApp?" no topo da home, filtros por tema (`config/topics.json`, por palavras-chave, sem IA), bloco **Mais cobertos agora** e "Também noticiado por" (agrupa manchetes parecidas de veículos diferentes, sem IA), botões maiores para toque, tema claro/escuro, letra ajustável.

## Robustez

**Coleta**
- Feeds buscados em paralelo, com timeout, limite de 5 MB e até 2 novas tentativas (só para erros passageiros, respeitando `Retry-After`).
- XML não confiável: feeds que declaram entidades (ataque "billion laughs") são rejeitados; caracteres inválidos e `&` solto são tolerados.
- Só entram links `http(s)`. Nada de `javascript:` ou `data:`. Títulos e descrições perdem caracteres de controle e de inversão de texto.
- Duplicados são removidos por URL (sem parâmetros de rastreamento) e por título dentro da mesma fonte.
- Escrita atômica. Se `articles.json` estiver corrompido, a coleta **para** (e guarda cópia) em vez de apagar o histórico. Se todas as fontes falharem, o histórico é mantido e o workflow avisa.
- Cada fonte tem seu estado em `data/health.json` ("fora do ar desde..."), que só muda em transições, sem gerar commits à toa. A página "Como funciona" mostra isso.

**Site**
- O build é feito numa pasta temporária e só substitui o site atual se passar na verificação (`python -m radar verify`): arquivos obrigatórios, sitemap e JSON-LD válidos, `title`/`canonical`/`description` em todas as páginas, nenhum link perigoso.
- JSON-LD escapa `<`, `>` e `&`, então dados de fontes nunca "fecham" a tag `<script>`.
- Registros quebrados são ignorados em vez de derrubar o build. Sem dados ainda, o site sai vazio, mas válido.
- Funciona sem JavaScript (a lista e os links são HTML). Aparece um aviso se a última atualização tiver mais de 6 horas.

**Funções (resumo e verificador)**
- Corpo do pedido limitado a 16 KB, `Content-Type` e origem conferidos, método errado devolve 405.
- Leitura de páginas com limite de 600 KB e **redirecionamentos seguidos manualmente, validando cada salto** (nada de IP, `localhost`, porta estranha ou domínio fora da lista).
- IA com uma nova tentativa em erro passageiro e, se configurado, provedor reserva. Se a IA falhar, **a cota do leitor é devolvida**.
- "Não conseguimos consultar as agências" é um estado próprio (`indisponivel`), diferente de "nenhuma agência checou". Resultados em que a consulta falhou não vão para o cache.
- Falhas de cache (KV) não derrubam a função. Logs estruturados, sem dados pessoais, nos logs do Cloudflare.

**Monitoramento (GitHub Actions)**
- Roda os testes antes de coletar e publicar, com `timeout` de 15 minutos.
- Só guarda os dados no repositório depois que o site foi gerado e verificado. O envio tem 3 tentativas.
- Resumo de saúde das fontes em cada execução, conferência de que o site respondeu após o deploy e **issue de alerta** automática quando algo falha (fechada sozinha quando volta ao normal).

## SEO e anúncios

Já incluído: HTML renderizado no servidor, `title` e `description` por página com data, canonical, Open Graph, JSON-LD (`CollectionPage`, `ItemList`, `WebApplication`), `sitemap.xml`, `robots.txt`, páginas por fonte (`/fonte/g1/`) e por dia (`/dia/2026-10-04/`), HTML leve (sem fontes externas), breadcrumbs, `ads.txt` automático, páginas de privacidade e "Como funciona".

Anúncios: preencha em `config/site.json` o `adsense_client` e os `adsense_slots` (topo, lista, lateral). Sem isso, nenhum espaço de anúncio aparece. Há aviso de cookies com opção de anúncios não personalizados, e os espaços têm altura reservada para não "pular" a página.

Expectativas honestas:
- Agregador de manchetes tem **pouco conteúdo próprio**. Buscadores tendem a valorizar mais o original, e o AdSense pode recusar sites "finos". O verificador, a página de metodologia e conteúdo próprio (por exemplo, explicações semanais) são o que pode diferenciar o site.
- SEO leva semanas ou meses. Cadastre o domínio no Google Search Console e envie o `sitemap.xml`.
- Direitos autorais: mostramos só título, descrição curta e link, sempre apontando para a fonte. Se um veículo pedir remoção, remova-o de `config/sources.json`.

## Antigo pipeline de resumos diários e régua dos temas

Foi removido desta versão para focar no formato de jornal e no custo mínimo. Está no histórico do Git (commit "Primeira versão do Radar de Notícias") caso queira trazer de volta.

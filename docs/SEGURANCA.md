# Segurança do Radar de Notícias

Relatório do ataque feito ao site no ar em 06/10/2026 (script `scripts/pentest_site.mjs`, rodado pelo workflow
"Segurança e Turnstile" com `acao = atacar`; resultado na branch `auditoria`). Cada item mapeia para OWASP Top 10:2021,
OWASP ASVS 4.0 e CWE.

## Resultado

46 verificações: 42 aprovadas, 4 falhas (3 dependem de uma ação sua), 4 informativas.

| ID | Severidade | Achado | Padrão | Situação |
|---|---|---|---|---|
| A4 | Alta | Sem Turnstile, quem forja o cabeçalho `Origin` (um script) consegue chamar a IA | OWASP A04 · ASVS 11.1.4 · CWE-799 | Aberto: precisa criar o widget do Turnstile (ver abaixo) |
| A5 | Alta | Rajada em paralelo passa do limite por IP: o KV não faz contagem atômica (14 de 14 pedidos passaram) | OWASP A04 · CWE-362/770 | Aberto: um contador em memória foi adicionado, mas o teste seguinte ainda passou 14 de 14 (cada pedido caiu numa instância diferente). Só o Turnstile resolve |
| A5b | Alta | Em sequência o limite funciona (5 por dia por IP sem Turnstile; 429 depois) | OWASP A04 · CWE-770 | Ok em sequência; a rajada (A5) continua aberta |
| E2 | Baixa | Sem `security.txt` (canal para reportar falhas) | RFC 9116 | Precisa de um e-mail de contato (variável `CONTACT_EMAIL`); o build publica sozinho |
| H1–H4 | Alta/Média | Sem CSP e sem HSTS | OWASP A05 · ASVS 14.4 · CWE-1021/79/319 | Corrigido (CSP sem `unsafe-inline` em scripts, por hash; HSTS 1 ano; COOP/CORP) |
| G1 | Média | Ações do GitHub Actions sem versão fixa por SHA | OWASP A08 · CWE-829 | Corrigido |
| G2 | Média | `${{ inputs.acao }}` dentro de `run:` (injeção de script no workflow) | OWASP A03 · CWE-78/94 | Corrigido (vai por variável de ambiente) |
| G4/G6 | Baixa | `wrangler@latest` e dependências Python com `>=` | OWASP A06 · CWE-1104 | Corrigido (versões fixas) |
| C3 | Média | Links vindos da API sem validar esquema (`javascript:`) | ASVS 5.1.5 · CWE-79 | Corrigido (só http/https vira link) |

Passaram sem mudanças: nenhum arquivo interno ou segredo público (E1, E4), sem XSS refletido (X1), sem redirecionamento
aberto (X3), cabeçalhos `X-Forwarded-*` ignorados (X2), SSRF recusado em 14 alvos (169.254.169.254, localhost, IPs em
decimal/hex, `file://`, `gopher://`, `user@host`, subdomínio falso) em `/api/resumir`, POST sem `Origin` ou de outro site
recusado (403), JSON quebrado/gigante/tipos errados/`__proto__` sem erro 500, métodos PUT/DELETE/PATCH/TRACE recusados,
erros sem detalhe interno, prompt injection sem efeito no veredito, nenhum sink de DOM perigoso no JavaScript do site,
sem `pull_request_target`, permissões mínimas nos workflows.

## O que ainda é risco

O cabeçalho `Origin` não prova nada: qualquer script o escreve. Ele só barra uso casual (curl sem `Origin`, outros sites).
**O que impede de verdade que alguém de fora gaste sua IA é o Turnstile**, que só emite o token depois de um navegador
real resolver o desafio, e cada token vale uma única vez. Enquanto ele não estiver ligado, o gasto fica limitado a
5 usos por IP por dia, com a falha da rajada descrita acima.

## Ligar o Turnstile (3 minutos, sem token)

1. Painel da Cloudflare, Turnstile, Add widget: nome "Radar de Notícias", domínio `radar-noticias.pages.dev`, modo Managed.
2. Copie a Site Key e o Secret Key.
3. Pages, projeto `radar-noticias`, Settings, Variables and Secrets, Production: crie o secret `TURNSTILE_SECRET` com o Secret Key.
4. GitHub, repositório, Settings, Variables: crie `TURNSTILE_SITEKEY` com a Site Key.
5. Actions, "Monitorar notícias", Run workflow (publica de novo com a chave).

Depois rode "Segurança e Turnstile" com `acao = atacar`: A4 e A5 devem passar.

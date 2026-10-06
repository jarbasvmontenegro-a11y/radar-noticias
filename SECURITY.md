# Política de segurança

Se você achou uma falha de segurança no Radar de Notícias, **não abra uma issue pública**.
Use o relato privado do GitHub: aba **Security**, **Report a vulnerability**.

Inclua o endereço afetado, os passos para reproduzir e o impacto que você imagina. Respondemos assim que possível.

Fora do escopo: pedidos de remoção de manchetes (fale com o veículo de origem), spam e ataques de negação de serviço.

## O que já é feito

- Rotas de IA e de notificações só aceitam chamadas vindas do próprio site, com limite por pessoa e teto diário; Turnstile quando configurado.
- Notificações: só endereços de push de serviços conhecidos (proteção contra SSRF), rotas de envio protegidas por segredo e conteúdo sempre tratado como texto.
- CSP restritiva (scripts só do próprio site), HSTS, isolamento de origem, ações do GitHub fixadas por commit, CodeQL semanal e atualização automática de dependências.

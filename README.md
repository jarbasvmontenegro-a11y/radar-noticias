# Radar de Notícias

Política do Brasil em um só lugar, direto das fontes.

**Site:** https://radar-noticias.pages.dev

O Radar reúne, de hora em hora, as manchetes de política de mais de 100 veículos e agências de checagem, de grandes portais a jornais locais de cada estado. Cada manchete leva ao texto no veículo original: o site organiza e ajuda a entender, não republica conteúdo.

## O que ele faz

- **Todas as manchetes, sem ruído.** Linha do tempo por dia, com filtro por estado, tema e fonte.
- **Como cada veículo contou.** Quando vários veículos cobrem o mesmo assunto, o site mostra as manchetes lado a lado.
- **Resumo com IA sob demanda.** Só quando a pessoa pede, relacionando o que outros veículos publicaram.
- **Verificador de fake news.** Cole um boato e veja se agências de checagem já analisaram e quais sinais de alerta aparecem.
- **Notificações escolhidas por você.** Temas, estados e alertas de checagem; só os assuntos mais noticiados, sem repetir e sem avisos de madrugada.
- **Envio no WhatsApp**, busca nas manchetes, tema claro e escuro, letra ajustável e instalação como app.

## Como é feito

Um site estático gerado em Python, publicado no Cloudflare Pages, com pequenas funções para o que precisa de servidor (resumo, verificador, notificações). Um fluxo no GitHub Actions coleta, testa, gera e publica a cada hora, sem servidor próprio e a custo zero.

```
fontes (RSS) → coleta → site estático → Cloudflare Pages
                                  └→ funções: IA, verificador, notificações
```

Segurança e privacidade estão descritas em [SECURITY.md](SECURITY.md) e na [política de privacidade](https://radar-noticias.pages.dev/privacidade/) do site.

## Rodar localmente

```bash
pip install -r requirements.txt
python -m radar collect      # coleta as manchetes
python -m radar build        # gera o site em site/
python -m unittest discover -s tests
```

## Licença

[MIT](LICENSE). As manchetes e marcas pertencem aos seus veículos.

# Canais

O Radar tem um motor só (pastas `radar/`, `functions/`, `lib/` e `templates/`) e um assunto por pasta aqui.
Hoje só **Política** está no ar.

## O que cada canal tem

| Arquivo | Para que serve | Obrigatório |
| --- | --- | --- |
| `canal.json` | nome e recursos ligados (`estados`, `pessoas`, `verificador`) | sim |
| `sources.json` | fontes (feeds RSS e sitemaps) | sim |
| `topics.json` | temas do menu | sim |
| `relevancia.json` | palavras e siglas que dizem se uma manchete de feed geral é do assunto | se alguma fonte usa o filtro |
| `ruido.json` | manchetes de modelo a descartar | não |
| `pessoas.json` | nomes a reconhecer nas manchetes | só com o recurso `pessoas` |
| `candidatos.json` | candidatos a fonte, para o diagnóstico de feeds | não |

Arquivos que valem para todos os canais ficam em `config/`: `site.json`, `estados.json`, `municipios.json`,
`enquadramento.json` e `correcoes.json`. Um arquivo que falta na pasta do canal é procurado lá.

O canal ativo vem da variável `RADAR_CANAL` (padrão: `politica`). Um recurso desligado tira as páginas e os
links do menu daquele recurso (o teste `test_canal_sem_recursos_de_politica` confere).

## Para abrir um canal novo (quando chegar a hora)

1. Criar `canais/<id>/` com os arquivos obrigatórios acima e testar as fontes com o diagnóstico de feeds.
2. Ainda falta no motor, e fica para essa etapa:
   - publicar o canal num endereço próprio (`/games/`): os links das páginas hoje partem da raiz do site;
   - dados separados por canal (`RADAR_DATA=data/<id>`) e um passo de coleta por canal no fluxo do GitHub;
   - menu para trocar de canal e escolha de canais na newsletter e nas notificações;
   - textos de "Como funciona" e instruções da IA por canal (hoje falam de política).

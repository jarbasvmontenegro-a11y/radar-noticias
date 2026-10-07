// Testes das funções sob demanda, com IA, agências de checagem, GDELT e páginas simuladas (sem rede).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { extractText, parseHttpUrl, readLimitedText, resetHostsCache } from "../lib/api.js";
import { aggregate, classifyRating, tokens } from "../lib/verify.js";
import { onRequestPost as resumir } from "../functions/api/resumir.js";
import { onRequestPost as verificar } from "../functions/api/verificar.js";

// ---------- doubles ----------
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k) ?? null; }
  async put(k, v) { this.m.set(k, v); }
}

const SEARCH_INDEX = [
  { t: "Câmara aprova projeto sobre reforma administrativa", s: "g1", u: "https://g1.globo.com/a", p: "2026-10-04T10:00" },
  { t: "Time vence campeonato regional de futebol", s: "g1", u: "https://g1.globo.com/b", p: "2026-10-04T11:00" },
];
// a lista oficial de municípios que o build publica em /data/municipios.json
const MUNICIPIOS = JSON.parse(fs.readFileSync(new URL("../config/municipios.json", import.meta.url), "utf8"));

const ARTICLE_HTML = `<html><head><title>Titulo</title><meta property="og:description" content="Descri&ccedil;&atilde;o"></head>
<body><nav>menu</nav><article>${"<p>" + "Parágrafo longo com conteúdo da matéria sobre a votação no plenário. ".repeat(8) + "</p>".repeat(1)}
${"<p>" + "Outro parágrafo com mais informação relevante para o resumo do leitor. ".repeat(8) + "</p>"}</article><script>x()</script></body></html>`;

/**
 * Troca o fetch global por um falso que atende IA, Google Fact Check, GDELT, índice, municípios, hosts e páginas.
 * Opções: llm(body, n, url, init) -> texto ou Response; factchecks, factStatus, factBody; gdelt { status, body } ou função;
 * index (lista ou null = arquivo ausente); municipios (lista ou null); pageHtml, pageStatus, page(url, n).
 */
function setup({ llm, factchecks = [], factStatus = 200, factBody, pageHtml = ARTICLE_HTML, pageStatus = 200, page, index = SEARCH_INDEX, municipios = MUNICIPIOS, gdelt } = {}) {
  const calls = { llm: 0, fact: 0, gdelt: 0, page: 0, urls: [], factHeaders: [], llmBodies: [] };
  resetHostsCache(); // também limpa os caches de módulo do índice e dos municípios
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.urls.push(url);
    if (url.includes("/chat/completions")) {
      calls.llm++;
      const body = JSON.parse(init.body);
      calls.llmBodies.push(body);
      const out = llm ? llm(body, calls.llm, url, init) : "Resumo de teste da matéria.";
      if (out instanceof Response) return out;
      return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 });
    }
    if (url.includes("factchecktools")) {
      calls.fact++;
      calls.factHeaders.push(init?.headers || {});
      if (factStatus !== 200) return new Response(factBody ?? "erro", { status: factStatus });
      return new Response(JSON.stringify({ claims: factchecks }), { status: 200 });
    }
    if (url.includes("gdeltproject")) {
      calls.gdelt++;
      const g = typeof gdelt === "function" ? gdelt(url, calls.gdelt) : gdelt;
      if (!g) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); // 200 sem "articles": ninguém noticiou
      return new Response(typeof g.body === "string" ? g.body : JSON.stringify(g.body ?? {}), { status: g.status ?? 200 });
    }
    if (url.includes("/data/search-index.json")) return index === null ? new Response("", { status: 404 }) : new Response(JSON.stringify(index), { status: 200 });
    if (url.includes("/data/municipios.json")) return municipios === null ? new Response("", { status: 404 }) : new Response(JSON.stringify(municipios), { status: 200 });
    if (url.includes("/data/allowed-hosts.json")) return new Response(JSON.stringify(["g1.globo.com", "folha.uol.com.br"]), { status: 200 });
    calls.page++;
    if (page) return page(url, calls.page);
    return new Response(pageHtml, { status: pageStatus, headers: { "content-type": "text/html" } });
  };
  const env = { RADAR_KV: new FakeKV(), LLM_API_KEY: "k", FACTCHECK_API_KEY: "g", IP_DAILY_LIMIT: "3" };
  return { env, calls };
}

const quota = async (env) => [...env.RADAR_KV.m.entries()].filter(([k]) => k.startsWith("rl:")).map(([, v]) => Number(v));
const cacheKeys = (env, prefixo) => [...env.RADAR_KV.m.keys()].filter((k) => k.startsWith(prefixo));

const req = (path, body, headers = {}) =>
  new Request("https://site.test" + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4", Origin: "https://site.test", ...headers }, body: JSON.stringify(body) });
const call = (fn, env, path, body, headers) => fn({ request: req(path, body, headers), env });

// ---------- unidades puras ----------
test("classifyRating entende avaliações em português", () => {
  assert.equal(classifyRating("Falso"), "falso");
  assert.equal(classifyRating("Não é verdade"), "falso");
  assert.equal(classifyRating("Enganoso"), "enganoso");
  assert.equal(classifyRating("Descontextualizado"), "enganoso");
  assert.equal(classifyRating("Verdadeiro, mas"), "misto");
  assert.equal(classifyRating("Verdadeiro"), "verdadeiro");
  assert.equal(classifyRating("Em análise"), "desconhecido");
});

test("aggregate: veredito só vem de checagens", () => {
  assert.equal(aggregate([]), "sem_checagem");
  assert.equal(aggregate(["falso"]), "falso");
  assert.equal(aggregate(["falso", "enganoso", "enganoso"]), "enganoso");
  assert.equal(aggregate(["verdadeiro"]), "verdadeiro");
  assert.equal(aggregate(["verdadeiro", "falso"]), "misto");
  assert.equal(aggregate(["desconhecido"]), "misto");
});

test("parseHttpUrl bloqueia endereços internos e IPs", () => {
  assert.ok(parseHttpUrl("https://g1.globo.com/x"));
  for (const bad of ["http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "https://[::1]/", "ftp://g1.globo.com/", "https://user:pw@g1.globo.com/", "https://g1.globo.com:8080/", "https://intranet/", "javascript:alert(1)"]) {
    assert.equal(parseHttpUrl(bad), null, bad);
  }
});

test("extractText tira menu e script e lê og:description", () => {
  const d = extractText(ARTICLE_HTML);
  assert.match(d.description, /Descri/);
  assert.ok(d.text.includes("votação no plenário"));
  assert.ok(!d.text.includes("menu"));
  assert.ok(!d.text.includes("x()"));
});

test("tokens ignora palavras curtas e acentos", () => {
  assert.deepEqual(tokens("Câmara aprova a PEC da reforma"), ["camara", "aprova", "reforma"]);
});

// ---------- /api/resumir ----------
const OK_BODY = { url: "https://g1.globo.com/politica/noticia.html", title: "Título", source: "g1", desc: "desc" };

// resposta da IA no formato novo: JSON com resumo e contexto
const resumoJson = (resumo = "Resumo de teste da matéria.", contexto = "") => JSON.stringify({ resumo, contexto });

test("resumir: gera resumo da matéria, guarda em cache (sum3:) e não chama a IA duas vezes", async () => {
  const { env, calls } = setup();
  const r1 = await call(resumir, env, "/api/resumir", OK_BODY);
  const d1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.equal(d1.base, "materia");
  assert.match(d1.resumo, /Resumo de teste/);
  assert.deepEqual(Object.keys(d1).sort(), ["aviso", "base", "checagens", "contexto", "nota", "oficiais", "outros", "resumo", "tituloConfere", "veiculos"]);
  assert.equal(d1.veiculos, null); // índice sem termos suficientes para comparar: a página não afirma nada
  assert.equal(d1.aviso, "");
  assert.equal(cacheKeys(env, "sum3:").length, 1);
  assert.equal(cacheKeys(env, "sum:").length, 0); // a chave antiga não é mais usada
  const r2 = await call(resumir, env, "/api/resumir", OK_BODY);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), d1);
  assert.equal(calls.llm, 1);
});

test("resumir: o prompt pede JSON e proíbe repetir o título", async () => {
  const { env, calls } = setup({ llm: () => resumoJson() });
  await call(resumir, env, "/api/resumir", OK_BODY);
  const b = calls.llmBodies[0];
  assert.deepEqual(b.response_format, { type: "json_object" });
  assert.match(b.messages[0].content, /PROIBIDO repetir ou parafrasear o título/);
  assert.match(b.messages[0].content, /3 a 5 frases curtas/);
  assert.match(b.messages[1].content, /votação no plenário/); // o texto da matéria vai para a IA
});

test("resumir: matéria curta (paywall) e sem descrições úteis: base 'nenhuma', sem IA, devolve a cota e não vai para o cache", async () => {
  const { env, calls } = setup({ pageHtml: "<html><article><p>Assine para ler esta matéria completa agora mesmo.</p></article></html>" });
  const r = await call(resumir, env, "/api/resumir", OK_BODY);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.base, "nenhuma");
  assert.equal(d.resumo, "");
  assert.equal(d.contexto, "");
  assert.equal(d.aviso, "Não foi possível ler esta matéria. Veja como outros veículos noticiaram:");
  assert.deepEqual(d.outros, []);
  assert.equal(calls.llm, 0);
  assert.deepEqual(await quota(env), [0]);
  assert.equal(cacheKeys(env, "sum3:").length, 0);
});

// descrição publicada pelo veículo: mais de 200 caracteres e com fatos que o título não traz
const DESC_SENADO = "O Senado aprovou por 52 votos a 18 o texto-base da reforma tributária, que unifica impostos sobre consumo e prevê período de transição de oito anos para estados e municípios, com um fundo de compensação para os entes que perderem arrecadação.";

test("resumir: sem matéria, mas com descrições publicadas (página + índice): base 'descricoes' com aviso", async () => {
  const html = `<html><head><title>Senado aprova texto-base da reforma tributária</title><meta property="og:description" content="${DESC_SENADO}"></head><body><p>Assine para ler.</p></body></html>`;
  const { env, calls } = setup({ pageHtml: html });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(d.base, "descricoes");
  assert.equal(d.aviso, "Não conseguimos ler a matéria completa (acesso restrito ou página bloqueada). Este resumo usa as descrições publicadas pelos veículos.");
  assert.equal(calls.llm, 1);
  assert.ok(calls.llmBodies[0].messages[1].content.includes("52 votos a 18")); // a IA recebeu a descrição
});

test("resumir: a descrição do CLIENTE só vale quando falta tudo do servidor, e então o resultado não é guardado em cache", async () => {
  const { env } = setup({ pageHtml: "<html><head><title>Senado aprova texto-base da reforma tributária</title></head><body><p>Assine.</p></body></html>" });
  const d = await (await call(resumir, env, "/api/resumir", { ...OK_BODY, desc: DESC_SENADO })).json();
  assert.equal(d.base, "descricoes");
  assert.equal(cacheKeys(env, "sum3:").length, 0); // veio do cliente: não pode envenenar o cache
});

// índice com a própria matéria e a cobertura de outros veículos
const SENADO = "Senado aprova reforma tributária com transição de oito anos para estados";
const INDICE_RESUMO = [
  { t: SENADO, s: "g1", u: "https://g1.globo.com/politica/noticia.html", p: "2026-10-05T09:00", d: "Texto-base passou por 52 votos a 18 e segue para a Câmara." },
  { t: "Senado conclui votação da reforma tributária e fixa transição de oito anos", s: "Folha", u: "https://www1.folha.uol.com.br/mercado/r1", p: "2026-10-05T10:00", d: "Folha destaca a perda de arrecadação dos estados." },
  { t: "Reforma tributária: Senado aprova texto com transição de oito anos para os estados", s: "Estadão", u: "https://www.estadao.com.br/economia/r2", p: "2026-10-05T11:00" },
  { t: "Senado aprova reforma tributária e fixa transição de oito anos", s: "g1", u: "https://g1.globo.com/economia/outra", p: "2026-10-05T12:00" }, // mesmo veículo da matéria: não entra
  { t: "Time vence campeonato regional de futebol", s: "Lance", u: "https://www.lance.com.br/x", p: "2026-10-05T12:00" },
  { t: "Senado aprova reforma", s: "Poder360", u: "javascript:alert(1)", p: "2026-10-05T12:00" },
];

test("resumir: 'outros' e 'contexto' vêm do índice do servidor (outro veículo, >= 3 termos), nunca do cliente", async () => {
  const { env, calls } = setup({
    index: INDICE_RESUMO,
    llm: () => resumoJson("O texto-base foi aprovado por 52 votos a 18 e segue para a Câmara.", "A Folha destaca a perda de arrecadação dos estados, enquanto o Estadão foca na transição de oito anos."),
  });
  const d = await (await call(resumir, env, "/api/resumir", { ...OK_BODY, outros: [{ fonte: "Site Falso", titulo: "Inventado", url: "https://falso.test/x" }], contexto: "inventado pelo cliente" })).json();
  assert.equal(d.base, "materia");
  assert.deepEqual(d.outros.map((o) => o.fonte).sort(), ["Estadão", "Folha"]);
  assert.ok(d.outros.every((o) => /^https:\/\//.test(o.url)));
  assert.ok(d.outros.every((o) => Object.keys(o).sort().join() === "fonte,titulo,url"));
  assert.match(d.contexto, /Folha/);
  const prompt = calls.llmBodies[0].messages[1].content;
  assert.ok(prompt.includes("Folha destaca a perda de arrecadação")); // descrição `d` do outro veículo vai para a IA
  assert.ok(!prompt.includes("Site Falso") && !prompt.includes("inventado"));
});

test("resumir: 'contexto' que não cita nenhum veículo da lista é descartado; sem outros, contexto é sempre vazio", async () => {
  const sem = setup({ llm: () => resumoJson("Resumo de teste.", "Outros veículos também noticiaram o caso.") });
  assert.equal((await (await call(resumir, sem.env, "/api/resumir", OK_BODY)).json()).contexto, "");
  const com = setup({ index: INDICE_RESUMO, llm: () => resumoJson("Resumo de teste.", "Outros veículos também noticiaram o caso.") });
  assert.equal((await (await call(resumir, com.env, "/api/resumir", OK_BODY)).json()).contexto, "");
});

test("resumir: resumo que só repete o título ganha UMA segunda tentativa", async () => {
  const titulo = "Flávio e Caiado dão declarações em Goiânia";
  const html = ARTICLE_HTML.replace("<title>Titulo</title>", `<title>${titulo}</title>`);
  const { env, calls } = setup({
    pageHtml: html,
    llm: (b, n) => (n === 1 ? resumoJson("Flávio e Caiado deram declarações em Goiânia.") : resumoJson("Flávio disse que disputará o Senado e Caiado afirmou que apoiará a chapa, em ato com 300 pessoas.")),
  });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(calls.llm, 2);
  assert.match(d.resumo, /disputará o Senado/);
  assert.equal(d.aviso, "");
  assert.match(calls.llmBodies[1].messages[0].content, /resposta anterior só repetia o título/);
});

test("resumir: se ainda repetir o título depois da segunda tentativa, devolve mesmo assim com aviso (nunca 502)", async () => {
  const titulo = "Flávio e Caiado dão declarações em Goiânia";
  const html = ARTICLE_HTML.replace("<title>Titulo</title>", `<title>${titulo}</title>`);
  const { env, calls } = setup({ pageHtml: html, llm: () => resumoJson("Flávio e Caiado deram declarações em Goiânia.") });
  const r = await call(resumir, env, "/api/resumir", OK_BODY);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(calls.llm, 2);
  assert.equal(d.aviso, "Resumo curto: a matéria traz poucos detalhes além do título.");
  assert.match(d.resumo, /Flávio e Caiado/);
});

test("resumir: resposta da IA em texto corrido (sem JSON) ainda vira resumo", async () => {
  const { env } = setup({ llm: () => "O governo anunciou novas regras para o programa e o prazo termina em dezembro." });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.match(d.resumo, /novas regras/);
});

test("resumir: recusa domínios que não são fontes monitoradas", async () => {
  const { env, calls } = setup();
  const r = await call(resumir, env, "/api/resumir", { ...OK_BODY, url: "https://site-qualquer.com/x" });
  assert.equal(r.status, 403);
  assert.equal(calls.llm, 0);
});

test("resumir: limite por IP e origem cruzada", async () => {
  const { env } = setup();
  for (let i = 0; i < 3; i++) {
    const r = await call(resumir, env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?n=" + i });
    assert.equal(r.status, 200);
  }
  const blocked = await call(resumir, env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?n=99" });
  assert.equal(blocked.status, 429);
  const other = await call(resumir, env, "/api/resumir", OK_BODY, { Origin: "https://evil.example" });
  assert.equal(other.status, 403);
});

test("resumir: sem KV ou sem chave a função se recusa a rodar (não gasta à toa)", async () => {
  const { env } = setup();
  delete env.RADAR_KV;
  assert.equal((await call(resumir, env, "/api/resumir", OK_BODY)).status, 503);
});

// ---------- /api/verificar ----------
const isRelacoes = (body) => body.messages[0].content.includes("avaliacoes");
const extracao = (o = {}) => JSON.stringify({ afirmacao: "Urnas eletrônicas aceitam voto duplo", busca: "urnas eletronicas voto duplo", municipios: [], tipo: "afirmacao", sinais: ["Pede para compartilhar antes que apaguem"], conferir: ["Procure a checagem do TSE"], ...o });
/** IA falsa: 1ª chamada (extração) devolve `ex`; a de relações devolve `relacoes` [{ i, relacao }]. */
const llmVerificar = (ex = {}, relacoes = []) => (body) => (isRelacoes(body) ? JSON.stringify({ avaliacoes: relacoes }) : extracao(ex));

const FACT = [{
  text: "Urnas eletrônicas aceitam voto duplo",
  claimReview: [{ publisher: { name: "Agência Lupa" }, title: "É falso que urnas aceitam voto duplo", url: "https://lupa.news/x", textualRating: "Falso", reviewDate: "2026-09-01" }],
}];
const post = async (env, texto) => { const r = await call(verificar, env, "/api/verificar", { texto }); return { r, d: await r.clone().json() }; };

test("verificar: veredito 'É falso' vem da agência (origem 'agencia'), IA só traz sinais de alerta", async () => {
  const { env } = setup({ llm: llmVerificar(), factchecks: FACT });
  const { r, d } = await post(env, "URGENTE! Urnas eletrônicas aceitam voto duplo, compartilhe antes que apaguem");
  assert.equal(r.status, 200);
  assert.deepEqual(d.resultado, { rotulo: "É falso", tom: "falso", origem: "agencia", confianca: "alta", resumo: "A agência Agência Lupa avaliou: “Falso”." });
  assert.equal(d.veredito, "falso");
  assert.equal(d.checagens[0].agencia, "Agência Lupa");
  assert.ok(!("classe" in d.checagens[0]) && !("relacionada" in d.checagens[0]));
  assert.equal(d.sinais.length, 1);
  assert.equal(d.diagnostico.agencias, "ok");
  assert.equal(d.diagnostico.ia, "ok");
  assert.equal(d.radar.nivel, "provavelmente_falso");
  assert.match(d.radar.motivos[0], /Agência Lupa avaliou/);
});

test("verificar: a consulta ao Google leva o Referer do site (chaves restritas por referenciador)", async () => {
  const { env, calls } = setup({ llm: llmVerificar(), factchecks: FACT });
  await post(env, "Urnas eletrônicas aceitam voto duplo, diz mensagem");
  assert.equal(calls.factHeaders[0].Referer, "https://site.test/");
  env.FACTCHECK_REFERER = "https://radar.exemplo.org/";
  await post(env, "Urnas eletrônicas aceitam voto duplo, diz outra mensagem");
  assert.equal(calls.factHeaders[1].Referer, "https://radar.exemplo.org/");
});

test("verificar: sem checagem não vira 'verdadeiro' nem 'falso'; mostra notícias relacionadas", async () => {
  const { env } = setup({
    llm: llmVerificar({ afirmacao: "Câmara aprova reforma administrativa", busca: "camara aprova reforma administrativa" }),
    factchecks: [],
  });
  const { d } = await post(env, "A Câmara aprovou a reforma administrativa ontem à noite");
  assert.equal(d.veredito, "sem_checagem");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.noticias.length, 1);
  assert.equal(d.noticias[0].fonte, "g1");
  assert.equal(d.noticias[0].relacao, "relacionada"); // a IA não devolveu avaliações: só "relacionada"
  assert.equal(d.resultado.rotulo, "Não deu para confirmar");
});

test("verificar: ignora checagem de outro assunto (sem sobreposição de termos)", async () => {
  const { env } = setup({
    llm: llmVerificar(),
    factchecks: [{ text: "Vacina causa efeitos colaterais graves", claimReview: [{ publisher: { name: "X" }, title: "É falso que vacina cause", url: "https://x.test/1", textualRating: "Falso" }] }],
  });
  const { d } = await post(env, "Urnas eletrônicas aceitam voto duplo, diz mensagem");
  assert.equal(d.veredito, "sem_checagem");
  assert.deepEqual(d.checagens, []);
});

test("verificar: recusa links internos e textos muito curtos", async () => {
  const { env, calls } = setup({ llm: llmVerificar() });
  assert.equal((await call(verificar, env, "/api/verificar", { texto: "http://localhost/admin" })).status, 400);
  assert.equal((await call(verificar, env, "/api/verificar", { texto: "http://169.254.169.254/latest/meta-data" })).status, 400);
  assert.equal((await call(verificar, env, "/api/verificar", { texto: "oi" })).status, 400);
  assert.equal(calls.llm, 0);
});

test("verificar: resultado repetido vem do cache (ver2:)", async () => {
  const { env, calls } = setup({ llm: llmVerificar(), factchecks: FACT });
  const body = { texto: "Urnas eletrônicas aceitam voto duplo, compartilhe" };
  await call(verificar, env, "/api/verificar", body);
  assert.equal(cacheKeys(env, "ver2:").length, 1);
  assert.equal(cacheKeys(env, "ver:").length, 0);
  const n = calls.llm;
  await call(verificar, env, "/api/verificar", body);
  assert.equal(calls.llm, n);
});

test("verificar: se a IA cair, ainda devolve o resultado das agências", async () => {
  const { env } = setup({ factchecks: FACT, llm: () => new Response("erro", { status: 500 }) });
  const { d } = await post(env, "Urnas eletrônicas aceitam voto duplo, diz o boato");
  assert.equal(d.veredito, "falso");
  assert.equal(d.resultado.rotulo, "É falso");
  assert.equal(d.diagnostico.ia, "falhou");
  assert.deepEqual(d.sinais, []);
});

// ---------- avaliação própria do Radar (sem agência) ----------
const MERENDA = "O prefeito de Serra do Cajueiro Seco, Zeferino Quaresma Dantas, teria desviado R$ 48.317.902,00 da merenda escolar em três meses, com o caso arquivado e abafado pela mídia.";
const exMerenda = { afirmacao: "O prefeito de Serra do Cajueiro Seco teria desviado R$ 48 milhões da merenda escolar em três meses", busca: "prefeito Serra Cajueiro Seco desvio merenda", municipios: ["Serra do Cajueiro Seco"], tipo: "afirmacao" };

test("verificar (aceitação): boato da merenda com município inexistente => 'Provavelmente falso', origem radar, motivos com IBGE e gatilho", async () => {
  const { env, calls } = setup({ llm: llmVerificar(exMerenda), factchecks: [] });
  const { r, d } = await post(env, MERENDA);
  assert.equal(r.status, 200);
  assert.equal(d.resultado.rotulo, "Provavelmente falso");
  assert.equal(d.resultado.tom, "falso");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.resultado.confianca, "alta");
  assert.equal(d.resultado.resumo, "Não existe município com esse nome no Brasil e nenhum veículo noticiou o caso.");
  assert.equal(d.veredito, "sem_checagem");
  assert.equal(d.radar.nivel, "provavelmente_falso");
  assert.equal(d.radar.motivos[0], "Não existe município chamado “Serra do Cajueiro Seco” na lista oficial do IBGE (5.571 municípios).");
  assert.ok(d.radar.motivos.some((m) => m.includes("abafado pela mídia")), JSON.stringify(d.radar.motivos));
  assert.equal(d.radar.motivos.at(-1), "Nenhuma agência de checagem analisou este boato ainda.");
  assert.ok(d.radar.motivos.length <= 5);
  assert.deepEqual(d.diagnostico, { agencias: "ok", ia: "ok", gdelt: "ok", municipios: [{ nome: "Serra do Cajueiro Seco", existe: false }] });
  assert.ok(calls.urls.some((u) => u.includes("gdeltproject") && u.includes("%22Serra%20do%20Cajueiro%20Seco%22"))); // a consulta usa o município entre aspas
  assert.equal(calls.llm, 1); // sem candidatas, não há segunda chamada de IA
  assert.equal(cacheKeys(env, "ver2:").length, 1);
});

const NOTICIAS_FORTALEZA = [
  { t: "Prefeito de Fortaleza é investigado por desvio de recursos da merenda escolar", s: "g1", u: "https://g1.globo.com/ce/n1", p: "2026-10-05T10:00" },
  { t: "Prefeito de Fortaleza investigado por desvio na merenda escolar, diz Ministério Público", s: "Folha", u: "https://www1.folha.uol.com.br/n2", p: "2026-10-05T11:00" },
  { t: "Câmara aprova projeto sobre reforma administrativa", s: "g1", u: "https://g1.globo.com/a", p: "2026-10-04T10:00" },
];
const exFortaleza = { afirmacao: "O prefeito de Fortaleza é investigado por desvio de recursos da merenda escolar", busca: "prefeito Fortaleza desvio merenda escolar", municipios: ["Fortaleza"], tipo: "afirmacao" };
const TEXTO_FORTALEZA = "O prefeito de Fortaleza foi investigado por desvio de dinheiro da merenda escolar, segundo o Ministério Público.";

test("verificar (aceitação): município real com 2+ veículos que confirmam => 'Provavelmente verdadeiro'", async () => {
  const { env, calls } = setup({ index: NOTICIAS_FORTALEZA, llm: llmVerificar(exFortaleza, [{ i: 0, relacao: "confirma" }, { i: 1, relacao: "confirma" }]) });
  const { d } = await post(env, TEXTO_FORTALEZA);
  assert.equal(d.resultado.rotulo, "Provavelmente verdadeiro");
  assert.equal(d.resultado.tom, "verdadeiro");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.resultado.confianca, "media"); // 2 veículos; "alta" só com 3 ou mais
  assert.equal(d.resultado.resumo, "Foi noticiado por g1 e Folha.");
  assert.equal(d.radar.motivos[0], "Foi noticiado por g1 e Folha.");
  assert.deepEqual(d.noticias.map((n) => n.fonte), ["g1", "Folha"]);
  assert.ok(d.noticias.every((n) => n.relacao === "confirma" && /^https:/.test(n.url) && n.data === (n.fonte === "g1" ? "2026-10-05" : "2026-10-05")));
  assert.deepEqual(d.diagnostico.municipios, [{ nome: "Fortaleza", existe: true }]);
  assert.equal(d.diagnostico.gdelt, "pulado"); // 2 resultados locais bastam: GDELT nem é consultado
  assert.equal(calls.gdelt, 0);
  assert.equal(calls.llm, 2);
});

test("verificar: com 3 veículos distintos que confirmam, a confiança sobe para 'alta'", async () => {
  const idx = [...NOTICIAS_FORTALEZA, { t: "Prefeito de Fortaleza é alvo de investigação por desvio na merenda escolar", s: "Estadão", u: "https://www.estadao.com.br/n3", p: "2026-10-05T12:00" }];
  const { env } = setup({ index: idx, llm: llmVerificar(exFortaleza, [0, 1, 2].map((i) => ({ i, relacao: "confirma" }))) });
  const { d } = await post(env, TEXTO_FORTALEZA);
  assert.equal(d.resultado.rotulo, "Provavelmente verdadeiro");
  assert.equal(d.resultado.confianca, "alta");
});

test("verificar: dois links do MESMO veículo contam como uma fonte só", async () => {
  const idx = [
    NOTICIAS_FORTALEZA[0],
    { t: "Prefeito de Fortaleza investigado por desvio na merenda escolar, afirma a polícia", s: "g1", u: "https://g1.globo.com/ce/n9", p: "2026-10-05T11:30" },
  ];
  const { env } = setup({ index: idx, llm: llmVerificar(exFortaleza, [{ i: 0, relacao: "confirma" }, { i: 1, relacao: "confirma" }]) });
  const { d } = await post(env, TEXTO_FORTALEZA);
  assert.equal(d.resultado.rotulo, "Não deu para confirmar"); // 2 links, 1 veículo: não chega a MIN_FONTES
  assert.equal(d.noticias.length, 2);
});

test("verificar: uma fonte OFICIAL (o: 1) que confirma basta para 'Provavelmente verdadeiro'", async () => {
  const idx = [{ t: "Prefeitura de Fortaleza abre investigação sobre desvio na merenda escolar", s: "Agência Senado", u: "https://www12.senado.leg.br/n1", p: "2026-10-05T10:00", o: 1 }];
  const { env } = setup({ index: idx, llm: llmVerificar(exFortaleza, [{ i: 0, relacao: "confirma" }]) });
  const { d } = await post(env, TEXTO_FORTALEZA);
  assert.equal(d.resultado.rotulo, "Provavelmente verdadeiro");
});

test("verificar: a IA exagerou ('confirma' com poucos termos em comum): a guarda determinística rebaixa para 'relacionada'", async () => {
  const idx = [
    { t: "Prefeito de Fortaleza inaugura escola em bairro da periferia", s: "g1", u: "https://g1.globo.com/ce/e1", p: "2026-10-05T10:00" },
    { t: "Prefeito de Fortaleza inaugura creche e escola na zona norte", s: "Folha", u: "https://www1.folha.uol.com.br/e2", p: "2026-10-05T11:00" },
  ];
  const ex = { afirmacao: "O prefeito de Fortaleza desviou verba da merenda", busca: "prefeito Fortaleza merenda", municipios: ["Fortaleza"], tipo: "afirmacao" };
  const { env } = setup({ index: idx, llm: llmVerificar(ex, [{ i: 0, relacao: "confirma" }, { i: 1, relacao: "confirma" }]) });
  const { d } = await post(env, "O prefeito de Fortaleza desviou verba da merenda, diz mensagem");
  assert.notEqual(d.resultado.rotulo, "Provavelmente verdadeiro");
  assert.ok(d.noticias.every((n) => n.relacao === "relacionada"));
});

test("verificar: 2+ veículos que contradizem e nenhum que confirma => 'Provavelmente falso'", async () => {
  const idx = [
    { t: "Governo nega que vai cobrar imposto sobre o Pix", s: "g1", u: "https://g1.globo.com/p1", p: "2026-10-05T10:00" },
    { t: "Receita descarta cobrar imposto sobre o Pix e diz que é boato", s: "Estadão", u: "https://www.estadao.com.br/p2", p: "2026-10-05T11:00" },
  ];
  const ex = { afirmacao: "O governo vai cobrar imposto sobre o Pix", busca: "governo cobrar imposto Pix", municipios: [], tipo: "afirmacao" };
  const { env } = setup({ index: idx, llm: llmVerificar(ex, [{ i: 0, relacao: "contradiz" }, { i: 1, relacao: "contradiz" }]) });
  const { d } = await post(env, "O governo vai cobrar imposto sobre o Pix a partir do mês que vem");
  assert.equal(d.resultado.rotulo, "Provavelmente falso");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.resultado.confianca, "alta");
  assert.match(d.radar.motivos[0], /^Veículos como (g1 e Estadão|Estadão e g1) noticiam o contrário ou desmentem a afirmação\.$/);
  assert.deepEqual(d.noticias.map((n) => n.relacao), ["contradiz", "contradiz"]);
});

test("verificar: uma manchete que contradiz sozinha não basta para 'falso'", async () => {
  const idx = [{ t: "Governo nega que vai cobrar imposto sobre o Pix", s: "g1", u: "https://g1.globo.com/p1", p: "2026-10-05T10:00" }];
  const ex = { afirmacao: "O governo vai cobrar imposto sobre o Pix", busca: "governo cobrar imposto Pix", municipios: [], tipo: "afirmacao" };
  const { env } = setup({ index: idx, llm: llmVerificar(ex, [{ i: 0, relacao: "contradiz" }]) });
  const { d } = await post(env, "O governo vai cobrar imposto sobre o Pix a partir do mês que vem");
  assert.notEqual(d.resultado.rotulo, "Provavelmente falso");
});

test("verificar (aceitação): texto com gatilhos de corrente, sem município e sem cobertura => 'Suspeito de ser boato'", async () => {
  const { env } = setup({ llm: llmVerificar({ afirmacao: "O governo vai cobrar imposto sobre o Pix", busca: "governo cobrar imposto Pix", municipios: [], tipo: "afirmacao" }) });
  const { d } = await post(env, "ATENÇÃO!!! O governo vai cobrar imposto sobre o Pix a partir do mês que vem. Compartilhe com todos antes que apaguem!");
  assert.equal(d.resultado.rotulo, "Suspeito de ser boato");
  assert.equal(d.resultado.tom, "alerta");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.resultado.confianca, "media");
  assert.equal(d.resultado.resumo, "Nenhuma agência checou e nenhum veículo confirma; a mensagem usa gatilhos típicos de corrente.");
  assert.equal(d.radar.nivel, "suspeito");
  assert.ok(d.radar.motivos.some((m) => m.startsWith("Pede para compartilhar") && m.includes("“Compartilhe”")), JSON.stringify(d.radar.motivos));
  assert.ok(d.radar.motivos.some((m) => m.includes("antes que apaguem")));
  assert.ok(d.radar.motivos.includes("Nenhum veículo de imprensa que consultamos noticiou o caso."));
  assert.equal(d.radar.motivos.at(-1), "Nenhuma agência de checagem analisou este boato ainda.");
});

test("verificar: anúncio de medida ('vai taxar o Pix') que a IA marcou como 'previsão' é tratado como afirmação", async () => {
  const ex = { afirmacao: "O governo vai cobrar imposto sobre o Pix", busca: "governo cobrar imposto Pix", municipios: [], tipo: "previsao" };
  const { env } = setup({ llm: llmVerificar(ex) });
  // 25 (divulgue) + 15 (medida do governo) = 40: abaixo de 45, então só vale pela regra "afirmação sem cobertura e >= 25"
  const { d } = await post(env, "O governo vai cobrar imposto sobre o Pix a partir do mês que vem, divulgue");
  assert.equal(d.resultado.rotulo, "Suspeito de ser boato");
});

test("verificar (aceitação): opinião => 'Não deu para confirmar', mesmo citando município inexistente", async () => {
  const ex = { afirmacao: "O prefeito de Serra do Cajueiro Seco é o pior da região", busca: "prefeito Serra Cajueiro Seco", municipios: ["Serra do Cajueiro Seco"], tipo: "opiniao" };
  const { env } = setup({ llm: llmVerificar(ex) });
  const { d } = await post(env, "Acho que o prefeito de Serra do Cajueiro Seco é o pior da região, na minha opinião.");
  assert.equal(d.resultado.rotulo, "Não deu para confirmar");
  assert.equal(d.resultado.tom, "neutro");
  assert.equal(d.resultado.confianca, "baixa");
  assert.equal(d.resultado.resumo, "Isto é opinião ou previsão, não um fato que possa ser checado.");
  assert.equal(d.radar.motivos[0], "Isto é opinião ou previsão, não um fato que possa ser checado.");
  assert.equal(d.radar.nivel, "nao_confirmado");
});

test("verificar: sem nada a dizer, 'Não deu para confirmar' (baixa confiança, tom neutro)", async () => {
  const ex = { afirmacao: "Alguém viu um objeto estranho no céu ontem", busca: "objeto estranho ceu ontem", municipios: [], tipo: "afirmacao", sinais: [], conferir: [] };
  const { env } = setup({ llm: llmVerificar(ex) });
  const { d } = await post(env, "Alguém viu um objeto estranho no céu ontem à noite");
  assert.equal(d.resultado.rotulo, "Não deu para confirmar");
  assert.equal(d.resultado.confianca, "baixa");
  assert.equal(d.resultado.resumo, "Não encontramos agência, veículo ou dado oficial que confirme ou desminta isto.");
  assert.ok(d.conferir.length >= 2); // sem sugestões da IA, entram as padrão
});

test("verificar (aceitação): Google responde 403 com corpo JSON de erro => diagnostico.agencias 'erro: 403 ...' e o resultado sai do Radar, sem vazar a chave", async () => {
  const chave = "AIzaSyFAKEKEY1234567890abcdefghijk";
  const corpo = JSON.stringify({ error: { code: 403, message: `Requests from referer <empty> are blocked. (key=${chave})`, status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_HTTP_REFERRER_BLOCKED", domain: "googleapis.com" }] } });
  const { env, calls } = setup({ llm: llmVerificar(exMerenda), factStatus: 403, factBody: corpo });
  env.FACTCHECK_API_KEY = chave;
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let r, d;
  try { r = await call(verificar, env, "/api/verificar", { texto: MERENDA }); d = await r.json(); } finally { console.log = orig; }
  assert.equal(r.status, 200);
  assert.ok(d.diagnostico.agencias.startsWith("erro: 403"), d.diagnostico.agencias);
  assert.ok(d.diagnostico.agencias.includes("API_KEY_HTTP_REFERRER_BLOCKED"));
  assert.equal(d.resultado.rotulo, "Provavelmente falso"); // a falha das agências não derruba o Radar
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.veredito, "indisponivel");
  assert.equal(d.radar.motivos.at(-1), "Não conseguimos consultar as agências agora.");
  assert.ok(!d.radar.motivos.slice(0, -1).some((m) => /agência/i.test(m))); // e isso não é motivo de falsidade
  assert.ok(!JSON.stringify(d).includes("AIzaSy"), "a chave vazou na resposta");
  assert.ok(!logs.join("\n").includes("AIzaSy"), "a chave vazou nos logs");
  assert.equal(calls.fact, 1); // 403 não é erro passageiro: sem nova tentativa
  assert.equal(cacheKeys(env, "ver2:").length, 0); // consulta às agências falhou: não guarda
});

test("verificar: corpo de erro do Google que não é JSON vira só o código HTTP; sem chave vira 'sem_chave'", async () => {
  const a = setup({ llm: llmVerificar(), factStatus: 400, factBody: "<html>Bad Request</html>" });
  assert.equal((await post(a.env, "Urnas eletrônicas aceitam voto duplo, diz mensagem")).d.diagnostico.agencias, "erro: 400");
  const b = setup({ llm: llmVerificar() });
  delete b.env.FACTCHECK_API_KEY;
  const { d } = await post(b.env, "Urnas eletrônicas aceitam voto duplo, diz mensagem");
  assert.equal(d.diagnostico.agencias, "sem_chave");
  assert.equal(b.calls.fact, 0);
});

test("verificar (aceitação): GDELT responde 429 com texto puro => 'limite', nada quebra e não vai para o cache", async () => {
  const { env, calls } = setup({
    llm: llmVerificar(exMerenda),
    gdelt: { status: 429, body: "Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries." },
  });
  const { r, d } = await post(env, MERENDA);
  assert.equal(r.status, 200);
  assert.equal(calls.gdelt, 1);
  assert.equal(d.diagnostico.gdelt, "limite");
  assert.equal(d.resultado.rotulo, "Provavelmente falso");
  assert.equal(cacheKeys(env, "ver2:").length, 0);
});

test("verificar: GDELT com resposta que não é JSON ou com erro HTTP => 'erro'; sem 'articles' => 'ok'", async () => {
  const a = setup({ llm: llmVerificar(exMerenda), gdelt: { status: 200, body: "The specified phrase is too short." } });
  assert.equal((await post(a.env, MERENDA)).d.diagnostico.gdelt, "erro");
  const b = setup({ llm: llmVerificar(exMerenda), gdelt: { status: 500, body: "boom" } });
  assert.equal((await post(b.env, MERENDA)).d.diagnostico.gdelt, "erro");
  const c = setup({ llm: llmVerificar(exMerenda), gdelt: { status: 200, body: { articles: [] } } });
  assert.equal((await post(c.env, MERENDA)).d.diagnostico.gdelt, "ok");
});

test("verificar: o GDELT entra quando o índice local traz menos de 2 resultados, e seus artigos contam como cobertura", async () => {
  const gdelt = {
    status: 200,
    body: { articles: [
      { url: "https://oglobo.globo.com/ce/p1", title: "Prefeito de Fortaleza é investigado por desvio na merenda escolar", domain: "oglobo.globo.com", seendate: "20261005T120000Z" },
      { url: "https://www.estadao.com.br/ce/p2", title: "Desvio na merenda escolar: prefeito de Fortaleza vira alvo de investigação", domain: "estadao.com.br", seendate: "20261005T130000Z" },
      { url: "javascript:alert(1)", title: "Prefeito de Fortaleza merenda escolar desvio", domain: "x.com", seendate: "20261005T130000Z" },
      { url: "https://www.exemplo.com/off", title: "Receita de bolo de cenoura", domain: "exemplo.com", seendate: "20261005T130000Z" },
    ] },
  };
  const { env, calls } = setup({ gdelt, llm: llmVerificar(exFortaleza, [{ i: 0, relacao: "confirma" }, { i: 1, relacao: "confirma" }]) });
  const { d } = await post(env, TEXTO_FORTALEZA);
  assert.equal(calls.gdelt, 1);
  assert.equal(d.diagnostico.gdelt, "ok");
  assert.equal(d.resultado.rotulo, "Provavelmente verdadeiro");
  assert.deepEqual(d.noticias.map((n) => n.data), ["2026-10-05", "2026-10-05"]);
  assert.ok(d.noticias.every((n) => /^https:/.test(n.url)));
  assert.ok(calls.urls.find((u) => u.includes("gdeltproject")).includes("%22Fortaleza%22")); // município entre aspas
});

test("verificar: sem município, a consulta do GDELT usa até 4 palavras-chave com sourcelang:portuguese", async () => {
  const { env, calls } = setup({ llm: llmVerificar({ busca: "urnas eletrônicas voto duplo tse" }) });
  await post(env, "Urnas eletrônicas aceitam voto duplo, diz mensagem");
  const u = decodeURIComponent(calls.urls.find((x) => x.includes("gdeltproject")));
  assert.match(u, /query=urnas eletrônicas voto duplo sourcelang:portuguese&mode=artlist&format=json&maxrecords=8&timespan=3months&sort=datedesc/);
});

test("verificar: erro de grafia no município ('Fortalesa') vira 'parecido', não 'inexistente'", async () => {
  const ex = { afirmacao: "O prefeito de Fortalesa desviou verba da merenda", busca: "prefeito Fortalesa desvio merenda", municipios: ["Fortalesa"], tipo: "afirmacao" };
  const { env } = setup({ llm: llmVerificar(ex) });
  const { d } = await post(env, "O prefeito de Fortalesa desviou verba da merenda escolar, diz o boato");
  assert.deepEqual(d.diagnostico.municipios, [{ nome: "Fortalesa", existe: false, parecido: "Fortaleza" }]);
  assert.notEqual(d.resultado.rotulo, "Provavelmente falso");
});

test("verificar: município inexistente SEM contexto municipal, cidade estrangeira e nome que a IA inventou não viram evidência", async () => {
  // sem "prefeito de", "cidade de"...: o nome pode ser bairro, distrito ou qualquer coisa
  const a = setup({ llm: llmVerificar({ municipios: ["Vila Inexistente Nova"] }) });
  const da = (await post(a.env, "Ontem em Vila Inexistente Nova teve uma festa enorme com muita gente na praça central.")).d;
  assert.notEqual(da.resultado.rotulo, "Provavelmente falso");
  assert.deepEqual(da.diagnostico.municipios, [{ nome: "Vila Inexistente Nova", existe: false }]);
  // cidade estrangeira nem é conferida
  const b = setup({ llm: llmVerificar({ municipios: ["Paris"] }) });
  const db = (await post(b.env, "O prefeito de Paris anunciou que vai fechar o centro da cidade para carros em 2027")).d;
  assert.deepEqual(db.diagnostico.municipios, []);
  assert.notEqual(db.resultado.rotulo, "Provavelmente falso");
  // nome que não está no texto (a IA inventou) é ignorado
  const c = setup({ llm: llmVerificar({ municipios: ["Serra do Cajueiro Seco"] }) });
  const dc = (await post(c.env, "O prefeito de Fortaleza anunciou um novo programa de merenda para as escolas municipais")).d;
  assert.deepEqual(dc.diagnostico.municipios, []);
});

test("verificar: a lista de municípios (~120 KB) só é lida quando o texto cita algum município que pode ser conferido", async () => {
  const leu = (calls) => calls.urls.some((u) => u.includes("/data/municipios.json"));
  // sem município: nem baixa nem interpreta a lista (poupa CPU)
  const a = setup({ llm: llmVerificar({ municipios: [] }) });
  await post(a.env, "O governo vai taxar o Pix a partir do mês que vem, avisa a mensagem que circula.");
  assert.equal(leu(a.calls), false);
  // país, capital estrangeira e estado nem são conferidos: também não leem a lista
  const b = setup({ llm: llmVerificar({ municipios: ["Paris", "Minas Gerais"] }) });
  await post(b.env, "O prefeito de Paris e o governador de Minas Gerais combinaram uma visita oficial em 2027.");
  assert.equal(leu(b.calls), false);
  // município de verdade: lê, e uma só vez por isolate (a segunda requisição usa o cache de módulo)
  const c = setup({ llm: llmVerificar(exFortaleza) });
  await post(c.env, TEXTO_FORTALEZA);
  await post(c.env, TEXTO_FORTALEZA + " Veja mais detalhes no site do Ministério Público.");
  assert.equal(c.calls.urls.filter((u) => u.includes("/data/municipios.json")).length, 1);
});

test("verificar: sem a lista de municípios (arquivo fora do ar) a checagem é pulada, sem derrubar nada", async () => {
  const { env } = setup({ llm: llmVerificar(exMerenda), municipios: null });
  const { r, d } = await post(env, MERENDA);
  assert.equal(r.status, 200);
  assert.deepEqual(d.diagnostico.municipios, []);
  assert.notEqual(d.resultado.rotulo, "Provavelmente falso"); // sem a lista não há como afirmar que o município não existe
});

test("verificar: se a IA cair, as regras seguem sozinhas (município por regex, texto cru como busca)", async () => {
  const { env } = setup({ llm: () => new Response("erro", { status: 500 }) });
  const { r, d } = await post(env, MERENDA);
  assert.equal(r.status, 200);
  assert.equal(d.resultado.rotulo, "Provavelmente falso");
  assert.equal(d.diagnostico.ia, "falhou");
  assert.deepEqual(d.diagnostico.municipios, [{ nome: "Serra do Cajueiro Seco", existe: false }]);
  assert.ok(d.sinais.length > 0 && d.conferir.length > 0); // sinais determinísticos e sugestões padrão no lugar das da IA
  assert.equal(cacheKeys(env, "ver2:").length, 0); // IA falhou: não guarda
});

// ---------- agências pelo índice (sem chave) ----------
const INDICE_CHECAGENS = [
  { t: "É falso que o governo vai cobrar imposto sobre o Pix", s: "Aos Fatos", u: "https://www.aosfatos.org/c1", p: "2026-10-03T10:00", c: 1 },
  { t: "Governo e Receita explicam mudanças nas regras do Pix e do imposto", s: "Lupa", u: "https://lupa.news/c2", p: "2026-10-03T11:00", c: 1 },
  { t: "Câmara aprova projeto sobre reforma administrativa", s: "g1", u: "https://g1.globo.com/a", p: "2026-10-04T10:00" },
];
const exPix = { afirmacao: "O governo vai cobrar imposto sobre o Pix", busca: "governo cobrar imposto Pix", municipios: [], tipo: "afirmacao" };

test("verificar: sem a chave do Google, checagem do índice (c: 1) com veredito no título decide como agência", async () => {
  const { env, calls } = setup({ index: INDICE_CHECAGENS, llm: llmVerificar(exPix) });
  delete env.FACTCHECK_API_KEY;
  const { d } = await post(env, "O governo vai cobrar imposto sobre o Pix a partir do mês que vem");
  assert.equal(calls.fact, 0);
  assert.equal(d.diagnostico.agencias, "sem_chave");
  assert.equal(d.resultado.rotulo, "É falso");
  assert.equal(d.resultado.origem, "agencia");
  assert.equal(d.resultado.resumo, "A agência Aos Fatos avaliou: “Falso”.");
  assert.equal(d.veredito, "falso");
  assert.equal(d.checagens[0].url, "https://www.aosfatos.org/c1");
  assert.ok(!("relacionada" in d.checagens[0]));
  assert.equal(calls.llm, 1); // agência decidiu: sem segunda chamada de IA
});

test("verificar: checagem do índice sem veredito no título aparece como 'relacionada' e não entra no agregado", async () => {
  const { env } = setup({ index: INDICE_CHECAGENS.slice(1), llm: llmVerificar(exPix) });
  const { d } = await post(env, "O governo vai cobrar imposto sobre o Pix a partir do mês que vem");
  assert.equal(d.checagens.length, 1);
  assert.equal(d.checagens[0].agencia, "Lupa");
  assert.equal(d.checagens[0].relacionada, true);
  assert.equal(d.veredito, "sem_checagem");
  assert.equal(d.resultado.origem, "radar");
  assert.ok(d.radar.motivos.includes("Há checagens de agências sobre assuntos parecidos, mas nenhuma conclui sobre esta mensagem."));
});

test("verificar: checagem com sentido oposto ao do texto (negação) não vira veredito: 'É falso que vai taxar' não vale para 'NÃO vai taxar'", async () => {
  const { env } = setup({ index: INDICE_CHECAGENS, llm: llmVerificar({ ...exPix, afirmacao: "O governo não vai cobrar imposto sobre o Pix" }) });
  const { d } = await post(env, "O governo não vai cobrar imposto sobre o Pix a partir do mês que vem");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.veredito, "sem_checagem");
  assert.equal(d.checagens[0].relacionada, true);
});

test("verificar: a mesma checagem do Google com negação oposta também não decide", async () => {
  const { env } = setup({ llm: llmVerificar({ ...exPix, afirmacao: "O governo não vai cobrar imposto sobre o Pix" }), factchecks: [{ text: "O governo vai cobrar imposto sobre o Pix", claimReview: [{ publisher: { name: "Lupa" }, title: "É falso que governo vai cobrar imposto sobre o Pix", url: "https://lupa.news/pix", textualRating: "Falso" }] }] });
  const { d } = await post(env, "O governo não vai cobrar imposto sobre o Pix");
  assert.equal(d.resultado.origem, "radar");
  assert.equal(d.checagens[0].relacionada, true);
});

test("verificar: avaliação do Google que não dá para classificar ('Em análise') não conta como veredito", async () => {
  const { env } = setup({ llm: llmVerificar(), factchecks: [{ text: "Urnas eletrônicas aceitam voto duplo", claimReview: [{ publisher: { name: "Lupa" }, title: "Urnas e voto duplo", url: "https://lupa.news/y", textualRating: "Em análise" }] }] });
  const { d } = await post(env, "Urnas eletrônicas aceitam voto duplo, diz mensagem");
  assert.equal(d.veredito, "sem_checagem");
  assert.equal(d.checagens[0].relacionada, true);
  assert.equal(d.resultado.origem, "radar");
});

test("verificar: link é lido pela página (título, descrição e texto); gatilhos de corrente só valem para texto colado", async () => {
  const html = `<html><head><title>Compartilhe e repasse esta matéria</title></head><body><article>${"<p>" + "Compartilhe com todos antes que apaguem: o texto da matéria fala de assuntos variados e traz detalhes de interesse. ".repeat(6) + "</p>"}</article></body></html>`;
  const { env } = setup({ pageHtml: html, llm: llmVerificar({ afirmacao: "Matéria fala de assuntos variados", busca: "materia assuntos variados detalhes" }) });
  const { r, d } = await post(env, "https://exemplo-noticia.com/materia");
  assert.equal(r.status, 200);
  assert.equal(d.resultado.rotulo, "Não deu para confirmar"); // a página tem "compartilhe", mas é link: sem pontos de corrente
});

// ---------- robustez ----------
const llmDown = () => new Response("erro", { status: 500 });

test("parseHttpUrl bloqueia IP em decimal e hexadecimal", () => {
  assert.equal(parseHttpUrl("http://2130706433/"), null);
  assert.equal(parseHttpUrl("http://0x7f000001/"), null);
});

test("readLimitedText corta respostas gigantes", async () => {
  const big = new Response("a".repeat(5_000_000));
  const txt = await readLimitedText(big, 1000);
  assert.ok(txt.length <= 1000);
});

test("pedido: método errado, corpo grande e content-type errado são recusados", async () => {
  const { env } = setup();
  const { onRequest } = await import("../functions/api/resumir.js");
  assert.equal((await onRequest()).status, 405);
  const big = await call(resumir, env, "/api/resumir", { ...OK_BODY, desc: "x".repeat(20000) });
  assert.equal(big.status, 413);
  const wrong = await resumir({ request: new Request("https://site.test/api/resumir", { method: "POST", headers: { "Content-Type": "text/plain", Origin: "https://site.test" }, body: "x" }), env });
  assert.equal(wrong.status, 415);
  const bad = await resumir({ request: new Request("https://site.test/api/resumir", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://site.test" }, body: "{quebrado" }), env });
  assert.equal(bad.status, 400);
});

test("resumir: se a IA cai, devolve 502 e DEVOLVE a cota do leitor", async () => {
  const { env } = setup({ llm: llmDown });
  const r = await call(resumir, env, "/api/resumir", OK_BODY);
  assert.equal(r.status, 502);
  assert.deepEqual(await quota(env), [0]);
});

test("IA que devolve JSON válido mas sem objeto ('null', número, texto entre aspas) nunca causa erro 500", async () => {
  for (const lixo of ["null", "42", '"só texto"', "[]", "true"]) {
    // resumir: não é resumo; trata como falha do serviço (502) e devolve a cota
    const a = setup({ llm: () => lixo });
    const ra = await call(resumir, a.env, "/api/resumir", OK_BODY);
    assert.equal(ra.status, 502, lixo);
    assert.deepEqual(await quota(a.env), [0], lixo);
    // verificar: sem extração da IA, as regras seguem sozinhas (aqui, o município inexistente por regex)
    const b = setup({ llm: () => lixo });
    const { r, d } = await post(b.env, MERENDA);
    assert.equal(r.status, 200, lixo);
    assert.equal(d.diagnostico.ia, "falhou", lixo);
    assert.equal(d.resultado.rotulo, "Provavelmente falso", lixo);
  }
});

test("IA: erro passageiro tem uma nova tentativa antes de desistir", async () => {
  const { env, calls } = setup({ llm: (b, n) => (n === 1 ? new Response("x", { status: 503 }) : resumoJson("Resumo depois do retry.")) });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(d.resumo, "Resumo depois do retry.");
  assert.equal(calls.llm, 2);
});

test("IA: provedor reserva entra quando o principal recusa a chave", async () => {
  const { env, calls } = setup({ llm: (b, n, url) => (url.includes("reserva.test") ? resumoJson("Resumo curto vindo do provedor reserva.") : new Response("no", { status: 401 })) });
  Object.assign(env, { LLM_FALLBACK_API_KEY: "k2", LLM_FALLBACK_BASE_URL: "https://reserva.test/v1", LLM_FALLBACK_MODEL: "m2" });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(d.resumo, "Resumo curto vindo do provedor reserva.");
  assert.equal(calls.llm, 2); // principal (401, sem retry) + reserva
});

test("redirecionamento para endereço interno é bloqueado e nunca é requisitado", async () => {
  const { env, calls } = setup({
    page: (url) => (url.includes("g1.globo.com")
      ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
      : new Response("segredo", { status: 200, headers: { "content-type": "text/html" } })),
  });
  const r = await call(resumir, env, "/api/resumir", OK_BODY);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.base, "nenhuma"); // não leu a página: sem o que resumir
  assert.ok(!calls.urls.some((u) => u.includes("169.254")));
});

test("redirecionamento para outro domínio não monitorado também é bloqueado", async () => {
  const { env, calls } = setup({
    page: (url) => (url.includes("g1.globo.com")
      ? new Response(null, { status: 301, headers: { location: "https://site-qualquer.com/x" } })
      : new Response("x", { status: 200, headers: { "content-type": "text/html" } })),
  });
  await call(resumir, env, "/api/resumir", OK_BODY);
  assert.ok(!calls.urls.some((u) => u.includes("site-qualquer.com")));
});

test("verificar: agência fora do ar vira 'indisponivel' (não 'ninguém checou') e não vai para o cache", async () => {
  const { env, calls } = setup({ llm: llmVerificar(), factStatus: 500 });
  const body = { texto: "Urnas eletrônicas aceitam voto duplo, diz mensagem" };
  const d = await (await call(verificar, env, "/api/verificar", body)).json();
  assert.equal(d.veredito, "indisponivel");
  assert.equal(d.diagnostico.agencias, "erro: 500");
  assert.equal(calls.fact, 2); // 5xx tem uma nova tentativa
  const before = calls.llm;
  await call(verificar, env, "/api/verificar", body);
  assert.ok(calls.llm > before); // não veio do cache
});

test("verificar: sem chave das agências também vira 'indisponivel'", async () => {
  const { env } = setup({ llm: llmVerificar() });
  delete env.FACTCHECK_API_KEY;
  const d = await (await call(verificar, env, "/api/verificar", { texto: "Urnas eletrônicas aceitam voto duplo, diz mensagem" })).json();
  assert.equal(d.veredito, "indisponivel");
});

test("verificar: se tudo falha (sem IA, sem agências, sem notícias, sem regra), 502 e a cota volta", async () => {
  const { env } = setup({ llm: llmDown, factStatus: 500 });
  const r = await call(verificar, env, "/api/verificar", { texto: "Texto qualquer sem nenhum assunto conhecido aqui" });
  assert.equal(r.status, 502);
  assert.deepEqual(await quota(env), [0]);
});

test("verificar: sem IA e sem agências, mas com regra com algo a dizer (gatilhos), responde 200", async () => {
  const { env } = setup({ llm: llmDown, factStatus: 500 });
  const r = await call(verificar, env, "/api/verificar", { texto: "URGENTE!!! Compartilhe com todos antes que apaguem esta mensagem importante" });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.resultado.rotulo, "Suspeito de ser boato");
  assert.equal(d.radar.motivos.at(-1), "Não conseguimos consultar as agências agora.");
});

test("verificar: link que não abre devolve a cota", async () => {
  const { env } = setup({ llm: llmVerificar(), page: () => new Response("nao", { status: 404 }) });
  const r = await call(verificar, env, "/api/verificar", { texto: "https://exemplo-noticia.com/materia-que-sumiu" });
  assert.equal(r.status, 400);
  assert.deepEqual(await quota(env), [0]);
});

test("verificar: link para endereço interno via redirecionamento é bloqueado", async () => {
  const { env, calls } = setup({
    llm: llmVerificar(),
    page: (url) => (url.includes("exemplo-noticia.com")
      ? new Response(null, { status: 302, headers: { location: "http://localhost:8080/admin" } })
      : new Response("x", { status: 200, headers: { "content-type": "text/html" } })),
  });
  const r = await call(verificar, env, "/api/verificar", { texto: "https://exemplo-noticia.com/materia" });
  assert.equal(r.status, 400);
  assert.ok(!calls.urls.some((u) => u.includes("localhost")));
});

test("verificar: nunca devolve link que não seja http(s), nem de agência nem de notícia", async () => {
  const { env } = setup({
    llm: llmVerificar(),
    factchecks: [{ text: "Urnas eletrônicas aceitam voto duplo", claimReview: [{ publisher: { name: "X" }, title: "Urnas voto duplo", url: "javascript:alert(1)", textualRating: "Falso" }] }],
    index: [
      { t: "Urnas eletrônicas aceitam voto duplo, diz boato", s: "Y", u: "javascript:alert(2)", p: "2026-10-04T10:00" },
      { t: "É falso que urnas eletrônicas aceitam voto duplo", s: "Z", u: "data:text/html,x", p: "2026-10-04T10:00", c: 1 },
    ],
  });
  const { d } = await post(env, "Urnas eletrônicas aceitam voto duplo, compartilhe");
  assert.deepEqual(d.checagens, []);
  assert.deepEqual(d.noticias, []);
  assert.equal(d.veredito, "sem_checagem");
});

test("verificar: índice de manchetes fora do ar não derruba nada", async () => {
  const { env } = setup({ llm: llmVerificar(exMerenda), index: null });
  const { r, d } = await post(env, MERENDA);
  assert.equal(r.status, 200);
  assert.equal(d.resultado.rotulo, "Provavelmente falso");
});

test("cache com falha no KV não derruba a função", async () => {
  const { env } = setup();
  const kv = env.RADAR_KV;
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => { if (k.startsWith("sum3:")) throw new Error("kv fora"); return origPut(k, v, o); };
  const r = await call(resumir, env, "/api/resumir", OK_BODY);
  assert.equal(r.status, 200);
});


// ---------- proteção contra uso fora do site ----------
test("proteção: sem Origin (curl, script) ou de outro site é recusado antes de qualquer custo", async () => {
  const { env, calls } = setup({ llm: llmVerificar({ afirmacao: "x", busca: "x", municipios: [], tipo: "afirmacao", sinais: [], conferir: [] }) });
  const semOrigin = new Request("https://site.test/api/verificar", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" }, body: JSON.stringify({ texto: "Urnas aceitam voto duplo, diz a mensagem" }) });
  assert.equal((await verificar({ request: semOrigin, env })).status, 403);
  const fora = await call(verificar, env, "/api/verificar", { texto: "Urnas aceitam voto duplo, diz a mensagem" }, { Origin: "https://evil.example" });
  assert.equal(fora.status, 403);
  const cross = await call(verificar, env, "/api/verificar", { texto: "Urnas aceitam voto duplo, diz a mensagem" }, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(cross.status, 403);
  assert.equal(calls.llm, 0);
  assert.equal(calls.fact, 0);
});

test("proteção: com Turnstile configurado, token vazio ou falso é recusado antes de chamar a IA", async () => {
  const { env, calls } = setup();
  env.TURNSTILE_SECRET = "segredo";
  const orig = globalThis.fetch;
  globalThis.fetch = async (i, init) => (String(i).includes("turnstile/v0/siteverify")
    ? new Response(JSON.stringify({ success: String(init.body).includes("response=token-valido-123") }), { status: 200 })
    : orig(i, init));
  for (const token of ["", "curto", undefined]) {
    const r = await call(resumir, env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?t=" + String(token), token });
    assert.equal(r.status, 403, String(token));
  }
  assert.equal(calls.llm, 0);
  const ok = await call(resumir, env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?ok", token: "token-valido-123" });
  assert.equal(ok.status, 200);
});

test("proteção: sem Turnstile (modo aberto) os limites são menores; com Turnstile, os normais", async () => {
  const aberto = setup();
  delete aberto.env.IP_DAILY_LIMIT;
  let n = 0;
  for (let i = 0; i < 8; i++) { const r = await call(resumir, aberto.env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?a=" + i }); if (r.status === 200) n++; }
  assert.equal(n, 5);
});

test("proteção: se o contador (KV) falhar, a IA NÃO é chamada (falha segura)", async () => {
  const { env, calls } = setup();
  env.RADAR_KV.get = async () => { throw new Error("kv fora"); };
  const r = await call(resumir, env, "/api/resumir", OK_BODY);
  assert.equal(r.status, 503);
  assert.equal(calls.llm, 0);
});

test("proteção: rajada em paralelo (corrida no KV) não passa do limite por IP", async () => {
  const { env } = setup();
  delete env.IP_DAILY_LIMIT;
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call(resumir, env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?p=" + i })));
  assert.equal(rs.filter((r) => r.status === 200).length, 5);
});

test("proteção: teto global do serviço bloqueia quando atingido", async () => {
  const { env } = setup();
  delete env.IP_DAILY_LIMIT;
  env.DAILY_CAP = "2"; env.CAP_STEP = "1";
  const st = [];
  for (let i = 0; i < 3; i++) st.push((await call(resumir, env, "/api/resumir", { ...OK_BODY, url: OK_BODY.url + "?c=" + i })).status);
  assert.deepEqual(st, [200, 200, 429]);
});

test("resumir: o prompt manda atribuir (\"segundo o veículo\") e a resposta traz o aviso de que não garante verdade", async () => {
  const { env, calls } = setup({ llm: () => resumoJson() });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  const sistema = calls.llmBodies[0].messages[0].content;
  assert.match(sistema, /ATRIBUA/);
  assert.match(sistema, /titulo_confere/);
  assert.match(d.nota, /não garante que seja verdade/);
});

test("resumir: conta os veículos do mesmo assunto (sem checagem, sem repetir veículo) e traz fonte oficial e checagem do índice", async () => {
  const indice = [
    ...INDICE_RESUMO,
    { t: "STF: Senado aprova reforma tributária e fixa transição de oito anos para estados", s: "STF", u: "https://portal.stf.jus.br/n/1", p: "2026-10-05T12:30", o: 1 },
    { t: "É falso que Senado aprovou reforma tributária com transição de oito anos para estados", s: "Agência Lupa", u: "https://lupa.uol.com.br/c/1", p: "2026-10-05T13:00", c: 1 },
  ];
  const { env } = setup({ index: indice, llm: () => resumoJson("O texto-base foi aprovado por 52 votos a 18.", "A Folha destaca a perda dos estados.") });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(d.veiculos, 3); // g1 (a própria) + Folha + Estadão; o STF e a Lupa não contam como veículo
  assert.equal(d.oficiais.length, 1);
  assert.equal(d.oficiais[0].fonte, "STF");
  assert.ok(d.checagens.length >= 1 && d.checagens[0].agencia === "Agência Lupa" && /^https:\/\//.test(d.checagens[0].url));
  // os dados do índice não vão para o cache: a segunda resposta (do cache) continua trazendo os dados atuais
  const d2 = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(d2.veiculos, 3);
});

test("resumir: 'titulo_confere' só aparece quando a IA leu a matéria e a frase é útil", async () => {
  const frase = "O título diz que a reforma foi sancionada, mas o texto informa que ela só foi aprovada no Senado.";
  const a = setup({ llm: () => JSON.stringify({ resumo: "Resumo de teste da matéria.", contexto: "", titulo_confere: frase }) });
  assert.equal((await (await call(resumir, a.env, "/api/resumir", OK_BODY)).json()).tituloConfere, frase);
  const b = setup({ llm: () => JSON.stringify({ resumo: "Resumo de teste da matéria.", contexto: "", titulo_confere: "" }) });
  assert.equal((await (await call(resumir, b.env, "/api/resumir", OK_BODY)).json()).tituloConfere, "");
  const curta = setup({ llm: () => JSON.stringify({ resumo: "Resumo de teste da matéria.", contexto: "", titulo_confere: "vazio" }) });
  assert.equal((await (await call(resumir, curta.env, "/api/resumir", OK_BODY)).json()).tituloConfere, "");
});

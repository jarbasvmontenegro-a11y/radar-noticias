// Testes das funções sob demanda, com IA, agências de checagem e páginas simuladas (sem rede).
import test from "node:test";
import assert from "node:assert/strict";

import { extractText, parseHttpUrl } from "../lib/api.js";
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
const ARTICLE_HTML = `<html><head><title>Titulo</title><meta property="og:description" content="Descri&ccedil;&atilde;o"></head>
<body><nav>menu</nav><article>${"<p>" + "Parágrafo longo com conteúdo da matéria sobre a votação no plenário. ".repeat(8) + "</p>".repeat(1)}
${"<p>" + "Outro parágrafo com mais informação relevante para o resumo do leitor. ".repeat(8) + "</p>"}</article><script>x()</script></body></html>`;

function setup({ llm, factchecks = [], pageHtml = ARTICLE_HTML, pageStatus = 200 } = {}) {
  const calls = { llm: 0, fact: 0, page: 0 };
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/chat/completions")) {
      calls.llm++;
      const body = JSON.parse(init.body);
      const content = llm ? llm(body, calls.llm) : "Resumo de teste da matéria.";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
    if (url.includes("factchecktools")) {
      calls.fact++;
      return new Response(JSON.stringify({ claims: factchecks }), { status: 200 });
    }
    if (url.includes("/data/search-index.json")) return new Response(JSON.stringify(SEARCH_INDEX), { status: 200 });
    if (url.includes("/data/allowed-hosts.json")) return new Response(JSON.stringify(["g1.globo.com", "folha.uol.com.br"]), { status: 200 });
    calls.page++;
    return new Response(pageHtml, { status: pageStatus, headers: { "content-type": "text/html" } });
  };
  const env = { RADAR_KV: new FakeKV(), LLM_API_KEY: "k", FACTCHECK_API_KEY: "g", IP_DAILY_LIMIT: "3" };
  return { env, calls };
}

const req = (path, body, headers = {}) =>
  new Request("https://site.test" + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4", ...headers }, body: JSON.stringify(body) });
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

test("resumir: gera resumo da matéria, guarda em cache e não chama a IA duas vezes", async () => {
  const { env, calls } = setup();
  const r1 = await call(resumir, env, "/api/resumir", OK_BODY);
  const d1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.equal(d1.base, "materia");
  assert.match(d1.resumo, /Resumo de teste/);
  const r2 = await call(resumir, env, "/api/resumir", OK_BODY);
  assert.equal(r2.status, 200);
  assert.equal(calls.llm, 1);
});

test("resumir: matéria curta (paywall) usa só título e descrição", async () => {
  const { env } = setup({ pageHtml: "<html><article><p>Assine para ler esta matéria completa agora mesmo.</p></article></html>" });
  const d = await (await call(resumir, env, "/api/resumir", OK_BODY)).json();
  assert.equal(d.base, "titulo");
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
const llmVerify = (body, n) =>
  n === 1
    ? JSON.stringify({ afirmacao: "Urnas eletrônicas aceitam voto duplo", busca: "urnas eletronicas voto duplo" })
    : JSON.stringify({ sinais: ["Pede para compartilhar antes que apaguem"], conferir: ["Procure a checagem do TSE"] });

const FACT = [{
  text: "Urnas eletrônicas aceitam voto duplo",
  claimReview: [{ publisher: { name: "Agência Lupa" }, title: "É falso que urnas aceitam voto duplo", url: "https://lupa.news/x", textualRating: "Falso", reviewDate: "2026-09-01" }],
}];

test("verificar: veredito 'falso' vem da agência, IA só traz sinais de alerta", async () => {
  const { env } = setup({ llm: llmVerify, factchecks: FACT });
  const r = await call(verificar, env, "/api/verificar", { texto: "URGENTE! Urnas eletrônicas aceitam voto duplo, compartilhe antes que apaguem" });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.veredito, "falso");
  assert.equal(d.checagens[0].agencia, "Agência Lupa");
  assert.ok(!("classe" in d.checagens[0]));
  assert.equal(d.sinais.length, 1);
});

test("verificar: sem checagem não vira 'verdadeiro' nem 'falso'; mostra notícias relacionadas", async () => {
  const { env } = setup({
    llm: (b, n) => n === 1 ? JSON.stringify({ afirmacao: "Câmara aprova reforma administrativa", busca: "camara aprova reforma administrativa" }) : JSON.stringify({ sinais: [], conferir: [] }),
    factchecks: [],
  });
  const d = await (await call(verificar, env, "/api/verificar", { texto: "A Câmara aprovou a reforma administrativa ontem à noite" })).json();
  assert.equal(d.veredito, "sem_checagem");
  assert.equal(d.noticias.length, 1);
  assert.equal(d.noticias[0].fonte, "g1");
});

test("verificar: ignora checagem de outro assunto (sem sobreposição de termos)", async () => {
  const { env } = setup({
    llm: llmVerify,
    factchecks: [{ text: "Vacina causa efeitos colaterais graves", claimReview: [{ publisher: { name: "X" }, title: "É falso que vacina cause", url: "https://x.test/1", textualRating: "Falso" }] }],
  });
  const d = await (await call(verificar, env, "/api/verificar", { texto: "Urnas eletrônicas aceitam voto duplo, diz mensagem" })).json();
  assert.equal(d.veredito, "sem_checagem");
});

test("verificar: recusa links internos e textos muito curtos", async () => {
  const { env, calls } = setup({ llm: llmVerify });
  assert.equal((await call(verificar, env, "/api/verificar", { texto: "http://localhost/admin" })).status, 400);
  assert.equal((await call(verificar, env, "/api/verificar", { texto: "http://169.254.169.254/latest/meta-data" })).status, 400);
  assert.equal((await call(verificar, env, "/api/verificar", { texto: "oi" })).status, 400);
  assert.equal(calls.llm, 0);
});

test("verificar: resultado repetido vem do cache", async () => {
  const { env, calls } = setup({ llm: llmVerify, factchecks: FACT });
  const body = { texto: "Urnas eletrônicas aceitam voto duplo, compartilhe" };
  await call(verificar, env, "/api/verificar", body);
  const n = calls.llm;
  await call(verificar, env, "/api/verificar", body);
  assert.equal(calls.llm, n);
});

test("verificar: se a IA cair, ainda devolve o resultado das agências", async () => {
  const { env } = setup({ factchecks: FACT, llm: () => { throw new Error("fora do ar"); } });
  const orig = globalThis.fetch;
  globalThis.fetch = async (i, init) => (String(i).includes("/chat/completions") ? new Response("erro", { status: 500 }) : orig(i, init));
  const d = await (await call(verificar, env, "/api/verificar", { texto: "Urnas eletrônicas aceitam voto duplo, diz o boato" })).json();
  assert.equal(d.veredito, "falso");
  assert.deepEqual(d.sinais, []);
});

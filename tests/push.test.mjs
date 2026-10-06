// Testes das notificações: criptografia (vetor da RFC 8291), seleção do que enviar, rotas e rodada de envio. Sem rede.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { criptografar, jwtVapid } from "../lib/webpush.js";
import { b64uToBytes, bytesToB64u, chaveDaInscricao, endpointValido, gerarVapid, inscricaoValida, prefsValidas, segredoConfere } from "../lib/push.js";
import { LIMIARES, montarCarga, pontuar, selecionar } from "../lib/pushselect.js";
import { rodar } from "../lib/pushrun.js";
import { onRequestPost as inscrever } from "../functions/api/inscrever.js";
import { onRequestGet as chave } from "../functions/api/push/chave.js";
import { onRequestGet as lista } from "../functions/api/push/lista.js";
import { onRequestPost as baixa } from "../functions/api/push/baixa.js";

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const v = this.m.get(k) ?? null; return t === "json" && v ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const todas = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const ini = cursor ? Number(cursor) : 0;
    const fatia = todas.slice(ini, ini + limit);
    const fim = ini + limit >= todas.length;
    return { keys: fatia.map((name) => ({ name })), list_complete: fim, cursor: fim ? undefined : String(ini + limit) };
  }
}

// ---------- criptografia ----------
test("criptografar bate com o vetor de teste da RFC 8291", () => {
  const par = crypto.createECDH("prime256v1");
  par.setPrivateKey(Buffer.from(b64uToBytes("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")));
  const corpo = criptografar("When I grow up, I want to be a watermelon", {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { salt: Buffer.from(b64uToBytes("DGv6ra1nlYgDCS1FRnbzlw")), par });
  assert.equal(bytesToB64u(corpo),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("jwtVapid gera um JWT ES256 que a chave pública verifica", async () => {
  const v = await gerarVapid();
  const jwt = jwtVapid(v.jwk, "https://fcm.googleapis.com/fcm/send/abc", "https://exemplo.org", 1_700_000_000_000);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
  const corpo = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(corpo.aud, "https://fcm.googleapis.com");
  assert.ok(corpo.exp - 1_700_000_000 <= 12 * 3600);
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: v.jwk.x, y: v.jwk.y }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.equal(b64uToBytes(v.pub).length, 65);
});

// ---------- validação ----------
function inscricaoFalsa(host = "fcm.googleapis.com", n = 1) {
  const par = crypto.createECDH("prime256v1"); par.generateKeys();
  return { endpoint: `https://${host}/fcm/send/${n}`, keys: { p256dh: bytesToB64u(par.getPublicKey()), auth: bytesToB64u(crypto.randomBytes(16)) } };
}

test("endpoint: só serviços de push conhecidos, https, sem credenciais nem porta", () => {
  assert.ok(endpointValido("https://fcm.googleapis.com/fcm/send/x"));
  assert.ok(endpointValido("https://updates.push.services.mozilla.com/wpush/v2/x"));
  assert.ok(endpointValido("https://web.push.apple.com/x"));
  assert.ok(endpointValido("https://wns2-par02p.notify.windows.com/x"));
  for (const ruim of ["http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x",
    "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://169.254.169.254/x", "javascript:alert(1)", null, 5]) {
    assert.equal(endpointValido(ruim), null, String(ruim));
  }
});

test("inscricaoValida confere o tamanho das chaves", () => {
  assert.ok(inscricaoValida(inscricaoFalsa()));
  const s = inscricaoFalsa(); s.keys.auth = "curta";
  assert.equal(inscricaoValida(s), null);
  const t = inscricaoFalsa(); t.keys.p256dh = bytesToB64u(crypto.randomBytes(65)); // não começa com 0x04
  assert.equal(inscricaoValida(t), null);
});

test("prefsValidas limpa lixo, limita tamanhos e exige ao menos uma escolha", () => {
  assert.equal(prefsValidas({}), null);
  assert.equal(prefsValidas({ temas: ["<script>"], ufs: ["XX"] }), null);
  const p = prefsValidas({ geral: true, temas: ["justica", "justica", "a b"], ufs: ["CE", "ZZ"], nivel: "x", max: 99 });
  assert.deepEqual(p, { geral: true, temas: ["justica"], ufs: ["CE"], pessoas: [], checagens: false, nivel: "top", max: 5 });
  assert.deepEqual(prefsValidas({ pessoas: ["lula", "<x>", "lula"] }).pessoas, ["lula"]);
  assert.equal(prefsValidas({ temas: Array.from({ length: 50 }, (_, i) => `t${i}`) }).temas.length, 12);
});

test("segredoConfere exige segredo longo e igual", () => {
  const seg = "a".repeat(64);
  const req = (t) => new Request("https://x.org/", { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  assert.ok(segredoConfere({ PUSH_SECRET: seg }, req(seg)));
  assert.ok(!segredoConfere({ PUSH_SECRET: seg }, req("b".repeat(64))));
  assert.ok(!segredoConfere({ PUSH_SECRET: seg }, req()));
  assert.ok(!segredoConfere({ PUSH_SECRET: "curto" }, req("curto")));
  assert.ok(!segredoConfere({}, req(seg)));
});

// ---------- seleção ----------
const D = (id, n, extra = {}) => ({ id, t: `Assunto ${id}`, u: `https://g1.globo.com/${id}`, f: "g1", n, temas: [], ufs: [], k: "assunto", p: 1000 + n, ...extra });
const meioDia = new Date("2026-10-06T15:00:00Z"); // 12h em Brasília
const prefs = (o = {}) => ({ geral: false, temas: [], ufs: [], pessoas: [], checagens: false, nivel: "top", max: 3, ...o });

test("pontuar respeita os limiares de cada nível, tema e estado", () => {
  assert.equal(pontuar(D("a", 6), prefs({ geral: true })), 0);
  assert.ok(pontuar(D("a", 7), prefs({ geral: true })) > 0);
  assert.ok(pontuar(D("a", 5), prefs({ geral: true, nivel: "importantes" })) > 0);
  assert.equal(pontuar(D("a", 4, { temas: ["justica"] }), prefs({ temas: ["justica"] })), 0);
  assert.ok(pontuar(D("a", 5, { temas: ["justica"] }), prefs({ temas: ["justica"] })) > 0);
  assert.equal(pontuar(D("a", 9, { temas: ["economia"] }), prefs({ temas: ["justica"] })), 0); // tema que a pessoa não escolheu
  assert.ok(pontuar(D("a", 5, { pessoas: ["lula"] }), prefs({ pessoas: ["lula"] })) > 0);
  assert.equal(pontuar(D("a", 4, { pessoas: ["lula"] }), prefs({ pessoas: ["lula"] })), 0);
  assert.equal(pontuar(D("a", 9, { pessoas: ["moraes"] }), prefs({ pessoas: ["lula"] })), 0);
  assert.ok(pontuar(D("a", 3, { ufs: ["CE"] }), prefs({ ufs: ["CE"] })) > 0);
  assert.equal(pontuar(D("a", 2, { ufs: ["CE"] }), prefs({ ufs: ["CE"] })), 0);
  assert.equal(pontuar(D("a", 9, { ufs: ["SP"] }), prefs({ ufs: ["CE"] })), 0);
  assert.equal(pontuar(D("c", 1, { k: "checagem" }), prefs({ geral: true })), 0);
  assert.ok(pontuar(D("c", 1, { k: "checagem" }), prefs({ checagens: true })) > 0);
  assert.ok(LIMIARES.importantes.geral < LIMIARES.top.geral);
});

test("selecionar: primeira vez só marca o que já existe, sem enviar", () => {
  const r = selecionar([D("a", 9), D("b", 8)], { p: prefs({ geral: true }) }, meioDia);
  assert.equal(r.enviar.length, 0);
  assert.deepEqual(r.estado.s, ["a", "b"]);
});

test("selecionar: manda os maiores, no máximo 2 por rodada, sem repetir", () => {
  const dest = [D("a", 9), D("b", 12), D("c", 8), D("d", 3)];
  const reg = { p: prefs({ geral: true }), s: [], d: "2026-10-06", n: 0 };
  const r = selecionar(dest, reg, meioDia);
  assert.deepEqual(r.enviar.map((d) => d.id), ["b", "a"]);
  assert.equal(r.estado.n, 2);
  const r2 = selecionar(dest, { ...reg, ...r.estado }, meioDia);
  assert.deepEqual(r2.enviar.map((d) => d.id), ["c"]); // limite diário (3) alcança no terceiro
  assert.equal(r2.estado.n, 3);
  const r3 = selecionar([...dest, D("e", 10)], { ...reg, ...r2.estado }, meioDia);
  assert.equal(r3.enviar.length, 0);
});

test("selecionar: o limite diário zera no dia seguinte", () => {
  const reg = { p: prefs({ geral: true, max: 1 }), s: ["x"], d: "2026-10-05", n: 1 };
  assert.equal(selecionar([D("a", 9)], reg, meioDia).enviar.length, 1);
});

test("selecionar: sem aviso de madrugada", () => {
  const reg = { p: prefs({ geral: true }), s: [], d: "2026-10-06", n: 0 };
  assert.equal(selecionar([D("a", 9)], reg, new Date("2026-10-06T04:00:00Z")).enviar.length, 0); // 01h em Brasília
  assert.equal(selecionar([D("a", 9)], reg, new Date("2026-10-07T01:30:00Z")).enviar.length, 0); // 22h30
  assert.equal(selecionar([D("a", 9)], reg, new Date("2026-10-06T10:30:00Z")).enviar.length, 1); // 07h30
});

test("selecionar: não repete a mesma matéria com ids diferentes", () => {
  const reg = { p: prefs({ geral: true }), s: [], d: "2026-10-06", n: 0 };
  const a = D("a", 9), b = D("b", 8, { u: a.u });
  assert.equal(selecionar([a, b], reg, meioDia).enviar.length, 1);
});

test("montarCarga corta textos longos", () => {
  const c = montarCarga(D("a", 9, { t: "x".repeat(500) }));
  assert.ok(c.b.length <= 180 && c.t.length <= 60);
  assert.equal(montarCarga(D("c", 1, { k: "checagem" })).t, "Checagem: pode ser falso");
});

// ---------- rotas ----------
const SEG = "s".repeat(64);
const ORIGEM = "https://radar.exemplo.org";
function ctx(kv, url, { method = "GET", body, headers = {}, env = {} } = {}) {
  return {
    env: { RADAR_KV: kv, PUSH_SECRET: SEG, ...env },
    request: new Request(ORIGEM + url, { method, headers: { Origin: ORIGEM, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }),
  };
}

test("inscrever: salva, atualiza mantendo histórico e remove", async () => {
  const kv = new FakeKV();
  const sub = inscricaoFalsa();
  let r = await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub, prefs: { geral: true } } }));
  assert.equal(r.status, 200);
  const k = await chaveDaInscricao(sub.endpoint);
  const reg = await kv.get(k, "json");
  assert.equal(reg.e, sub.endpoint);
  assert.equal(reg.p.geral, true);
  reg.s = ["a"]; reg.d = "2026-10-06"; reg.n = 2; kv.m.set(k, JSON.stringify(reg));
  r = await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub, prefs: { temas: ["justica"] } } }));
  assert.equal(r.status, 200);
  const depois = await kv.get(k, "json");
  assert.deepEqual(depois.s, ["a"]);
  assert.deepEqual(depois.p.temas, ["justica"]);
  r = await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "remover", sub } }));
  assert.equal(r.status, 200);
  assert.equal(await kv.get(k), null);
});

test("inscrever: recusa origem errada, endpoint estranho e preferências vazias", async () => {
  const kv = new FakeKV();
  const sub = inscricaoFalsa();
  const ruim = ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub, prefs: { geral: true } }, headers: { Origin: "https://evil.org" } });
  assert.equal((await inscrever(ruim)).status, 403);
  assert.equal((await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub: inscricaoFalsa("evil.example.com"), prefs: { geral: true } } }))).status, 400);
  assert.equal((await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub, prefs: {} } }))).status, 400);
  assert.equal(kv.m.size <= 2, true); // nada de inscrição gravada (no máximo contadores)
  assert.ok(![...kv.m.keys()].some((k) => k.startsWith("push:")));
});

test("inscrever funciona sem a chave da IA configurada", async () => {
  const kv = new FakeKV();
  const r = await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub: inscricaoFalsa(), prefs: { geral: true } }, env: { LLM_API_KEY: undefined } }));
  assert.equal(r.status, 200);
});

test("chave pública é criada uma vez e a privada nunca sai por ela", async () => {
  const kv = new FakeKV();
  const a = await (await chave(ctx(kv, "/api/push/chave"))).json();
  const b = await (await chave(ctx(kv, "/api/push/chave"))).json();
  assert.equal(a.pub, b.pub);
  assert.deepEqual(Object.keys(a), ["pub"]);
});

test("lista e baixa exigem o segredo", async () => {
  const kv = new FakeKV();
  assert.equal((await lista(ctx(kv, "/api/push/lista"))).status, 401);
  assert.equal((await lista(ctx(kv, "/api/push/lista", { headers: { Authorization: "Bearer errado" } }))).status, 401);
  assert.equal((await baixa(ctx(kv, "/api/push/baixa", { method: "POST", body: { remover: [] } }))).status, 401);
  assert.equal((await lista(ctx(kv, "/api/push/lista", { headers: { Authorization: `Bearer ${SEG}` } }))).status, 200);
});

test("lista pagina em 40 e baixa atualiza e remove", async () => {
  const kv = new FakeKV();
  const auth = { Authorization: `Bearer ${SEG}` };
  for (let i = 0; i < 45; i++) {
    const sub = inscricaoFalsa("fcm.googleapis.com", i);
    await inscrever(ctx(kv, "/api/inscrever", { method: "POST", body: { acao: "salvar", sub, prefs: { geral: true } }, env: { IP_DAILY_LIMIT: "1000", DAILY_CAP: "1000" } }));
  }
  const p1 = await (await lista(ctx(kv, "/api/push/lista", { headers: auth }))).json();
  assert.equal(p1.subs.length, 40);
  assert.ok(p1.cursor && p1.vapid.pub && p1.vapid.jwk.d);
  const p2 = await (await lista(ctx(kv, `/api/push/lista?cursor=${p1.cursor}`, { headers: auth }))).json();
  assert.equal(p2.subs.length, 5);
  assert.equal(p2.cursor, null);
  assert.equal(p2.vapid, undefined);
  const [a, b] = p1.subs;
  const r = await baixa(ctx(kv, "/api/push/baixa", { method: "POST", headers: auth, body: { atualizar: [{ k: a.k, s: ["x", "y"], d: "2026-10-06", n: 2 }, { k: "push:nao-existe" }], remover: [b.k, "../../vapid:v1"] } }));
  const j = await r.json();
  assert.equal(j.atualizados, 1);
  assert.equal(j.removidos, 1);
  assert.deepEqual((await kv.get(a.k, "json")).s, ["x", "y"]);
  assert.equal(await kv.get(b.k), null);
  assert.ok(await kv.get("vapid:v1")); // chave VAPID nunca é apagada por esta rota
});

// ---------- rodada de envio ----------
test("rodar: envia só o que cada pessoa escolheu, marca como enviado e remove inscrição vencida", async () => {
  const kv = new FakeKV();
  const auth = { Authorization: `Bearer ${SEG}` };
  const envs = { IP_DAILY_LIMIT: "1000", DAILY_CAP: "1000" };
  const subs = { geral: inscricaoFalsa("fcm.googleapis.com", 1), ce: inscricaoFalsa("fcm.googleapis.com", 2), morta: inscricaoFalsa("fcm.googleapis.com", 3) };
  await inscrever(ctx(kv, "/api/inscrever", { method: "POST", env: envs, body: { acao: "salvar", sub: subs.geral, prefs: { geral: true } } }));
  await inscrever(ctx(kv, "/api/inscrever", { method: "POST", env: envs, body: { acao: "salvar", sub: subs.ce, prefs: { ufs: ["CE"] } } }));
  await inscrever(ctx(kv, "/api/inscrever", { method: "POST", env: envs, body: { acao: "salvar", sub: subs.morta, prefs: { geral: true } } }));
  const dest = [D("a", 9), D("b", 4, { ufs: ["CE"] })];

  // roteia o "fetch" da rodada direto para as funções
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const c = ctx(kv, u.pathname + u.search, { method: init.method || "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = u.pathname.endsWith("lista") ? lista : baixa;
    return handler(c);
  };
  const enviados = [];
  const enviarFn = async (sub, carga) => { enviados.push([sub.endpoint, carga.id]); return sub.endpoint === subs.morta.endpoint ? 410 : 201; };

  // 1ª rodada: pessoas novas só marcam o que existe
  let s = await rodar({ base: ORIGEM, segredo: SEG, destaques: dest, agora: meioDia, fetchFn, enviarFn, log: () => {} });
  assert.equal(s.enviadas, 0);
  assert.equal(s.novos, 3);
  assert.equal(enviados.length, 0);

  // 2ª rodada: surge um assunto novo grande e um do Ceará
  const dest2 = [...dest, D("c", 10), D("d", 3, { ufs: ["CE"] })];
  s = await rodar({ base: ORIGEM, segredo: SEG, destaques: dest2, agora: meioDia, fetchFn, enviarFn, log: () => {} });
  assert.deepEqual(enviados.filter(([e]) => e === subs.geral.endpoint).map(([, id]) => id), ["c"]);
  assert.deepEqual(enviados.filter(([e]) => e === subs.ce.endpoint).map(([, id]) => id), ["d"]);
  assert.equal(s.removidos, 1);
  assert.equal(await kv.get(await chaveDaInscricao(subs.morta.endpoint)), null);
  const regGeral = await kv.get(await chaveDaInscricao(subs.geral.endpoint), "json");
  assert.ok(regGeral.s.includes("c") && regGeral.n === 1);

  // 3ª rodada igual: ninguém recebe de novo
  const antes = enviados.length;
  await rodar({ base: ORIGEM, segredo: SEG, destaques: dest2, agora: meioDia, fetchFn, enviarFn, log: () => {} });
  assert.equal(enviados.length, antes);
});

test("rodar avisa claramente quando o segredo não confere", async () => {
  const kv = new FakeKV();
  const fetchFn = async (url, init) => lista(ctx(kv, new URL(url).pathname, { headers: init.headers }));
  await assert.rejects(rodar({ base: ORIGEM, segredo: "x".repeat(64), destaques: [], fetchFn, log: () => {} }), /PUSH_SECRET/);
});

// ---------- agrupamento por IA (rota protegida) ----------
import { onRequestPost as agrupar } from "../functions/api/ia/agrupar.js";

test("agrupar: exige segredo, filtra números inventados e assuntos pequenos", async () => {
  const kv = new FakeKV();
  const itens = Array.from({ length: 8 }, (_, i) => `${i + 1}|Veículo ${i}|Manchete ${i}`);
  const mk = (headers) => ({ env: { RADAR_KV: kv, PUSH_SECRET: SEG, LLM_API_KEY: "k" }, request: new Request(ORIGEM + "/api/ia/agrupar", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ itens }) }) });
  assert.equal((await agrupar(mk({}))).status, 401);
  assert.equal((await agrupar(mk({ Authorization: "Bearer errado" }))).status, 401);

  const real = globalThis.fetch;
  let corpo;
  globalThis.fetch = async (url, init) => {
    corpo = JSON.parse(init.body);
    const content = JSON.stringify({ assuntos: [
      { titulo: "Assunto bom", resumo: "Fato.", ids: [1, 2, 3, 99] },
      { titulo: "Repete número", resumo: "x", ids: [3, 4] },            // 3 já usado: sobra 1 -> descartado
      { titulo: "Pequeno", resumo: "x", ids: [5] },
      { titulo: "", resumo: "x", ids: [6, 7] }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const r = await agrupar(mk({ Authorization: `Bearer ${SEG}` }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.assuntos.length, 1);
    assert.deepEqual(j.assuntos[0].ids, [1, 2, 3]);
    assert.match(corpo.messages[0].content, /NÃO CONFIÁVEIS/);
    assert.match(corpo.messages[1].content, /1\|Veículo 0\|Manchete 0/);
  } finally { globalThis.fetch = real; }
});

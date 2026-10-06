import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({ encodeURIComponent });
vm.runInContext(readFileSync(new URL("../templates/static/share.js", import.meta.url), "utf8"), ctx);
const R = ctx.RadarShare;
const O = { siteUrl: "https://exemplo.org/", siteName: "Radar" };
const chk = { agencia: "Lupa", avaliacao: "Falso", titulo: "t", url: "https://piaui.folha.uol.com.br/lupa/x" };

test("falso: mensagem de desmentido cita agência, avaliação e link", () => {
  const m = R.verdictMessage({ veredito: "falso", afirmacao: "Vão cobrar imposto no Pix", checagens: [chk] }, O);
  assert.match(m, /FALSO/);
  assert.match(m, /Vão cobrar imposto no Pix/);
  assert.match(m, /Lupa avaliou como: _Falso_/);
  assert.match(m, /https:\/\/piaui\.folha\.uol\.com\.br\/lupa\/x/);
  assert.match(m, /https:\/\/exemplo\.org\/verificador\//);
  assert.doesNotMatch(m, /\/\/verificador/);
});

test("enganoso usa palavra de contexto, não 'falso'", () => {
  const m = R.verdictMessage({ veredito: "enganoso", afirmacao: "x", checagens: [chk] }, O);
  assert.match(m, /ENGANOSO/);
  assert.doesNotMatch(m, /FALSO/);
});

test("sem checagem NUNCA afirma que é falso nem cita agência", () => {
  for (const v of ["sem_checagem", "indisponivel", undefined, "qualquer"]) {
    const m = R.verdictMessage({ veredito: v, afirmacao: "algo", checagens: [chk] }, O);
    assert.doesNotMatch(m, /FALSO|ENGANOSO|CONFIRMADO/, String(v));
    assert.doesNotMatch(m, /Lupa/, String(v));
    assert.match(m, /antes de repassar/);
  }
});

test("link que não é http(s) não entra na mensagem", () => {
  const bad = { agencia: "X", avaliacao: "Falso", url: "javascript:alert(1)" };
  const m = R.verdictMessage({ veredito: "falso", afirmacao: "a", checagens: [bad] }, O);
  assert.doesNotMatch(m, /javascript:/);
});

test("texto longo e caracteres de controle são tratados", () => {
  const m = R.verdictMessage({ veredito: "falso", afirmacao: "a‮b\n".repeat(500), checagens: [chk, chk, chk] }, O);
  assert.ok(m.length <= 1200);
  assert.doesNotMatch(m, /‮/);
});

test("notícia: título, descrição curta, fonte e link por último", () => {
  const n = R.newsMessage({ title: "Título", source: "G1", url: "https://g1.globo.com/a", kind: "noticia",
    desc: "Partido decidiu não apoiar candidatos no 1º turno. Leia no Poder360." }, O);
  assert.match(n, /^\*Título\*/);
  assert.match(n, /Partido decidiu não apoiar candidatos no 1º turno\./);
  assert.doesNotMatch(n, /Leia no Poder360/);
  assert.ok(n.endsWith("https://g1.globo.com/a"), "o link deve ser a última linha");
  assert.doesNotMatch(n, /falso/i);
  assert.doesNotMatch(n, /[\u{1F300}-\u{1FAFF}]/u, "sem emojis de 4 bytes (quebram em alguns WhatsApp Web)");
});

test("checagem de agência é apresentada como checagem", () => {
  const c = R.newsMessage({ title: "É falso que…", source: "Lupa", url: "https://lupa.news/a", kind: "checagem", desc: "" }, O);
  assert.match(c, /Checagem publicada por Lupa/);
  assert.ok(c.endsWith("https://lupa.news/a"));
});

test("descrição longa é cortada em fim de frase", () => {
  const d = "Primeira frase completa e bem comprida para passar do mínimo de oitenta caracteres sem problema nenhum. " + "Segunda frase ".repeat(30);
  const s = R.shortDesc(d);
  assert.ok(s.length <= 221);
  assert.ok(s.endsWith("nenhum."));
});

test("mensagens do verificador não usam emojis de 4 bytes", () => {
  for (const v of ["falso", "enganoso", "verdadeiro", "misto", "sem_checagem"]) {
    const m = R.verdictMessage({ veredito: v, afirmacao: "x", checagens: [chk] }, O);
    assert.doesNotMatch(m, /[\u{1F300}-\u{1FAFF}]/u, v);
  }
});

test("waLink codifica quebras de linha e símbolos", () => {
  const l = R.waLink("a&b\nc");
  assert.equal(l, "https://wa.me/?text=a%26b%0Ac");
});

// ---- avaliação própria do Radar (sem agência) ----
const radar = (nivel, extra = {}) => ({
  veredito: "sem_checagem", afirmacao: "O prefeito de Serra do Cajueiro Seco desviou R$ 48 milhões",
  resultado: { rotulo: "x", tom: "falso", origem: "radar", confianca: "alta", resumo: "r" },
  radar: { nivel, motivos: ["Não existe município chamado “Serra do Cajueiro Seco” na lista oficial do IBGE.", "A mensagem diz que a mídia abafou o caso.", "Nenhuma agência de checagem analisou este boato ainda."] },
  checagens: [chk], noticias: [], ...extra,
});

test("radar: 'provavelmente falso' diz provavelmente, cita motivos e avisa que não é checagem de agência", () => {
  const m = R.verdictMessage(radar("provavelmente_falso"), O);
  assert.match(m, /provavelmente é FALSO/);
  assert.match(m, /IBGE/);
  assert.match(m, /não é checagem de agência/);
  assert.doesNotMatch(m, /Nenhuma agência de checagem analisou/); // "ninguém checou" não é motivo de falsidade
  assert.doesNotMatch(m, /Lupa/);
  assert.match(m, /https:\/\/exemplo\.org\/verificador\//);
});

test("radar: suspeito e não confirmado pedem calma e nunca dizem 'falso'", () => {
  for (const n of ["suspeito", "nao_confirmado"]) {
    const m = R.verdictMessage(radar(n), O);
    assert.match(m, /antes de repassar/);
    assert.doesNotMatch(m, /FALSO|CONFIRMADO/);
  }
});

test("radar: 'provavelmente verdadeiro' lista até 2 matérias que confirmam, só links http(s)", () => {
  const noticias = [
    { titulo: "a", fonte: "g1", url: "https://g1.globo.com/a", relacao: "confirma" },
    { titulo: "b", fonte: "Folha", url: "javascript:alert(1)", relacao: "confirma" },
    { titulo: "c", fonte: "Poder360", url: "https://poder360.com.br/c", relacao: "relacionada" },
    { titulo: "d", fonte: "Estadão", url: "https://estadao.com.br/d", relacao: "confirma" },
  ];
  const m = R.verdictMessage(radar("provavelmente_verdadeiro", { noticias }), O);
  assert.match(m, /parece verdadeiro/);
  assert.match(m, /g1globo|g1\.globo\.com\/a/);
  assert.match(m, /estadao\.com\.br\/d/);
  assert.doesNotMatch(m, /javascript:|poder360/);
});

test("quando a agência concluiu, a mensagem continua sendo a de desmentido da agência", () => {
  const d = { veredito: "falso", afirmacao: "x", checagens: [chk], resultado: { origem: "agencia", rotulo: "É falso", tom: "falso" } };
  assert.match(R.verdictMessage(d, O), /Lupa avaliou como: _Falso_/);
});

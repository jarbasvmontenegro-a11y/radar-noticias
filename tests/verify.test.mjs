// Testes das regras puras (sem rede): classificação das agências, municípios, sinais de corrente, decisão do Radar,
// cobertura da imprensa e apoio ao resumo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FONTES_ALTA, LIMIAR_SEM_COBERTURA, LIMIAR_SUSPEITO, MIN_FONTES, MIN_TERMOS, PONTOS_MAX,
  decidir, fontesDistintas, listaDeNomes, resultadoDaAgencia, sinaisDeCorrente,
} from "../lib/radar.js";
import {
  aparece, buildMunicipalityIndex, checkMention, checkMunicipality, classifyRating, classifyTitle, ehNaoMunicipal,
  findMunicipalityMentions, normalizeName, temContextoMunicipal, temNegacao, titleVerdict, tokens,
} from "../lib/verify.js";
import { fold, maisRecente, sharedCount, sourceKey, squash, topicTerms } from "../lib/text.js";
import { NewsIndex } from "../lib/data.js";
import { coberturaDoIndice, consultaGdelt, juntarCandidatas, regraDeCobertura } from "../lib/coverage.js";
import { checagensDoIndice, mesclarChecagens, publicas } from "../lib/factcheck.js";
import { AVISO_CURTO, citaVeiculo, descricoesUteis, outrosVeiculos, repeteTitulo } from "../lib/summary.js";

// a lista oficial que o build publica em /data/municipios.json (5.571 itens)
const LISTA = JSON.parse(fs.readFileSync(new URL("../config/municipios.json", import.meta.url), "utf8"));

// ---------- texto ----------
test("fold: minúsculas e sem acento; símbolos que não são letras latinas viram espaço", () => {
  assert.equal(fold("Câmara Não Açúcar ÇÃO"), "camara nao acucar cao");
  assert.equal(fold("á"), "a"); // acento combinante (texto decomposto)
  assert.equal(fold("ok 😀 ok"), "ok    ok");
  assert.equal(fold("só ascii"), "so ascii");
});

test("tokens: >= 4 letras (ou sigla útil), sem palavras vazias, sem repetição, na ordem", () => {
  assert.deepEqual(tokens("Governo vai cobrar imposto sobre o Pix, o imposto do STF"), ["governo", "cobrar", "imposto", "pix", "stf"]);
  assert.deepEqual(tokens("Câmara aprova a PEC da reforma"), ["camara", "aprova", "reforma"]);
  assert.deepEqual(tokens(""), []);
});

test("topicTerms tira os termos genéricos do noticiário; sharedCount conta termos em comum", () => {
  assert.deepEqual(topicTerms("Governo federal anuncia novo imposto sobre o Pix"), ["imposto", "pix"]);
  assert.equal(sharedCount(["pix", "imposto", "cobrar"], ["imposto", "pix", "nega"]), 2);
});

test("sourceKey: domínio registrável, para contar veículos DISTINTOS", () => {
  assert.equal(sourceKey("https://g1.globo.com/a"), "globo.com");
  assert.equal(sourceKey("https://oglobo.globo.com/b"), "globo.com");
  assert.equal(sourceKey("https://www1.folha.uol.com.br/x"), "uol.com.br");
  assert.equal(sourceKey("https://www.cartacapital.com.br/"), "cartacapital.com.br");
  assert.equal(sourceKey("https://www.bbc.com/portuguese"), "bbc.com");
  assert.equal(sourceKey("nao é url"), "");
});

test("squash e maisRecente", () => {
  assert.equal(squash("  a​  b \n c "), "a b c");
  const l = [{ p: "2026-10-01T10:00" }, { p: "2026-10-03T10:00" }, { p: "2026-10-03T10:00" }].sort(maisRecente);
  assert.deepEqual(l.map((x) => x.p), ["2026-10-03T10:00", "2026-10-03T10:00", "2026-10-01T10:00"]);
  assert.equal(maisRecente({ p: "a" }, { p: "a" }), 0);
});

// ---------- classificação das agências ----------
test("classifyRating: rótulos curtos e vereditos explícitos", () => {
  const casos = {
    "Falso": "falso", "Falsa": "falso", "Não é verdade": "falso", "#FAKE": "falso", "Fake": "falso", "Boato": "falso", "Golpe": "falso",
    "Enganoso": "enganoso", "Distorcido": "enganoso", "Descontextualizado": "enganoso", "Sem contexto": "enganoso", "Impreciso": "enganoso", "Exagerado": "enganoso",
    "Verdadeiro, mas": "misto", "Parcialmente verdadeiro": "misto", "Parcialmente falso": "misto", "Não é bem assim": "misto", "Misto": "misto",
    "Verdadeiro": "verdadeiro", "Verdade": "verdadeiro", "Fato": "verdadeiro", "#FATO": "verdadeiro", "Real": "verdadeiro",
    "Em análise": "desconhecido", "Não verificado": "desconhecido", "": "desconhecido", "Fato ou Fake": "desconhecido",
  };
  for (const [texto, esperado] of Object.entries(casos)) assert.equal(classifyRating(texto), esperado, texto);
  assert.equal(classifyRating(undefined), "desconhecido");
});

test("classifyTitle: reconhece 'É falso que', '#FAKE', 'Não é verdade', 'É verdade que', '#FATO', 'enganoso'; ignora o nome da série", () => {
  const casos = [
    ["É falso que militares avisaram ao STF que não vão intervir em caso de crise", "falso"],
    ["É falsa pesquisa de boca de urna que mostra Flávio eleito em 1º turno", "falso"],
    ["Não é verdade que policiais encontraram urna fraudada no DF", "falso"],
    ["Fato ou Fake: governo vai taxar o Pix? É #FAKE", "falso"],
    ["É #FAKE que o imposto do Pix começa em novembro", "falso"],
    ["FALSO: Lula não fez isso", "falso"],
    ["É verdadeiro o vídeo de menino segurando arma em comemoração de bolsonaristas", "verdadeiro"],
    ["É verdade que o governo vai aumentar o salário mínimo", "verdadeiro"],
    ["É #FATO que Lula disse isso em entrevista", "verdadeiro"],
    ["#FATO: dados do TSE confirmam o número", "verdadeiro"],
    ["Posts enganosos sugerem travamento de tecla ‘confirma’ após voto", "enganoso"],
    ["Vídeo de Lula no Paraguai é usado fora de contexto para sugerir constrangimento", "enganoso"],
    ["Vídeo de carteiro entregando propaganda omite contexto sobre Mala Direta", "enganoso"],
    // sem veredito explícito: palavras soltas num título são assunto, não conclusão
    ["Fato ou Fake: vídeo mostra ministro em reunião", "desconhecido"],
    ["Verdade ou mentira: vacina causa efeitos graves?", "desconhecido"],
    ["Fake news sobre urnas é tema de audiência no Senado", "desconhecido"],
    ["Zema recorre a fake contra Lula para justificar descumprimento", "desconhecido"],
    ["Teoria conspiratória sobre ‘golpe da esquerda’ ganha força", "desconhecido"],
    ["IA vai de documento falso a fazendas de fakes", "desconhecido"],
    ["Lula não gastou R$ 7 bilhões em viagens pessoais", "desconhecido"],
  ];
  for (const [titulo, esperado] of casos) assert.equal(classifyTitle(titulo), esperado, titulo);
});

test("titleVerdict: diz se a afirmação checada tem negação (para não inverter o sentido)", () => {
  assert.deepEqual(titleVerdict("É falso que o governo vai taxar o Pix"), { classe: "falso", negado: false });
  assert.deepEqual(titleVerdict("É falso que militares avisaram que não vão intervir"), { classe: "falso", negado: true });
  assert.deepEqual(titleVerdict("Não é verdade que policiais encontraram urna fraudada"), { classe: "falso", negado: false }); // o "não" é do veredito
  assert.deepEqual(titleVerdict("É #FATO que o governo não vai taxar o Pix"), { classe: "verdadeiro", negado: true });
  assert.equal(temNegacao("O governo NÃO vai cobrar"), true);
  assert.equal(temNegacao("O governo vai cobrar"), false);
});

// ---------- municípios ----------
test("normalizeName: minúsculas, sem acento nem pontuação", () => {
  assert.equal(normalizeName("Santa Bárbara d'Oeste"), "santa barbara d oeste");
  assert.equal(normalizeName("Santa Bárbara D’Oeste"), "santa barbara d oeste");
  assert.equal(normalizeName("Mogi-Guaçu"), "mogi guacu");
  assert.equal(normalizeName("  São   Paulo "), "sao paulo");
});

test("checkMunicipality: existe, erro de grafia (parecido) e inexistente", () => {
  const ix = buildMunicipalityIndex(LISTA);
  assert.equal(ix.itens.length, 5571);
  assert.ok(ix.norm.every((x) => x === undefined), "nada deve ser normalizado antes da primeira consulta");
  assert.deepEqual(checkMunicipality("Fortaleza", ix), { existe: true, uf: "CE" });
  assert.deepEqual(checkMunicipality("FORTALEZA", ix), { existe: true, uf: "CE" });
  assert.deepEqual(checkMunicipality("Sao Paulo", ix), { existe: true, uf: "SP" });
  assert.deepEqual(checkMunicipality("Santa Bárbara d'Oeste", ix), { existe: true, uf: "SP" });
  assert.deepEqual(checkMunicipality("Alta Floresta D'Oeste", ix), { existe: true, uf: "RO" });
  assert.deepEqual(checkMunicipality("Mogi Guacu", ix), { existe: true, uf: "SP" });
  assert.deepEqual(checkMunicipality("Brasília", ix), { existe: true, uf: "DF" });
  assert.deepEqual(checkMunicipality("Fortaleza/CE", ix), { existe: true, uf: "CE" }); // sigla do estado não faz parte do nome
  assert.deepEqual(checkMunicipality("Fortaleza - CE", ix), { existe: true, uf: "CE" });
  // erro de grafia: distância 1 (até 11 letras) ou 2 (12+ letras); inversão de letras vizinhas conta como 1
  assert.deepEqual(checkMunicipality("Fortalesa", ix), { existe: false, parecido: "Fortaleza", uf: "CE" });
  assert.deepEqual(checkMunicipality("Fortlaeza", ix), { existe: false, parecido: "Fortaleza", uf: "CE" });
  assert.equal(checkMunicipality("Pindamonhagaba", ix).parecido, "Pindamonhangaba"); // 14 letras, 1 letra a menos
  assert.equal(checkMunicipality("Pindamonhangabba", ix).parecido, "Pindamonhangaba");
  assert.equal(checkMunicipality("Embu das Arte", ix).parecido, "Embu das Artes");
  // inexistente: nada parecido
  assert.deepEqual(checkMunicipality("Serra do Cajueiro Seco", ix), { existe: false });
  assert.deepEqual(checkMunicipality("Xyzzy", ix), { existe: false });
  assert.deepEqual(checkMunicipality("", ix), { existe: false });
  assert.deepEqual(checkMunicipality("Fortaleza", buildMunicipalityIndex([])), { existe: false });
  assert.ok(ix.norm.some((x) => x !== undefined)); // agora sim, só os examinados
});

test("checkMunicipality: o limite de distância depende do tamanho do nome (1 edição até 11 letras; 2 a partir de 12)", () => {
  const ix = buildMunicipalityIndex([["Abcdefghij", "XX"], ["Abcdefghijklm", "XX"]]);
  assert.ok(checkMunicipality("Abcdefghxx", ix).parecido === undefined, "duas trocas em nome de 10 letras: inexistente"); // 2 edições, < 12 letras
  assert.equal(checkMunicipality("Abcdefghix", ix).parecido, "Abcdefghij"); // 1 troca
  assert.equal(checkMunicipality("Abcdefghijxx", ix).parecido, "Abcdefghij"); // 12 letras: 2 edições valem (aqui, 2 letras a mais)
  assert.equal(checkMunicipality("Abcdefghijxxx", ix).parecido, undefined); // 3 edições: não
});

// Referência lenta e óbvia: normaliza todos os nomes e calcula a distância completa (com inversão de letras vizinhas).
// Serve para provar que as otimizações de CPU (duas passadas, pedaços da consulta) não mudam nenhuma resposta.
function distanciaCompleta(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function checkLento(nome, lista, normais) {
  const q = normalizeName(nome), max = q.replace(/ /g, "").length >= 12 ? 2 : 1;
  let melhor = -1, dMelhor = max + 1, comeco = -1;
  for (let i = 0; i < lista.length; i++) {
    const n = normais[i];
    if (n === q) return { existe: true, uf: lista[i][1] };
    if (comeco < 0 && n.startsWith(q + " ")) comeco = i;
    if (Math.abs(n.length - q.length) > max) continue; // diferença de tamanho já passa do limite (só poupa tempo do teste)
    const d = distanciaCompleta(q, n);
    if (d < dMelhor) { dMelhor = d; melhor = i; }
  }
  const i = melhor >= 0 ? melhor : comeco;
  return i >= 0 ? { existe: false, parecido: lista[i][0], uf: lista[i][1] } : { existe: false };
}

test("checkMunicipality: dá a mesma resposta da busca completa (nomes reais, com 1 a 3 erros, começos de nome e lixo)", () => {
  let seed = 20261006; // semente fixa: o teste é determinístico
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const LETRAS = "abcdefghijklmnopqrstuvwxyz ";
  const editar = (s, k) => {
    const a = s.split("");
    for (let e = 0; e < k; e++) {
      const op = Math.floor(rnd() * 4), p = Math.floor(rnd() * Math.max(1, a.length));
      if (op === 0) a[p] = pick(LETRAS);                           // trocar
      else if (op === 1) a.splice(p, 1);                           // apagar
      else if (op === 2) a.splice(p, 0, pick(LETRAS));             // inserir
      else if (p + 1 < a.length) [a[p], a[p + 1]] = [a[p + 1], a[p]]; // inverter vizinhas
    }
    return a.join("");
  };
  const curtos = LISTA.filter((x) => x[0].length <= 8), longos = LISTA.filter((x) => x[0].length >= 16);
  const ix = buildMunicipalityIndex(LISTA);
  const normais = LISTA.map((x) => normalizeName(x[0]));
  const vistos = { existe: 0, parecido: 0, inexistente: 0 };
  const conferir = (q) => {
    const r = checkMunicipality(q, ix);
    assert.deepEqual(r, checkLento(q, LISTA, normais), `consulta: "${q}"`);
    vistos[r.existe ? "existe" : r.parecido ? "parecido" : "inexistente"]++;
  };
  for (let k = 0; k < 40; k++) {
    const base = fold(pick(LISTA)[0]);
    conferir(base);                                              // existe
    conferir(editar(base, 1));                                   // 1 erro
    conferir(editar(base, 2));                                   // 2 erros
    conferir(base.split(" ").slice(0, -1).join(" ") || "xyz");   // só o começo do nome
    conferir(editar(fold(pick(curtos)[0]), 1));                  // nome curto com 1 erro
    conferir(editar(fold(pick(longos)[0]), 2));                  // nome longo com 2 erros
    conferir(Array.from({ length: 4 + Math.floor(rnd() * 16) }, () => pick(LETRAS)).join("").trim() || "xyz"); // lixo
  }
  // as três respostas possíveis apareceram: o teste não passou "no vazio"
  assert.ok(vistos.existe > 20 && vistos.parecido > 20 && vistos.inexistente > 20, JSON.stringify(vistos));
});

test("buildMunicipalityIndex: usa a lista como veio quando está certa e descarta só os itens sem nome", () => {
  const certa = [["Fortaleza", "CE"], ["Sobral", "CE"]];
  assert.equal(buildMunicipalityIndex(certa).itens, certa); // sem cópia (poupa CPU)
  const torta = buildMunicipalityIndex([["Fortaleza", "CE"], null, ["", "XX"], ["Sobral"], 42, ["Crato", "CE", "extra"]]);
  assert.deepEqual(torta.itens, [["Fortaleza", "CE"], ["Sobral", ""], ["Crato", "CE"]]);
  assert.deepEqual(buildMunicipalityIndex("não é lista").itens, []);
  assert.deepEqual(checkMunicipality("Sobral", torta), { existe: true, uf: "" });
});

test("checkMunicipality: nome que é só o COMEÇO de um município maior é 'parecido', não inexistente", () => {
  const ix = buildMunicipalityIndex(LISTA);
  const r = checkMunicipality("Olho d'Água do", ix); // truncado
  assert.equal(r.existe, false);
  assert.ok(r.parecido && r.parecido.startsWith("Olho d'Água"), JSON.stringify(r));
});

test("findMunicipalityMentions: padrão 'prefeito/prefeitura/município/cidade/vereador/câmara municipal de X'", () => {
  assert.deepEqual(findMunicipalityMentions("O prefeito de Serra do Cajueiro Seco, Zeferino Quaresma Dantas, teria desviado..."), ["Serra do Cajueiro Seco"]);
  assert.deepEqual(findMunicipalityMentions("A prefeitura de Poços de Caldas e a cidade de Mogi das Cruzes"), ["Poços de Caldas", "Mogi das Cruzes"]);
  assert.deepEqual(findMunicipalityMentions("Segundo a Câmara Municipal de Santa Bárbara d'Oeste, nada"), ["Santa Bárbara d'Oeste"]);
  assert.deepEqual(findMunicipalityMentions("A vereadora de Olho d'Água do Casado disse"), ["Olho d'Água do Casado"]);
  assert.deepEqual(findMunicipalityMentions("Secretaria Municipal de Saúde de Belo Horizonte informou"), ["Belo Horizonte"]);
  assert.deepEqual(findMunicipalityMentions("O município de Guaíba tem 100 mil habitantes"), ["Guaíba"]);
  assert.deepEqual(findMunicipalityMentions("o prefeito de são paulo disse"), []); // sem inicial maiúscula não é nome próprio
  assert.deepEqual(findMunicipalityMentions("Ele é prefeito e mora na cidade"), []);
  assert.deepEqual(findMunicipalityMentions(""), []);
});

test("checkMention: nome seguido de pessoa, sem vírgula, ainda acha o município; 'Serra do ...' não vira 'Serra'", () => {
  const ix = buildMunicipalityIndex(LISTA);
  assert.equal(checkMention("Fortaleza Evandro Leitão", ix).existe, true);
  assert.equal(checkMention("São Paulo Ricardo Nunes", ix).existe, true);
  assert.equal(checkMention("Serra do Cajueiro Seco", ix).existe, false); // "Serra" existe, mas "do Cajueiro Seco" é parte do nome
  assert.equal(checkMention("Serra do Cajueiro Seco Zeferino Quaresma", ix).existe, false);
});

test("temContextoMunicipal, aparece e ehNaoMunicipal: guardas contra acusar quem não deve", () => {
  const t = "O prefeito de Serra do Cajueiro Seco teria desviado a verba.";
  assert.equal(temContextoMunicipal(t, "Serra do Cajueiro Seco"), true);
  assert.equal(temContextoMunicipal("Ontem em Serra do Cajueiro Seco teve festa na praça.", "Serra do Cajueiro Seco"), false);
  assert.equal(temContextoMunicipal("O prefeito anunciou. Muito depois, numa conversa sobre futebol e culinária, falou-se de um lugar chamado Vila Nova Esperança, bem distante do assunto.", "Vila Nova Esperança"), false); // o contexto está longe do nome
  assert.equal(temContextoMunicipal(t, "Outro Lugar"), false); // nome ausente do texto
  assert.equal(aparece(t, "serra do cajueiro seco"), true);
  assert.equal(aparece(t, "Fortaleza"), false);
  for (const n of ["Paris", "Nova York", "Estados Unidos", "Brasil", "Minas Gerais", "Roraima", "Buenos Aires"]) assert.equal(ehNaoMunicipal(n), true, n);
  for (const n of ["Fortaleza", "Serra do Cajueiro Seco"]) assert.equal(ehNaoMunicipal(n), false, n);
});

// ---------- sinais de corrente ----------
const pontos = (t) => sinaisDeCorrente(t).pontos;

test("sinais de corrente: pesos e explicações", () => {
  assert.equal(pontos("Compartilhe com todos"), 25);
  assert.equal(pontos("Repasse esta mensagem; divulgue; espalhe; passe adiante; mande para todos"), 25); // o mesmo sinal não soma duas vezes
  assert.equal(pontos("Salve antes que apaguem"), 25);
  assert.equal(pontos("Antes que eles deletem o vídeo"), 25);
  assert.equal(pontos("Isso foi abafado pela mídia"), 20);
  assert.equal(pontos("A grande mídia não mostra isso"), 20);
  assert.equal(pontos("Ninguém fala sobre esse caso"), 20);
  assert.equal(pontos("A TV não vai passar essa notícia"), 20);
  assert.equal(pontos("A imprensa esconde a verdade"), 20);
  assert.equal(pontos("Mensagem encaminhada com frequência"), 15);
  assert.equal(pontos("Segundo uma fonte anônima, tudo mudou"), 15);
  assert.equal(pontos("Um primo meu que é delegado me disse que vai cair tudo"), 15);
  assert.equal(pontos("O governo vai taxar as heranças"), 15);
  assert.equal(pontos("A Receita vai cobrar uma nova taxa"), 15);
  assert.equal(pontos("O STF vai proibir o uso"), 15);
  assert.equal(pontos("URGENTE: leia isto"), 10);
  assert.equal(pontos("Atenção, gente, isto é sério"), 10);
  assert.equal(pontos("Isso é um absurdo!!!"), 10);
  assert.equal(pontos("Prova irrefutável de que mentiram"), 10);
  assert.equal(pontos("O vídeo mostra tudo"), 10);
  assert.equal(pontos("Ele teria recebido o dinheiro"), 5);
  assert.equal(pontos("Supostamente isso ocorreu"), 5);
  assert.equal(pontos("O Senado aprovou o texto por 52 votos a 18 nesta terça-feira, informou a assessoria."), 0);
});

test("sinais de corrente: citam o trecho original (com acento), 'vai taxar' exige o governo, prova com link não conta, maiúsculas contam", () => {
  const s = sinaisDeCorrente("O caso foi abafado pela mídia e ninguém fala dele");
  assert.equal(s.itens[0].texto, "Diz que a imprensa esconde o fato (“abafado pela mídia”)");
  assert.equal(pontos("Alguém vai taxar o seu sonho"), 0); // sem governo/STF/Receita...
  assert.equal(sinaisDeCorrente("O governo vai cobrar imposto sobre o Pix").medida, true);
  assert.equal(sinaisDeCorrente("Vai cobrar caro o ingresso").medida, false);
  assert.equal(pontos("Veja a prova irrefutável em https://exemplo.org/doc"), 0);
  assert.equal(pontos("ESTA MENSAGEM FOI ESCRITA TODA EM LETRAS MAIÚSCULAS PARA CHAMAR A ATENÇÃO DE TODO MUNDO"), 10);
  assert.equal(pontos("Curto DEMAIS"), 0); // menos de 20 letras: caixa alta não é sinal
});

test("sinais de corrente: soma limitada a 100, mais pesados primeiro", () => {
  const tudo = "URGENTE!!! Compartilhe antes que apaguem! A grande mídia esconde. Encaminhada com frequência. Fonte anônima diz que o governo vai taxar tudo. Prova irrefutável, ele teria roubado.";
  const s = sinaisDeCorrente(tudo);
  assert.equal(s.pontos, PONTOS_MAX);
  assert.equal(s.itens.reduce((n, i) => n + i.peso, 0), 140); // a soma bruta passa de 100
  assert.deepEqual(s.itens.map((i) => i.peso), [...s.itens.map((i) => i.peso)].sort((a, b) => b - a));
});

// ---------- decisão ----------
test("limiares da decisão são constantes nomeadas com os valores da regra", () => {
  assert.equal(LIMIAR_SUSPEITO, 45);
  assert.equal(LIMIAR_SEM_COBERTURA, 25);
  assert.equal(MIN_FONTES, 2);
  assert.equal(FONTES_ALTA, 3);
  assert.equal(MIN_TERMOS, 3);
});

const fonte = (nome, extra = {}) => ({ fonte: nome, chave: nome.toLowerCase() + ".com", ...extra });
const corrente = (pontos, itens = []) => ({ pontos, itens });

test("decidir: 'suspeito' a partir de 45 pontos (44 não basta) quando há cobertura que não confirma", () => {
  const base = { tipo: "afirmacao", cobertura: 1 };
  assert.equal(decidir({ ...base, corrente: corrente(LIMIAR_SUSPEITO - 1) }).nivel, "nao_confirmado");
  assert.equal(decidir({ ...base, corrente: corrente(LIMIAR_SUSPEITO) }).nivel, "suspeito");
  // ...mas não se alguma fonte confirma
  assert.equal(decidir({ ...base, corrente: corrente(80), confirmam: [fonte("A")] }).nivel, "nao_confirmado");
});

test("decidir: sem nenhuma cobertura, 25 pontos bastam (24 não), mas só para tipo 'afirmacao'", () => {
  const base = { cobertura: 0 };
  assert.equal(decidir({ ...base, tipo: "afirmacao", corrente: corrente(LIMIAR_SEM_COBERTURA - 1) }).nivel, "nao_confirmado");
  assert.equal(decidir({ ...base, tipo: "afirmacao", corrente: corrente(LIMIAR_SEM_COBERTURA) }).nivel, "suspeito");
  assert.equal(decidir({ ...base, tipo: "outro", corrente: corrente(LIMIAR_SEM_COBERTURA + 10) }).nivel, "nao_confirmado");
  assert.equal(decidir({ ...base, tipo: "outro", corrente: corrente(LIMIAR_SUSPEITO) }).nivel, "suspeito");
});

test("decidir: município inexistente sem cobertura que confirme => 'provavelmente falso' (alta); com confirmação não", () => {
  const r = decidir({ tipo: "afirmacao", inexistentes: ["Serra do Cajueiro Seco"], cobertura: 0 });
  assert.deepEqual([r.nivel, r.rotulo, r.tom, r.origem, r.confianca], ["provavelmente_falso", "Provavelmente falso", "falso", "radar", "alta"]);
  assert.equal(r.motivos[0], "Não existe município chamado “Serra do Cajueiro Seco” na lista oficial do IBGE (5.571 municípios).");
  assert.equal(r.resumo, "Não existe município com esse nome no Brasil e nenhum veículo noticiou o caso.");
  assert.equal(decidir({ tipo: "afirmacao", inexistentes: ["X"], cobertura: 3 }).resumo, "Não existe município com esse nome no Brasil e nenhum veículo confirmou o caso.");
  const com = decidir({ tipo: "afirmacao", inexistentes: ["X"], cobertura: 2, confirmam: [fonte("A")] });
  assert.notEqual(com.nivel, "provavelmente_falso");
  assert.equal(decidir({ tipo: "afirmacao", inexistentes: ["X"], total: 5570 }).motivos[0], "Não existe município chamado “X” na lista oficial do IBGE (5.570 municípios).");
});

test("decidir: 2 fontes DISTINTAS que contradizem e nenhuma que confirma => 'provavelmente falso'", () => {
  const dois = decidir({ tipo: "afirmacao", cobertura: 2, contradizem: [fonte("A"), fonte("B")] });
  assert.deepEqual([dois.nivel, dois.confianca], ["provavelmente_falso", "alta"]);
  assert.equal(dois.motivos[0], "Veículos como A e B noticiam o contrário ou desmentem a afirmação.");
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 1, contradizem: [fonte("A")] }).nivel, "provavelmente_falso");
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 2, contradizem: [fonte("A"), fonte("A")] }).nivel, "provavelmente_falso"); // mesmo veículo
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 3, contradizem: [fonte("A"), fonte("B")], confirmam: [fonte("C")] }).nivel, "provavelmente_falso");
});

test("decidir: 'provavelmente verdadeiro' com 2 fontes distintas (media) ou 3+ (alta), ou 1 fonte oficial; nunca com contradição ou município inexistente", () => {
  const dois = decidir({ tipo: "afirmacao", cobertura: 2, confirmam: [fonte("A"), fonte("B")] });
  assert.deepEqual([dois.nivel, dois.rotulo, dois.tom, dois.confianca, dois.resumo], ["provavelmente_verdadeiro", "Provavelmente verdadeiro", "verdadeiro", "media", "Foi noticiado por A e B."]);
  const tres = decidir({ tipo: "afirmacao", cobertura: 3, confirmam: [fonte("A"), fonte("B"), fonte("C")] });
  assert.deepEqual([tres.confianca, tres.resumo], ["alta", "Foi noticiado por A, B e C."]);
  assert.equal(decidir({ tipo: "afirmacao", cobertura: 4, confirmam: ["A", "B", "C", "D"].map((n) => fonte(n)) }).resumo, "Foi noticiado por A, B, C e outros.");
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 1, confirmam: [fonte("A")] }).nivel, "provavelmente_verdadeiro");
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 2, confirmam: [fonte("A"), fonte("A")] }).nivel, "provavelmente_verdadeiro");
  assert.equal(decidir({ tipo: "afirmacao", cobertura: 1, confirmam: [fonte("Agência Senado", { oficial: true })] }).nivel, "provavelmente_verdadeiro");
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 3, confirmam: [fonte("A"), fonte("B")], contradizem: [fonte("C")] }).nivel, "provavelmente_verdadeiro");
  assert.notEqual(decidir({ tipo: "afirmacao", cobertura: 2, confirmam: [fonte("A"), fonte("B")], inexistentes: ["X"] }).nivel, "provavelmente_verdadeiro");
});

test("decidir: opinião e previsão nunca viram falso nem verdadeiro", () => {
  for (const tipo of ["opiniao", "previsao"]) {
    const r = decidir({ tipo, inexistentes: ["X"], cobertura: 2, confirmam: [fonte("A"), fonte("B"), fonte("C")], contradizem: [fonte("D"), fonte("E")] });
    assert.equal(r.nivel, "nao_confirmado");
    assert.equal(r.resumo, "Isto é opinião ou previsão, não um fato que possa ser checado.");
    assert.equal(r.motivos[0], "Isto é opinião ou previsão, não um fato que possa ser checado.");
  }
});

test("decidir: motivos, os mais pesados primeiro, até 5, com a nota das agências por último", () => {
  const itens = [{ peso: 25, texto: "Pede para compartilhar" }, { peso: 25, texto: "Pede para espalhar antes que apaguem" }, { peso: 20, texto: "Diz que a imprensa esconde o fato" }, { peso: 15, texto: "Marcada como encaminhada" }, { peso: 10, texto: "Usa urgência" }, { peso: 5, texto: "Usa teria" }];
  const r = decidir({ tipo: "afirmacao", inexistentes: ["X"], cobertura: 0, corrente: corrente(100, itens), agencias: { consultou: true, checagens: 0 } });
  assert.equal(r.motivos.length, 5);
  assert.match(r.motivos[0], /IBGE/);
  assert.equal(r.motivos[1], "Nenhum veículo de imprensa que consultamos noticiou o caso.");
  assert.equal(r.motivos[2], "Pede para compartilhar");
  assert.equal(r.motivos.at(-1), "Nenhuma agência de checagem analisou este boato ainda.");
  // a nota depende de a consulta ter funcionado
  assert.equal(decidir({ agencias: { consultou: false, checagens: 0 } }).motivos.at(-1), "Não conseguimos consultar as agências agora.");
  assert.equal(decidir({ agencias: { consultou: true, checagens: 2 } }).motivos.at(-1), "Há checagens de agências sobre assuntos parecidos, mas nenhuma conclui sobre esta mensagem.");
  assert.equal(decidir({ cobertura: 2 }).motivos[0], "Há notícias sobre o assunto, mas nenhuma confirma a afirmação.");
});

test("decidir: o resumo do suspeito só diz 'nenhuma agência checou' se a consulta funcionou e nada veio", () => {
  const base = { tipo: "afirmacao", cobertura: 0, corrente: corrente(60) };
  assert.equal(decidir({ ...base, agencias: { consultou: true, checagens: 0 } }).resumo, "Nenhuma agência checou e nenhum veículo confirma; a mensagem usa gatilhos típicos de corrente.");
  assert.equal(decidir({ ...base, agencias: { consultou: false, checagens: 0 } }).resumo, "Nenhum veículo confirma; a mensagem usa gatilhos típicos de corrente.");
});

test("resultadoDaAgencia: rótulo, tom e resumo a partir do veredito das agências", () => {
  const ch = [{ agencia: "Lupa", avaliacao: "Falso", titulo: "É falso que X", classe: "falso" }];
  const r = resultadoDaAgencia("falso", ch);
  assert.deepEqual(r.resultado, { rotulo: "É falso", tom: "falso", origem: "agencia", confianca: "alta", resumo: "A agência Lupa avaliou: “Falso”." });
  assert.equal(resultadoDaAgencia("enganoso", ch).resultado.rotulo, "É enganoso");
  assert.equal(resultadoDaAgencia("verdadeiro", ch).resultado.rotulo, "É verdadeiro");
  const m = resultadoDaAgencia("misto", ch).resultado;
  assert.deepEqual([m.rotulo, m.tom], ["Tem ressalvas", "alerta"]);
  assert.equal(resultadoDaAgencia("sem_checagem", ch), null);
  assert.equal(resultadoDaAgencia("indisponivel", ch), null);
  // sem avaliação separada (itens do índice), cita o título
  assert.equal(resultadoDaAgencia("falso", [{ agencia: "Aos Fatos", avaliacao: "", titulo: "É falso que Y.", classe: "falso" }]).resultado.resumo, "A agência Aos Fatos avaliou: “É falso que Y”.");
});

test("listaDeNomes e fontesDistintas", () => {
  assert.equal(listaDeNomes([]), "");
  assert.equal(listaDeNomes(["A"]), "A");
  assert.equal(listaDeNomes(["A", "B"]), "A e B");
  assert.equal(listaDeNomes(["A", "B", "A", "C"]), "A, B e C");
  assert.equal(listaDeNomes(["A", "B", "C", "D"]), "A, B, C e outros");
  assert.equal(fontesDistintas([fonte("A"), fonte("A"), fonte("B")]), 2);
});

// ---------- índice de manchetes ----------
const IDX = new NewsIndex([
  { t: "Governo investiga suspeito de fraude no Pix", s: "g1", u: "https://g1.globo.com/1/", p: "2026-10-01T10:00" },
  { t: "SUS amplia vacinação contra a gripe", s: "Folha", u: "https://www1.folha.uol.com.br/2", p: "2026-10-02T10:00" },
  { t: "Câmara aprova reforma administrativa", s: "g1", u: "https://g1.globo.com/3", p: "2026-10-03T10:00" },
  { t: "É falso que o governo vai cobrar imposto sobre o Pix", s: "Aos Fatos", u: "https://www.aosfatos.org/4", p: "2026-10-03T11:00", c: 1 },
  { t: "inválida", s: "X" }, null, { t: 5, u: "https://x.test" },
]);

test("NewsIndex.achar: o pré-filtro é por pedaço de palavra, mas a conferência é palavra a palavra ('sus' não casa com 'suspeito')", () => {
  assert.equal(IDX.lista.length, 4); // entradas inválidas ficam de fora
  const sus = IDX.achar(["sus"], 1);
  assert.deepEqual(sus.map((x) => x.a.s), ["Folha"]);
  const pix = IDX.achar(["pix", "governo", "imposto"], 2, (a) => a.c !== 1);
  assert.deepEqual(pix.map((x) => [x.a.s, x.shared]), [["g1", 2]]); // "Governo investiga suspeito de fraude no Pix": governo e pix
  assert.deepEqual(IDX.achar(["pix", "governo", "imposto"], 3, (a) => a.c !== 1), []); // com 3 exigidos, nenhuma sem checagem tem
  assert.deepEqual(IDX.achar(["pix", "governo", "imposto"], 3).map((x) => x.a.s), ["Aos Fatos"]); // a checagem tem os 3
  assert.deepEqual(IDX.achar([], 1), []);
  assert.deepEqual(IDX.achar(["pix"], 0), []);
});

test("NewsIndex.achar: o filtro rápido (regex) trata os termos como texto, não como padrão, e só chama aceita() quando precisa", () => {
  const ix = new NewsIndex([
    { t: "Tarifa a.b sobe", s: "A", u: "https://a.test/1" },
    { t: "Tarifa axb sobe", s: "B", u: "https://b.test/2" },
    { t: "Outro assunto qualquer", s: "C", u: "https://c.test/3" },
  ]);
  // sem escapar, "(sobe", "a[b" e "c++" seriam regex inválidas e a busca lançaria SyntaxError
  assert.deepEqual(ix.achar(["tarifa", "(sobe", "a[b", "x\\y", "c++"], 1).map((x) => x.a.s), ["A", "B"]);
  const vistos = [];
  ix.achar(["tarifa"], 1, (a) => { vistos.push(a.s); return true; });
  assert.deepEqual(vistos, ["A", "B", "C"]); // aceita() roda em todas (é o filtro barato), mas o resultado só traz as que têm o termo
});

test("NewsIndex.porUrl: acha a própria matéria com ou sem barra no fim", () => {
  assert.equal(IDX.porUrl("https://g1.globo.com/1").s, "g1");
  assert.equal(IDX.porUrl("https://g1.globo.com/1/").s, "g1");
  assert.equal(IDX.porUrl("https://g1.globo.com/3/").t, "Câmara aprova reforma administrativa");
  assert.equal(IDX.porUrl("https://g1.globo.com/9"), null);
});

// ---------- cobertura ----------
test("regraDeCobertura: >= 3 termos em comum, ou >= 60% da busca quando ela tem até 4 termos", () => {
  const W = ["prefeito", "fortaleza", "desvio", "merenda", "escolar"];
  const longa = regraDeCobertura(W, W); // busca com 5 termos: só vale a regra dos 3 termos
  assert.equal(longa.serve(["prefeito", "fortaleza", "obra"]), false);
  assert.equal(longa.serve(["prefeito", "fortaleza", "merenda"]), true);
  const B = ["imposto", "pix", "cobrar"]; // 3 termos: 60% = 2
  const curta = regraDeCobertura(B, B);
  assert.equal(curta.serve(["imposto", "pix"]), true);
  assert.equal(curta.serve(["imposto"]), false);
  assert.equal(regraDeCobertura(["pix"], ["pix"]).serve(["pix"]), true); // 1 termo: 60% = 1
  assert.equal(regraDeCobertura([], []).serve(["qualquer"]), false); // sem termos nada vale
  assert.equal(regraDeCobertura(B, B).prefiltro, 2);
  assert.equal(regraDeCobertura(W, W).prefiltro, 3);
});

test("coberturaDoIndice: ignora checagens (c: 1), limita duas por veículo e ordena por termos em comum e data", () => {
  const ix = new NewsIndex([
    { t: "Prefeito de Fortaleza é investigado por desvio na merenda escolar", s: "g1", u: "https://g1.globo.com/a", p: "2026-10-01T10:00" },
    { t: "Prefeito de Fortaleza investigado por desvio na merenda escolar, diz MP", s: "g1", u: "https://g1.globo.com/b", p: "2026-10-02T10:00" },
    { t: "Prefeito de Fortaleza alvo de desvio na merenda escolar, afirma polícia", s: "oglobo", u: "https://oglobo.globo.com/c", p: "2026-10-03T10:00" }, // mesmo domínio registrável (globo.com): cota de 2 já cheia
    { t: "Prefeito de Fortaleza desvio merenda escolar Folha", s: "Folha", u: "https://www1.folha.uol.com.br/d", p: "2026-10-04T10:00" },
    { t: "É falso que prefeito de Fortaleza tenha desvio na merenda escolar", s: "Lupa", u: "https://lupa.news/e", p: "2026-10-05T10:00", c: 1 },
  ]);
  const W = ["prefeito", "fortaleza", "desvio", "merenda", "escolar"];
  const c = coberturaDoIndice(ix, W, W);
  // empate em termos: a mais recente primeiro; "oglobo" e "g1" são o mesmo domínio registrável (globo.com), então só duas passam
  assert.deepEqual(c.map((x) => x.fonte), ["Folha", "oglobo", "g1"]);
  assert.ok(c.every((x) => x.via === "indice" && x.chave && /^https:/.test(x.url)));
  assert.deepEqual(coberturaDoIndice(null, W, W), []);
  assert.deepEqual(coberturaDoIndice(ix, [], []), []);
});

test("juntarCandidatas: sem URL repetida, até 8 e duas por veículo", () => {
  const mk = (n, chave) => ({ titulo: "t" + n, url: `https://${chave}/${n}`, chave });
  const local = [mk(1, "a.com"), mk(2, "a.com"), mk(3, "a.com"), mk(4, "b.com")];
  const gdelt = [mk(4, "b.com"), ...Array.from({ length: 10 }, (_, i) => mk(10 + i, `s${i}.com`))];
  const r = juntarCandidatas(local, gdelt);
  assert.equal(r.length, 8);
  assert.deepEqual(r.slice(0, 3).map((x) => x.titulo), ["t1", "t2", "t4"]); // a terceira de a.com e a repetida de b.com saem
});

test("consultaGdelt: município entre aspas, ou até 4 palavras-chave (com acento) + sourcelang:portuguese", () => {
  assert.equal(consultaGdelt(["Serra do Cajueiro Seco"], "x", []), '"Serra do Cajueiro Seco"');
  assert.equal(consultaGdelt(['Cidade "Teste"'], "x", []), '"Cidade Teste"');
  const B = ["urnas", "eletronicas", "duplo", "voto", "tse"];
  assert.equal(consultaGdelt([], "urnas eletrônicas voto duplo tse", B), "urnas eletrônicas voto duplo sourcelang:portuguese"); // as 4 primeiras, como o usuário escreveu
  assert.equal(consultaGdelt([], "palavra", ["palavra"]), ""); // uma palavra só: não vale a consulta
  assert.equal(consultaGdelt([], "", []), "");
});

// ---------- agências pelo índice ----------
test("checagensDoIndice: só c === 1, com >= 3 termos em comum; veredito pelo título; negação oposta vira 'relacionada'", () => {
  const termos = ["governo", "cobrar", "imposto", "pix"];
  const itens = checagensDoIndice(IDX, termos);
  assert.equal(itens.length, 1);
  assert.deepEqual([itens[0].agencia, itens[0].classe, itens[0].avaliacao, itens[0].data], ["Aos Fatos", "falso", "Falso", "2026-10-03"]);
  assert.deepEqual(publicas(itens), [{ agencia: "Aos Fatos", avaliacao: "Falso", titulo: "É falso que o governo vai cobrar imposto sobre o Pix", url: "https://www.aosfatos.org/4", data: "2026-10-03" }]);
  // quem diz que o governo NÃO vai cobrar: "É falso que ... vai cobrar" não vale para esse texto
  const oposto = checagensDoIndice(IDX, termos, true);
  assert.equal(oposto[0].classe, "");
  assert.equal(publicas(oposto)[0].relacionada, true);
  assert.deepEqual(checagensDoIndice(IDX, ["pix"]).length, 1); // com 1 termo, exige 1 (min(3, n))
  assert.deepEqual(checagensDoIndice(null, termos), []);
  assert.deepEqual(checagensDoIndice(IDX, []), []);
});

test("mesclarChecagens: sem URL repetida, com veredito primeiro, até 5", () => {
  const mk = (n, classe, s = 1) => ({ agencia: "A", avaliacao: "", titulo: "t" + n, url: `https://x.test/${n}`, data: "", classe, _s: s });
  const r = mesclarChecagens([mk(1, "", 5), mk(2, "falso", 1)], [mk(1, "falso", 9), mk(3, "", 3), mk(4, "enganoso", 2), mk(5, "", 1), mk(6, "", 1), mk(7, "", 1)]);
  assert.deepEqual(r.map((x) => x.titulo), ["t4", "t2", "t1", "t3", "t5"]);
  assert.equal(r.length, 5);
});

// ---------- resumo ----------
test("repeteTitulo: >= 85% das palavras do resumo no título, ou no máximo 2 palavras novas", () => {
  const titulo = "Flávio e Caiado dão declarações em Goiânia";
  assert.equal(repeteTitulo("Flávio e Caiado deram declarações em Goiânia.", titulo), true); // paráfrase com verbo flexionado
  assert.equal(repeteTitulo("Flávio e Caiado dão declarações em Goiânia", titulo), true); // cópia
  assert.equal(repeteTitulo("", titulo), true);
  assert.equal(repeteTitulo("Flávio disse que disputará o Senado e Caiado afirmou que apoiará a chapa, em ato com 300 pessoas.", titulo), false);
  assert.equal(repeteTitulo("O texto-base foi aprovado por 52 votos a 18 e segue para a Câmara, onde o relator promete votar até dezembro.", "Senado aprova reforma tributária"), false);
  assert.ok(AVISO_CURTO.startsWith("Resumo curto"));
});

test("descricoesUteis: tira vazias, curtas, repetidas e as que só repetem o título", () => {
  const titulo = "Senado aprova reforma tributária";
  const longa = "O texto-base passou por 52 votos a 18 e segue para a Câmara dos Deputados, onde precisa de maioria.";
  const r = descricoesUteis(["", "curta", longa, longa.toUpperCase(), "Senado aprova a reforma tributária hoje em Brasília", undefined], titulo);
  assert.deepEqual(r, [longa]);
});

test("outrosVeiculos: outro veículo, >= 3 termos do título, ordenados, um por veículo, no máximo 4", () => {
  const ix = new NewsIndex([
    { t: "Senado aprova reforma tributária com transição de oito anos", s: "g1", u: "https://g1.globo.com/a", p: "2026-10-05T09:00" },
    { t: "Senado conclui votação da reforma tributária e fixa transição de oito anos", s: "Folha", u: "https://www1.folha.uol.com.br/b", p: "2026-10-05T12:00", d: "Texto destaca estados." },
    { t: "Reforma tributária: Senado aprova transição de oito anos", s: "Folha", u: "https://www1.folha.uol.com.br/c", p: "2026-10-05T10:00" }, // 2ª do mesmo veículo (mais antiga: perde)
    { t: "Senado aprova reforma tributária com transição de oito anos para estados", s: "g1", u: "https://g1.globo.com/d", p: "2026-10-05T13:00" }, // mesmo veículo da matéria
    { t: "Reforma tributária: Estadão detalha transição de oito anos aprovada pelo Senado", s: "Estadão", u: "https://www.estadao.com.br/e", p: "2026-10-05T11:00" },
    { t: "Time vence campeonato regional", s: "Lance", u: "https://www.lance.com.br/f", p: "2026-10-05T11:00" },
  ]);
  const self = ix.porUrl("https://g1.globo.com/a");
  const o = outrosVeiculos(ix, "https://g1.globo.com/a", self.t, self);
  assert.deepEqual(o.map((x) => x.fonte).sort(), ["Estadão", "Folha"]);
  assert.equal(o.find((x) => x.fonte === "Folha").d, "Texto destaca estados.");
  assert.deepEqual(outrosVeiculos(ix, "https://g1.globo.com/a", "Time vence", null), []); // título com menos de 3 termos
  assert.deepEqual(outrosVeiculos(null, "https://g1.globo.com/a", self.t, self), []);
});

test("citaVeiculo: o contexto precisa citar pelo menos um veículo da lista", () => {
  const outros = [{ fonte: "Folha de S.Paulo" }, { fonte: "g1" }];
  assert.equal(citaVeiculo("A Folha destaca a perda de arrecadação.", outros), true);
  assert.equal(citaVeiculo("O g1 foca na votação.", outros), true);
  assert.equal(citaVeiculo("Outros veículos também noticiaram.", outros), false);
  assert.equal(citaVeiculo("", outros), false);
});

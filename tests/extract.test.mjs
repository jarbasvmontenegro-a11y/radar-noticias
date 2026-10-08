// Testes do extrator de texto (lib/extract.js).
//
// tests/fixtures/html/*.html são versões ENXUTAS (10-30 KB) da ESTRUTURA de páginas de matérias de veículos de imprensa
// (g1, Folha, Estadão, Poder360, Gazeta do Povo, Agência Brasil, CartaCapital, Correio Braziliense, BBC Brasil). O texto
// corrido das matérias foi trocado por texto neutro do mesmo tamanho (o repositório não guarda textos de terceiros);
// ficam as tags, classes, menus e rodapés, que é o que o extrator precisa distinguir. Foram geradas por scripts/montar_fixtures.mjs: mantêm a estrutura
// (class/id, aninhamento, menus e rodapé como "isca"), mas sem scripts, estilos, imagens, campos de formulário nem tokens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractText, extractDetailed, decodeEntities } from "../lib/extract.js";

const dir = new URL("./fixtures/html/", import.meta.url);
const ler = (nome) => fs.readFileSync(new URL(nome + ".html", dir), "utf8");

// fonte -> [frase conhecida do corpo da matéria, textos de menu/rodapé/chamadas que NÃO podem aparecer]
const FIXTURES = {
  "g1": ["superávit de US$ 7,7 bilhões em setembro", ["Pular para o conteúdo", "Resumo do dia", "Inscreva-se e receba a newsletter"]],
  "gazeta-do-povo": ["Última Análise", ["Dê de presente", "Deixe sua opinião", "Comunique erros"]],
  "folha": ["Procuradoria-Geral Eleitoral afirmou", ["Diminuir fonte", "7 acessos por dia", "benefício do assinante"]],
  "estadao": ["espírito de vingança", ["Jornal do Carro", "Gerando resumo", "Confira o resumo que a LE.IA"]],
  "poder360": ["Edinho associou o congressista", ["Ir para o menu", "Priorize o Poder no Google", "Formulário de cadastro"]],
  "agencia-brasil": ["Luiza Erundina (Psol) tornou-se", ["Pular para o conteúdo principal", "Relacionadas", "Compartilhe essa notícia"]],
  "cartacapital": ["Banco Central passará a divulgar mensalmente", ["Edição da semana", "Sugestão de busca"]],
  "correio-braziliense": ["É necessário que se reforme o Poder Judiciário", ["Leia também", "Siga o canal do Correio Braziliense", "Fique por dentro das notícias que importam"]],
  "bbc-brasil": ["Nikolas Ferreira", ["Vá para o conteúdo", "Pule Mais lidas", "Article Information"]],
};

for (const [nome, [frase, ruido]] of Object.entries(FIXTURES)) {
  test(`extrator: página real ${nome}`, () => {
    const r = extractText(ler(nome));
    assert.ok(r.text.length >= 600, `texto curto demais (${r.text.length} caracteres)`);
    assert.ok(r.text.length <= 20000);
    assert.ok(r.text.includes(frase), `faltou a frase do corpo: ${frase}`);
    for (const x of ruido) assert.ok(!r.text.includes(x), `apareceu texto que não é da matéria: ${x}`);
    assert.ok(r.title.length > 10, "sem título");
    assert.ok(r.description.length > 10, "sem descrição");
    assert.deepEqual(Object.keys(r).sort(), ["description", "text", "title"]);
  });
}

test("extrator: o g1 (um <div> por parágrafo) devolve a matéria inteira, inclusive os itens de lista com números", () => {
  const r = extractText(ler("g1"));
  assert.match(r.text, /As exportações somaram U\$ 34,4 bilhões/);
  assert.match(r.text, /nove primeiros meses/);
});

test("extrator: legenda de foto não vira parágrafo", () => {
  const r = extractText(ler("correio-braziliense"));
  assert.ok(!/\(crédito:/i.test(r.text));
});

// ---------- casos sintéticos ----------
const p = (i) => `<p>Parágrafo número ${i} da matéria, com texto suficiente para contar como conteúdo jornalístico de verdade.</p>`;
const paragrafos = (n, ini = 1) => Array.from({ length: n }, (_, i) => p(i + ini)).join("\n");
const pagina = (corpo, cab = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Título da página</title>${cab}</head><body>${corpo}</body></html>`;

test("extrator: título e descrição com entidades (nomeadas, decimais e hexadecimais)", () => {
  const r = extractText(pagina("<article>" + paragrafos(4) + "</article>",
    '<meta property="og:title" content="Gest&atilde;o &amp; a&ccedil;&otilde;es: &ldquo;caso&rdquo;"><meta property="og:description" content="Ele disse: &#39;n&#xE3;o&#39;&nbsp;e saiu.">'));
  assert.equal(r.title, "Gestão & ações: “caso”");
  assert.equal(r.description, "Ele disse: 'não' e saiu.");
  assert.equal(decodeEntities("&Eacute; &agrave; &ordm; &foo; &#0;"), "É à º &foo; ");
});

test("extrator: usa o <title> quando não há og:title, e ignora o texto de <script>, <style> e comentários", () => {
  const r = extractText(pagina(`<script>var segredo = "não deve aparecer aqui nem em lugar nenhum desta página";</script><style>.a{content:"também não deve aparecer"}</style><!-- comentário que não deve aparecer no texto final da matéria --><article>${paragrafos(4)}</article>`));
  assert.equal(r.title, "Título da página");
  assert.ok(!/segredo|também não|comentário/.test(r.text));
  assert.match(r.text, /Parágrafo número 1/);
});

test("extrator: <p> sem fechamento e texto solto separado por <br>", () => {
  const solto = '<div class="materia">A prefeitura informou que o contrato foi assinado ontem, com valor total de R$ 2 milhões para a obra.<br><br>O Ministério Público pediu explicações sobre a licitação, que teve apenas uma empresa participante, segundo o edital.<br>A Câmara Municipal marcou audiência para a próxima semana, com a presença de vereadores e técnicos.</div>';
  const r = extractText(pagina(solto));
  assert.match(r.text, /contrato foi assinado ontem/);
  assert.match(r.text, /audiência para a próxima semana/);
  const semFechar = extractText(pagina("<article><p>Primeiro parágrafo sem fechamento, mas com texto longo o bastante para valer como conteúdo.<p>Segundo parágrafo também sem fechamento, igualmente longo, falando de outra coisa qualquer.<p>Terceiro parágrafo, o último, ainda com tamanho suficiente para entrar na lista de parágrafos.</article>"));
  assert.equal(semFechar.text.split("\n").length, 3);
});

test("extrator: menu, rodapé, comentários e 'leia também' ficam de fora; a matéria fica", () => {
  const html = pagina(`
    <header><nav><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/s${i}">Seção de notícias número ${i}</a></li>`).join("")}</ul></nav></header>
    <main><article class="post-content">${paragrafos(5)}
      <div class="related-posts"><p>Leia também: outra matéria que não tem nada a ver com esta e que deve ficar de fora do texto.</p><p>Outra chamada longa de matéria relacionada, que também não faz parte do texto desta reportagem.</p></div>
    </article>
    <section id="comments"><p>Comentário de leitor que escreveu bastante coisa para ocupar espaço e atrapalhar a extração do texto.</p></section></main>
    <footer><p>Todos os direitos reservados. Este site usa cookies para melhorar a sua experiência de navegação, leia a política.</p></footer>`);
  const r = extractText(html);
  assert.match(r.text, /Parágrafo número 5/);
  assert.ok(!/Leia também|Comentário de leitor|Todos os direitos|Seção de notícias|Outra chamada longa/.test(r.text));
});

test("extrator: parágrafo feito só de links (chamada) não conta", () => {
  const link = '<p><a href="/x">Chamada longa de outra matéria do mesmo portal, toda dentro de um link, que não é texto da reportagem</a></p>';
  const r = extractText(pagina(`<article>${paragrafos(4)}${link}${paragrafos(1, 5)}</article>`));
  assert.ok(!/Chamada longa/.test(r.text));
  assert.match(r.text, /Parágrafo número 5/);
});

test("extrator: <form> que envolve a página inteira (ASP.NET) não derruba o texto", () => {
  const r = extractText(`<html><body><form method="post" action="/x"><div id="conteudo"><div class="materia">${paragrafos(5)}</div></div></form></body></html>`);
  assert.match(r.text, /Parágrafo número 3/);
});

test("extrator: modal de consentimento (LGPD) não é confundido com a matéria", () => {
  const modal = `<div class="modal lgpd-consent"><p>${"Usamos cookies e dados pessoais para melhorar a sua experiência, conforme a política de privacidade. ".repeat(6)}</p><p>${"Ao continuar navegando você concorda com os termos de uso e com o tratamento dos seus dados pessoais. ".repeat(6)}</p></div>`;
  const r = extractText(pagina(`${modal}<div id="texto">${paragrafos(4)}</div>`));
  assert.match(r.text, /Parágrafo número 1/);
  assert.ok(!/cookies/.test(r.text));
});

test("extrator: fim da matéria (©, 'Mais lidas') corta o que vem depois", () => {
  const r = extractText(pagina(`<article>${paragrafos(5)}<p>© 2026 Veículo de Comunicação. Reprodução proibida sem autorização expressa.</p><p>Texto depois do rodapé que não pode entrar na matéria, mesmo sendo longo o suficiente.</p></article>`));
  assert.match(r.text, /Parágrafo número 5/);
  assert.ok(!/Texto depois do rodapé|©/.test(r.text));
});

test("extrator: JSON-LD articleBody quando a página não traz parágrafos (conteúdo montado no navegador)", () => {
  const corpo = Array.from({ length: 6 }, (_, i) => `Frase número ${i} do corpo da matéria publicado apenas no JSON-LD, longo o bastante para valer.`).join("\n");
  const ld = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: "X", articleBody: corpo })}</script>`;
  const r = extractDetailed(pagina('<div id="root"></div>', ld));
  assert.equal(r.via, "json-ld");
  assert.match(r.text, /Frase número 5/);
});

test("extrator: JSON-LD inválido (quebra de linha crua) ainda é lido", () => {
  const corpo = Array.from({ length: 6 }, (_, i) => `Linha ${i} do corpo da matéria no JSON-LD quebrado, com tamanho suficiente para passar do mínimo.`).join("\n");
  const ld = `<script type="application/ld+json">{"@type":"NewsArticle","articleBody":"${corpo}","x":}</script>`;
  const r = extractText(pagina('<div id="root"></div>', ld));
  assert.match(r.text, /Linha 5 do corpo/);
});

test("extrator: parágrafos completos ganham de um JSON-LD parecido", () => {
  const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: "Resumo curto. ".repeat(60) })}</script>`;
  const r = extractDetailed(pagina(`<article>${paragrafos(8)}</article>`, ld));
  assert.equal(r.via, "paragrafos");
});

test("extrator: nunca lança erro e devolve sempre os três campos", () => {
  for (const entrada of [undefined, null, 0, "", "<", ">", "<<<>>>", "<p", "<p>", "</p></div></article>", "a<b", "\u0000\u0001�", "<script>", "<!--", "<![CDATA[", { toString() { return "<p>x</p>"; } }]) {
    const r = extractText(entrada);
    assert.equal(typeof r.title, "string");
    assert.equal(typeof r.description, "string");
    assert.equal(typeof r.text, "string");
  }
});

test("extrator: HTML patológico termina rápido (sem varredura quadrática)", () => {
  const casos = ["<a ".repeat(100000), '<a href="'.repeat(50000), "<p>".repeat(60000) + "texto", "<div>".repeat(5000) + "x", "&".repeat(200000), "<!--".repeat(50000)];
  for (const c of casos) {
    const t0 = performance.now();
    extractText(c);
    assert.ok(performance.now() - t0 < 500, `lento demais para ${c.slice(0, 12)}`);
  }
});

test("extrator: texto devolvido tem no máximo 20 mil caracteres", () => {
  const r = extractText(pagina(`<article>${paragrafos(600)}</article>`));
  assert.ok(r.text.length <= 20000 && r.text.length > 15000);
});

test("extrator: entrada acima de 1 MB é cortada, não processada inteira", () => {
  const lixo = "<div>x</div>".repeat(200000); // 2,4 MB
  const t0 = performance.now();
  const r = extractText(pagina(`<article>${paragrafos(6)}</article>${lixo}`));
  assert.match(r.text, /Parágrafo número 6/);
  assert.ok(performance.now() - t0 < 1000);
});

test("extrator: carrossel de colunistas fora da matéria (Oeste) não vence o corpo da matéria", () => {
  const bio = (n) => `<p>Colunista ${n} é jornalista, integrante do conselho editorial, foi um dos criadores de uma revista que dirigiu por quinze anos e escreve semanalmente.</p>`;
  const html = pagina(
    `<main><article class="entry-single post-1 post"><h1>Polícia prende suspeitos</h1>
       <div class="entry-content"><section class="ais-summary"><div class="ais-summary__body"><p>Resumo automático do próprio veículo, com algumas frases sobre a operação.</p></div></section>
       ${paragrafos(12)}</div>
       <div class="card-author"><p class="card-author__description">Autor da matéria é jornalista e escreve sobre segurança pública há muitos anos no veículo.</p></div></article>
     <section class="content-aside"><div id="our-columnists-widget" class="swiper-columnist-archive columnist-archive__content"><div class="swiper-wrapper columnist-archive__content-columnists">${Array.from({ length: 30 }, (_, i) => bio(i)).join("")}</div></div></section></main>`);
  const r = extractText(html);
  assert.match(r.text, /Parágrafo número 1\b/);
  assert.doesNotMatch(r.text, /Colunista \d+ é jornalista/);
  assert.doesNotMatch(r.text, /Autor da matéria é jornalista/);
  assert.doesNotMatch(r.text, /Resumo automático do próprio veículo/);
});

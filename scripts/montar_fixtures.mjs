// Monta fixtures ENXUTAS de teste do extrator a partir de HTMLs completos de matérias (os do diagnóstico em diag/html).
//   node scripts/montar_fixtures.mjs <pasta com os HTMLs completos> <pasta de saída> [fonte ...]
// Cada fixture mantém a ESTRUTURA real da página (poda de elementos inteiros, nunca corte no meio de uma tag):
//   - cabeçalho mínimo: título, metas de descrição e JSON-LD com articleBody;
//   - cabeçalho/menu do começo do corpo e rodapé do fim, inteiros, como "isca" (o extrator NÃO pode devolver esse texto);
//   - a subárvore que contém a matéria (a maior que caiba em ~24 KB), com as tags dos ancestrais preservadas (class/id).
// Scripts, estilos, svg, comentários e campos <input> saem, e e-mails são trocados por um genérico: nenhum token, segredo
// ou dado pessoal da página vai para o repositório.
// As páginas são publicadas por veículos de imprensa e usadas aqui só como amostra de teste do extrator.
import fs from "node:fs";
import path from "node:path";
import { extractDetailed } from "../lib/extract.js";

const [dir, out, ...only] = process.argv.slice(2);
if (!dir || !out) { console.error("uso: node scripts/montar_fixtures.mjs <pasta HTML completos> <pasta de saída> [fonte ...]"); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

const MAX_REGIAO = 24000;  // tamanho máximo da subárvore da matéria
const MAX_ISCA = 3000;     // tamanho máximo de cada isca (começo e fim do corpo)
const VAZIOS = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

// Árvore mínima: cada elemento guarda onde começa e termina no texto (tolera HTML mal formado).
function arvore(h) {
  const raiz = { name: "#raiz", start: 0, end: h.length, open: "", parent: null, kids: [] };
  const pilha = [raiz];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = re.exec(h))) {
    const nome = m[2].toLowerCase();
    if (!m[1]) {
      if (VAZIOS.has(nome) || m[3].trim().endsWith("/")) continue;
      const el = { name: nome, start: m.index, open: m[0], end: h.length, parent: pilha[pilha.length - 1], kids: [] };
      el.parent.kids.push(el); pilha.push(el);
    } else {
      let i = pilha.length - 1;
      while (i > 0 && pilha[i].name !== nome) i--;
      if (i > 0) { while (pilha.length > i + 1) pilha.pop().end = m.index; pilha.pop().end = re.lastIndex; }
    }
  }
  return raiz;
}
const profundo = (el, pos) => { for (;;) { const k = el.kids.find((x) => x.start <= pos && pos < x.end); if (!k) return el; el = k; } };
const ancestrais = (el) => { const l = []; for (let e = el; e && e.name !== "#raiz"; e = e.parent) l.unshift(e); return l; };
const tamanho = (e) => e.end - e.start;
// ancestrais abaixo do <body> são recriados em volta do trecho, para class/id continuarem como na página
const envolver = (el, h) => { const a = ancestrais(el).slice(0, -1).filter((e) => e.name !== "body"); return a.map((e) => e.open).join("") + h.slice(el.start, el.end) + [...a].reverse().map((e) => `</${e.name}>`).join(""); };

// Elementos inteiros, em ordem, que cabem no orçamento (descendo um nível quando o primeiro é grande demais).
function isca(el, h, doFim) {
  const lista = [];
  const coleta = (e, nivel) => {
    const filhos = doFim ? [...e.kids].reverse() : e.kids;
    let gasto = lista.reduce((n, x) => n + tamanho(x), 0);
    for (const k of filhos) {
      if (gasto + tamanho(k) <= MAX_ISCA) { lista.push(k); gasto += tamanho(k); }
      else if (nivel < 3 && !lista.length) { coleta(k, nivel + 1); break; }
      else break;
    }
  };
  coleta(el, 0);
  return (doFim ? lista.reverse() : lista).map((e) => envolver(e, h)).join("\n");
}

// O extrator só olha class, id e itemprop; o resto (data-*, href, src, style, tokens de rastreio) sai, junto com imagens e campos.
const MANTER = new Set(["class", "id", "itemprop", "role"]);
function podarAtributos(h) {
  h = h.replace(/<(?:img|source|input|link|meta|base)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, "");
  return h.replace(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (tag, nome, attrs) => {
    const mantidos = [...attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .filter((m) => MANTER.has(m[1].toLowerCase()))
      .map((m) => `${m[1]}="${(m[2] ?? m[3] ?? m[4] ?? "").slice(0, 160).replace(/"/g, "&quot;")}"`);
    return `<${nome}${mantidos.length ? " " + mantidos.join(" ") : ""}>`;
  });
}

function enxugar(html, nome) {
  const r = extractDetailed(html);
  const lds = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim()).filter((j) => j.includes("articleBody"));
  // scripts primeiro: eles podem conter "<!--" em strings e comer tags se os comentários saíssem antes
  // (um <script> sem fechamento, comum em HTML truncado, vai até o fim)
  let h = html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  h = podarAtributos(h).replace(/\s{2,}/g, " ");
  const ini = h.search(/<body\b/i);
  const corpo = ini < 0 ? h : h.slice(ini);

  // posições da matéria: parágrafos longos que o extrator reconheceu, procurados por trechos de texto simples
  const linhas = r.text.split("\n").filter((l) => l.length >= 120);
  const trechos = (l) => [...l.matchAll(/[A-Za-z0-9 ,]{24,}/g)].map((m) => m[0].trim().slice(0, 40)).filter((t) => t.length >= 24);
  let a = -1, b = -1;
  for (const l of linhas) { for (const t of trechos(l)) { a = corpo.indexOf(t); if (a >= 0) break; } if (a >= 0) break; }
  for (const l of [...linhas].reverse()) { for (const t of trechos(l).reverse()) { b = corpo.lastIndexOf(t); if (b >= 0) break; } if (b >= 0) break; }
  if (a < 0 || b < a) throw new Error(`${nome}: não localizei a matéria no HTML`);

  const raiz = arvore(corpo);
  const body = raiz.kids.find((k) => k.name === "body") || raiz;
  // subárvore da matéria: o menor elemento que contém o primeiro e o último parágrafo, subindo enquanto couber no orçamento
  let el = profundo(body, a);
  while (el.parent && (el.end <= b || el.start > a)) el = el.parent;
  while (el.parent && el.parent !== body && el.parent !== raiz && tamanho(el.parent) <= MAX_REGIAO) el = el.parent;
  if (tamanho(el) > MAX_REGIAO * 1.4) console.warn(`  aviso: ${nome}: subárvore da matéria com ${Math.round(tamanho(el) / 1024)} KB`);

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /(?:property|name)=["'](?:og:title|og:description|description|twitter:title|twitter:description)["']/i.test(t));
  const titulo = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, nome])[1].trim();
  const cab = `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title>\n${metas.join("\n")}\n` +
    lds.map((j) => `<script type="application/ld+json">${j}</script>`).join("\n") + `\n</head>\n`;
  const fx = `${cab}<body>\n${isca(body, corpo, false)}\n<!-- trecho omitido -->\n${envolver(el, corpo)}\n<!-- trecho omitido -->\n${isca(body, corpo, true)}\n</body></html>\n`;
  // e-mail de jornalista (vem no JSON-LD de autoria) é dado pessoal e não ajuda o teste: sai
  return fx.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "autor@exemplo.invalid");
}

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html")).sort()) {
  const nome = f.replace(/\.html$/, "");
  if (only.length && !only.includes(nome)) continue;
  const fx = enxugar(fs.readFileSync(path.join(dir, f), "utf8"), nome);
  fs.writeFileSync(path.join(out, f), fx);
  const r = extractDetailed(fx);
  console.log(nome.padEnd(22), String(Math.round(fx.length / 1024)).padStart(3) + " KB", "texto:", r.text.length, "via:", r.via, "container:", r.container);
}

// Leitura do texto de uma matéria a partir do HTML (sem DOM, sem dependências).
//
// Por que não basta "o primeiro <article>": muitos sites aninham <article> (cartões de "leia mais", vídeos) e o g1 põe
// cada parágrafo num <div> próprio. Aqui o texto é achado pelos parágrafos: cada <p> útil soma seu tamanho a todos os
// elementos que o contêm, e vence o contêiner com mais texto de parágrafo e menos "ruído" (menus, links, legendas).
//
// CPU: o plano gratuito do Cloudflare dá ~10 ms por requisição. Por isso é uma única passada de regex sobre as tags,
// <script>/<style>/<svg> são pulados com busca nativa e nenhum laço é quadrático (busca de fechamento limitada).
import { fold, squash } from "./text.js";

// ---------- entidades HTML ----------
const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml").split(" ");
const ENT = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
  bdquo: "„", hellip: "…", bull: "•", trade: "™", euro: "€", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", lrm: "", rlm: "",
  prime: "′", Prime: "″", minus: "−", larr: "←", rarr: "→", oelig: "œ", OElig: "Œ", scaron: "š", Scaron: "Š", dagger: "†",
};
LATIN1.forEach((n, i) => { ENT[n] = String.fromCharCode(0xa0 + i); });

/** Decodifica entidades nomeadas comuns (português incluso) e numéricas (&#39; &#x27;). O que não conhece, deixa como está. */
export function decodeEntities(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,9});/g, (all, e) => {
    if (e.charCodeAt(0) === 35) {
      const n = (e.charCodeAt(1) | 32) === 120 ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (n === 9 || n === 10 || n === 13) return " ";
      return n > 31 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return ENT[e] ?? all;
  });
}
const plain = (s) => squash(decodeEntities(s));

// ---------- limites e pesos (ajustados com páginas reais de g1, Folha, Estadão, Poder360, Gazeta, CartaCapital...) ----------
const MIN_PARA = 40;          // parágrafo mínimo para contar como texto da matéria
const MIN_LOOSE = 80;         // texto solto (fora de <p>, ex.: <div> com <br>) mínimo
const MIN_ITEM = 35;          // item de lista (<li>) mínimo, só dentro do contêiner vencedor
const MAX_LINK = 0.5;         // parágrafo com mais da metade em links é chamada, não texto
const MIN_FRAME = 120;        // contêiner com menos texto que isso nem é candidato
const GAMMA = 1.0;            // quanto cada caractere de ruído desconta de um caractere de texto
const LD_MIN = 400;           // articleBody menor que isso não serve
const MAX_LD = 300000;        // JSON-LD gigante não vale o parse
const MAX_OUT = 20000;        // texto devolvido
const MAX_HTML = 1000000;      // entrada maior que isso é cortada (fetchPage já limita a 900 KB; isto vale para quem chamar direto)
const MAX_TAGS = 150000;      // trava contra HTML patológico
const MAX_DEPTH = 400;
const SEARCH_DEPTH = 60;      // quantos níveis olhar para achar o elemento que um </tag> fecha

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const INLINE = new Set("a abbr b bdi bdo big cite code data del dfn em font i ins kbd label mark q s samp small span strike strong sub sup time tt u var".split(" "));
const RAW = new Set(["script", "style", "noscript", "svg", "template", "iframe", "textarea", "title"]);
const EXCL = new Set(["figure", "figcaption", "nav", "aside", "footer", "form", "button", "select"]);
const AUTO = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], option: ["option"] };
const P_END = new Set("div ul ol table section article main h1 h2 h3 h4 h5 h6 blockquote pre form header footer aside nav figure dl fieldset address".split(" "));
const LOOSE_BAD = new Set("h1 h2 h3 h4 h5 h6 button option select summary th legend dt figcaption label".split(" "));
const POS = /article|content|post|entry|materia|texto|body|noticia|story/;
const NEG = /comment|sidebar|related|recommend|widget|newsletter|promo|share|menu|footer|trending|mais-?lidas|cookie|banner|publicidade|advert|breadcrumb|social|outbrain|taboola|modal|popup|consent|lgpd|ler-?tambem|leia-?tambem|veja-?tambem|saiba-?mais|vale-?ler/;
// Blocos que, DENTRO do contêiner vencedor, são só ruído (cartões de "leia também", comentários, modais): seus parágrafos saem.
const BAD = /comment|sidebar|related|recommend|widget|newsletter|promo|trending|mais-?lidas|share|social|cookie|modal|popup|consent|lgpd|banner|publicidade|advert|outbrain|taboola|ler-?tambem|leia-?tambem|veja-?tambem|saiba-?mais|vale-?ler/;

// Chamadas que não são texto da matéria (comparadas sem acento e em minúsculas).
const CTA = /^(leia (tambem|mais|a seguir|abaixo|aqui)|veja (tambem|mais|abaixo|a seguir)|assista|inscreva-se|receba|siga (o|a|os|as|no|na|nas)\b|publicidade|continua apos a publicidade|newsletter|ouca|compartilhe|clique|baixe|cadastre-se|assine|apoie|fique por dentro|participe d|entre (no|na) (grupo|canal)|continue (lendo|a ler)|leia a (materia|reportagem) completa)/;
// Marcas de fim de matéria: o que vem depois é rodapé ou lista de outras notícias.
const END = /^(copyright|todos os direitos|direitos reservados|mais lidas|conteudo relacionado|noticias relacionadas|veja mais noticias|comentarios)/;

// Tag de abertura/fechamento, testada só na posição de cada "<" (sticky). Atributos limitados a 4000 repetições e as falhas
// são contadas (MAX_FAILS): assim "<a " repetido sem nenhum ">" custa um trabalho limitado, não uma varredura por "<".
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*'){0,4000})>/y;
const MAX_FAILS = 3000;
const CLOSERS = new Map([...RAW].map((n) => [n, new RegExp("</" + n + "\\b", "gi")]));
const LD_TYPE = /ld\+json/i;

// Valores de id/class/itemprop do elemento, em minúsculas (calculado só para quem tem texto).
function keyOf(f) {
  if (f.key === undefined) {
    const m = f.at.length > 6 ? f.at.toLowerCase().match(/\b(?:id|class|itemprop)\s*=\s*(?:"[^"]*"|'[^']*')/g) : null;
    f.key = m ? m.join(" ") : "";
  }
  return f.key;
}
function weight(f) {
  if (f.n === "body" || f.n === "html") return 0.8; // a classe do <body> (ex.: "single-post" no WordPress) não diz nada sobre a matéria
  let w = f.n === "article" || f.n === "main" ? 1.3 : 1;
  const key = keyOf(f);
  if (key) {
    if (/itemprop\s*=\s*["']articlebody/.test(key)) w *= 1.4;
    if (POS.test(key)) w *= 1.25;
    if (NEG.test(key)) w *= 0.4;
  }
  return w;
}

function parse(html, dbg) {
  const meta = Object.create(null);
  let titleTag = "";
  const ld = [];
  const paras = [];           // textos de parágrafo (ainda com entidades), em ordem
  const stack = [];           // elementos abertos
  const bad = [];             // [início, fim, texto] de blocos de ruído com parágrafos
  let okTotal = 0, textTotal = 0, badT = 0, badA = 0, bestScore = 0, best = null, bestFrame = null;
  let cur = null, aDepth = 0, excl = 0;
  let loose = "", looseLen = 0, looseLink = 0;
  let last = 0, guard = 0;

  const endParagraph = () => {
    const c = cur; cur = null; aDepth = 0;
    if (!c || c.ex) return;
    const t = c.buf.replace(/\s+/g, " ").trim();
    if (t.length >= MIN_PARA && c.link <= MAX_LINK * c.len) { paras.push(t); okTotal += t.length; }
  };
  const flushLoose = () => {
    if (loose === "") return;
    const top = stack[stack.length - 1];
    if (top && !LOOSE_BAD.has(top.n)) {
      if (looseLen >= MIN_LOOSE && looseLink <= MAX_LINK * looseLen) {
        const t = loose.replace(/\s+/g, " ").trim();
        if (t.length >= MIN_LOOSE) { paras.push(t); okTotal += t.length; }
      } else if (top.n === "li" && looseLen >= MIN_ITEM && looseLink <= 0.2 * looseLen) {
        // item de lista curto ("As exportações somaram US$ 34 bilhões"): traz números úteis, mas só vale dentro do contêiner
        // vencedor; por isso entra em `paras` sem somar em okTotal (não influencia a escolha do contêiner)
        const t = loose.replace(/\s+/g, " ").trim();
        if (t.length >= MIN_ITEM && t.split(" ").length >= 5) paras.push(t);
      }
    }
    loose = ""; looseLen = 0; looseLink = 0;
  };
  const closeFrame = (f) => {
    if (f.ex) excl--;
    if (f.n === "p") { endParagraph(); return; }
    // texto do contêiner sem o dos blocos de ruído que ele contém (esses saem do resultado de qualquer jeito)
    const T = okTotal - f.t0 - (badT - f.b0), A = textTotal - f.a0 - (badA - f.ba0);
    if (okTotal > f.t0 && f.n !== "body" && f.n !== "html" && BAD.test(keyOf(f))) {
      bad.push([f.p0, paras.length, okTotal - f.t0]);
      badT += okTotal - f.t0 - (badT - f.b0);
      badA += textTotal - f.a0 - (badA - f.ba0);
    }
    if (T < MIN_FRAME) return;
    // texto de parágrafo vale; o resto do texto do contêiner (menus, links, legendas) é descontado
    const sc = ((1 + GAMMA) * T - GAMMA * A) * weight(f);
    if (dbg) dbg.push({ n: f.n, at: f.at.slice(0, 90), T, A, sc: Math.round(sc), p0: f.p0, p1: paras.length });
    if (sc > bestScore) { bestScore = sc; best = [f.p0, paras.length]; bestFrame = f.n; }
  };
  const popTo = (i) => { while (stack.length > i) closeFrame(stack.pop()); };
  const closeOpenP = () => {
    for (let i = stack.length - 1, n = 0; i >= 0 && n < SEARCH_DEPTH; i--, n++) if (stack[i].n === "p") { popTo(i); return; }
    cur = null;
  };
  const readMeta = (at) => {
    if (!at.includes("og:") && !at.includes("description") && !at.includes("twitter:")) return;
    const k = at.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    if (!k) return;
    const key = k[1].toLowerCase();
    if (key !== "og:title" && key !== "og:description" && key !== "description" && key !== "twitter:description" && key !== "twitter:title") return;
    const v = at.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (v && !meta[key]) meta[key] = v[1] ?? v[2];
  };

  // Texto entre a última marcação e `upTo`: vai para o parágrafo aberto ou vira "texto solto".
  const takeText = (upTo) => {
    if (upTo <= last) return;
    const seg = html.slice(last, upTo);
    const tl = seg.trim().length;
    if (tl) {
      textTotal += tl;
      if (cur) { if (!cur.ex) { cur.buf += seg; cur.len += tl; if (aDepth) cur.link += tl; } }
      else if (excl === 0) { loose += seg; looseLen += tl; if (aDepth) looseLink += tl; }
    } else if (cur) { if (!cur.ex) cur.buf += " "; } else if (loose !== "") loose += " ";
  };

  // Nada depois do último ">" pode ser tag. Cortar aí (e sair se não há nenhum) evita varreduras inúteis.
  const lastGt = html.lastIndexOf(">");
  if (lastGt < 0) return { meta, titleTag, ld, paras, best, bestFrame, bad };
  if (lastGt < html.length - 1) html = html.slice(0, lastGt + 1);
  let from = 0, fails = 0;
  for (;;) {
    const pos = html.indexOf("<", from);
    if (pos < 0 || ++guard > MAX_TAGS) break;
    if (html.charCodeAt(pos + 1) === 33) { // "<!": comentário, doctype ou CDATA
      takeText(pos);
      const isComment = html.startsWith("<!--", pos);
      const end = isComment ? html.indexOf("-->", pos + 4) : html.indexOf(">", pos + 2);
      last = from = end < 0 ? html.length : end + (isComment ? 3 : 1);
      continue;
    }
    TAG.lastIndex = pos;
    const m = TAG.exec(html);
    if (m === null) { // "<" que não abre tag (ex.: "a<b"): continua sendo texto
      if (++fails > MAX_FAILS) break;
      from = pos + 1;
      continue;
    }
    takeText(pos);
    last = from = TAG.lastIndex;
    const name = m[2].toLowerCase();
    const at = m[3];

    if (m[1] === "/") {
      if (INLINE.has(name)) { if (name === "a" && aDepth > 0) aDepth--; continue; }
      if (VOID.has(name)) continue;
      flushLoose();
      for (let i = stack.length - 1, n = 0; i >= 0 && n < SEARCH_DEPTH; i--, n++) if (stack[i].n === name) { popTo(i); break; }
      continue;
    }
    const selfClose = at.charCodeAt(at.length - 1) === 47;
    if (VOID.has(name)) {
      if (name === "br") { if (cur) { if (!cur.ex) cur.buf += " "; } else flushLoose(); }
      else if (name === "meta") readMeta(at);
      else if (name === "hr") flushLoose();
      continue;
    }
    if (INLINE.has(name)) { if (name === "a" && !selfClose) aDepth++; continue; }
    if (RAW.has(name)) { // conteúdo que não é texto: pula até o fechamento com busca nativa
      if (selfClose) continue;
      const re = CLOSERS.get(name);
      re.lastIndex = last;
      const c = re.exec(html);
      const end = c ? c.index : html.length;
      if (name === "script") { if (LD_TYPE.test(at) && end - last < MAX_LD) ld.push(html.slice(last, end)); }
      else if (name === "title" && !titleTag) titleTag = html.slice(last, end);
      const gt = c ? html.indexOf(">", end) : -1;
      last = from = gt < 0 ? html.length : gt + 1;
      continue;
    }

    flushLoose();
    if (cur && (name === "p" || P_END.has(name))) closeOpenP(); // <p> sem </p>
    const auto = AUTO[name];
    if (auto && stack.length && auto.includes(stack[stack.length - 1].n)) popTo(stack.length - 1);
    if (selfClose || stack.length >= MAX_DEPTH) continue;
    // <form> logo abaixo de <body> é o invólucro da página (ASP.NET), não um formulário de comentários
    const ex = EXCL.has(name) && !(name === "form" && stack.length <= 3);
    if (ex) excl++;
    stack.push({ n: name, at, p0: paras.length, t0: okTotal, a0: textTotal, b0: badT, ba0: badA, ex });
    if (name === "p") { cur = { buf: "", len: 0, link: 0, ex: excl > 0 }; aDepth = 0; }
  }
  flushLoose();
  popTo(0);
  endParagraph();
  return { meta, titleTag, ld, paras, best, bestFrame, bad };
}

// ---------- JSON-LD ----------
function walk(n, out, depth) {
  if (!n || typeof n !== "object" || depth > 8) return;
  if (Array.isArray(n)) { for (const x of n) walk(x, out, depth + 1); return; }
  if (typeof n.articleBody === "string") out.push(n.articleBody);
  for (const k in n) { const v = n[k]; if (v && typeof v === "object") walk(v, out, depth + 1); }
}
function ldArticleBody(blocks) {
  let best = "";
  for (const raw of blocks) {
    if (raw.indexOf("articleBody") < 0) continue;
    const found = [];
    try { walk(JSON.parse(raw), found, 0); } catch {
      // JSON inválido (quebra de linha crua dentro da string é comum): tenta só o campo
      const m = raw.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
      if (m) { try { found.push(JSON.parse('"' + m[1].replace(/[\u0000-\u001f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + '"')); } catch { /* ignora */ } }
    }
    for (const s of found) if (s.length > best.length) best = s;
  }
  if (!best) return [];
  if (best.includes("<")) best = best.replace(/<\/(?:p|div|li|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ");
  return best.split(/\n+/).map(plain).filter(Boolean);
}

// ---------- limpeza ----------
// Legenda de foto que veio dentro de um <p>: "Foto: Fulano/Agência" no começo ou "(crédito: Fulano)" no fim.
const CAPTION_END = /\((credito|foto|imagem|reproducao|divulgacao)\s*[:\/][^)]{0,100}\)\s*$/;
const isCaption = (p, head) => (p.length < 160 && /^(foto|credito|imagem)\s*:/.test(head)) || CAPTION_END.test(fold(p.slice(-130)));

/** Tira chamadas, repetições e a cauda (rodapé, "mais lidas"); junta com quebra de linha. */
function clean(list) {
  const out = [], seen = new Set();
  let total = 0;
  for (const p of list) {
    if (p.length < 30) continue;
    const head = fold(p.slice(0, 60)).trim();
    if (total >= 300 && (END.test(head) || p.charCodeAt(0) === 169)) break; // 169 = ©
    if (CTA.test(head)) continue;
    if (p.length < 400 && isCaption(p, head)) continue;
    const key = p.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    total += p.length + 1;
    if (total > MAX_OUT) break;
  }
  // manchetes de "leia também" no fim: curtas e sem pontuação final (parágrafo de matéria quase sempre termina com ponto)
  while (out.length > 1 && out[out.length - 1].length < 120 && !/[.!?…:;"”’)»\]]$/.test(out[out.length - 1])) out.pop();
  return out.join("\n");
}

/**
 * Lê título, descrição e texto da matéria. Nunca lança erro.
 * `via` e `container` existem para diagnóstico (scripts e testes); extractText devolve só os três campos.
 */
export function extractDetailed(html, dbg) {
  try { return analyze(String(html || ""), dbg); } catch { return { title: "", description: "", text: "", via: "erro", container: "" }; }
}
export function extractText(html) {
  const { title, description, text } = extractDetailed(html);
  return { title, description, text };
}

function analyze(html, dbg) {
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
  const { meta, titleTag, ld, paras, best, bestFrame, bad } = parse(html, dbg);
  const title = plain(meta["og:title"] || titleTag || meta["twitter:title"] || "");
  const description = plain(meta["og:description"] || meta.description || meta["twitter:description"] || "");

  let inBest = [];
  if (best) {
    const [p0, p1] = best;
    const bestT = paras.slice(p0, p1).reduce((n, t) => n + t.length, 0);
    // ruído aninhado e pequeno (cartões "leia também", comentários) sai; se o "ruído" é a própria matéria, fica
    const cut = bad.filter(([a, b, t]) => a >= p0 && b <= p1 && t < bestT * 0.5);
    inBest = paras.slice(p0, p1).filter((_, i) => !cut.some(([a, b]) => p0 + i >= a && p0 + i < b));
  }
  let via = "paragrafos", container = bestFrame || "";
  let text = clean(inBest.map(plain));
  if (text.length < 300) { // não achou contêiner bom: todos os parágrafos da página
    const all = clean(paras.filter((p) => p.length >= 60).map(plain));
    if (all.length > text.length) { text = all; via = "todos"; container = ""; }
  }

  const body = clean(ldArticleBody(ld));
  if (body.length >= LD_MIN) {
    const a = text.length, b = body.length;
    // O JSON-LD às vezes traz manchetes relacionadas coladas no fim; o que o leitor vê (parágrafos) é mais confiável.
    // Ele só vence se tiver bem mais texto (parágrafos incompletos) ou se os parágrafos forem inúteis e ele plausível.
    const useLd = !a || (a > b * 3 || b > a * 3 ? a < 600 && b >= 600 && b <= 12000 : b > a * 1.25);
    if (useLd) { text = body; via = "json-ld"; container = ""; }
  }
  return { title: title.trim(), description: description.trim(), text: text.slice(0, MAX_OUT), via, container };
}

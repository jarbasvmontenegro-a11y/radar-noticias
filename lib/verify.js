// Lógica pura do verificador (sem rede, fácil de testar): leitura das avaliações das agências e checagem de municípios.
import { fold, tokens } from "./text.js";

export { tokens }; // continua exportado daqui: o verificador e os testes importam de lib/verify.js

// ---------- avaliação das agências ----------
// "Fato ou Fake" e "Verdade ou mentira" são nomes de série, não vereditos: saem antes de classificar.
const SERIE = /\b(?:fato ou fake|verdade ou mentira)\b/g;

// Vereditos explícitos, confiáveis até em títulos longos (texto sem acento, minúsculo). A ordem importa:
// "não é verdade" precisa ser visto antes de "é verdade".
const EXPLICITOS = [
  ["falso", /#(?:fake|falso|falsa)\b|(?:^|[^a-z])(?:e|eh|sao)\s+#?(?:falso|falsa|falsos|falsas|fake|mentira)\b|^#?(?:fake|falso|falsa)\s*[:,.!?-]|\b(?:falso|falsa) que\b|\bnao (?:e|eh) (?:verdade|verdadeiro|verdadeira|fato)\b|\bnao procede\b/],
  ["enganoso", /\benganos[oa]s?\b|\b(?:distorcid|descontextualiz)\w*|\b(?:fora de|sem|omite) contexto\b|\b(?:e|eh|sao) (?:exagerad[oa]s?|imprecis[oa]s?|insustentave(?:l|is))\b/],
  ["misto", /\b(?:e|eh) (?:parcialmente|em parte)\b|\bverdad(?:e|eiro|eira),? mas\b|\bmeia[- ]verdade\b|^#?misto\b|\bparcialmente (?:verdadeir|falso|correto)/],
  ["verdadeiro", /#(?:fato|verdade|verdadeiro|verdadeira)\b|(?:^|[^a-z])(?:e|eh|sao)\s+#?(?:fato|verdade|verdadeiro|verdadeira|verdadeiros|verdadeiras|comprovad[oa]s?)\b|^#?(?:fato|verdadeiro|verdadeira)\s*[:,.!?-]/],
];
// Rótulos curtos ("Falso", "Distorcido"): aqui palavras soltas já bastam, porque o texto é só o veredito.
const ROTULOS = [
  ["falso", /\b(?:nao e verdade|fals[oa]s?|fake|golpe|boato|manipulad[oa]|fabricad[oa]|sem evidencias?|inventad[oa]|nao procede|mentira)\b/],
  ["enganoso", /(?:enganos|distorc|descontextual|sem contexto|fora de contexto|exager|impreciso|insustentavel|alterad)/],
  ["misto", /(?:parcial|misto|em parte|discutivel|verdad(?:e|eiro),? mas|ressalva|nao e bem assim)/],
  ["verdadeiro", /\b(?:verdadeir[oa]s?|verdade|correto|comprovad[oa]|confirmad[oa]|real|procede|fato)\b/],
];

function limpar(s) {
  return fold(s ?? "").replace(SERIE, " ").replace(/\s+/g, " ").trim();
}
function explicito(r) {
  for (const [classe, re] of EXPLICITOS) {
    const m = re.exec(r);
    if (m) return { classe, resto: r.slice(m.index + m[0].length) }; // resto = o que vem depois do veredito (a afirmação checada)
  }
  return { classe: "desconhecido", resto: r };
}

/** Classe ("falso" | "enganoso" | "misto" | "verdadeiro" | "desconhecido") da avaliação textual de uma agência. */
export function classifyRating(rating) {
  const r = limpar(rating);
  if (!r) return "desconhecido";
  const c = explicito(r).classe;
  if (c !== "desconhecido" || r.length > 60) return c; // texto longo é frase, não rótulo: só vale veredito explícito
  for (const [classe, re] of ROTULOS) if (re.test(r)) return classe;
  return "desconhecido";
}

/**
 * Classe a partir do TÍTULO de uma checagem (itens do índice, sem avaliação separada). Só vereditos explícitos
 * ("É falso que", "#FAKE", "Não é verdade", "É verdade que", "#FATO", "enganoso"...): palavras soltas num título
 * ("golpe", "fake") são assunto, não conclusão. Sem veredito reconhecível devolve "desconhecido".
 */
export function classifyTitle(title) {
  return explicito(limpar(title)).classe;
}

const NEGACAO = /\b(?:nao|nunca|jamais|nem|ninguem|nenhum|nenhuma|sem)\b/;
/** O texto tem negação ("não", "nunca", "sem"...)? */
export const temNegacao = (s) => NEGACAO.test(fold(s));

/**
 * Como classifyTitle, mas diz também se a afirmação checada (o que vem depois do veredito) tem negação.
 * Serve para não inverter o sentido: "É falso que o governo vai taxar o Pix" vale para quem diz que VAI taxar,
 * não para quem diz que NÃO vai. Quem usa compara com a negação do texto do leitor.
 */
export function titleVerdict(title) {
  const { classe, resto } = explicito(limpar(title));
  return { classe, negado: NEGACAO.test(resto) };
}

export function aggregate(classes) {
  if (!classes.length) return "sem_checagem";
  const c = (k) => classes.filter((x) => x === k).length;
  const neg = c("falso") + c("enganoso");
  if (neg && !c("verdadeiro")) return c("falso") >= c("enganoso") ? "falso" : "enganoso";
  if (c("verdadeiro") && !neg && !c("misto")) return "verdadeiro";
  return "misto";
}

// ---------- municípios ----------
/** Minúsculas, sem acento nem pontuação ("Santa Bárbara d'Oeste" -> "santa barbara d oeste"). */
export const normalizeName = (s) => fold(s ?? "").replace(/[^a-z0-9]+/g, " ").trim();

const UFS = new Set("ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to".split(" "));
// "Fortaleza/CE", "Fortaleza - CE", "Fortaleza (CE)": a sigla não faz parte do nome
function semUF(nome) {
  const m = String(nome ?? "").match(/^(.{3,}?)\s*(?:[-/,(]\s*)([A-Za-z]{2})\)?\s*$/);
  return m && UFS.has(m[2].toLowerCase()) ? m[1] : String(nome ?? "");
}

/**
 * Índice dos municípios a partir de [[nome, UF], ...]. Nada é normalizado aqui: com 5.571 nomes isso custaria vários
 * milissegundos de CPU (o plano gratuito dá ~10 ms por requisição); cada nome é normalizado só quando uma consulta o examina.
 */
export function buildMunicipalityIndex(lista) {
  if (!Array.isArray(lista)) return { itens: [], norm: [] };
  const comNome = (it) => Array.isArray(it) && typeof it[0] === "string" && it[0] !== "";
  // a lista oficial já vem no formato certo e é usada como veio: copiar os 5.571 itens custa ~1 ms de CPU
  const itens = lista.every((it) => comNome(it) && typeof it[1] === "string") ? lista : lista.filter(comNome).map((it) => [it[0], String(it[1] || "")]);
  return { itens, norm: new Array(itens.length) };
}

// Distância de edição (inserir, apagar, trocar ou inverter duas letras vizinhas), calculada só numa faixa estreita
// e abandonada assim que passa de `max`; devolve max + 1 nesse caso.
function distancia(a, b, max) {
  const la = a.length, lb = b.length, INF = max + 1;
  if (Math.abs(la - lb) > max) return INF;
  let p2 = new Array(lb + 1).fill(INF), p1 = new Array(lb + 1).fill(INF), cur = new Array(lb + 1).fill(INF);
  for (let j = 0; j <= Math.min(lb, max); j++) p1[j] = j;
  for (let i = 1; i <= la; i++) {
    cur.fill(INF);
    if (i <= max) cur[0] = i;
    let melhor = cur[0];
    for (let j = Math.max(1, i - max), fim = Math.min(lb, i + max); j <= fim; j++) {
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, p2[j - 2] + 1);
      if (v > INF) v = INF;
      cur[j] = v;
      if (v < melhor) melhor = v;
    }
    if (melhor > max) return INF;
    const t = p2; p2 = p1; p1 = cur; cur = t;
  }
  return p1[lb];
}

const primeiraLetra = (s) => { const c = s.charCodeAt(0); return c < 128 ? c | 32 : fold(s[0]).charCodeAt(0); };

/**
 * Pedaços de `q` separados por uma letra: max + 1 deles (2 para max 1, 3 para max 2). Cada edição (trocar, apagar,
 * inserir ou inverter duas letras vizinhas) mexe em no máximo duas posições vizinhas, então estraga no máximo um pedaço;
 * logo todo nome a `max` edições de `q` contém algum pedaço inteiro. Serve para pular a distância da maioria dos nomes.
 */
function pedacos(q, max) {
  const L = q.length, cortes = max === 1 ? [L >> 1] : [Math.floor(L / 3), Math.floor((2 * L) / 3)];
  const out = [];
  let ini = 0;
  for (const c of cortes) { out.push(q.slice(ini, c)); ini = c + 1; }
  out.push(q.slice(ini));
  return out;
}

/**
 * { existe, uf? } se o nome está na lista; { existe: false, parecido, uf } se é quase igual a um nome da lista
 * (erro de grafia provável: distância <= 1, ou <= 2 em nomes com 12+ letras, ou o nome é só o começo de um município maior);
 * { existe: false } quando nada se parece: município inexistente.
 *
 * Duas passadas porque cada normalização custa CPU (isolate frio, plano gratuito): a primeira só olha nomes que começam
 * com a mesma letra e resolve o caso comum (município que existe); a segunda, mais cara, só roda se o nome não foi achado.
 */
export function checkMunicipality(nome, indice) {
  const q = normalizeName(semUF(nome));
  const itens = indice?.itens;
  if (!q || !itens?.length) return { existe: false };
  const norm = (i) => (indice.norm[i] ??= normalizeName(itens[i][0]));
  const q0 = q.charCodeAt(0);
  let comeco = -1; // município cujo nome COMEÇA com o nome consultado ("Olho" para "Olho d'Água")
  for (let i = 0; i < itens.length; i++) {
    const bruto = itens[i][0];
    if (bruto.length < q.length || primeiraLetra(bruto) !== q0) continue; // o nome bruto nunca é menor que o normalizado
    const n = norm(i);
    if (n === q) return { existe: true, uf: itens[i][1] };
    if (comeco < 0 && n.startsWith(q + " ")) comeco = i;
  }
  const max = q.replace(/ /g, "").length >= 12 ? 2 : 1;
  const algum = new RegExp(pedacos(q, max).join("|")); // só letras, números e espaço: não precisa escapar
  let melhor = -1, dMelhor = max + 1;
  for (let i = 0; i < itens.length; i++) {
    if (Math.abs(itens[i][0].length - q.length) > max + 1) continue; // nome bruto tem quase o mesmo tamanho do normalizado
    const n = norm(i);
    if (n === q) return { existe: true, uf: itens[i][1] }; // nome com pontuação no começo, que a 1ª passada não viu
    if (!algum.test(n)) continue;
    const d = distancia(q, n, dMelhor - 1 < max ? dMelhor - 1 : max);
    if (d < dMelhor) { dMelhor = d; melhor = i; }
  }
  const i = melhor >= 0 ? melhor : comeco;
  return i >= 0 ? { existe: false, parecido: itens[i][0], uf: itens[i][1] } : { existe: false };
}

// Lugares que não são município brasileiro e que uma IA ou uma regex podem confundir com um: países, capitais
// estrangeiras, estados e regiões. Nunca viram "município inexistente".
const NAO_MUNICIPAIS = new Set((
  "brasil;estados unidos;eua;portugal;argentina;paraguai;uruguai;chile;bolivia;peru;venezuela;colombia;equador;cuba;mexico;canada;franca;alemanha;italia;espanha;" +
  "inglaterra;reino unido;china;russia;ucrania;israel;gaza;ira;iraque;japao;india;angola;mocambique;africa do sul;egito;turquia;paris;londres;lisboa;madri;roma;berlim;" +
  "nova york;new york;washington;miami;orlando;los angeles;buenos aires;montevideu;assuncao;santiago;lima;bogota;caracas;havana;toquio;pequim;moscou;kiev;jerusalem;" +
  "tel aviv;bruxelas;genebra;vaticano;california;texas;florida;nova iorque;chicago;boston;houston;san francisco;las vegas;dallas;seattle;atlanta;filadelfia;detroit;toronto;vancouver;montreal;cidade do mexico;" +
  "barcelona;sevilha;coimbra;braga;amsterda;viena;praga;varsovia;budapeste;atenas;istambul;ancara;teera;bagda;cairo;dubai;riad;doha;cabul;nova delhi;mumbai;xangai;hong kong;seul;bangcoc;jacarta;sydney;melbourne;" +
  "johannesburgo;luanda;maputo;lagos;nairobi;casablanca;tunis;argel;" +
  "norte;nordeste;sul;sudeste;centro oeste;amazonia;pantanal;cerrado;" +
  "acre;alagoas;amapa;amazonas;bahia;ceara;distrito federal;espirito santo;goias;maranhao;mato grosso;mato grosso do sul;minas gerais;para;paraiba;parana;pernambuco;" +
  "piaui;rio de janeiro;rio grande do norte;rio grande do sul;rondonia;roraima;santa catarina;sao paulo;sergipe;tocantins"
).split(";"));

/** True para países, capitais estrangeiras, estados e regiões (nomes que não valem como município). */
export const ehNaoMunicipal = (nome) => NAO_MUNICIPAIS.has(normalizeName(semUF(nome)));

const CONTEXTO = /\b(?:prefeit[oa]s?|prefeitura|municipi\w*|cidade|vereador\w*|camara municipal|secretaria municipal|munic[ei]pes?)\b/;

/**
 * O nome aparece no texto, e perto dele há palavra de contexto municipal ("prefeito de", "cidade de", "vereador")?
 * Só nesse caso "município inexistente" vale como evidência: sem o contexto o nome pode ser bairro, distrito, cidade
 * estrangeira ou outra coisa qualquer.
 */
export function temContextoMunicipal(texto, nome) {
  const t = " " + normalizeName(texto) + " ", n = " " + normalizeName(semUF(nome)) + " ";
  const i = t.indexOf(n);
  return i >= 0 && CONTEXTO.test(t.slice(Math.max(0, i - 60), i + n.length + 40));
}

/** O nome (sem acento, maiúsculas nem pontuação) aparece literalmente no texto? */
export const aparece = (texto, nome) => (" " + normalizeName(texto) + " ").includes(" " + normalizeName(semUF(nome)) + " ");

// Plano B quando a IA falha: "prefeito de X", "município de X", "vereador de X", "Câmara Municipal de X"... com X em maiúsculas.
// Os verbos de contexto vão com a inicial explícita (sem flag i), senão \p{Lu} casaria minúsculas também.
const PALAVRA = "(?:\\p{Lu}[\\p{L}'’.-]*|d['’]\\p{Lu}\\p{L}*)";
const MENCAO = new RegExp(
  "(?:[Pp]refeit[oa]s?|[Pp]refeitura|[Mm]unic[ií]pio|[Cc]idade|[Vv]ereador(?:a|es|as)?|[Cc][aâ]mara [Mm]unicipal|[Ss]ecretaria [Mm]unicipal(?: d[aeo]s? \\p{L}+)?)" +
  "\\s+d[eoa]s?\\s+(" + PALAVRA + "(?:\\s+(?:d[eoa]s?\\s+)?" + PALAVRA + "){0,4})", "gu");

/** Nomes que o texto cita como município, pelo padrão "prefeito/prefeitura/município/cidade/vereador/câmara municipal de X". Até 3. */
export function findMunicipalityMentions(texto) {
  const out = [], vistos = new Set();
  for (const m of String(texto ?? "").matchAll(MENCAO)) {
    const nome = m[1].replace(/[.'’-]+$/, "").trim();
    const k = normalizeName(nome);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    out.push(nome);
    if (out.length === 3) break;
  }
  return out;
}

const LIGACAO = /^(?:d[eoa]s?|d['’].*)$/;

/**
 * Confere um nome achado por regex. O texto às vezes traz o município seguido do nome de uma pessoa, sem vírgula
 * ("prefeito de Fortaleza Evandro Leitão"): se o nome inteiro não existe, tenta os começos mais curtos. Um começo só vale
 * se a palavra seguinte não for "de/do/da" ("Serra do Cajueiro Seco" não vira o município "Serra").
 */
export function checkMention(nome, indice) {
  const inteiro = checkMunicipality(nome, indice);
  if (inteiro.existe || inteiro.parecido) return inteiro;
  const palavras = String(nome).split(/\s+/);
  for (let n = palavras.length - 1; n >= 1; n--) {
    if (LIGACAO.test(palavras[n]) || LIGACAO.test(palavras[n - 1])) continue;
    const c = checkMunicipality(palavras.slice(0, n).join(" "), indice);
    if (c.existe) return c;
  }
  return inteiro;
}

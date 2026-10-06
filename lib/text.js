// Utilitários de texto puros (sem rede), compartilhados por extract.js, verify.js e radar.js.
// Escritos para serem baratos: o plano gratuito do Cloudflare dá ~10 ms de CPU por requisição,
// e String.prototype.normalize("NFD") é lento quando aplicado a milhares de títulos.

const ACC = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ā: "a", ă: "a", ą: "a",
  ç: "c", ć: "c", č: "c",
  è: "e", é: "e", ê: "e", ë: "e", ē: "e", ė: "e", ę: "e", ě: "e",
  ì: "i", í: "i", î: "i", ï: "i", ī: "i",
  ñ: "n", ń: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ō: "o",
  ù: "u", ú: "u", û: "u", ü: "u", ū: "u",
  ý: "y", ÿ: "y", ß: "ss", œ: "oe", æ: "ae",
};
const NON_ASCII = /[^\x00-\x7f]/;
const NON_ASCII_G = /[^\x00-\x7f]/g;

/** Minúsculas e sem acento. Letras latinas viram a letra base; outros símbolos não ASCII viram espaço. */
export function fold(s) {
  s = String(s).toLowerCase();
  if (!NON_ASCII.test(s)) return s;
  return s.replace(NON_ASCII_G, (c) => {
    const k = c.charCodeAt(0);
    if (k >= 0x300 && k <= 0x36f) return ""; // acento combinante (texto já decomposto)
    return ACC[c] ?? " ";
  });
}

// Palavras comuns demais para servir de evidência.
const STOP = new Set("para como mais pelo pela pelos pelas sobre entre esta este essa esse isso aqui onde quando porque muito muita que com sem uma uns umas dos das nos nas nao sim foi sao ser tem vai vem ate apos desde contra todos todas".split(" "));
// Siglas de 3 letras que identificam o assunto (sem isso, "imposto sobre o Pix" perderia a palavra mais importante).
const SHORT_KEEP = new Set("pix stf stj tse tcu cpi sus".split(" "));
const WORD = /[a-z0-9]{3,}/g;

/** Termos distintos de um texto, na ordem em que aparecem (>= 4 letras, sem palavras vazias). */
export function tokens(s) {
  const m = fold(s).match(WORD);
  const out = [];
  if (m) for (const w of m) if ((w.length >= 4 || SHORT_KEEP.has(w)) && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}

// Termos genéricos do noticiário político: aparecem em centenas de manchetes e não provam que o assunto é o mesmo.
const GENERIC = new Set("governo federal brasil brasileiro brasileira brasileiros brasileiras presidente nacional ministro ministra ministros ministerio senado deputado deputada deputados camara congresso anuncia aprova diz afirma nova novo novas novos sobre projeto lei pais estado estados politica eleicao eleicoes candidato candidata campanha noticia noticias video mensagem circula redes sociais ontem hoje semana ano anos".split(" "));

/** Termos que servem para comparar assuntos: tokens() sem os genéricos. */
export const topicTerms = (s) => tokens(s).filter((w) => !GENERIC.has(w));

/** Quantos termos de `a` também estão em `b` (listas de termos distintos). */
export function sharedCount(a, b) {
  let n = 0;
  for (const w of a) if (b.includes(w)) n++;
  return n;
}

/** Texto em uma linha só, sem espaços repetidos e sem caracteres invisíveis. */
export const squash = (s) => String(s).replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "").replace(/\s+/g, " ").trim();

// Segundo nível "público" brasileiro e afins: "uol.com.br" é o domínio registrável, não "com.br".
const SLD = new Set("com org net gov edu mil jus leg mp adv".split(" "));

/** Domínio registrável de uma URL ("g1.globo.com" -> "globo.com"); serve para contar veículos DISTINTOS. Vazio se a URL não abre. */
export function sourceKey(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch { return ""; }
  const p = h.split(".");
  if (p.length <= 2) return h;
  const n = p.length;
  return p.slice(p[n - 1].length === 2 && SLD.has(p[n - 2]) ? -3 : -2).join(".");
}

/** Comparador para sort: entrada do índice mais recente primeiro (campo `p`, texto ISO); empate devolve 0 e mantém a ordem. */
export const maisRecente = (a, b) => {
  const x = String(a.p ?? ""), y = String(b.p ?? "");
  return y > x ? 1 : y < x ? -1 : 0;
};

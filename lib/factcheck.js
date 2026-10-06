// Agências de checagem: Google Fact Check Tools (com a chave) e, como reserva sem chave, as checagens que o próprio
// índice do site já traz (c === 1, coletadas por RSS de Lupa, Aos Fatos, Comprova, Estadão Verifica, Fato ou Fake...).
import { clip, log, parseHttpUrl, readLimitedText } from "./api.js";
import { MIN_TERMOS } from "./radar.js";
import { sharedCount, tokens } from "./text.js";
import { classifyRating, temNegacao, titleVerdict } from "./verify.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DECISIVAS = new Set(["falso", "verdadeiro"]); // vereditos que dependem do sentido (positivo ou negativo) da afirmação
const ROTULO = { falso: "Falso", enganoso: "Enganoso", verdadeiro: "Verdadeiro", misto: "Com ressalvas" };

/** Tira a chave (e qualquer coisa com cara de chave do Google) de um texto que vai para o diagnóstico. */
function sanear(env, texto) {
  let t = String(texto ?? "");
  if (env.FACTCHECK_API_KEY) t = t.split(env.FACTCHECK_API_KEY).join("[chave]");
  return t.replace(/AIza[0-9A-Za-z_-]{8,}/g, "[chave]").replace(/\s+/g, " ").trim();
}

/** "erro: 403 API_KEY_HTTP_REFERRER_BLOCKED: mensagem curta" a partir do corpo JSON de erro do Google (nunca inclui a chave). */
async function motivoDaFalha(env, r) {
  let extra = "";
  try {
    const e = JSON.parse(await readLimitedText(r, 4000)).error || {};
    const razao = (Array.isArray(e.details) ? e.details : []).map((d) => d?.reason).find((x) => typeof x === "string" && x) || e.status || "";
    const msg = sanear(env, e.message).slice(0, 100);
    extra = [sanear(env, razao), msg].filter(Boolean).join(": ");
  } catch { /* corpo que não é JSON: fica só o código HTTP */ }
  return `erro: ${r.status}${extra ? " " + extra : ""}`;
}

/**
 * Consulta o Google Fact Check Tools. Devolve { status, itens }: status é "ok", "sem_chave" ou "erro: <http> <motivo>".
 * "ok" com lista vazia quer dizer que ninguém checou; falha é outra coisa e o chamador precisa distinguir.
 *
 * Chaves restritas por "referenciador HTTP" no Google Cloud recusam chamadas feitas por servidor (sem Referer) com
 * 403 API_KEY_HTTP_REFERRER_BLOCKED; por isso a chamada leva o endereço do próprio site como Referer
 * (ou FACTCHECK_REFERER, se a chave foi restrita a outro endereço).
 * `desejados` são os termos da busca; `negado` diz se o texto do leitor tem negação (veja titleVerdict).
 */
export async function consultarGoogle(env, origin, busca, desejados, negado = false) {
  if (!env.FACTCHECK_API_KEY) return { status: "sem_chave", itens: [] };
  if (!busca) return { status: "ok", itens: [] };
  const u = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
  u.search = new URLSearchParams({ query: busca, languageCode: "pt", pageSize: "10", key: env.FACTCHECK_API_KEY }).toString();
  const pedir = () => fetch(u, { headers: { Referer: env.FACTCHECK_REFERER || origin + "/", Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  try {
    let r = await pedir();
    if (r.status === 429 || r.status >= 500) { await sleep(500); r = await pedir(); }
    if (!r.ok) {
      log("factcheck_fail", { status: r.status });
      return { status: await motivoDaFalha(env, r), itens: [] };
    }
    const d = await r.json();
    const itens = [];
    for (const claim of d.claims || []) {
      for (const rv of claim.claimReview || []) {
        const shared = sharedCount(desejados, tokens(`${claim.text || ""} ${rv.title || ""}`));
        // só aceita resultados com termos em comum, para não mostrar checagem de outro assunto
        if (shared < Math.min(2, desejados.length)) continue;
        if (!parseHttpUrl(rv.url)) continue; // nunca devolve link que não seja http(s)
        let classe = classifyRating(rv.textualRating);
        // "Falso" vale para a afirmação checada; se ela tem o sentido oposto ao do texto do leitor, a checagem só é "relacionada"
        if (DECISIVAS.has(classe) && temNegacao(claim.text || rv.title || "") !== negado) classe = "desconhecido";
        itens.push({
          agencia: clip(rv.publisher?.name || rv.publisher?.site || "Agência de checagem", 80),
          avaliacao: clip(rv.textualRating, 80),
          titulo: clip(rv.title || claim.text, 200),
          url: rv.url,
          data: (rv.reviewDate || "").slice(0, 10),
          classe: classe === "desconhecido" ? "" : classe,
          _s: shared,
        });
      }
    }
    return { status: "ok", itens };
  } catch (e) {
    log("factcheck_fail", { erro: String(e?.name || "erro").slice(0, 40) }); // sem a mensagem: ela pode trazer a URL com a chave
    return { status: "erro: sem resposta do Google", itens: [] };
  }
}

/** Reserva sem chave: checagens do índice (c === 1) cujo título compartilha termos com a busca. */
export function checagensDoIndice(index, desejados, negado = false) {
  const min = Math.min(MIN_TERMOS, desejados.length);
  if (!index || min < 1) return [];
  const itens = [];
  for (const { a, shared } of index.achar(desejados, min, (x) => x.c === 1)) {
    if (!parseHttpUrl(a.u)) continue;
    let { classe, negado: tn } = titleVerdict(a.t);
    if (DECISIVAS.has(classe) && tn !== negado) classe = "desconhecido";
    const ok = classe !== "desconhecido";
    itens.push({ agencia: clip(a.s, 80) || "Agência de checagem", avaliacao: ok ? ROTULO[classe] : "", titulo: clip(a.t, 200), url: a.u, data: String(a.p || "").slice(0, 10), classe: ok ? classe : "", _s: shared });
  }
  return itens;
}

/**
 * Junta Google e índice sem repetir URL. Os que têm veredito vêm primeiro (e entram no agregado); os demais viram
 * "checagem relacionada" (relacionada: true) e não entram. Devolve até 5, ainda com `classe` e `_s` (use publicas()).
 */
export function mesclarChecagens(...listas) {
  const vistos = new Set(), todos = [];
  for (const c of listas.flat()) {
    const k = c.url.replace(/\/$/, "");
    if (!vistos.has(k)) { vistos.add(k); todos.push(c); }
  }
  const porTermos = (a, b) => b._s - a._s;
  return [...todos.filter((c) => c.classe).sort(porTermos), ...todos.filter((c) => !c.classe).sort(porTermos)].slice(0, 5);
}

/** Formato de saída da API: sem os campos internos; checagem sem veredito leva relacionada: true. */
export const publicas = (lista) => lista.map((c) => ({ agencia: c.agencia, avaliacao: c.avaliacao, titulo: c.titulo, url: c.url, data: c.data, ...(c.classe ? {} : { relacionada: true }) }));

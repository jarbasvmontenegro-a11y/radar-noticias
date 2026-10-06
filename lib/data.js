// Dados locais que as funções leem do próprio site (publicados pelo build): índice de manchetes e lista de municípios.
//
// CPU: o plano gratuito do Cloudflare dá ~10 ms por requisição, e o índice tem ~1.500 manchetes. Por isso tudo aqui é
// guardado em memória por 5 minutos (o isolate costuma viver mais que isso) e calculado de forma preguiçosa:
// os títulos só são normalizados na primeira busca, e os termos de cada manchete só quando o pré-filtro a escolhe.
import { registerReset } from "./api.js";
import { fold, sharedCount, tokens } from "./text.js";
import { buildMunicipalityIndex } from "./verify.js";

const TTL = 300000; // 5 minutos

const semBarra = (u) => (u.endsWith("/") ? u.slice(0, -1) : u);

/** Índice de manchetes: [{ t: título, s: veículo, u: url, p: "2026-10-06T14:30", c?: 1 checagem, o?: 1 oficial, d?: descrição }]. */
export class NewsIndex {
  constructor(lista) {
    this.lista = lista.filter((a) => a && typeof a.t === "string" && a.t && typeof a.u === "string");
    this.dobrados = null; // títulos sem acento e em minúsculas, calculados na primeira busca
    this.termosDe = [];   // termos de cada manchete, sob demanda
  }
  termos(i) { return (this.termosDe[i] ??= tokens(this.lista[i].t)); }

  /**
   * Manchetes com pelo menos `min` dos `termos`. O pré-filtro olha só se algum termo aparece no título (uma chamada
   * nativa por manchete; pode ser pedaço de palavra: "sus" dentro de "suspeito"); a contagem e a conferência palavra a
   * palavra vêm depois, só nas que passaram. `aceita(a)` é um filtro extra (ex.: só checagens) e roda primeiro, por ser o mais barato.
   * Devolve [{ a, i, shared }].
   */
  achar(termos, min, aceita = () => true) {
    if (!termos.length || min < 1) return [];
    const f = (this.dobrados ??= this.lista.map((a) => fold(a.t)));
    const algum = new RegExp(termos.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
    const out = [];
    for (let i = 0; i < f.length; i++) {
      if (!aceita(this.lista[i]) || !algum.test(f[i])) continue;
      let n = 0;
      for (const w of termos) if (f[i].includes(w)) n++;
      if (n < min) continue;
      const shared = sharedCount(termos, this.termos(i));
      if (shared >= min) out.push({ a: this.lista[i], i, shared });
    }
    return out;
  }

  /** A entrada de uma URL (com ou sem barra no fim). */
  porUrl(url) {
    const k = semBarra(String(url));
    return this.lista.find((a) => semBarra(a.u) === k) || null;
  }
}

// Carrega um arquivo do site (pelo binding ASSETS quando existe) e guarda o resultado por 5 minutos.
// A promessa é guardada, então chamadas simultâneas dividem a mesma leitura; falha (null) não fica em cache.
function memo(carrega) {
  let desde = 0, p = null;
  registerReset(() => { desde = 0; p = null; }); // testes: resetHostsCache() limpa tudo
  return (env, origin) => {
    if (p && Date.now() - desde < TTL) return p;
    desde = Date.now();
    const atual = (p = carrega(env, origin).catch(() => null));
    atual.then((v) => { if (v === null && p === atual) p = null; });
    return atual;
  };
}
async function lerJson(env, origin, caminho) {
  const req = new Request(`${origin}${caminho}`);
  const r = env.ASSETS ? await env.ASSETS.fetch(req) : await fetch(req);
  return r.ok ? r.json() : null;
}

/** NewsIndex, ou null se o arquivo não está disponível. */
export const loadIndex = memo(async (env, origin) => {
  const lista = await lerJson(env, origin, "/data/search-index.json");
  return Array.isArray(lista) ? new NewsIndex(lista) : null;
});

/** Índice de municípios (veja buildMunicipalityIndex), ou null se o arquivo não está disponível. */
export const loadMunicipios = memo(async (env, origin) => {
  const lista = await lerJson(env, origin, "/data/municipios.json");
  return Array.isArray(lista) && lista.length ? buildMunicipalityIndex(lista) : null;
});

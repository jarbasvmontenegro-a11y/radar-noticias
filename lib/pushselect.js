// Escolhe, para cada inscrito, só as notícias que valem uma notificação. Função pura (testável).
// destaques: [{ id, t, u, f, n, temas[], ufs[], k: "assunto"|"checagem", p: pontuação }]
// reg: { p: prefs, s: [ids já enviados], d: "AAAA-MM-DD", n: enviados hoje }

export const LIMIARES = {
  top: { geral: 7, tema: 5, uf: 3 },
  importantes: { geral: 5, tema: 3, uf: 2 },
};
export const POR_RODADA = 2;
export const HORA_INICIO = 7, HORA_FIM = 22; // horário de Brasília: de madrugada ninguém quer notificação

export function horaBrasilia(agora = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(agora));
}
export function diaBrasilia(agora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

/** Por que este destaque interessa a esta pessoa? Devolve a pontuação (0 = não interessa). */
export function pontuar(d, prefs) {
  const lim = LIMIARES[prefs.nivel] || LIMIARES.top;
  if (d.k === "checagem") return prefs.checagens ? 100 + (d.n || 1) : 0;
  const n = d.n || 0;
  if (prefs.geral && n >= lim.geral) return n;
  if (prefs.temas.some((t) => d.temas?.includes(t)) && n >= lim.tema) return n - 1;
  if (prefs.ufs.some((u) => d.ufs?.includes(u)) && n >= lim.uf) return n - 2;
  return 0;
}

/**
 * Devolve { enviar: [destaques], estado: { s, d, n } }.
 * `reg.s` vazio e `primeira` = true: primeira vez que vemos a pessoa; marca tudo que existe como visto e não envia nada
 * (senão ela receberia uma enxurrada logo ao se inscrever).
 */
export function selecionar(destaques, reg, agora = new Date(), { porRodada = POR_RODADA } = {}) {
  const prefs = reg.p;
  const hoje = diaBrasilia(agora);
  const vistos = new Set(reg.s || []);
  const enviadosHoje = reg.d === hoje ? reg.n || 0 : 0;
  const estado = (extra = []) => ({ s: [...(reg.s || []), ...extra].slice(-60), d: hoje, n: enviadosHoje + extra.length });
  if (!reg.s) return { enviar: [], estado: { s: destaques.map((d) => d.id).slice(-60), d: hoje, n: 0 } };
  const h = horaBrasilia(agora);
  if (h < HORA_INICIO || h >= HORA_FIM) return { enviar: [], estado: estado() };
  const resta = Math.min(porRodada, prefs.max - enviadosHoje);
  if (resta <= 0) return { enviar: [], estado: estado() };
  const vistosUrl = new Set();
  const candidatos = destaques
    .filter((d) => !vistos.has(d.id))
    .map((d) => ({ d, p: pontuar(d, prefs) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p || (b.d.p || 0) - (a.d.p || 0));
  const escolhidos = [];
  for (const { d } of candidatos) {
    if (vistosUrl.has(d.u)) continue;
    vistosUrl.add(d.u);
    escolhidos.push(d);
    if (escolhidos.length >= resta) break;
  }
  return { enviar: escolhidos, estado: estado(escolhidos.map((d) => d.id)) };
}

/** Texto da notificação (curto: telas pequenas cortam o resto). */
export function montarCarga(d) {
  const corta = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
  const titulo = d.k === "checagem" ? "Checagem: pode ser falso" : d.n >= 2 ? `Em ${d.n} veículos` : "Radar de Notícias";
  return { t: corta(titulo, 60), b: corta(d.t, 180), u: d.u, id: d.id, f: corta(d.f || "", 60) };
}

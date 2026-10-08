// Descobre quais veículos bloqueiam a leitura automática das matérias (HTTP 401/403/451 ou página praticamente vazia).
// Resultado: data/bloqueados.json { "hosts": [...] }. O site usa a lista para NÃO oferecer resumo dessas matérias
// (o robô não consegue ler, e resumir só a manchete ou a notícia de outro veículo induz ao erro).
// Histerese para não oscilar: entra na lista quando TODAS as amostras falham; sai quando QUALQUER uma abre.
// Só reescreve o arquivo se a lista mudou (evita commit e deploy à toa).
import fs from "node:fs";
import { extractDetailed } from "../lib/extract.js";

const ARQ = "data/bloqueados.json";
const UA = "Mozilla/5.0 (compatible; RadarNoticiasBot/1.0)"; // o mesmo de lib/api.js (fetchPage)
const hostKey = (h) => h.toLowerCase().replace(/^www\./, "");

const artigos = JSON.parse(fs.readFileSync("data/articles.json", "utf8")).articles
  .filter((a) => a.kind === "noticia")
  .sort((a, b) => String(b.published).localeCompare(String(a.published)));
const amostras = new Map();
for (const a of artigos) {
  let h; try { h = hostKey(new URL(a.url).hostname); } catch { continue; }
  const l = amostras.get(h) || [];
  if (l.length < 2) { l.push(a.url); amostras.set(h, l); }
}

async function abre(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    if ([401, 403, 451].includes(r.status)) return false;
    if (!r.ok || !/html|xml/i.test(r.headers.get("content-type") || "")) return null; // erro passageiro (5xx, 404...): não conclui nada
    const t = extractDetailed((await r.text()).slice(0, 900000));
    return t.text.length >= 150 || t.description.length >= 60;
  } catch { return null; }
}

const antes = fs.existsSync(ARQ) ? new Set(JSON.parse(fs.readFileSync(ARQ, "utf8")).hosts || []) : new Set();
const hosts = [...amostras.keys()];
const resultado = new Map();
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < hosts.length) {
    const h = hosts[i++];
    resultado.set(h, await Promise.all(amostras.get(h).map(abre)));
  }
}));

const novo = new Set();
for (const [h, r] of resultado) {
  const falhou = r.filter((x) => x === false).length;
  const abriu = r.filter((x) => x === true).length;
  if (abriu > 0) continue;                       // alguma abriu: liberado
  if (falhou === r.length) novo.add(h);          // todas falharam: bloqueado
  else if (antes.has(h)) novo.add(h);            // sem conclusão (rede, 5xx): mantém como estava
}
// hosts que sumiram do índice (sem matéria recente) mantêm o estado anterior
for (const h of antes) if (!amostras.has(h)) novo.add(h);

const lista = [...novo].sort();
const igual = lista.length === antes.size && lista.every((h) => antes.has(h));
console.log(`sondar: ${hosts.length} veículos, bloqueados: ${lista.join(", ") || "nenhum"}${igual ? " (sem mudança)" : " (ATUALIZADO)"}`);
if (!igual || !fs.existsSync(ARQ)) fs.writeFileSync(ARQ, JSON.stringify({ hosts: lista }, null, 1) + "\n");

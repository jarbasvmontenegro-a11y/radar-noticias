// Diagnóstico: o que o extrator lê de matérias de uma fonte (uso: node scripts/diagnostico_texto.mjs diag <fonte> [quantas])
import fs from "node:fs";
import path from "node:path";
import { extractDetailed } from "../lib/extract.js";

const [out = "diag", fonte = "oeste", n = "12"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const store = JSON.parse(fs.readFileSync("data/articles.json", "utf8")).articles.filter((a) => a.source === fonte);
const curtas = store.filter((a) => /[?]p=/.test(a.url)).slice(0, 4);
const normais = store.filter((a) => !/[?]p=/.test(a.url)).slice(0, Number(n) - curtas.length);
const linhas = [`fonte=${fonte} total=${store.length}`];
for (const a of [...curtas, ...normais]) {
  try {
    const r = await fetch(a.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RadarNoticiasBot/1.0)", Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const html = (await r.text()).slice(0, 900000);
    const d = extractDetailed(html); const t = d.text;
    linhas.push(`\n## ${a.title}\n${a.url}\n-> ${r.url} status=${r.status} html=${html.length} texto=${t.length} via=${d.via} container=${d.container}\ndesc: ${d.description.slice(0, 120)}\n${t.slice(0, 260).replace(/\n/g, " ")}`);
  } catch (e) { linhas.push(`\n## ${a.title}\n${a.url}\nERRO ${e.message}`); }
}
// detalhe da primeira matéria normal: contêineres mais pontuados e onde aparece o texto da descrição
{
  const a = normais[0];
  const r = await fetch(a.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RadarNoticiasBot/1.0)" }, redirect: "follow" });
  const html = (await r.text()).slice(0, 900000);
  const dbg = [];
  extractDetailed(html, dbg);
  linhas.push(`\n\n# DETALHE ${a.url}`);
  for (const f of dbg.sort((x, y) => y.sc - x.sc).slice(0, 10)) linhas.push(`${f.n} sc=${f.sc} T=${f.T} A=${f.A} p=${f.p0}-${f.p1} ${f.at}`);
  const d = extractDetailed(html);
  const marca = d.description.slice(0, 40);
  const i = marca ? html.indexOf(marca.replace(/&/g, "&amp;")) : -1;
  linhas.push(`descricao no html em ${i}`);
  const j = html.indexOf("<article");
  linhas.push(`article em ${j}: ${j >= 0 ? html.slice(j, j + 600) : ""}`);
  const k = html.indexOf("J.R. Guzzo é jornalista");
  linhas.push(`bio Guzzo em ${k}; contexto antes: ${k >= 0 ? html.slice(Math.max(0, k - 700), k) : ""}`);
  const ps = [...html.matchAll(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/g)].map((m) => m[0].slice(0, 160));
  linhas.push("h1: " + JSON.stringify(ps.slice(0, 3)));
  const lds = [...html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].length + ":" + (m[1].includes("articleBody") ? "tem articleBody" : "sem body"));
  linhas.push("ld: " + lds.join(", "));
}
fs.writeFileSync(path.join(out, "texto.md"), linhas.join("\n"));

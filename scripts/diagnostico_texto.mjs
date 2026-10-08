// Diagnóstico: o que o extrator lê de matérias de uma fonte (uso: node scripts/diagnostico_texto.mjs diag <fonte> [quantas])
import fs from "node:fs";
import path from "node:path";
import { extractText } from "../lib/api.js";

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
    const t = extractText(html);
    linhas.push(`\n## ${a.title}\n${a.url}\n-> ${r.url} status=${r.status} html=${html.length} texto=${t.length}\n${t.slice(0, 260).replace(/\n/g, " ")}`);
  } catch (e) { linhas.push(`\n## ${a.title}\n${a.url}\nERRO ${e.message}`); }
}
fs.writeFileSync(path.join(out, "texto.md"), linhas.join("\n"));

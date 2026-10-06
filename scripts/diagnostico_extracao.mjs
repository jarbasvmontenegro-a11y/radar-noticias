// Diagnóstico: como o texto das matérias é lido hoje? Roda no GitHub Actions (rede livre).
// Para uma matéria de cada fonte mostra status, tamanho, se há JSON-LD com articleBody e quanto texto o extrator atual recupera.
// Guarda o HTML de algumas páginas (cortado) para montar testes reais do extrator.
import fs from "node:fs";
import path from "node:path";
import { extractText } from "../lib/api.js";

const out = process.argv[2] || "diag";
fs.mkdirSync(path.join(out, "html"), { recursive: true });

const UA_BOT = "Mozilla/5.0 (compatible; RadarNoticiasBot/1.0)";
const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SAVE = new Set(["g1", "folha", "estadao", "poder360", "cnn-brasil", "o-globo", "uol", "metropoles", "agencia-brasil", "valor", "correio-braziliense", "gazeta-do-povo", "cartacapital", "bbc-brasil"]);

const store = JSON.parse(fs.readFileSync("data/articles.json", "utf8")).articles;
const bySource = new Map();
for (const a of store) if (!bySource.has(a.source)) bySource.set(a.source, a);
const picks = [...bySource.values()].slice(0, 60);

function ldBodies(html) {
  const lens = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n.articleBody === "string") lens.push(n.articleBody.length);
        for (const v of Object.values(n)) walk(v);
      };
      walk(JSON.parse(m[1]));
    } catch { /* json inválido */ }
  }
  return lens;
}

async function get(url, ua) {
  const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ctype: r.headers.get("content-type") || "", html: buf.toString("utf8").slice(0, 900000), final: r.url };
}

const lines = [];
await Promise.all(picks.map(async (a, i) => {
  await new Promise((r) => setTimeout(r, i * 150));
  const row = { source: a.source, url: a.url };
  try {
    let r = await get(a.url, UA_BOT);
    row.status_bot = r.status;
    if (r.status >= 400) { const r2 = await get(a.url, UA_BROWSER); row.status_browser = r2.status; if (r2.status < 400) r = r2; }
    row.final = r.final !== a.url ? r.final : "";
    row.bytes = r.html.length;
    row.article_tags = (r.html.match(/<article\b/gi) || []).length;
    row.p_tags = (r.html.match(/<p\b/gi) || []).length;
    row.ld_articleBody = ldBodies(r.html);
    const t = extractText(r.html);
    row.text_len = t.text.length;
    row.desc_len = t.description.length;
    row.sample = t.text.slice(0, 140).replace(/\s+/g, " ");
    if (SAVE.has(a.source) && r.status < 400) fs.writeFileSync(path.join(out, "html", `${a.source}.html`), r.html.slice(0, 450000));
  } catch (e) {
    row.erro = String(e?.message || e).slice(0, 100);
  }
  lines.push(row);
}));

lines.sort((x, y) => x.source.localeCompare(y.source));
fs.writeFileSync(path.join(out, "extracao.json"), JSON.stringify(lines, null, 1));
const ok = lines.filter((l) => l.text_len >= 600).length;
const txt = [`${ok} de ${lines.length} matérias com texto >= 600 caracteres pelo extrator atual`, ""];
for (const l of lines) {
  txt.push(`${l.source.padEnd(22)} bot=${l.status_bot ?? "-"}${l.status_browser ? ` browser=${l.status_browser}` : ""} bytes=${l.bytes ?? "-"} article=${l.article_tags ?? "-"} p=${l.p_tags ?? "-"} ld=${JSON.stringify(l.ld_articleBody ?? [])} texto=${l.text_len ?? "-"} ${l.erro || ""}`);
}
fs.writeFileSync(path.join(out, "extracao.txt"), txt.join("\n"));
console.log(txt.slice(0, 40).join("\n"));

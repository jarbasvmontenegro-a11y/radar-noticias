// Mede a CPU do extrator de texto (lib/extract.js) sobre páginas HTML.
//   node scripts/medir_extracao.mjs [pasta ou arquivos .html ...] [--rodadas=30] [--ampliar=2]
// Padrão: as fixtures de tests/fixtures/html. Para páginas completas (ex.: as de diag/html), passe a pasta.
// --ampliar=K repete o corpo de cada página K vezes, para simular páginas perto do limite de 900 KB do fetchPage.
// Referência: o plano gratuito do Cloudflare dá ~10 ms de CPU por requisição, e o extrator ainda divide esse
// orçamento com a leitura da página, a chamada à IA e o JSON de resposta. A meta é ficar bem abaixo de 8 ms.
import fs from "node:fs";
import path from "node:path";
import { extractText } from "../lib/extract.js";

const args = process.argv.slice(2);
const opt = (nome, padrao) => Number((args.find((a) => a.startsWith(`--${nome}=`)) || "").split("=")[1]) || padrao;
const rodadas = opt("rodadas", 30);
const ampliar = opt("ampliar", 1);
const alvos = args.filter((a) => !a.startsWith("--"));
if (!alvos.length) alvos.push(new URL("../tests/fixtures/html/", import.meta.url).pathname);

const arquivos = alvos.flatMap((a) => (fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(a, f)) : [a]));
if (!arquivos.length) { console.error("nenhum .html encontrado"); process.exit(1); }

// CPU do processo (usuário + sistema), em milissegundos, ao redor de uma chamada
function cpuMs(fn) {
  const a = process.cpuUsage();
  const r = fn();
  const b = process.cpuUsage(a);
  return [(b.user + b.system) / 1000, r];
}
const mediana = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];

console.log(`${"página".padEnd(26)} ${"KB".padStart(5)} ${"1ª".padStart(7)} ${"mediana".padStart(8)} ${"máx".padStart(7)}  texto`);
let piorMediana = 0, primeira = true;
for (const f of arquivos) {
  let html = fs.readFileSync(f, "utf8");
  if (ampliar > 1) {
    const i = html.search(/<body[^>]*>/i), fim = html.lastIndexOf("</body>");
    if (i >= 0 && fim > i) { const corpo = html.slice(html.indexOf(">", i) + 1, fim); html = html.slice(0, html.indexOf(">", i) + 1) + corpo.repeat(ampliar) + html.slice(fim); }
  }
  const [frio, r] = cpuMs(() => extractText(html)); // a primeiríssima chamada do processo inclui compilação do JIT e das regex
  const t = [];
  for (let i = 0; i < rodadas; i++) t.push(cpuMs(() => extractText(html))[0]);
  const med = mediana(t);
  piorMediana = Math.max(piorMediana, med);
  console.log(`${path.basename(f).padEnd(26)} ${String(Math.round(html.length / 1024)).padStart(5)} ${frio.toFixed(2).padStart(7)} ${med.toFixed(2).padStart(8)} ${Math.max(...t).toFixed(2).padStart(7)}  ${r.text.length}${primeira ? "  (1ª chamada do processo, com JIT frio)" : ""}`);
  primeira = false;
}
console.log(`\nmaior mediana: ${piorMediana.toFixed(2)} ms de CPU (tempos em ms; ${rodadas} rodadas por página${ampliar > 1 ? `, corpo repetido ${ampliar}x` : ""})`);

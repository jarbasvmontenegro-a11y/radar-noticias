// Minifica os .js e .css da raiz do site gerado (uso: node scripts/minificar.mjs site/). Remove comentários e espaços.
// O código-fonte legível continua no repositório; só o que é publicado sai compacto. Falha de um arquivo não derruba o build:
// o arquivo original fica como estava (o build avisa).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function carregar() {
  for (const p of ["esbuild", "/opt/npm-tools/node_modules/esbuild"]) {
    try { return require(p); } catch { /* tenta a próxima */ }
  }
  return null;
}

const dir = process.argv[2];
const esbuild = carregar();
if (!esbuild) { console.log("minificar: esbuild não encontrado, arquivos publicados sem minificar"); process.exit(0); }
let antes = 0, depois = 0, falhas = 0;
for (const nome of fs.readdirSync(dir)) {
  const loader = nome.endsWith(".js") ? "js" : nome.endsWith(".css") ? "css" : null;
  if (!loader) continue;
  const f = path.join(dir, nome);
  const src = fs.readFileSync(f, "utf8");
  try {
    const r = esbuild.transformSync(src, { loader, minify: true, legalComments: "none", charset: "utf8" });
    fs.writeFileSync(f, r.code);
    antes += src.length; depois += r.code.length;
  } catch (e) { falhas++; console.log(`minificar: ${nome} ficou como estava (${String(e.message).split("\n")[0]})`); }
}
console.log(`minificar: ${antes} -> ${depois} bytes${falhas ? `, ${falhas} falha(s)` : ""}`);
process.exit(falhas ? 1 : 0);

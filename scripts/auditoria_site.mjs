// Auditoria de segurança do site NO AR (roda no GitHub Actions, que alcança o site).
// Procura segredos no que o visitante recebe, confere cabeçalhos, arquivos que não deveriam existir
// e como as APIs de IA respondem a quem não é o navegador do site. Nunca imprime valores de segredos.
import fs from "node:fs";

const SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
const out = process.argv[2] || "diag";
fs.mkdirSync(out, { recursive: true });
const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };

if (!SITE) { say("SITE_URL vazio: nada a auditar."); fs.writeFileSync(`${out}/auditoria.txt`, lines.join("\n")); process.exit(0); }

const SECRET_PATTERNS = [
  ["chave tipo sk- (DeepSeek/OpenAI)", /sk-[A-Za-z0-9_-]{20,}/],
  ["chave Google (AIza...)", /AIza[0-9A-Za-z_-]{30,}/],
  ["token GitHub", /(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["token Cloudflare (cfut_/cfat_/cfk_)", /cf[a-z]{2,3}_[A-Za-z0-9]{30,}/],
  ["Authorization/Bearer", /Bearer [A-Za-z0-9._-]{25,}/],
  ["chave privada", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["atribuição de segredo", /(api[_-]?key|secret|passwd|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-.]{16,}["']/i],
  ["Turnstile secret (0x4...)", /0x4[A-Za-z0-9_-]{30,}/],
];
const findings = [];
function scan(label, body) {
  for (const [name, rx] of SECRET_PATTERNS) {
    const m = body.match(rx);
    if (m) findings.push(`${label}: possível ${name} (trecho oculto, ${m[0].length} caracteres, começa com "${m[0].slice(0, 4)}")`);
  }
}

async function get(path, init = {}) {
  try {
    const r = await fetch(SITE + path, { redirect: "manual", signal: AbortSignal.timeout(20000), ...init });
    const body = await r.text();
    return { status: r.status, headers: r.headers, body, ctype: r.headers.get("content-type") || "" };
  } catch (e) { return { status: 0, headers: new Headers(), body: "", ctype: "", erro: String(e?.message || e).slice(0, 80) }; }
}

say(`# Auditoria de ${SITE}  (${new Date().toISOString().slice(0, 16)}Z)`);

// 1) o que o visitante recebe: HTML, scripts, dados
say("\n## 1. Segredos no que o visitante recebe");
const pages = ["/", "/verificador/", "/sobre/", "/privacidade/", "/app.js", "/share.js", "/style.css", "/manifest.webmanifest", "/robots.txt", "/sitemap.xml",
  "/data/search-index.json", "/data/allowed-hosts.json"];
const home = await get("/");
const extra = [...home.body.matchAll(/(?:src|href)=["'](\/[^"'#?]+\.(?:js|json|css|webmanifest))["']/g)].map((m) => m[1]);
for (const p of [...new Set([...pages, ...extra])]) {
  const r = await get(p);
  say(`${String(r.status).padEnd(4)} ${p}  ${r.ctype.split(";")[0]}  ${r.body.length} bytes${r.erro ? " " + r.erro : ""}`);
  if (r.status === 200) scan(p, r.body);
}
// sitekey do Turnstile e token de analytics são públicos por natureza; só informamos se existem
say(`Turnstile configurado no HTML: ${/data-turnstile="[^"]+"/.test(home.body) ? "SIM" : "NAO (data-turnstile vazio)"}`);
say(`Beacon de analytics no HTML: ${/cloudflareinsights/.test(home.body) ? "sim (o token dele é público por desenho)" : "não"}`);
say(findings.length ? "ACHADOS:\n- " + findings.join("\n- ") : "Nenhum padrão de segredo encontrado nos arquivos públicos.");

// 2) arquivos que não podem existir no ar
say("\n## 2. Arquivos que não deveriam estar públicos (esperado: 404)");
for (const p of ["/.env", "/.git/config", "/.git/HEAD", "/wrangler.toml", "/functions/api/resumir.js", "/functions/api/verificar.js", "/lib/api.js", "/package.json",
  "/config/site.json", "/config/sources.json", "/data/articles.json", "/data/health.json", "/data/status.json", "/.dev.vars", "/requirements.txt"]) {
  const r = await get(p);
  const html404 = r.status === 200 && /<title>/i.test(r.body) && !/json|javascript/.test(r.ctype);
  say(`${String(r.status).padEnd(4)} ${p}${r.status === 200 && !html404 ? "   <-- PUBLICO, conferir" : ""}${html404 ? "   (200 com página HTML: provável 404 amigável)" : ""}`);
  if (r.status === 200) scan(p, r.body);
}

// 3) cabeçalhos
say("\n## 3. Cabeçalhos da página inicial");
for (const h of ["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "cache-control", "access-control-allow-origin"]) {
  say(`${h.padEnd(28)} ${home.headers.get(h) || "(ausente)"}`);
}

// 4) APIs de IA vistas por quem NÃO é o navegador do site
say("\n## 4. APIs");
async function api(path, body, headers = {}, method = "POST") {
  const r = await get(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
  scan(`resposta de ${method} ${path}`, r.body);
  return r;
}
const org = { Origin: SITE };
const g = await api("/api/verificar", null, {}, "GET");
say(`GET /api/verificar -> ${g.status} (esperado 405)`);
const op = await api("/api/verificar", null, { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }, "OPTIONS");
say(`OPTIONS com origem estranha -> ${op.status}; allow-origin: ${op.headers.get("access-control-allow-origin") || "(ausente, bom)"}`);
const cross = await api("/api/verificar", { texto: "teste de auditoria de segurança do verificador" }, { Origin: "https://evil.example" });
say(`POST de origem estranha (evil.example) -> ${cross.status} (esperado 403)`);
const bad = await api("/api/verificar", { texto: "x".repeat(20000) }, org);
say(`POST gigante -> ${bad.status} (esperado 413); corpo: ${bad.body.slice(0, 80)}`);
const broken = await get("/api/resumir", { method: "POST", headers: { "Content-Type": "application/json", ...org }, body: "{quebrado" });
say(`POST JSON quebrado -> ${broken.status} (esperado 400); corpo: ${broken.body.slice(0, 80)}`);
const noOrigin = await api("/api/verificar", { texto: "A prefeitura anunciou ontem novo horário de funcionamento dos postos de saúde.", token: "" });
say(`POST SEM navegador (sem Origin, token vazio) -> ${noOrigin.status}   <-- se 200, qualquer script consegue usar a IA do site`);
say(`   corpo: ${noOrigin.body.slice(0, 140).replace(/\s+/g, " ")}`);
const tokenFake = await api("/api/verificar", { texto: "A prefeitura anunciou ontem novo horário de funcionamento das escolas.", token: "token-falso" }, org);
say(`POST com token falso -> ${tokenFake.status}   (200 = o servidor ignora o token; 403 = Turnstile ativo)`);
let art = null;
try { art = JSON.parse(fs.readFileSync("data/articles.json", "utf8")).articles.find((a) => /g1\.globo\.com/.test(a.url)); } catch { /* sem dados locais */ }
if (art) {
  const sum = await api("/api/resumir", { url: art.url, title: art.title, source: "g1", desc: art.desc || "", token: "" });
  say(`POST /api/resumir sem token -> ${sum.status}`);
}

say("\n## 5. Resumo");
say(findings.length ? `ATENCAO: ${findings.length} possível(is) segredo(s) exposto(s).` : "Sem segredos expostos nas respostas e nos arquivos públicos.");
say(`Proteção contra robôs (Turnstile): ${/data-turnstile="[^"]+"/.test(home.body) && tokenFake.status === 403 ? "ATIVA" : "INATIVA"}`);
fs.writeFileSync(`${out}/auditoria.txt`, lines.join("\n"));

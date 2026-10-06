// Cloudflare Turnstile (proteção contra robôs nas APIs de IA).
//   node scripts/turnstile.mjs testar       confere o que o token da Cloudflare pode fazer (não muda nada)
//   node scripts/turnstile.mjs configurar   cria o widget, guarda o segredo no projeto do Pages e mostra a sitekey
// Nunca imprime o token da Cloudflare nem o segredo do Turnstile.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const acao = process.argv[2] || "testar";
const out = process.argv[3] || "diag";
fs.mkdirSync(out, { recursive: true });
const { CF_TOKEN, CF_ACCOUNT, CF_PROJECT = "radar-noticias", SITE_URL = "" } = process.env;
const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const save = () => fs.writeFileSync(`${out}/turnstile.txt`, lines.join("\n"));

if (!CF_TOKEN || !CF_ACCOUNT) { say("Faltam CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID nos secrets do GitHub."); save(); process.exit(0); }

async function api(method, path, body) {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method, headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok && j.success !== false, j };
  } catch (e) { return { status: 0, ok: false, j: { errors: [{ message: String(e?.message || e).slice(0, 80) }] } }; }
}
const errs = (j) => (j.errors || []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") || "sem detalhe";

say(`# Turnstile / Cloudflare (${acao})  ${new Date().toISOString().slice(0, 16)}Z`);

// 1) o token enxerga o projeto do Pages? quais variáveis existem (só os NOMES)
const proj = await api("GET", `/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}`);
say(`\nPages: GET projeto ${CF_PROJECT} -> ${proj.status} ${proj.ok ? "ok" : errs(proj.j)}`);
if (proj.ok) {
  const dc = proj.j.result?.deployment_configs?.production || {};
  const vars = Object.entries(dc.env_vars || {}).map(([k, v]) => `${k}(${v?.type || "?"})`);
  say(`Variáveis de produção: ${vars.join(", ") || "(nenhuma)"}`);
  say(`KV: ${Object.keys(dc.kv_namespaces || {}).join(", ") || "(nenhum)"}`);
  say(`Domínios: ${(proj.j.result?.domains || []).join(", ")}`);
}

// 2) permissão de Turnstile
const list = await api("GET", `/accounts/${CF_ACCOUNT}/challenges/widgets?per_page=50`);
say(`\nTurnstile: listar widgets -> ${list.status} ${list.ok ? "ok" : errs(list.j)}`);
const widgets = list.ok ? list.j.result || [] : [];
for (const w of widgets) say(`  widget "${w.name}" sitekey=${w.sitekey} domínios=${(w.domains || []).join(",")} modo=${w.mode}`);
const canTurnstile = list.ok;
say(`\nO token tem permissão de Turnstile? ${canTurnstile ? "SIM" : "NAO (adicione 'Conta > Turnstile > Editar' ao token da Cloudflare, ou crie o widget no painel)"}`);

if (acao === "configurar") {
  if (!canTurnstile) { say("Não dá para configurar sem a permissão. Nada foi alterado."); save(); process.exit(0); }
  const host = (() => { try { return new URL(SITE_URL).hostname; } catch { return "radar-noticias.pages.dev"; } })();
  const NAME = "Radar de Notícias";
  let sitekey = "", secret = "";
  const mine = widgets.find((w) => w.name === NAME);
  if (mine) {
    sitekey = mine.sitekey;
    const rot = await api("POST", `/accounts/${CF_ACCOUNT}/challenges/widgets/${sitekey}/rotate_secret`, { invalidate_immediately: true });
    say(`Widget já existia; segredo renovado -> ${rot.status} ${rot.ok ? "ok" : errs(rot.j)}`);
    secret = rot.j.result?.secret || "";
  } else {
    const domains = [...new Set([host, "radar-noticias.pages.dev"])];
    const cr = await api("POST", `/accounts/${CF_ACCOUNT}/challenges/widgets`, { name: NAME, domains, mode: "managed", bot_fight_mode: false, region: "world", offlabel: false });
    say(`Criar widget -> ${cr.status} ${cr.ok ? "ok" : errs(cr.j)}`);
    sitekey = cr.j.result?.sitekey || ""; secret = cr.j.result?.secret || "";
  }
  if (!sitekey || !secret) { say("Não recebi sitekey/segredo; nada foi gravado no Pages."); save(); process.exit(0); }
  console.log(`::add-mask::${secret}`);

  // grava o segredo SÓ no projeto do Pages (wrangler mexe apenas nessa variável; as outras ficam como estão)
  const w = spawnSync("npx", ["--yes", "wrangler@latest", "pages", "secret", "put", "TURNSTILE_SECRET", "--project-name", CF_PROJECT],
    { input: secret, encoding: "utf8", env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT }, timeout: 120000 });
  const wout = `${w.stdout || ""}${w.stderr || ""}`.split(secret).join("***").replace(CF_TOKEN, "***").slice(-600);
  say(`wrangler pages secret put -> código ${w.status}\n${wout}`);
  const after = await api("GET", `/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}`);
  const names = Object.keys(after.j.result?.deployment_configs?.production?.env_vars || {});
  say(`Variáveis depois: ${names.join(", ")}`);
  say(`SITEKEY=${sitekey}`);
}
save();

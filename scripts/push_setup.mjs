// Garante que o projeto do Pages tem o segredo PUSH_SECRET (usado só entre o GitHub Actions e as rotas de envio).
// O valor é derivado do token da Cloudflare, então o GitHub e o site chegam ao mesmo segredo sem ninguém copiar nada.
// Não faz nada se o segredo já existe. Nunca derruba o fluxo principal.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const { CLOUDFLARE_API_TOKEN: tok, CLOUDFLARE_ACCOUNT_ID: conta, CF_PROJECT = "radar-noticias" } = process.env;
if (!tok || !conta) { console.log("Notificações: faltam credenciais da Cloudflare."); process.exit(0); }
try {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${conta}/pages/projects/${CF_PROJECT}`, {
    headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.log(`::warning::Notificações: não consegui ler o projeto (HTTP ${r.status}).`); process.exit(0); }
  const vars = j.result?.deployment_configs?.production?.env_vars || {};
  if (vars.PUSH_SECRET) { console.log("Notificações: segredo de envio já configurado."); process.exit(0); }
  const segredo = crypto.createHmac("sha256", tok).update("radar-push-v1").digest("hex");
  const w = spawnSync("npx", ["--yes", "wrangler@4", "pages", "secret", "put", "PUSH_SECRET", "--project-name", CF_PROJECT],
    { input: segredo, encoding: "utf8", env: { ...process.env, CLOUDFLARE_API_TOKEN: tok, CLOUDFLARE_ACCOUNT_ID: conta }, timeout: 120000 });
  const txt = `${w.stdout || ""}${w.stderr || ""}`.split(segredo).join("***").split(tok).join("***").slice(-300);
  console.log(w.status === 0 ? "Notificações: segredo de envio criado." : `::warning::Notificações: não consegui criar o segredo (${txt})`);
} catch (e) {
  console.log(`::warning::Notificações: ${String(e?.message || e).slice(0, 150)}`);
}

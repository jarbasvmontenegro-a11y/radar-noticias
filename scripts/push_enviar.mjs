// Envia as notificações da rodada. Roda no GitHub Actions depois da publicação. Nunca derruba o fluxo principal.
import crypto from "node:crypto";
import fs from "node:fs";
import { rodar } from "../lib/pushrun.js";

const { CLOUDFLARE_API_TOKEN, SITE_URL } = process.env;
if (!CLOUDFLARE_API_TOKEN || !SITE_URL) { console.log("Notificações: faltam CLOUDFLARE_API_TOKEN ou SITE_URL; nada a fazer."); process.exit(0); }
let destaques = [];
try { destaques = JSON.parse(fs.readFileSync("site/data/destaques.json", "utf8")); } catch { console.log("Notificações: sem destaques."); process.exit(0); }
const segredo = crypto.createHmac("sha256", CLOUDFLARE_API_TOKEN).update("radar-push-v1").digest("hex");
console.log(`::add-mask::${segredo}`);
try {
  const s = await rodar({ base: SITE_URL.replace(/\/$/, ""), segredo, destaques });
  console.log(`Notificações: ${s.inscritos} inscritos, ${s.enviadas} enviadas, ${s.novos} novos, ${s.removidos} removidos, ${s.falhas} falhas.`);
} catch (e) {
  console.log(`::warning::Notificações não enviadas: ${String(e?.message || e).slice(0, 200)}`);
}

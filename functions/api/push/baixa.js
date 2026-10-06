// POST /api/push/baixa  { atualizar: [{k, s, d, n}], remover: [k] }  (até 15 de cada: o Cloudflare limita as consultas por chamada)   (só o GitHub Actions, com o segredo)
// Registra o que foi enviado a cada inscrito (para não repetir nem passar do limite diário) e apaga inscrições vencidas.
import { fail, json, log, methodNotAllowed } from "../../../lib/api.js";
import { segredoConfere } from "../../../lib/push.js";

const CHAVE = /^push:[0-9a-f]{32}$/;

export async function onRequestPost({ request, env }) {
  try {
    if (!env.RADAR_KV) return fail("Serviço em configuração.", 503);
    if (!segredoConfere(env, request)) return fail("Não autorizado.", 401);
    let body;
    try { body = await request.json(); } catch { return fail("Pedido inválido."); }
    const atualizar = (Array.isArray(body?.atualizar) ? body.atualizar : []).filter((u) => CHAVE.test(u?.k)).slice(0, 15);
    const remover = (Array.isArray(body?.remover) ? body.remover : []).filter((k) => CHAVE.test(k)).slice(0, 15);
    let n = 0;
    for (const u of atualizar) {
      const reg = await env.RADAR_KV.get(u.k, "json").catch(() => null);
      if (!reg) continue; // a pessoa saiu enquanto enviávamos
      reg.s = Array.isArray(u.s) ? u.s.map(String).slice(-60) : reg.s;
      reg.d = typeof u.d === "string" ? u.d.slice(0, 10) : reg.d;
      reg.n = Math.max(0, Math.min(50, Number(u.n) || 0));
      await env.RADAR_KV.put(u.k, JSON.stringify(reg));
      n++;
    }
    for (const k of remover) await env.RADAR_KV.delete(k);
    return json({ ok: true, atualizados: n, removidos: remover.length });
  } catch (e) {
    log("baixa_erro", { erro: String(e?.message || e).slice(0, 80) });
    return fail("Erro inesperado.", 500);
  }
}
export const onRequest = () => methodNotAllowed();

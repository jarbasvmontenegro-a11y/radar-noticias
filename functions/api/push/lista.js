// GET /api/push/lista?cursor=...   (só o GitHub Actions, com o segredo)
// Devolve a chave VAPID privada e uma página de inscrições para o envio. 40 por página: o Cloudflare limita as
// consultas por chamada.
import { fail, json, log, methodNotAllowed } from "../../../lib/api.js";
import { lerOuCriarVapid, segredoConfere } from "../../../lib/push.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.RADAR_KV) return fail("Serviço em configuração.", 503);
    if (!segredoConfere(env, request)) return fail("Não autorizado.", 401);
    const cursor = new URL(request.url).searchParams.get("cursor") || undefined;
    const pg = await env.RADAR_KV.list({ prefix: "push:", limit: 40, cursor });
    const regs = await Promise.all(pg.keys.map(async (k) => ({ k: k.name, v: await env.RADAR_KV.get(k.name, "json").catch(() => null) })));
    const out = { subs: regs.filter((r) => r.v && r.v.e && r.v.p), cursor: pg.list_complete ? null : pg.cursor };
    if (!cursor) out.vapid = await lerOuCriarVapid(env);
    return json(out);
  } catch (e) {
    log("lista_erro", { erro: String(e?.message || e).slice(0, 80) });
    return fail("Erro inesperado.", 500);
  }
}
export const onRequest = () => methodNotAllowed();

// GET /api/push/chave -> { pub }  chave pública VAPID (o navegador precisa dela para se inscrever). Pública por natureza.
import { fail, json, log, methodNotAllowed } from "../../../lib/api.js";
import { lerOuCriarVapid } from "../../../lib/push.js";

export async function onRequestGet({ env }) {
  try {
    if (!env.RADAR_KV) return fail("Serviço em configuração. Tente mais tarde.", 503);
    const v = await lerOuCriarVapid(env);
    return json({ pub: v.pub });
  } catch (e) {
    log("chave_erro", { erro: String(e?.message || e).slice(0, 80) });
    return fail("Erro inesperado.", 500);
  }
}
export const onRequest = () => methodNotAllowed();

// POST /api/inscrever  { acao: "salvar" | "remover", sub: {endpoint, keys}, prefs: {...}, token? }
// Guarda (ou apaga) a inscrição de notificações do navegador e as preferências da pessoa. Não usa IA.
// O que fica no KV: o endereço de push do navegador, as chaves dele e as preferências. Nada de nome, e-mail ou IP.
import { checkLimits, checkTurnstile, fail, json, log, methodNotAllowed, preflight } from "../../lib/api.js";
import { chaveDaInscricao, inscricaoValida, prefsValidas } from "../../lib/push.js";

export const onRequest = () => methodNotAllowed();

export async function onRequestPost({ request, env }) {
  try {
    const pre = await preflight(request, env, 8192, { llm: false });
    if (pre.error) return pre.error;
    const { body } = pre;
    const sub = inscricaoValida(body.sub);
    if (!sub) return fail("Esse navegador não enviou uma inscrição válida de notificações.");
    const chave = await chaveDaInscricao(sub.endpoint);

    if (body.acao === "remover") {
      await env.RADAR_KV.delete(chave);
      return json({ ok: true });
    }
    if (body.acao !== "salvar") return fail("Pedido inválido.");
    const prefs = prefsValidas(body.prefs);
    if (!prefs) return fail("Escolha pelo menos um tipo de notícia para receber.");

    if (!(await checkTurnstile(env, request, body.token))) return fail("Não conseguimos confirmar que você é uma pessoa. Recarregue a página.", 403);
    const lim = await checkLimits(env, request, "inscrever");
    if (lim.error) return lim.error;

    // quem já estava inscrito mantém o histórico (o que já foi enviado hoje); só as preferências mudam
    const antes = await env.RADAR_KV.get(chave, "json").catch(() => null);
    const reg = { e: sub.endpoint, k: sub.keys, p: prefs, c: antes?.c || new Date().toISOString().slice(0, 10) };
    if (antes?.s) { reg.s = antes.s; reg.d = antes.d; reg.n = antes.n; }
    try { await env.RADAR_KV.put(chave, JSON.stringify(reg)); } catch { await lim.release(); return fail("Não foi possível salvar agora. Tente de novo em instantes.", 503); }
    log("inscrever", { novo: !antes });
    return json({ ok: true });
  } catch (e) {
    log("inscrever_erro", { erro: String(e?.message || e).slice(0, 80) });
    return fail("Erro inesperado. Tente de novo em instantes.", 500);
  }
}

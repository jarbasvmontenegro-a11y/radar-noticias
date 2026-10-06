// Uma rodada de envio: lê as inscrições no site, escolhe o que cada pessoa quer e envia. Separado do script para poder testar.
import { enviar as enviarPush } from "./webpush.js";
import { montarCarga, selecionar } from "./pushselect.js";

const em_lotes = (v, n) => Array.from({ length: Math.ceil(v.length / n) }, (_, i) => v.slice(i * n, (i + 1) * n));

export async function rodar({ base, segredo, destaques, agora = new Date(), fetchFn = fetch, enviarFn = enviarPush, log = console.log }) {
  const cab = { Authorization: `Bearer ${segredo}` };
  const stats = { inscritos: 0, enviadas: 0, removidos: 0, falhas: 0, novos: 0 };
  let cursor = null, vapid = null, primeira = true;
  const atualizar = [], remover = [];
  do {
    const url = `${base}/api/push/lista${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetchFn(url, { headers: cab, signal: AbortSignal.timeout(20000) });
    if (r.status === 401) throw new Error("O segredo de envio não confere com o do site (PUSH_SECRET).");
    if (!r.ok) throw new Error(`lista de inscritos: HTTP ${r.status}`);
    const pg = await r.json();
    if (primeira) { vapid = pg.vapid; primeira = false; }
    cursor = pg.cursor || null;
    for (const lote of em_lotes(pg.subs || [], 10)) {
      await Promise.all(lote.map(async ({ k, v }) => {
        stats.inscritos++;
        const { enviar, estado } = selecionar(destaques, v, agora);
        if (!v.s) stats.novos++;
        if (!enviar.length) {
          if (!v.s) atualizar.push({ k, ...estado }); // primeira vez: só marca o que já existe como visto
          return;
        }
        let acabou = false, ok = 0;
        for (const d of enviar) {
          try {
            const st = await enviarFn({ endpoint: v.e, keys: v.k }, montarCarga(d), vapid, { sub: base, fetchFn });
            if (st === 404 || st === 410) { acabou = true; break; }
            if (st >= 200 && st < 300) ok++; else stats.falhas++;
          } catch { stats.falhas++; }
        }
        if (acabou) { remover.push(k); stats.removidos++; return; }
        stats.enviadas += ok;
        if (ok) { const sent = enviar.slice(0, ok); atualizar.push({ k, ...selecionarEstado(v, sent, agora, estado) }); }
      }));
    }
  } while (cursor);
  for (let i = 0; i < Math.max(atualizar.length, remover.length); i += 15) {
    const corpo = { atualizar: atualizar.slice(i, i + 15), remover: remover.slice(i, i + 15) };
    const r = await fetchFn(`${base}/api/push/baixa`, { method: "POST", headers: { ...cab, "Content-Type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(20000) });
    if (!r.ok) log(`baixa: HTTP ${r.status}`);
  }
  return stats;
}

// se só parte dos envios deu certo, registra só o que de fato foi entregue
function selecionarEstado(reg, enviados, agora, estadoCheio) {
  const base = (reg.s || []);
  const hoje = estadoCheio.d;
  const antes = reg.d === hoje ? reg.n || 0 : 0;
  return { s: [...base, ...enviados.map((d) => d.id)].slice(-60), d: hoje, n: antes + enviados.length };
}

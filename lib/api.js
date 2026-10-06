// Utilitários compartilhados das funções /api/resumir e /api/verificar (Cloudflare Pages Functions).
// A IA só é chamada aqui, sob demanda. A busca por notícias nunca usa IA.
import { extractText } from "./extract.js";

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
export const fail = (msg, status = 400) => json({ erro: msg }, status);
export const methodNotAllowed = () => fail("Método não permitido.", 405);

/** Log estruturado, sem dados pessoais (aparece nos logs do Cloudflare). */
export function log(event, data = {}) {
  try { console.log(JSON.stringify({ event, ...data })); } catch { /* log nunca derruba a função */ }
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ---------- validação de URL (evita SSRF) ----------
export function parseHttpUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[")) return null; // IP literal
  if (/^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h)) return null; // IP em hex/decimal
  return u;
}

// ---------- leitura limitada (evita corpo gigante) ----------
export async function readLimitedText(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let out = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (size >= maxBytes) { try { await reader.cancel(); } catch { /* ok */ } break; }
  }
  return out.slice(0, maxBytes);
}

// ---------- proteção contra abuso e custo ----------
// Com TURNSTILE_SECRET configurado, só navegador de verdade (que resolveu o desafio no site) consegue chamar a IA.
// Sem ele, as APIs ficam em "modo aberto": funcionam, mas com limites bem menores (e o painel avisa).
export const protegido = (env) => Boolean(env.TURNSTILE_SECRET);

export async function checkTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET) return true; // modo aberto: os limites menores de checkLimits é que protegem
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    return d.success === true;
  } catch { return false; }
}

/**
 * Conta o uso do dia. Devolve { error } (Response) se estourou o limite,
 * ou { release } para devolver a cota quando a tentativa falha por culpa do serviço.
 * Se o contador (KV) falhar, NÃO libera: sem conseguir contar, a IA não é chamada (falha segura, protege o bolso).
 */
// Outros módulos (índice de notícias, municípios) registram aqui como limpar seus caches em memória.
const resetters = [];
export function registerReset(fn) { resetters.push(fn); }

// O KV não faz contagem atômica: 100 pedidos em paralelo podem ler "0" ao mesmo tempo e passar todos. Este contador em
// memória é síncrono (sem await antes do incremento), então dentro de uma mesma instância não há corrida. Não é global
// (cada instância tem o seu), mas corta a rajada; a defesa completa é o Turnstile + regra de limite de taxa da Cloudflare.
const memUso = new Map();
registerReset(() => memUso.clear());
function memTomar(chave, limite) {
  if (memUso.size > 5000) memUso.clear();
  const n = memUso.get(chave) || 0;
  if (n >= limite) return false;
  memUso.set(chave, n + 1);
  return true;
}
const memDevolver = (chave) => memUso.set(chave, Math.max(0, (memUso.get(chave) || 1) - 1));

export async function checkLimits(env, request, kind) {
  const open = !protegido(env);
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = (await sha256((env.IP_SALT || "radar") + ip)).slice(0, 24);
  const perIp = Number(env.IP_DAILY_LIMIT || (open ? 5 : 10));
  const cap = Number(env.DAILY_CAP || (open ? 300 : 1500));
  const day = today();
  const kIp = `rl:${kind}:${day}:${ipHash}`;
  const kAll = `cap:${kind}:${day}`;
  const busy = () => ({ error: fail("O serviço está muito procurado agora. Tente de novo mais tarde.", 503) });
  const kMem = kIp;
  if (!memTomar(kMem, perIp)) return { error: fail("Você atingiu o limite diário gratuito. Volte amanhã.", 429) };
  const pare = (r) => { memDevolver(kMem); return r; };
  let nIp, nAll;
  try {
    const [a, b] = await Promise.all([env.RADAR_KV.get(kIp), env.RADAR_KV.get(kAll)]);
    nIp = Number(a || 0); nAll = Number(b || 0);
  } catch { log("kv_falhou", { op: "get" }); return pare(busy()); }
  if (nIp >= perIp) return { error: fail("Você atingiu o limite diário gratuito. Volte amanhã.", 429) };
  if (nAll >= cap) { log("cap_reached", { kind }); return pare({ error: fail("O limite diário do serviço foi atingido. Tente amanhã.", 429) }); }
  try {
    await Promise.all([
      env.RADAR_KV.put(kIp, String(nIp + 1), { expirationTtl: 90000 }),
      env.RADAR_KV.put(kAll, String(nAll + 1), { expirationTtl: 90000 }),
    ]);
  } catch { log("kv_falhou", { op: "put" }); return pare(busy()); }
  const release = async () => {
    memDevolver(kMem);
    try {
      const [x, y] = await Promise.all([env.RADAR_KV.get(kIp), env.RADAR_KV.get(kAll)]);
      await Promise.all([
        env.RADAR_KV.put(kIp, String(Math.max(0, Number(x || 0) - 1)), { expirationTtl: 90000 }),
        env.RADAR_KV.put(kAll, String(Math.max(0, Number(y || 0) - 1)), { expirationTtl: 90000 }),
      ]);
    } catch { /* devolver a cota é "melhor esforço" */ }
  };
  return { release };
}

/** Verificações comuns. Devolve { body } ou { error: Response }. */
export async function preflight(request, env, maxBody = 16384, { llm = true } = {}) {
  if (!env.RADAR_KV || (llm && !env.LLM_API_KEY)) return { error: fail("Serviço em configuração. Tente mais tarde.", 503) };
  // Navegadores sempre mandam Origin num POST. Quem chama sem ele (curl, script) ou de outro site é recusado
  // ANTES de qualquer custo. (Não é prova de nada: o Turnstile é que garante; isto só barra o uso casual.)
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) return { error: fail("Origem não permitida.", 403) };
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return { error: fail("Origem não permitida.", 403) };
  if (!/application\/json/i.test(request.headers.get("Content-Type") || "")) return { error: fail("Pedido inválido.", 415) };
  if (Number(request.headers.get("Content-Length") || 0) > maxBody) return { error: fail("Pedido grande demais.", 413) };
  let text;
  try { text = await readLimitedText(request, maxBody + 1); } catch { return { error: fail("Pedido inválido.") }; }
  if (text.length > maxBody) return { error: fail("Pedido grande demais.", 413) };
  let body;
  try { body = JSON.parse(text); } catch { return { error: fail("Pedido inválido.") }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: fail("Pedido inválido.") };
  return { body };
}

// ---------- hosts permitidos (fontes monitoradas) ----------
let hostsCache = { at: 0, set: null };
export function resetHostsCache() {
  hostsCache = { at: 0, set: null };
  for (const fn of resetters) fn();
}
export async function allowedHosts(env, origin) {
  if (hostsCache.set && Date.now() - hostsCache.at < 300000) return hostsCache.set;
  const req = new Request(`${origin}/data/allowed-hosts.json`);
  const r = env.ASSETS ? await env.ASSETS.fetch(req) : await fetch(req);
  const list = r.ok ? await r.json() : [];
  hostsCache = { at: Date.now(), set: new Set(Array.isArray(list) ? list : []) };
  return hostsCache.set;
}
export const hostKey = (h) => h.toLowerCase().replace(/^www\./, "");

// ---------- leitura da página (só para resumo/verificação, não é republicada) ----------
// O extrator mora em lib/extract.js; é reexportado aqui para não quebrar quem já importa de lib/api.js.
export { extractText };

/** Busca a página seguindo redirecionamentos manualmente, validando CADA salto. */
export async function fetchPage(startUrl, isAllowed = () => true, { maxBytes = 900000, maxRedirects = 3 } = {}) {
  let url = parseHttpUrl(startUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!url || !isAllowed(url)) throw new Error("url nao permitida");
    const r = await fetch(url.href, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RadarNoticiasBot/1.0)", Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) throw new Error("redirecionamento invalido");
      try { url = parseHttpUrl(new URL(loc, url).href); } catch { url = null; }
      continue;
    }
    if (!r.ok) throw new Error("pagina " + r.status);
    if (!/html|xml/i.test(r.headers.get("content-type") || "")) throw new Error("tipo nao suportado");
    return extractText(await readLimitedText(r, maxBytes));
  }
  throw new Error("redirecionamentos demais");
}

// ---------- IA (qualquer API compatível com OpenAI), com retry e provedor reserva ----------
async function callLLM(cfg, { system, user, json: wantJson, maxTokens }) {
  const body = {
    model: cfg.model,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (wantJson) body.response_format = { type: "json_object" };
  let r;
  try {
    r = await fetch(cfg.base.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) { // timeout ou rede: vale tentar de novo
    const err = new Error("llm rede"); err.retryable = true; throw err;
  }
  if (!r.ok) { const err = new Error("llm " + r.status); err.status = r.status; err.retryable = r.status === 429 || r.status >= 500; throw err; }
  const d = await r.json().catch(() => ({}));
  return (d.choices?.[0]?.message?.content || "").trim();
}

export async function chat(env, opts) {
  const primary = { base: env.LLM_BASE_URL || "https://api.deepseek.com", key: env.LLM_API_KEY, model: env.LLM_MODEL || "deepseek-chat" };
  const fallback = env.LLM_FALLBACK_API_KEY && env.LLM_FALLBACK_BASE_URL && env.LLM_FALLBACK_MODEL
    ? { base: env.LLM_FALLBACK_BASE_URL, key: env.LLM_FALLBACK_API_KEY, model: env.LLM_FALLBACK_MODEL } : null;
  const args = { json: false, maxTokens: 450, ...opts };
  const attempt = async (cfg) => { try { return { text: await callLLM(cfg, args) }; } catch (err) { return { err }; } };

  let r = await attempt(primary);
  if (r.err?.retryable) { await sleep(600); r = await attempt(primary); }
  if (r.text === undefined && fallback) {
    log("llm_fallback", { status: r.err?.status });
    r = await attempt(fallback);
  }
  if (r.text === undefined) { log("llm_fail", { status: r.err?.status }); throw r.err; }
  return r.text;
}

export function parseJson(raw) {
  try { return JSON.parse(raw); } catch {
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* cai no retorno vazio */ } }
    return {};
  }
}

export const clip = (s, n) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
export const clipList = (arr, n, len) => (Array.isArray(arr) ? arr.map((x) => clip(String(x), len)).filter(Boolean).slice(0, n) : []);

// ---------- cache ----------
export async function cacheGet(env, key) {
  try {
    const v = await env.RADAR_KV.get(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; } // cache nunca derruba a função
}
export async function cachePut(env, key, obj) {
  try { await env.RADAR_KV.put(key, JSON.stringify(obj), { expirationTtl: 86400 }); } catch { /* ok */ }
}

// Utilitários compartilhados das funções /api/resumir e /api/verificar (Cloudflare Pages Functions).
// A IA só é chamada aqui, sob demanda. A busca por notícias nunca usa IA.

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
export async function checkTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET) return true; // opcional
  if (!token) return false;
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
 */
export async function checkLimits(env, request, kind) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = (await sha256((env.IP_SALT || "radar") + ip)).slice(0, 24);
  const perIp = Number(env.IP_DAILY_LIMIT || 10);
  const cap = Number(env.DAILY_CAP || 1500);
  const day = today();
  const kIp = `rl:${kind}:${day}:${ipHash}`;
  const kAll = `cap:${kind}:${day}`;
  const [a, b] = await Promise.all([env.RADAR_KV.get(kIp), env.RADAR_KV.get(kAll)]);
  const nIp = Number(a || 0), nAll = Number(b || 0);
  if (nIp >= perIp) return { error: fail("Você atingiu o limite diário gratuito. Volte amanhã.", 429) };
  if (nAll >= cap) { log("cap_reached", { kind }); return { error: fail("O limite diário do serviço foi atingido. Tente amanhã.", 429) }; }
  await Promise.all([
    env.RADAR_KV.put(kIp, String(nIp + 1), { expirationTtl: 90000 }),
    env.RADAR_KV.put(kAll, String(nAll + 1), { expirationTtl: 90000 }),
  ]);
  const release = async () => {
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
export async function preflight(request, env, maxBody = 16384) {
  if (!env.RADAR_KV || !env.LLM_API_KEY) return { error: fail("Serviço em configuração. Tente mais tarde.", 503) };
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return { error: fail("Origem não permitida.", 403) };
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
export function resetHostsCache() { hostsCache = { at: 0, set: null }; }
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
export function extractText(html) {
  const meta = (name) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i"));
    return m ? decode(m[1]) : "";
  };
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = meta("og:title") || (t ? decode(t[1]) : "");
  const description = meta("og:description") || meta("description");

  let body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ");
  const art = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
  if (art) body = art[0];
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40);
  return { title: title.trim(), description: description.trim(), text: paras.join("\n") };
}

function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Busca a página seguindo redirecionamentos manualmente, validando CADA salto. */
export async function fetchPage(startUrl, isAllowed = () => true, { maxBytes = 600000, maxRedirects = 3 } = {}) {
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

// Utilitários compartilhados das funções /api/resumir e /api/verificar (Cloudflare Pages Functions).
// A IA só é chamada aqui, sob demanda. A busca por notícias nunca usa IA.

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
export const fail = (msg, status = 400) => json({ erro: msg }, status);

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const today = () => new Date().toISOString().slice(0, 10);

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
  return u;
}

// ---------- proteção contra abuso e custo ----------
export async function checkTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET) return true; // opcional
  if (!token) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const d = await r.json();
    return d.success === true;
  } catch { return false; }
}

/** Devolve null se pode seguir, ou uma Response de erro. */
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
  if (nIp >= perIp) return fail("Você atingiu o limite diário gratuito. Volte amanhã.", 429);
  if (nAll >= cap) return fail("O limite diário do serviço foi atingido. Tente amanhã.", 429);
  await Promise.all([
    env.RADAR_KV.put(kIp, String(nIp + 1), { expirationTtl: 90000 }),
    env.RADAR_KV.put(kAll, String(nAll + 1), { expirationTtl: 90000 }),
  ]);
  return null;
}

/** Verificações comuns. Devolve { body } ou { error: Response }. */
export async function preflight(request, env) {
  if (!env.RADAR_KV || !env.LLM_API_KEY) return { error: fail("Serviço em configuração. Tente mais tarde.", 503) };
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return { error: fail("Origem não permitida.", 403) };
  let body;
  try { body = await request.json(); } catch { return { error: fail("Pedido inválido.") }; }
  if (!body || typeof body !== "object") return { error: fail("Pedido inválido.") };
  return { body };
}

// ---------- hosts permitidos (fontes monitoradas) ----------
let hostsCache = { at: 0, set: null };
export async function allowedHosts(env, origin) {
  if (hostsCache.set && Date.now() - hostsCache.at < 300000) return hostsCache.set;
  const req = new Request(`${origin}/data/allowed-hosts.json`);
  const r = env.ASSETS ? await env.ASSETS.fetch(req) : await fetch(req);
  const list = r.ok ? await r.json() : [];
  hostsCache = { at: Date.now(), set: new Set(list) };
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

export async function fetchPage(url, isAllowed = () => true) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; RadarNoticiasBot/1.0)", Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("pagina " + r.status);
  const finalUrl = parseHttpUrl(r.url || url);
  if (!finalUrl || !isAllowed(finalUrl)) throw new Error("redirecionamento nao permitido");
  const type = r.headers.get("content-type") || "";
  if (!/html|xml/i.test(type)) throw new Error("tipo nao suportado");
  const html = (await r.text()).slice(0, 600000);
  return extractText(html);
}

// ---------- IA (qualquer API compatível com OpenAI) ----------
export async function chat(env, { system, user, json: wantJson = false, maxTokens = 450 }) {
  const base = (env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const body = {
    model: env.LLM_MODEL || "deepseek-chat",
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (wantJson) body.response_format = { type: "json_object" };
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error("llm " + r.status);
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || "").trim();
}

export function parseJson(raw) {
  try { return JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* cai no retorno vazio */ } }
    return {};
  }
}

export const clip = (s, n) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
export const clipList = (arr, n, len) => (Array.isArray(arr) ? arr.map((x) => clip(String(x), len)).filter(Boolean).slice(0, n) : []);

// ---------- cache ----------
export async function cacheGet(env, key) {
  const v = await env.RADAR_KV.get(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export const cachePut = (env, key, obj) => env.RADAR_KV.put(key, JSON.stringify(obj), { expirationTtl: 86400 });

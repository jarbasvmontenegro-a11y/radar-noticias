// Notificações push: validação das inscrições, preferências e chaves VAPID.
// Roda nas Pages Functions (Workers) e no Node (GitHub Actions); só usa Web Crypto e funções padrão.

export const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
export const NIVEIS = ["top", "importantes"];

// Só serviços de push conhecidos dos navegadores. Sem isso, qualquer um poderia mandar o servidor chamar um endereço qualquer.
const HOSTS_PUSH = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]*\.?push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];

export function b64uToBytes(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export function bytesToB64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function endpointValido(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 700) return null;
  let u;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  return HOSTS_PUSH.some((rx) => rx.test(u.hostname)) ? u.href : null;
}

/** Valida e normaliza { endpoint, keys: { p256dh, auth } }. Devolve null se algo estiver fora do padrão. */
export function inscricaoValida(sub) {
  if (!sub || typeof sub !== "object") return null;
  const endpoint = endpointValido(sub.endpoint);
  if (!endpoint) return null;
  const { p256dh, auth } = sub.keys || {};
  try {
    const pk = b64uToBytes(p256dh), au = b64uToBytes(auth);
    if (pk.length !== 65 || pk[0] !== 4 || au.length !== 16) return null;
  } catch { return null; }
  return { endpoint, keys: { p256dh: String(p256dh), auth: String(auth) } };
}

const lista = (v, max, ok) => (Array.isArray(v) ? [...new Set(v.map(String).filter(ok))].slice(0, max) : []);

/** Preferências: o que a pessoa quer receber. Tudo é validado de novo no servidor. */
export function prefsValidas(p, temasConhecidos = null) {
  p = p && typeof p === "object" ? p : {};
  const temas = lista(p.temas, 12, (t) => /^[a-z0-9-]{1,30}$/.test(t) && (!temasConhecidos || temasConhecidos.includes(t)));
  const ufs = lista(p.ufs, 27, (u) => UFS.includes(u));
  const pessoas = lista(p.pessoas, 12, (x) => /^[a-z0-9-]{1,30}$/.test(x));
  const out = {
    geral: p.geral === true,
    temas, ufs, pessoas,
    checagens: p.checagens === true,
    nivel: NIVEIS.includes(p.nivel) ? p.nivel : "top",
    max: Math.min(5, Math.max(1, Math.round(Number(p.max)) || 3)),
  };
  // sem nenhuma escolha não há o que enviar
  if (!out.geral && !out.temas.length && !out.ufs.length && !out.pessoas.length && !out.checagens) return null;
  return out;
}

export async function chaveDaInscricao(endpoint) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "push:" + [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Par de chaves VAPID (ECDSA P-256). `pub` é o ponto não comprimido em base64url, como o navegador espera. */
export async function gerarVapid() {
  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", par.privateKey);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(b64uToBytes(jwk.x), 1);
  raw.set(b64uToBytes(jwk.y), 33);
  return { pub: bytesToB64u(raw), jwk: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y } };
}

export async function lerOuCriarVapid(env) {
  const atual = await env.RADAR_KV.get("vapid:v1", "json").catch(() => null);
  if (atual?.pub && atual?.jwk) return atual;
  const nova = await gerarVapid();
  await env.RADAR_KV.put("vapid:v1", JSON.stringify(nova));
  // se duas chamadas criaram ao mesmo tempo, vale a que ficou gravada
  return (await env.RADAR_KV.get("vapid:v1", "json").catch(() => null)) || nova;
}

/** Comparação em tempo (quase) constante, para o segredo das rotas de envio. */
export function segredoConfere(env, request) {
  const esperado = String(env.PUSH_SECRET || "");
  const recebido = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (esperado.length < 32 || recebido.length !== esperado.length) return false;
  let d = 0;
  for (let i = 0; i < esperado.length; i++) d |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return d === 0;
}

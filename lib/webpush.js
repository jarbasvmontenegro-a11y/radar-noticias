// Envio de Web Push (RFC 8030 + RFC 8291 aes128gcm + VAPID RFC 8292), só com node:crypto. Roda no GitHub Actions.
import crypto from "node:crypto";
import { b64uToBytes, bytesToB64u } from "./push.js";

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));

/** Criptografa `texto` para a inscrição { p256dh, auth } (base64url). Devolve o corpo da requisição. */
export function criptografar(texto, keys, { salt, par } = {}) {
  const uaPub = Buffer.from(b64uToBytes(keys.p256dh));
  const auth = Buffer.from(b64uToBytes(keys.auth));
  const ecdh = par || crypto.createECDH("prime256v1");
  if (!par) ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const segredo = ecdh.computeSecret(uaPub);
  salt = salt || crypto.randomBytes(16);
  const ikm = hkdf(auth, segredo, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const claro = Buffer.concat([Buffer.from(texto, "utf8"), Buffer.from([2])]); // 0x02 = último registro
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const cifrado = Buffer.concat([c.update(claro), c.final(), c.getAuthTag()]);
  const cab = Buffer.alloc(21);
  salt.copy(cab, 0);
  cab.writeUInt32BE(4096, 16);
  cab[20] = asPub.length;
  return Buffer.concat([cab, asPub, cifrado]);
}

/** JWT VAPID (ES256). `jwk` é a chave privada { kty, crv, d, x, y }. */
export function jwtVapid(jwk, endpoint, sub, agora = Date.now()) {
  const enc = (o) => bytesToB64u(Buffer.from(JSON.stringify(o)));
  const corpo = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(agora / 1000) + 11 * 3600, sub })}`;
  const chave = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const assinatura = crypto.sign("sha256", Buffer.from(corpo), { key: chave, dsaEncoding: "ieee-p1363" });
  return `${corpo}.${bytesToB64u(assinatura)}`;
}

/** Envia uma notificação. Resolve com o status HTTP (201 ok; 404/410 = inscrição acabou). */
export async function enviar({ endpoint, keys }, carga, vapid, { sub, ttl = 6 * 3600, urgencia = "normal", fetchFn = fetch } = {}) {
  const corpo = criptografar(JSON.stringify(carga), keys);
  const r = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "Content-Length": String(corpo.length),
      TTL: String(ttl), Urgency: urgencia,
      Authorization: `vapid t=${jwtVapid(vapid.jwk, endpoint, sub)}, k=${vapid.pub}`,
    },
    body: corpo,
    signal: AbortSignal.timeout(15000),
  });
  try { await r.arrayBuffer(); } catch { /* ignora corpo */ }
  return r.status;
}

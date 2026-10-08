import test from "node:test";
import assert from "node:assert/strict";
import { ARMADILHAS, cair, ehArmadilha } from "../lib/pote.js";
import { onRequest } from "../functions/[[rota]].js";

const req = (path) => new Request("https://radarnoticias.top" + path, { headers: { "CF-Connecting-IP": "1.2.3.4", "User-Agent": "scanner" } });
const semEspera = async () => {};

test("pote: reconhece os caminhos de robô e deixa o site em paz", () => {
  for (const p of ["/wp-login.php", "/wp-admin/", "/.env", "/.env.production", "/.git/config", "/phpmyadmin/index.php", "/xmlrpc.php"]) assert.ok(ehArmadilha(p), p);
  for (const p of ["/", "/assuntos/", "/sobre/", "/api/resumir", "/verificador/", "/estado/ce/", "/pessoa/lula/", "/politica-editorial/"]) assert.ok(!ehArmadilha(p), p);
  assert.ok(ARMADILHAS.length < 90); // o _routes.json do Cloudflare aceita até 100 regras
});

test("pote: quem cai recebe 404 sem nada do pedido refletido, e o IP não vai para o log", async () => {
  const logs = [], orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    const r = await cair(req("/wp-login.php?x=<script>"), semEspera);
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /script|wp-login/);
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => l.includes('"pote"')));
  assert.ok(!logs.some((l) => l.includes("1.2.3.4")));
});

test("pote: a rota pega-tudo só age nas armadilhas", async () => {
  let seguiu = false;
  const r = await onRequest({ request: req("/sobre/"), next: async () => { seguiu = true; return new Response("ok"); } });
  assert.equal(seguiu, true);
  assert.equal(await r.text(), "ok");
});

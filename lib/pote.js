// Pote de mel (honeypot): endereços que só robôs de invasão visitam (o site não tem WordPress, .env nem painel).
// Quem cai num deles recebe uma página "não encontrada" depois de alguns segundos (atrasa o robô; esperar não gasta
// CPU) e fica registrado nos logs da Cloudflare (país, rede, navegador, caminho), SEM o IP.
// De propósito NÃO bloqueia ninguém: no Brasil muita gente divide o mesmo IP (operadoras de celular), e um robô na
// mesma rede tiraria pessoas de verdade do site. As funções já são protegidas pelo Turnstile e pelos limites de uso.
// Também não grava nada no KV: um ataque em massa não gasta as escritas do plano grátis.
import { log } from "./api.js";

export const ARMADILHAS = [
  "/wp-*", "/wordpress*", "/xmlrpc.php", "/.env*", "/.git*", "/.aws*", "/.ssh*", "/phpmyadmin*", "/pma*",
  "/administrator*", "/config.php", "/configuration.php", "/vendor/phpunit*", "/cgi-bin/*", "/server-status",
  "/actuator*", "/boaform*", "/.DS_Store",
];
const RE = new RegExp("^(?:" + ARMADILHAS.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).join("|") + ")$", "i");
export const ehArmadilha = (pathname) => RE.test(pathname);

/** Trata uma visita a uma armadilha. `esperar(ms)` existe para os testes não dormirem. */
export async function cair(request, esperar = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const url = new URL(request.url), cf = request.cf || {};
  log("pote", { caminho: url.pathname.slice(0, 80), metodo: request.method, pais: cf.country || "", rede: cf.asn || "",
                navegador: (request.headers.get("User-Agent") || "").slice(0, 80) });
  await esperar(3000);
  return new Response("<!doctype html><title>Página não encontrada</title><p>Página não encontrada.</p>", {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

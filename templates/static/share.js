/* Mensagens prontas para compartilhar (WhatsApp). Funções puras: sem rede e sem DOM, fáceis de testar.
   Regra de ouro: só usamos linguagem de desmentido ("é falso") quando uma AGÊNCIA DE CHECAGEM concluiu isso. */
(function (root) {
  "use strict";
  var MAX = 1200; // mensagens muito longas são cortadas pelo app e ficam ruins de ler

  function clean(s, n) {
    s = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }
  function safeUrl(u) { return /^https?:\/\/[^\s]+$/i.test(String(u || "")) ? String(u) : ""; }
  function trimSlash(u) { return String(u || "").replace(/\/+$/, ""); }
  function cap(text) { return text.length > MAX ? text.slice(0, MAX - 1).trimEnd() + "…" : text; }

  function footer(o) {
    var site = trimSlash(o && o.siteUrl);
    if (!site) return "";
    return "\n\nConfira também em " + (o.siteName ? o.siteName + ": " : "") + site + "/verificador/";
  }

  // ---- resultado do verificador -> mensagem -------------------------------------------------
  var HEAD = {
    falso: "⚠️ *Cuidado: isso é FALSO.*",
    enganoso: "⚠️ *Cuidado: isso é ENGANOSO (falta contexto).*",
    verdadeiro: "✅ *Isso foi CONFIRMADO por agência de checagem.*",
    misto: "⚠️ *Atenção: a checagem sobre isso tem ressalvas.*",
    sem_checagem: "🔎 *Calma, antes de repassar:* nenhuma agência de checagem analisou isso ainda. Vamos procurar a fonte original antes de acreditar.",
    indisponivel: "🔎 *Calma, antes de repassar:* vamos conferir isso numa fonte confiável primeiro."
  };
  var TAIL = {
    falso: "Por favor, não repasse. 🙏",
    enganoso: "Por favor, confira antes de repassar. 🙏",
    verdadeiro: "",
    misto: "Leia a checagem completa antes de repassar.",
    sem_checagem: "",
    indisponivel: ""
  };

  /** d = resposta de /api/verificar. Devolve o texto da mensagem. */
  function verdictMessage(d, o) {
    d = d || {};
    var v = HEAD[d.veredito] ? d.veredito : "sem_checagem";
    var lines = [HEAD[v]];
    var claim = clean(d.afirmacao, 160);
    if (claim) lines.push("", "Sobre: “" + claim + "”");
    // só citamos agências quando o veredito se apoia em checagem (nunca em "sem_checagem")
    var checks = (v === "sem_checagem" || v === "indisponivel") ? [] : (d.checagens || []).filter(function (c) { return safeUrl(c && c.url); }).slice(0, 2);
    if (checks.length) lines.push("");
    checks.forEach(function (c) {
      var who = clean(c.agencia, 60) || "Agência de checagem";
      var rate = clean(c.avaliacao, 60);
      lines.push("📌 " + who + (rate ? " avaliou como: _" + rate + "_" : " checou o assunto"), safeUrl(c.url));
    });
    if (TAIL[v]) lines.push("", TAIL[v]);
    return cap(lines.join("\n") + footer(o));
  }

  // ---- notícia comum ou checagem publicada por agência -> mensagem -------------------------------
  /** a = {title, source, url, kind}. kind "checagem" = texto publicado por uma agência de checagem. */
  function newsMessage(a, o) {
    a = a || {};
    var title = clean(a.title, 200), src = clean(a.source, 60), url = safeUrl(a.url);
    var head = a.kind === "checagem" ? "🔎 *Checagem" + (src ? " do(a) " + src : "") + ":*" : "📰 *" + (src || "Notícia") + ":*";
    var lines = [head, title];
    if (url) lines.push(url);
    if (a.kind === "checagem") lines.push("", "Confira antes de repassar boatos. 🙏");
    var site = trimSlash(o && o.siteUrl);
    if (site) lines.push("", "Via " + (o.siteName || "Radar de Notícias") + ": " + site);
    return cap(lines.join("\n"));
  }

  function waLink(text) { return "https://wa.me/?text=" + encodeURIComponent(text); }

  root.RadarShare = { verdictMessage: verdictMessage, newsMessage: newsMessage, waLink: waLink, clean: clean };
})(typeof window !== "undefined" ? window : globalThis);

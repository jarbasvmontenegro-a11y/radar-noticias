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
    sem_checagem: "*Calma, antes de repassar:* nenhuma agência de checagem analisou isso ainda. Vamos procurar a fonte original antes de acreditar.",
    indisponivel: "*Calma, antes de repassar:* vamos conferir isso numa fonte confiável primeiro."
  };
  var TAIL = {
    falso: "Por favor, não repasse.",
    enganoso: "Por favor, confira antes de repassar.",
    verdadeiro: "",
    misto: "Leia a checagem completa antes de repassar.",
    sem_checagem: "",
    indisponivel: ""
  };

  // Avaliação PRÓPRIA do Radar (quando nenhuma agência checou): nunca vira "é falso" seco, sempre "provavelmente" + motivos.
  var RADAR_HEAD = {
    provavelmente_falso: "⚠️ *Cuidado: isso provavelmente é FALSO.*",
    suspeito: "⚠️ *Calma, antes de repassar:* isso tem cara de boato e nenhuma fonte confirma.",
    provavelmente_verdadeiro: "✅ *Isso parece verdadeiro:* foi noticiado por veículos confiáveis.",
    nao_confirmado: "*Calma, antes de repassar:* não encontramos fonte que confirme nem desminta."
  };
  var RADAR_TAIL = {
    provavelmente_falso: "Por favor, confira antes de repassar.",
    suspeito: "Por favor, confira antes de repassar.",
    provavelmente_verdadeiro: "",
    nao_confirmado: ""
  };

  function radarMessage(d, o) {
    var nivel = d.radar && RADAR_HEAD[d.radar.nivel] ? d.radar.nivel : "nao_confirmado";
    var lines = [RADAR_HEAD[nivel]];
    var claim = clean(d.afirmacao, 160);
    if (claim) lines.push("", "Sobre: “" + claim + "”");
    var motivos = ((d.radar && d.radar.motivos) || []).filter(function (m) { return !/^Nenhuma agência|^Não conseguimos consultar/.test(m); }).slice(0, 2);
    if (motivos.length) { lines.push(""); motivos.forEach(function (m) { lines.push("• " + clean(m, 150)); }); }
    if (nivel === "provavelmente_verdadeiro") {
      var news = (d.noticias || []).filter(function (n) { return n && n.relacao === "confirma" && safeUrl(n.url); }).slice(0, 2);
      if (news.length) { lines.push(""); news.forEach(function (n) { lines.push("• " + (clean(n.fonte, 40) || "Veículo") + ":", safeUrl(n.url)); }); }
    }
    lines.push("", "_Avaliação do Radar de Notícias, não é checagem de agência._");
    if (RADAR_TAIL[nivel]) lines.push(RADAR_TAIL[nivel]);
    return cap(lines.join("\n") + footer(o));
  }

  /** d = resposta de /api/verificar. Devolve o texto da mensagem. */
  function verdictMessage(d, o) {
    d = d || {};
    if (d.resultado && d.resultado.origem === "radar") return radarMessage(d, o);
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
      lines.push("• " + who + (rate ? " avaliou como: _" + rate + "_" : " checou o assunto"), safeUrl(c.url));
    });
    if (TAIL[v]) lines.push("", TAIL[v]);
    return cap(lines.join("\n") + footer(o));
  }

  // ---- notícia comum ou checagem publicada por agência -> mensagem -------------------------------
  function shortDesc(d, limit) {
    limit = limit || 220;
    d = clean(d, 600).replace(/\s*Leia (?:mais )?(?:no|na|em|o texto no|a matéria no)\s+[^.]{1,40}\.?\s*$/, "").trim();
    if (d.length <= limit) return d;
    var cut = d.slice(0, limit), dot = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    return dot >= 80 ? cut.slice(0, dot + 1) : cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
  }

  /** a = {title, source, url, desc, kind}. Sem emojis fora do básico (alguns WhatsApp Web mostram "�"); o link vai por último. */
  function newsMessage(a, o) {
    a = a || {};
    var title = clean(a.title, 200), src = clean(a.source, 60) || "Notícia", url = safeUrl(a.url), desc = shortDesc(a.desc);
    var site = (o && o.siteName) || "Radar de Notícias";
    var lines = ["*" + title + "*"];
    if (desc) lines.push("", desc);
    if (a.kind === "checagem") lines.push("", "Checagem publicada por " + src + ". Confira antes de repassar boatos.");
    lines.push("", "_" + src + " · via " + site + "_");
    if (url) lines.push("Leia a matéria completa:", url);
    return cap(lines.join("\n"));
  }

  function waLink(text) { return "https://wa.me/?text=" + encodeURIComponent(text); }

  root.RadarShare = { verdictMessage: verdictMessage, newsMessage: newsMessage, shortDesc: shortDesc, waLink: waLink, clean: clean };
})(typeof window !== "undefined" ? window : globalThis);

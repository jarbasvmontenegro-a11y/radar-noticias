// Página de resultados da busca: roda no próprio site, sobre o índice de manchetes (/data/search-index.json).
(function () {
  "use strict";
  var form = document.getElementById("sf");
  if (!form) return;
  var info = document.getElementById("sinfo"), out = document.getElementById("sres"), more = document.getElementById("smore");
  var PAGE = 30;

  function fold(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || "")) ? String(u) : "#"; }

  var params = new URLSearchParams(location.search);
  var q = (params.get("q") || "").slice(0, 120), pessoa = (params.get("p") || "").replace(/[^a-z0-9-]/g, ""), tipo = params.get("t") === "n" || params.get("t") === "c" ? params.get("t") : "";
  form.elements.q.value = q; form.elements.p.value = pessoa; form.elements.t.value = tipo;
  var terms = fold(q).split(/\s+/).filter(function (t) { return t.length > 1; });
  if (!terms.length && !pessoa) return; // nada para buscar ainda

  info.textContent = "Buscando…";
  fetch("/data/search-index.json").then(function (r) { return r.json(); }).then(function (list) {
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (tipo === "c" && !e.c) continue;
      if (tipo === "n" && e.c) continue;
      if (pessoa && (!e.g || e.g.indexOf(pessoa) < 0)) continue;
      var title = fold(e.t), rest = fold(e.s + " " + (e.d || "")), score = 0, ok = true;
      for (var j = 0; j < terms.length; j++) {
        if (title.indexOf(terms[j]) >= 0) score += 2;
        else if (rest.indexOf(terms[j]) >= 0) score += 1;
        else { ok = false; break; }
      }
      if (ok) hits.push({ e: e, s: score, i: i });
    }
    // título que contém tudo vem antes; dentro do mesmo grau, o mais recente (o índice já vem do mais novo ao mais antigo)
    hits.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
    show(hits.map(function (h) { return h.e; }));
  }).catch(function () { info.textContent = "Não foi possível carregar a busca agora. Tente de novo em instantes."; });

  function when(p) { p = p || ""; return p.slice(8, 10) + "/" + p.slice(5, 7) + " " + p.slice(11, 16); }

  function item(e) {
    var R = window.RadarShare;
    var meta = el("p", { "class": "meta" }, [e.i ? el("a", { "class": "src", href: "/fonte/" + encodeURIComponent(e.i) + "/", text: e.s }) : el("span", { "class": "src", text: e.s })]);
    var actions = el("p", { "class": "actions" });
    if (!e.c && e.b) actions.appendChild(el("button", { type: "button", "class": "lnk btn-sum btn-off", disabled: "disabled", title: "Este veículo bloqueia a leitura automática da matéria", text: "Sem resumo (bloqueado)" }));
    else if (!e.c) actions.appendChild(el("button", { type: "button", "class": "lnk btn-sum", "data-url": safeUrl(e.u), "data-title": e.t, "data-source": e.s, "data-desc": e.d || "", text: "Resumir com IA" }));
    actions.appendChild(el("a", { "class": "lnk", href: safeUrl(e.u), target: "_blank", rel: "noopener", text: "Ler na fonte" }));
    if (R) actions.appendChild(el("a", { "class": "lnk lnk-zap", href: R.waLink(R.newsMessage({ title: e.t, source: e.s, url: e.u, desc: e.d || "", kind: e.c ? "checagem" : "noticia" }, { siteName: document.body.dataset.siteName })), target: "_blank", rel: "noopener noreferrer", text: e.c ? "Enviar checagem no WhatsApp" : "WhatsApp" }));
    var body = el("div", { "class": "body" }, [meta, el("h3", { "class": "title" }, [el("a", { href: safeUrl(e.u), target: "_blank", rel: "noopener", text: e.t })])]);
    if (e.d) body.appendChild(el("p", { "class": "desc", text: e.d }));
    body.appendChild(actions);
    body.appendChild(el("div", { "class": "sum", hidden: "", "aria-live": "polite" }));
    return el("article", { "class": "item" }, [el("time", { "class": "when", text: when(e.p) }), body]);
  }

  function show(list) {
    var shown = 0;
    var label = (q ? "“" + q + "”" : "") + (pessoa ? (q ? " com " : "") + (form.elements.p.selectedOptions[0] || {}).textContent : "");
    document.title = "Busca: " + (label || "manchetes") + " | " + (document.body.dataset.siteName || "Radar de Notícias");
    if (!list.length) { info.textContent = "Nenhuma manchete encontrada para " + label + ". Tente menos palavras ou outra grafia."; return; }
    info.textContent = list.length + (list.length === 1 ? " manchete encontrada" : " manchetes encontradas") + " para " + label + ".";
    function next() {
      list.slice(shown, shown + PAGE).forEach(function (e) { out.appendChild(item(e)); });
      shown = Math.min(list.length, shown + PAGE);
      more.hidden = shown >= list.length;
    }
    more.addEventListener("click", next);
    next();
  }
})();

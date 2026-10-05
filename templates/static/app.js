(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k]; else if (k === "text") n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  // ---- tamanho da letra ---------------------------------------------------------
  var sizes = ["0", "1", "2", "3"]; // 1 = padrão
  function curSize() { var s = document.documentElement.dataset.size; return sizes.indexOf(s) >= 0 ? sizes.indexOf(s) : 1; }
  function setSize(i) {
    i = Math.max(0, Math.min(3, i));
    document.documentElement.dataset.size = sizes[i];
    store("radar-size", sizes[i]);
  }
  var up = $("#size-up"), down = $("#size-down");
  if (up) up.addEventListener("click", function () { setSize(curSize() + 1); });
  if (down) down.addEventListener("click", function () { setSize(curSize() - 1); });

  // ---- anúncios e consentimento ---------------------------------------------------
  var ads = $$("ins.adsbygoogle");
  if (ads.length) {
    var box = $("#consent"), choice = store("radar-consent");
    window.adsbygoogle = window.adsbygoogle || [];
    var startAds = function () {
      if (store("radar-consent") !== "yes") window.adsbygoogle.requestNonPersonalizedAds = 1;
      ads.forEach(function () { try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {} });
    };
    if (!choice && box) {
      box.hidden = false;
      var answer = function (v) { store("radar-consent", v); box.hidden = true; startAds(); };
      $("#consent-yes").addEventListener("click", function () { answer("yes"); });
      $("#consent-no").addEventListener("click", function () { answer("no"); });
    } else { startAds(); }
  }

  // ---- busca nas manchetes da página ----------------------------------------------
  var q = $("#q");
  if (q) {
    var items = $$("#list .item");
    var count = $("#qcount");
    q.addEventListener("input", function () {
      var t = q.value.trim().toLowerCase(), n = 0;
      items.forEach(function (it) {
        var ok = !t || it.textContent.toLowerCase().indexOf(t) >= 0;
        it.hidden = !ok; if (ok) n++;
      });
      count.textContent = n + (n === 1 ? " manchete" : " manchetes");
    });
  }

  // ---- Turnstile (opcional) -------------------------------------------------------
  var tsReady = null;
  function getToken() {
    var key = document.body.dataset.turnstile;
    if (!key) return Promise.resolve("");
    if (!tsReady) tsReady = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.onload = res; s.onerror = function () { rej(new Error("turnstile")); };
      document.head.appendChild(s);
    });
    return tsReady.then(function () {
      return new Promise(function (res, rej) {
        var holder = $("#turnstile-box");
        if (!holder) { holder = el("div", { id: "turnstile-box" }); document.body.appendChild(holder); }
        holder.textContent = "";
        window.turnstile.render(holder, { sitekey: key, appearance: "interaction-only", callback: res,
          "error-callback": function () { rej(new Error("turnstile")); } });
      });
    });
  }

  function post(url, body) {
    return getToken().then(function (token) {
      body.token = token;
      return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.erro || "Não foi possível concluir agora."); e.status = r.status; throw e; }
        return data;
      });
    });
  }

  // ---- resumo sob demanda -----------------------------------------------------------
  $$(".btn-sum").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var out = btn.closest(".item").querySelector(".sum");
      if (!out.hidden && btn.dataset.done) { out.hidden = true; btn.textContent = "Resumir com IA"; return; }
      btn.disabled = true; btn.textContent = "Resumindo…";
      out.hidden = false; out.className = "sum"; out.textContent = "Gerando o resumo…";
      post("/api/resumir", { url: btn.dataset.url, title: btn.dataset.title, source: btn.dataset.source, desc: btn.dataset.desc })
        .then(function (d) {
          out.textContent = "";
          out.appendChild(el("span", { text: d.resumo }));
          out.appendChild(el("span", { class: "note", text: (d.base === "titulo" ? "Resumo feito só com título e descrição (matéria de acesso restrito ou indisponível). " : "") + "Resumo gerado por IA, pode conter erros. Confirme na fonte." }));
          btn.dataset.done = "1"; btn.textContent = "Ocultar resumo";
        })
        .catch(function (e) {
          out.className = "sum error"; out.textContent = e.message;
          btn.textContent = "Tentar de novo";
        })
        .then(function () { btn.disabled = false; });
    });
  });

  // ---- verificador ------------------------------------------------------------------
  var form = $("#vform");
  if (form) {
    var ta = $("#vtext"), cnt = $("#vcount"), res = $("#vresult"), btnV = $("#vbtn");
    ta.addEventListener("input", function () { cnt.textContent = ta.value.length; });
    var label = { falso: "Checagens apontam: falso", enganoso: "Checagens apontam: enganoso", verdadeiro: "Checagens apontam: verdadeiro", misto: "Checagem com conclusão mista", sem_checagem: "Nenhuma agência checou ainda" };
    var intro = {
      falso: "Agências de checagem classificaram como falso conteúdo muito parecido com o que você enviou. Confira abaixo se tratam do mesmo assunto antes de compartilhar.",
      enganoso: "Agências de checagem apontaram como enganoso ou sem contexto conteúdo muito parecido com o que você enviou. Confira abaixo se tratam do mesmo assunto.",
      verdadeiro: "Agências de checagem confirmaram conteúdo muito parecido com o que você enviou. Veja os detalhes e a fonte original abaixo.",
      misto: "As avaliações encontradas não são unânimes ou têm ressalvas. Leia as checagens completas.",
      sem_checagem: "Não encontramos checagem sobre isso. Isso não significa que seja verdade: desconfie e procure a fonte original."
    };
    function section(title, list, render) {
      if (!list || !list.length) return null;
      return el("section", { class: "vsec" }, [el("h3", { text: title }), el("ul", {}, list.map(render))]);
    }
    function add(n) { if (n) res.appendChild(n); }
    function link(a) { return el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", text: a.titulo || a.url }); }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var text = ta.value.trim();
      if (text.length < 12) { res.hidden = false; res.textContent = ""; res.appendChild(el("p", { text: "Cole um texto ou link um pouco maior para verificar." })); return; }
      btnV.disabled = true; btnV.textContent = "Verificando…";
      res.hidden = false; res.textContent = "Consultando agências de checagem e fontes confiáveis…";
      post("/api/verificar", { texto: text }).then(function (d) {
        res.textContent = "";
        var v = d.veredito || "sem_checagem";
        var cls = v === "sem_checagem" ? "v-sem" : "v-" + v;
        res.appendChild(el("div", { class: "verdict " + cls }, [
          el("span", { class: "badge", text: label[v] || label.sem_checagem }),
          el("h2", { text: d.afirmacao ? "Sobre: " + d.afirmacao : "Resultado" }),
          el("p", { text: intro[v] || intro.sem_checagem })
        ]));
        add(section("Checagens encontradas", d.checagens, function (c) {
          return el("li", {}, [link(c), el("br"), el("span", { class: "src", text: c.agencia + (c.avaliacao ? " · avaliação: " + c.avaliacao : "") })]);
        }));
        add(section("Notícias recentes de fontes monitoradas sobre o tema", d.noticias, function (n) {
          return el("li", {}, [link(n), el("br"), el("span", { class: "src", text: n.fonte })]);
        }));
        add(section("Sinais de alerta no texto (análise de IA)", d.sinais, function (s) { return el("li", { text: s }); }));
        add(section("O que você pode conferir", d.conferir, function (s) { return el("li", { text: s }); }));
        res.appendChild(el("p", { class: "small", text: "A IA aponta sinais de alerta, mas não decide o que é verdadeiro ou falso. Essa conclusão vem apenas de agências de checagem." }));
      }).catch(function (e) {
        res.textContent = ""; res.appendChild(el("p", { class: "sum error", text: e.message }));
      }).then(function () { btnV.disabled = false; btnV.textContent = "Verificar"; });
    });
  }
})();

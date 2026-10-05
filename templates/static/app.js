(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("radar-data").textContent);
  var days = DATA.days;
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function fmtDay(iso) {
    var d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  }
  function fmtShort(iso) {
    var d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }

  $("today-label").textContent = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  // ---- abas -------------------------------------------------------------------
  document.querySelectorAll(".tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".tabs button").forEach(function (x) { x.classList.toggle("active", x === b); });
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + b.dataset.tab); });
      history.replaceState(null, "", "#" + b.dataset.tab);
    });
  });
  var hash = location.hash.replace("#", "");
  if (hash) { var hb = document.querySelector('.tabs button[data-tab="' + hash + '"]'); if (hb) hb.click(); }

  if (!days.length) {
    $("feed").appendChild(el("div", { class: "empty", text: "Ainda não há edições. Rode `python -m radar daily` ou `python -m radar demo`." }));
    return;
  }

  // ---- filtros ----------------------------------------------------------------
  var temas = {}, fontes = {};
  days.forEach(function (d) {
    d.clusters.forEach(function (c) {
      temas[c.tema] = 1;
      c.articles.forEach(function (a) { fontes[a.source] = 1; });
    });
  });
  days.forEach(function (d) { $("f-day").appendChild(el("option", { value: d.day, text: fmtDay(d.day) })); });
  Object.keys(temas).sort().forEach(function (t) { $("f-tema").appendChild(el("option", { value: t, text: t })); });
  Object.keys(fontes).sort().forEach(function (f) { $("f-fonte").appendChild(el("option", { value: f, text: f })); });
  ["f-day", "f-tema", "f-fonte", "f-q", "f-multi"].forEach(function (id) {
    $(id).addEventListener("input", renderFeed);
  });

  function renderFeed() {
    var day = days.filter(function (d) { return d.day === $("f-day").value; })[0] || days[0];
    var tema = $("f-tema").value, fonte = $("f-fonte").value;
    var q = $("f-q").value.trim().toLowerCase(), multi = $("f-multi").checked;

    var list = day.clusters.filter(function (c) {
      if (tema && c.tema !== tema) return false;
      if (multi && c.n_sources < 2) return false;
      if (fonte && !c.articles.some(function (a) { return a.source === fonte; })) return false;
      if (q && (c.headline + " " + c.summary).toLowerCase().indexOf(q) < 0 &&
          !c.articles.some(function (a) { return a.title.toLowerCase().indexOf(q) >= 0; })) return false;
      return true;
    });

    $("count").textContent = list.length + (list.length === 1 ? " assunto" : " assuntos") + " em " + fmtDay(day.day);
    var feed = $("feed");
    feed.textContent = "";
    if (!list.length) { feed.appendChild(el("div", { class: "empty", text: "Nenhum assunto com esses filtros." })); return; }

    list.forEach(function (c, i) {
      var arts = c.articles.map(function (a) {
        return el("li", {}, [
          el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", text: a.title }),
          el("span", { class: "src", text: " — " + a.source })
        ]);
      });
      var story = el("article", { class: "story" + (i === 0 && !tema && !fonte && !q ? " lead" : "") }, [
        el("div", { class: "kicker" }, [
          el("span", { text: c.tema }),
          el("span", { class: "pill", text: c.n_sources + (c.n_sources === 1 ? " fonte" : " fontes") }),
          c.tom === "tenso" ? el("span", { class: "pill tenso", text: "clima tenso" }) : null
        ]),
        el("h3", { text: c.headline }),
        el("p", { text: c.summary }),
        el("details", {}, [
          el("summary", { text: "Ler nas fontes (" + c.articles.length + ")" }),
          el("ul", {}, arts)
        ])
      ]);
      feed.appendChild(story);
    });
  }
  renderFeed();

  // ---- resumos ----------------------------------------------------------------
  days.forEach(function (d) {
    var chips = d.topics.slice(0, 6).map(function (t) {
      return el("span", { class: "chip", text: t.tema + " · " + t.n_articles });
    });
    $("resumos").appendChild(el("div", { class: "day-card" }, [
      el("h3", { text: fmtDay(d.day) }),
      el("p", { text: d.summary }),
      el("div", { class: "chips" }, chips)
    ]));
  });

  // ---- régua ------------------------------------------------------------------
  (function () {
    var shown = days.slice(0, 14).reverse(); // mais antigo -> mais novo
    var allTemas = {};
    shown.forEach(function (d) { d.topics.forEach(function (t) { allTemas[t.tema] = (allTemas[t.tema] || 0) + t.n_articles; }); });
    var order = Object.keys(allTemas).sort(function (a, b) { return allTemas[b] - allTemas[a]; });
    var max = 1;
    shown.forEach(function (d) { d.topics.forEach(function (t) { if (t.n_articles > max) max = t.n_articles; }); });

    var table = el("table", { class: "regua" });
    var head = el("tr", {}, [el("th")]);
    shown.forEach(function (d) { head.appendChild(el("th", { text: fmtShort(d.day) })); });
    table.appendChild(head);

    order.forEach(function (tema) {
      var tr = el("tr", {}, [el("th", { class: "tema", text: tema })]);
      shown.forEach(function (d) {
        var t = d.topics.filter(function (x) { return x.tema === tema; })[0];
        var n = t ? t.n_articles : 0;
        var a = n ? (0.12 + 0.88 * n / max).toFixed(2) : 0;
        var td = el("td", { style: "--a:" + a, title: tema + ": " + n + " matérias", class: a > 0.55 ? "dark" : "" },
          [document.createTextNode(n || "")]);
        if (t && t.tom === "tenso") td.appendChild(el("span", { class: "dot", title: "clima tenso" }));
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    $("regua").appendChild(table);
  })();
})();

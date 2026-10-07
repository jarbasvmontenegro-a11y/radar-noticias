// Mini janela: assuntos em alta e últimas manchetes numa janela pequena que se atualiza sozinha.
// No Chrome/Edge para computador ela usa a janela flutuante (Picture-in-Picture de documento) e fica sempre por cima.
// Nos outros navegadores abre uma janelinha comum, em /mini/. Só monta o texto com textContent e nós criados um a um (nunca HTML em texto).
(function () {
  "use strict";
  var DADOS = "/data/ultimas.json";
  var A_CADA = 5 * 60 * 1000;
  var LARGURA = 380, ALTURA = 580;

  function seguro(u) {
    try { var x = new URL(u, location.origin); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch (e) { return ""; }
  }
  function hora(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function link(doc, href, nova) {
    var a = el(doc, "a");
    var h = seguro(href);
    if (h) { a.href = h; if (nova) { a.target = "_blank"; a.rel = "noopener noreferrer"; } }
    return a;
  }

  // Monta a janela inteira a partir dos dados. `novos` = endereços que não estavam na lista anterior.
  function montar(doc, root, dados, novos, conferido, falhou) {
    var vazio = root.cloneNode(false);
    root.parentNode.replaceChild(vazio, root);
    root = vazio;

    var cab = el(doc, "header", "m-head");
    cab.appendChild(el(doc, "div", "m-brand", "Radar de Notícias"));
    var st = el(doc, "div", "m-stat");
    st.appendChild(doc.createTextNode("site de " + hora(dados.gerado)));
    st.appendChild(doc.createElement("br"));
    st.appendChild(doc.createTextNode("conferido às " + hora(conferido)));
    cab.appendChild(st);
    root.appendChild(cab);

    var corpo = el(doc, "div", "m-body");
    if (falhou) corpo.appendChild(el(doc, "p", "m-warn", "Sem conexão agora. Mostrando a última lista e tentando de novo."));

    if (dados.assuntos && dados.assuntos.length) {
      corpo.appendChild(el(doc, "h2", null, "Assuntos em alta"));
      var ol = el(doc, "ol", "m-trend");
      dados.assuntos.slice(0, 5).forEach(function (a, i) {
        var li = el(doc, "li");
        var l = link(doc, a.u, true);
        l.appendChild(el(doc, "span", "n", String(i + 1)));
        var box = el(doc, "span");
        box.appendChild(el(doc, "span", "t", a.t));
        box.appendChild(el(doc, "span", "s", a.n + " veículos"));
        l.appendChild(box);
        li.appendChild(l);
        ol.appendChild(li);
      });
      corpo.appendChild(ol);
    }

    corpo.appendChild(el(doc, "h2", null, "Últimas manchetes"));
    var ul = el(doc, "ul", "m-last");
    (dados.itens || []).forEach(function (a) {
      var li = el(doc, "li", novos && novos[a.u] ? "novo" : "");
      var l = link(doc, a.u, true);
      l.appendChild(el(doc, "span", "h", hora(a.d)));
      var box = el(doc, "span");
      box.appendChild(el(doc, "span", "t", a.t));
      var s = el(doc, "span", "s");
      s.appendChild(el(doc, "b", null, a.s));
      if (a.n > 0) s.appendChild(doc.createTextNode(" e mais " + a.n + (a.n === 1 ? " veículo" : " veículos")));
      box.appendChild(s);
      l.appendChild(box);
      li.appendChild(l);
      ul.appendChild(li);
    });
    corpo.appendChild(ul);
    root.appendChild(corpo);

    var rodape = el(doc, "footer", "m-foot");
    var site = link(doc, "/", true);
    site.textContent = "Abrir o site";
    rodape.appendChild(site);
    rodape.appendChild(el(doc, "span", null, "atualiza a cada 5 min"));
    root.appendChild(rodape);
    return root;
  }

  // Controla uma janela (doc + raiz): busca, compara com a lista anterior, remonta e repete.
  function iniciar(doc, root, janelaDoTimer) {
    var anterior = null, ultimosDados = null, timer = null, parado = false;

    function mostrar(dados, falhou) {
      var novos = null;
      if (anterior) {
        novos = {};
        (dados.itens || []).forEach(function (a) { if (!anterior[a.u]) novos[a.u] = true; });
      }
      var pos = root.querySelector ? root.querySelector(".m-body") : null;
      var rolagem = pos ? pos.scrollTop : 0;
      root = montar(doc, root, dados, novos, new Date().toISOString(), falhou);
      var corpo = root.querySelector(".m-body");
      if (corpo && rolagem) corpo.scrollTop = rolagem;
      anterior = {};
      (dados.itens || []).forEach(function (a) { anterior[a.u] = true; });
      ultimosDados = dados;
    }

    function conferir() {
      if (parado) return;
      fetch(DADOS, { cache: "no-cache", credentials: "omit" })
        .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
        .then(function (dados) { if (!parado) mostrar(dados, false); })
        .catch(function () {
          if (parado) return;
          if (ultimosDados) mostrar(ultimosDados, true);
          else { root.textContent = ""; root.appendChild(el(doc, "p", "m-msg", "Não deu para carregar as notícias agora. Tentando de novo em instantes.")); }
        });
    }
    conferir();
    timer = janelaDoTimer.setInterval(conferir, A_CADA);
    return function parar() { parado = true; janelaDoTimer.clearInterval(timer); };
  }

  // ---- página /mini/ (janelinha comum) ----------------------------------------------
  if (document.body && document.body.dataset.mini) {
    var raiz = document.getElementById("mini-root");
    if (raiz) iniciar(document, raiz, window);
    return;
  }

  // ---- botão do site (só computador) -------------------------------------------------
  var botao = document.getElementById("mini-open");
  if (!botao) return;
  var computador = window.matchMedia && window.matchMedia("(min-width: 1021px) and (pointer: fine)").matches;
  if (!computador) return;
  botao.hidden = false;

  var pip = null, parar = null;

  function abrirFlutuante() {
    return window.documentPictureInPicture.requestWindow({ width: LARGURA, height: ALTURA }).then(function (janela) {
      var doc = janela.document;
      pip = janela;
      doc.title = "Radar de Notícias";
      var tema = document.documentElement.dataset.theme;
      if (tema) doc.documentElement.dataset.theme = tema;
      var css = doc.createElement("link");
      css.rel = "stylesheet";
      css.href = location.origin + (botao.dataset.css || "/mini.css");
      doc.head.appendChild(css);
      var viewport = doc.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1";
      doc.head.appendChild(viewport);
      var raiz = doc.createElement("div"); raiz.id = "mini-root"; raiz.className = "m";
      raiz.appendChild(el(doc, "p", "m-msg", "Carregando as últimas notícias."));
      doc.body.appendChild(raiz);
      parar = iniciar(doc, raiz, window);
      janela.addEventListener("pagehide", function () { if (parar) parar(); parar = null; pip = null; botao.setAttribute("aria-pressed", "false"); });
      botao.setAttribute("aria-pressed", "true");
    });
  }
  function abrirComum() {
    var esq = Math.max(0, (screen.availWidth || 1200) - LARGURA - 24);
    var w = window.open("/mini/", "radar-mini", "popup=yes,width=" + LARGURA + ",height=" + ALTURA + ",left=" + esq + ",top=80");
    if (w) w.focus();
  }
  botao.addEventListener("click", function () {
    if (pip) { pip.close(); return; }
    if (window.documentPictureInPicture && window.documentPictureInPicture.requestWindow) {
      abrirFlutuante().catch(abrirComum);
    } else {
      abrirComum();
    }
  });
})();

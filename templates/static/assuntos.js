// Página de assuntos: filtro por texto e abertura do assunto indicado no endereço (#a3).
(function () {
  "use strict";
  var box = document.getElementById("aq"), list = document.getElementById("alist"), info = document.getElementById("ainfo");
  if (!box || !list) return;
  var items = Array.prototype.slice.call(list.querySelectorAll(".story"));
  function fold(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  var folded = items.map(function (d) { return fold(d.getAttribute("data-q")); });
  function apply() {
    var terms = fold(box.value).split(/\s+/).filter(function (t) { return t.length > 1; });
    var shown = 0;
    items.forEach(function (d, i) {
      var ok = terms.every(function (t) { return folded[i].indexOf(t) >= 0; });
      d.hidden = !ok;
      if (ok) shown++;
      if (terms.length && ok) d.open = true; else if (!terms.length) d.open = d.open && d.id === (location.hash || "").slice(1);
    });
    info.textContent = terms.length
      ? (shown ? shown + (shown === 1 ? " assunto encontrado." : " assuntos encontrados.") : "Nenhum assunto com essas palavras. Tente menos palavras ou use a busca de manchetes.")
      : items.length + " assuntos.";
  }
  box.addEventListener("input", apply);
  var h = (location.hash || "").slice(1), alvo = h && document.getElementById(h);
  if (alvo && alvo.classList.contains("story")) { alvo.open = true; alvo.scrollIntoView(); }
})();

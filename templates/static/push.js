// Página de notificações: pede permissão, inscreve o navegador e guarda as escolhas no servidor.
(function () {
  "use strict";
  var form = document.getElementById("nf");
  if (!form) return;
  var status = document.getElementById("nf-status"), on = document.getElementById("nf-on"), off = document.getElementById("nf-off");
  var unsupported = document.getElementById("nf-unsupported");
  var KEY = "radar-push";

  function say(msg, err) { status.textContent = msg; status.className = "nstatus" + (err ? " err" : ""); }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  function save(p) { try { if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY); } catch (e) { /* sem armazenamento: ok */ } }
  function b64u(s) {
    var b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
    return Uint8Array.from(b, function (c) { return c.charCodeAt(0); });
  }
  function checked(name) { return Array.prototype.map.call(form.querySelectorAll('input[name="' + name + '"]:checked'), function (i) { return i.value; }); }
  function readPrefs() {
    return {
      geral: form.elements.geral.checked, checagens: form.elements.checagens.checked,
      temas: checked("tema"), ufs: checked("uf"),
      nivel: (form.querySelector('input[name="nivel"]:checked') || {}).value || "top",
      max: Number(form.elements.max.value) || 3,
    };
  }
  function fill(p) {
    if (!p) return;
    form.elements.geral.checked = !!p.geral; form.elements.checagens.checked = !!p.checagens;
    Array.prototype.forEach.call(form.querySelectorAll('input[name="tema"]'), function (i) { i.checked = (p.temas || []).indexOf(i.value) >= 0; });
    Array.prototype.forEach.call(form.querySelectorAll('input[name="uf"]'), function (i) { i.checked = (p.ufs || []).indexOf(i.value) >= 0; });
    Array.prototype.forEach.call(form.querySelectorAll('input[name="nivel"]'), function (i) { i.checked = i.value === p.nivel; });
    if (p.max) form.elements.max.value = String(p.max);
  }
  function ativo(isOn) { on.textContent = isOn ? "Salvar escolhas" : "Ativar notificações"; off.hidden = !isOn; }

  var ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!ok) { unsupported.hidden = false; on.disabled = true; return; }

  var reg = null;
  navigator.serviceWorker.register("/sw.js").then(function (r) { reg = r; return navigator.serviceWorker.ready; })
    .then(function (r) { return r.pushManager.getSubscription(); })
    .then(function (sub) {
      if (sub && Notification.permission === "granted") { fill(load()); ativo(true); }
    }).catch(function () { say("Não foi possível preparar as notificações neste navegador.", true); });

  function ready() { return navigator.serviceWorker.ready; }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var prefs = readPrefs();
    if (!prefs.geral && !prefs.checagens && !prefs.temas.length && !prefs.ufs.length) { say("Escolha pelo menos uma opção: assuntos do dia, checagens, um tema ou um estado.", true); return; }
    on.disabled = true; say("Ativando…");
    // o pedido de permissão precisa nascer do toque da pessoa, então vem antes de qualquer espera
    var perm = Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
    perm.then(function (p) {
      if (p !== "granted") throw new Error(p === "denied" ? "As notificações estão bloqueadas para este site. Libere nas configurações do navegador e tente de novo." : "Você não permitiu as notificações.");
      return ready();
    }).then(function (r) {
      return r.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        return fetch("/api/push/chave").then(function (x) { return x.json(); }).then(function (k) {
          if (!k || !k.pub) throw new Error("O serviço de notificações não está disponível agora.");
          return r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(k.pub) });
        });
      });
    }).then(function (sub) {
      return window.RadarPost("/api/inscrever", { acao: "salvar", sub: sub.toJSON(), prefs: prefs });
    }).then(function () {
      save(prefs); ativo(true); say("Pronto. Você vai receber só os avisos que combinam com as suas escolhas.");
    }).catch(function (e) {
      say((e && e.message) || "Não foi possível ativar agora. Tente de novo.", true);
    }).then(function () { on.disabled = false; });
  });

  off.addEventListener("click", function () {
    off.disabled = true; say("Desativando…");
    ready().then(function (r) { return r.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) return null;
      return window.RadarPost("/api/inscrever", { acao: "remover", sub: sub.toJSON() }).then(function () { return sub.unsubscribe(); });
    }).then(function () {
      save(null); ativo(false); say("Notificações desativadas e dados apagados.");
    }).catch(function (e) { say((e && e.message) || "Não foi possível desativar agora.", true); })
      .then(function () { off.disabled = false; });
  });
})();

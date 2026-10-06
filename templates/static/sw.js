// Service worker: só recebe avisos (push) e abre a matéria quando a pessoa toca. Não guarda nada em cache.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

function texto(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }

self.addEventListener("push", function (event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  if (!d || typeof d !== "object") d = {};
  var titulo = texto(d.t, 120) || "Radar de Notícias";
  var corpo = texto(d.b, 240);
  var fonte = texto(d.f, 60);
  event.waitUntil(self.registration.showNotification(titulo, {
    body: corpo + (fonte ? "\n" + fonte : ""),
    tag: texto(d.id, 40) || undefined,
    icon: "/icon-192.png", badge: "/icon-192.png", lang: "pt-BR",
    data: { u: texto(d.u, 700) },
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var alvo = "/";
  try {
    var u = new URL((event.notification.data && event.notification.data.u) || "", self.location.origin);
    if (u.protocol === "https:" || u.protocol === "http:") alvo = u.href; // nunca javascript: nem data:
  } catch (e) { /* mantém "/" */ }
  event.waitUntil(self.clients.openWindow(alvo));
});

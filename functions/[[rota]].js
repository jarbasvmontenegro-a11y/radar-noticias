// Só as armadilhas do pote de mel chegam aqui (ver _routes.json gerado no build); o resto segue para o site.
import { cair, ehArmadilha } from "../lib/pote.js";

export async function onRequest({ request, next }) {
  if (!ehArmadilha(new URL(request.url).pathname)) return next();
  return cair(request);
}

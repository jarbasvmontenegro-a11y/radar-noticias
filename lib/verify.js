// Lógica pura do verificador (sem rede), fácil de testar.
import { stripAccents } from "./api.js";

const STOP = new Set("para como mais pelo pela pelos pelas sobre entre esta este essa esse isso aqui onde quando porque muito muita que com sem uma uns umas dos das nos nas nao sim foi sao ser tem vai vem ate apos desde contra todos todas".split(" "));

export const tokens = (s) =>
  [...new Set(stripAccents(String(s).toLowerCase()).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];

// ---- classificação da avaliação textual de uma agência ----
export function classifyRating(rating) {
  const r = stripAccents(String(rating || "").toLowerCase());
  if (/(nao e verdade|falso|fake|golpe|boato|manipulad|fabricad|sem evidencia|inventad|nao procede|mentira)/.test(r)) return "falso";
  if (/(enganos|distorc|descontextual|sem contexto|fora de contexto|exager|impreciso|insustentavel|alterad)/.test(r)) return "enganoso";
  if (/(parcial|misto|em parte|discutivel|verdade, mas|verdadeiro, mas|ressalva|nao e bem assim)/.test(r)) return "misto";
  if (/(verdadeiro|verdade|correto|comprovado|confirmado|real|procede)/.test(r)) return "verdadeiro";
  return "desconhecido";
}

export function aggregate(classes) {
  if (!classes.length) return "sem_checagem";
  const c = (k) => classes.filter((x) => x === k).length;
  const neg = c("falso") + c("enganoso");
  if (neg && !c("verdadeiro")) return c("falso") >= c("enganoso") ? "falso" : "enganoso";
  if (c("verdadeiro") && !neg && !c("misto")) return "verdadeiro";
  return "misto";
}

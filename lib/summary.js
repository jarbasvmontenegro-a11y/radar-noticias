// Lógica pura do resumo (sem rede): o que conta como "resumo que só repete o título", descrições úteis e outros veículos.
import { fold, maisRecente, sharedCount, sourceKey, tokens, topicTerms } from "./text.js";

export const LIMITE_REPETICAO = 0.85;  // fração das palavras do resumo que já estavam no título
export const MIN_TERMOS_OUTROS = 3;    // termos do título que outra manchete precisa ter para entrar como "outro veículo"
export const MAX_OUTROS = 4;
export const MIN_TEXTO = 600;          // texto lido da página que basta para resumir a matéria
export const MIN_DESCRICOES = 200;     // caracteres úteis de descrição que bastam quando a matéria não abriu

export const AVISO_DESCRICOES = "Não conseguimos ler a matéria completa (acesso restrito ou página bloqueada). Este resumo usa as descrições publicadas pelos veículos.";
export const AVISO_NENHUMA = "Não foi possível ler esta matéria. Veja como outros veículos noticiaram:";
export const AVISO_BLOQUEADA = "Este veículo bloqueia a leitura automática da matéria, então não geramos resumo. Veja como outros veículos noticiaram:";
export const MAX_OFICIAIS = 2;
export const AVISO_IA = "Resumo gerado por IA, pode conter erros. Ele mostra o que a matéria diz e não garante que seja verdade. Confirme na fonte.";
export const AVISO_CURTO = "Resumo curto: a matéria traz poucos detalhes além do título.";

/**
 * O resumo só repete o título? Sim se >= 85% das suas palavras já estão no título, ou se ele traz no máximo 2 palavras
 * novas (paráfrase com verbo flexionado: "dão declarações" -> "deram declarações"). Um bom resumo de 3 a 5 frases
 * tem dezenas de palavras novas e passa longe dos dois limites.
 */
export function repeteTitulo(resumo, titulo) {
  const r = tokens(resumo);
  if (!r.length) return true;
  const comuns = sharedCount(r, tokens(titulo));
  return comuns / r.length >= LIMITE_REPETICAO || r.length - comuns <= 2;
}

/** Descrições distintas e que dizem algo além do título, na ordem recebida. Ignora vazias e repetidas. */
export function descricoesUteis(lista, titulo) {
  const vistos = new Set(), out = [];
  for (const d of lista) {
    const t = String(d || "").replace(/\s+/g, " ").trim();
    const k = fold(t);
    if (t.length < 30 || vistos.has(k) || repeteTitulo(t, titulo)) continue;
    vistos.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Manchetes de OUTROS veículos que tratam do mesmo assunto: >= 3 termos do título em comum (sem os termos genéricos do
 * noticiário), ordenadas por sobreposição e data, uma por veículo, até 4. `self` é a entrada da própria matéria no índice
 * (ou null). Devolve [{ fonte, titulo, url, d }].
 */
export function outrosVeiculos(index, href, titulo, self = null) {
  if (!index) return [];
  const termos = topicTerms(titulo);
  if (termos.length < MIN_TERMOS_OUTROS) return [];
  const meu = sourceKey(href);
  const achados = index.achar(termos, MIN_TERMOS_OUTROS, (a) => a.u !== self?.u && sourceKey(a.u) !== meu && !(self && a.s === self.s));
  achados.sort((x, y) => y.shared - x.shared || maisRecente(x.a, y.a));
  const vistos = new Set(), out = [];
  for (const { a } of achados) {
    const k = sourceKey(a.u);
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push({ fonte: String(a.s || k).slice(0, 60), titulo: String(a.t).slice(0, 200), url: a.u, d: String(a.d || "").slice(0, 140) });
    if (out.length === MAX_OUTROS) break;
  }
  return out;
}

/** O contexto cita pelo nome pelo menos um dos veículos da lista? (frase solta, que não cita ninguém, é descartada) */
export function citaVeiculo(contexto, outros) {
  const c = fold(contexto);
  return outros.some((o) => { const nome = fold(o.fonte).trim(); return (nome && c.includes(nome)) || tokens(o.fonte).some((t) => c.includes(t)); });
}

/**
 * Quantos veículos de notícia publicaram o mesmo assunto (contando o da própria matéria) e as fontes oficiais que tratam
 * dele. Mesma regra de "mesmo assunto" de outrosVeiculos. `veiculos` é null quando o título tem termos de menos para
 * comparar (aí a página não diz nada, em vez de dizer "só este veículo"). Não é prova de verdade: só mostra o quanto o
 * assunto é confirmado por mais de um veículo.
 */
export function cobertura(index, href, titulo, self = null) {
  const vazio = { veiculos: null, oficiais: [] };
  if (!index) return vazio;
  const termos = topicTerms(titulo);
  if (termos.length < MIN_TERMOS_OUTROS) return vazio;
  const meu = sourceKey(href);
  const achados = index.achar(termos, MIN_TERMOS_OUTROS, (a) => a.u !== self?.u && sourceKey(a.u) !== meu && !(self && a.s === self.s));
  const veiculos = new Set([meu]), oficiais = [], vistosOf = new Set();
  achados.sort((x, y) => y.shared - x.shared || maisRecente(x.a, y.a));
  for (const { a } of achados) {
    const k = sourceKey(a.u);
    if (a.o === 1) {
      if (!vistosOf.has(k) && oficiais.length < MAX_OFICIAIS) { vistosOf.add(k); oficiais.push({ fonte: String(a.s || k).slice(0, 60), titulo: String(a.t).slice(0, 200), url: a.u }); }
    } else if (a.c !== 1) veiculos.add(k);
  }
  return { veiculos: veiculos.size, oficiais };
}

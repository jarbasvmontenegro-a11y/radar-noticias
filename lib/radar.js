// Avaliação PRÓPRIA do Radar, usada quando nenhuma agência de checagem concluiu sobre o boato.
// Tudo aqui é puro e determinístico: a IA só extrai a afirmação e compara com manchetes; quem decide são estas regras,
// com limiares nomeados (e testados) logo abaixo.
import { fold } from "./text.js";

export const LIMIAR_SUSPEITO = 45;       // pontos de "corrente de boato" que bastam para desconfiar, mesmo sem outro dado
export const LIMIAR_SEM_COBERTURA = 25;  // pontos mínimos quando, além disso, nenhum veículo noticiou nada parecido
export const MIN_FONTES = 2;             // veículos DISTINTOS necessários para confirmar ou contradizer
export const FONTES_ALTA = 3;            // com tantos veículos confirmando, a confiança sobe de "media" para "alta"
export const MIN_TERMOS = 3;             // termos que uma manchete precisa ter em comum com a afirmação (guarda contra a IA)
export const PONTOS_MAX = 100;           // teto da pontuação de corrente

// ---------- sinais de corrente de boato ----------
// Cada sinal: peso, explicação curta (vira motivo) e regex sobre o texto sem acento e em minúsculas.
const SINAIS = [
  { peso: 25, texto: "Pede para compartilhar", re: /\b(?:compartilhe|compartilhem|repasse|repassem|divulgue|divulguem|espalhe|espalhem|(?:mande|manda|envie|encaminhe) (?:para|pra) todos|passe adiante)\b/ },
  { peso: 25, texto: "Pede para espalhar antes que apaguem", re: /\bantes que (?:(?:a|o|eles|elas)\s+)?(?:apaguem|deletem|censurem|removam|bloqueiem|derrubem|tirem do ar)\b/ },
  { peso: 20, texto: "Diz que a imprensa esconde o fato", re: /\b(?:(?:a |as |toda a |nossa )?(?:grande )?(?:midia|imprensa|tv|globo|jornais|emissoras)\b[^.!?\n]{0,40}\b(?:nao (?:mostra|mostram|conta|contam|fala|falam|divulga|divulgam|noticia|noticiam|vai (?:passar|mostrar|divulgar|noticiar))|esconde|escondem|omite|omitem|silencia|silenciam|abafa|abafam|censura|censuram)|abafad[oa]s? (?:pel[ao]s? )?(?:midia|imprensa)|grande midia|ninguem (?:fala|conta|mostra|divulga|noticia)|a tv nao (?:mostra|vai passar))\b/ },
  { peso: 15, texto: "Marcada como encaminhada várias vezes", re: /\bencaminhada (?:com frequencia|muitas vezes)\b/ },
  { peso: 15, texto: "Cita fonte anônima ou “um conhecido que contou”", re: /\bfonte (?:anonima|proxima|sigilosa|ligada)\b|\b(?:um|uma) (?:amigo|amiga|primo|prima|medico|medica|delegado|delegada|militar|policial|parente|conhecido|conhecida|vizinho|colega)\b[^.!?\n]{0,50}\b(?:disse|contou|falou|avisou|garantiu)\b/ },
  { peso: 15, texto: "Anuncia medida drástica do governo sem citar documento oficial", re: /\b(?:vai|vao|ira|irao)\s+(?:comecar a |passar a )?(?:taxar|proibir|cobrar|confiscar|bloquear|tributar|extinguir|acabar com|congelar|zerar)\b/, com: /\b(?:governo|stf|tse|receita|lula|bolsonaro|congresso|ministerio|banco central|camara|senado)\b/, medida: true },
  { peso: 10, texto: "Usa urgência, exclamações ou letras maiúsculas para pressionar", re: /^\W*(?:urgente|atencao)\b|!{3,}/, maiusculas: true },
  { peso: 10, texto: "Promete prova sem apontar a fonte", re: /\b(?:prova|provas) irrefutave(?:l|is)\b|\bvideo (?:mostra|prova)\b|\b(?:imagens|fotos) (?:mostram|provam)\b/, semLink: true },
  { peso: 5, texto: "Usa “teria” ou “supostamente” sem confirmar", re: /\b(?:teria|teriam|supostamente)\b/ },
];

function muitasMaiusculas(t) {
  let letras = 0, caixaAlta = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c.toLowerCase() === c.toUpperCase()) continue; // não é letra
    letras++;
    if (c === c.toUpperCase()) caixaAlta++;
  }
  return letras >= 20 && caixaAlta / letras > 0.4;
}

/**
 * Sinais típicos de corrente no texto: { pontos (0 a 100), itens: [{ peso, texto }] (mais pesados primeiro), medida }.
 * `medida` indica anúncio de medida do governo ("vai taxar o Pix"), que a IA às vezes confunde com "previsão".
 * Cada explicação cita o trecho que disparou o sinal, para o leitor ver que não é invenção.
 */
export function sinaisDeCorrente(texto) {
  const t = String(texto ?? "").normalize("NFC");
  const f = fold(t);
  const mesmoTamanho = f.length === t.length; // dá para citar o trecho original (com acento) pela mesma posição
  const temLink = /https?:\/\//i.test(t);
  const itens = [];
  let medida = false;
  for (const s of SINAIS) {
    const m = s.re.exec(f);
    let achou = !!m && !(s.com && !s.com.test(f)) && !(s.semLink && temLink);
    let trecho = m && mesmoTamanho ? t.slice(m.index, m.index + m[0].length).trim() : m ? m[0].trim() : "";
    if (!achou && s.maiusculas && muitasMaiusculas(t)) { achou = true; trecho = ""; }
    if (!achou) continue;
    if (s.medida) medida = true;
    itens.push({ peso: s.peso, texto: trecho && trecho.length <= 60 ? `${s.texto} (“${trecho}”)` : s.texto });
  }
  itens.sort((a, b) => b.peso - a.peso);
  return { pontos: Math.min(PONTOS_MAX, itens.reduce((n, i) => n + i.peso, 0)), itens, medida };
}

// ---------- decisão ----------
const NIVEIS = {
  provavelmente_falso: { rotulo: "Provavelmente falso", tom: "falso" },
  provavelmente_verdadeiro: { rotulo: "Provavelmente verdadeiro", tom: "verdadeiro" },
  suspeito: { rotulo: "Suspeito de ser boato", tom: "alerta" },
  nao_confirmado: { rotulo: "Não deu para confirmar", tom: "neutro" },
};

/** "A", "A e B", "A, B e C" (até 3 nomes; o resto vira "e outros"). */
export function listaDeNomes(nomes) {
  const n = [...new Set(nomes.filter(Boolean))];
  if (n.length <= 1) return n[0] || "";
  if (n.length === 2) return `${n[0]} e ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} e ${n[2]}`;
  return `${n[0]}, ${n[1]}, ${n[2]} e outros`;
}
const milhar = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Número de veículos distintos (a chave identifica o veículo; itens sem chave contam cada um). */
export const fontesDistintas = (lista) => new Set(lista.map((f, i) => f.chave || `#${i}`)).size;

/**
 * Regras, nesta ordem (a primeira que valer decide). Entrada:
 *   tipo         "afirmacao" | "opiniao" | "previsao" | "outro"
 *   inexistentes nomes de município que NÃO constam da lista do IBGE (já com a guarda de contexto aplicada)
 *   total        quantos municípios a lista do IBGE tem (para a frase do motivo)
 *   confirmam / contradizem   fontes [{ fonte, chave, oficial? }] cujas manchetes confirmam / contradizem a afirmação
 *   cobertura    quantas manchetes relacionadas a imprensa trouxe (de qualquer relação, menos "não relacionada")
 *   corrente     resultado de sinaisDeCorrente()
 *   agencias     { consultou: a consulta às agências funcionou?, checagens: quantas checagens (inclusive só "relacionadas") }
 * Saída: { nivel, rotulo, tom, confianca, resumo, motivos } com no máximo 5 motivos, os mais pesados primeiro.
 */
export function decidir({ tipo = "afirmacao", inexistentes = [], total = 5571, confirmam = [], contradizem = [], cobertura = 0, corrente = { pontos: 0, itens: [] }, agencias = {} }) {
  const opiniao = tipo === "opiniao" || tipo === "previsao";
  const nConf = fontesDistintas(confirmam), nContra = fontesDistintas(contradizem);
  const oficial = confirmam.some((f) => f.oficial);
  const nomesConf = listaDeNomes(confirmam.map((f) => f.fonte));
  let nivel, confianca, resumo;

  if (!opiniao && inexistentes.length && nConf === 0) {
    nivel = "provavelmente_falso"; confianca = "alta";
    resumo = `Não existe município com esse nome no Brasil e nenhum veículo ${cobertura ? "confirmou" : "noticiou"} o caso.`;
  } else if (!opiniao && nContra >= MIN_FONTES && nConf === 0) {
    nivel = "provavelmente_falso"; confianca = "alta";
    resumo = "Veículos de imprensa noticiam o contrário do que a mensagem afirma.";
  } else if (!opiniao && !inexistentes.length && nContra === 0 && (nConf >= MIN_FONTES || (nConf >= 1 && oficial))) {
    nivel = "provavelmente_verdadeiro"; confianca = nConf >= FONTES_ALTA ? "alta" : "media";
    resumo = `Foi noticiado por ${nomesConf}.`;
  } else if ((corrente.pontos >= LIMIAR_SUSPEITO && nConf === 0) || (tipo === "afirmacao" && cobertura === 0 && corrente.pontos >= LIMIAR_SEM_COBERTURA)) {
    nivel = "suspeito"; confianca = "media";
    resumo = agencias.consultou && !agencias.checagens
      ? "Nenhuma agência checou e nenhum veículo confirma; a mensagem usa gatilhos típicos de corrente."
      : "Nenhum veículo confirma; a mensagem usa gatilhos típicos de corrente.";
  } else {
    nivel = "nao_confirmado"; confianca = "baixa";
    resumo = opiniao
      ? "Isto é opinião ou previsão, não um fato que possa ser checado."
      : "Não encontramos agência, veículo ou dado oficial que confirme ou desminta isto.";
  }

  // motivos com peso: os mais pesados vêm primeiro
  const m = [];
  if (opiniao) m.push({ peso: 95, texto: "Isto é opinião ou previsão, não um fato que possa ser checado." });
  if (!opiniao) for (const nome of inexistentes.slice(0, 2)) m.push({ peso: 100, texto: `Não existe município chamado “${nome}” na lista oficial do IBGE (${milhar(total)} municípios).` });
  if (!opiniao && nContra) m.push({ peso: 90, texto: `Veículos como ${listaDeNomes(contradizem.map((f) => f.fonte))} noticiam o contrário ou desmentem a afirmação.` });
  if (nConf && nivel !== "provavelmente_falso") m.push({ peso: 80, texto: `Foi noticiado por ${nomesConf}.` });
  if (cobertura === 0) m.push({ peso: 40, texto: "Nenhum veículo de imprensa que consultamos noticiou o caso." });
  else if (!nConf && !nContra) m.push({ peso: 30, texto: "Há notícias sobre o assunto, mas nenhuma confirma a afirmação." });
  if (nivel !== "provavelmente_verdadeiro") for (const s of corrente.itens) m.push({ peso: s.peso, texto: s.texto });
  m.sort((a, b) => b.peso - a.peso);
  const motivos = m.slice(0, 4).map((x) => x.texto);

  // nota final sobre as agências: informa, mas nunca conta como motivo de falsidade
  if (agencias.checagens) motivos.push("Há checagens de agências sobre assuntos parecidos, mas nenhuma conclui sobre esta mensagem.");
  else if (agencias.consultou) motivos.push("Nenhuma agência de checagem analisou este boato ainda.");
  else motivos.push("Não conseguimos consultar as agências agora.");

  return { nivel, ...NIVEIS[nivel], origem: "radar", confianca, resumo, motivos };
}

// ---------- resultado quando uma agência concluiu ----------
const DA_AGENCIA = {
  falso: { rotulo: "É falso", tom: "falso", nivel: "provavelmente_falso" },
  enganoso: { rotulo: "É enganoso", tom: "enganoso", nivel: "provavelmente_falso" },
  verdadeiro: { rotulo: "É verdadeiro", tom: "verdadeiro", nivel: "provavelmente_verdadeiro" },
  misto: { rotulo: "Tem ressalvas", tom: "alerta", nivel: "nao_confirmado" },
};

/**
 * Resultado a partir do veredito agregado das agências ("falso" | "enganoso" | "verdadeiro" | "misto").
 * `checagens` traz { agencia, avaliacao, titulo, classe }. Devolve null se o veredito não é de agência.
 */
export function resultadoDaAgencia(agregado, checagens) {
  const d = DA_AGENCIA[agregado];
  if (!d) return null;
  const base = checagens.find((c) => c.classe === agregado) || checagens.find((c) => c.classe && c.classe !== "desconhecido") || checagens[0] || {};
  const dito = (base.avaliacao || base.titulo || "").replace(/[.\s]+$/, "");
  const resumo = `A agência ${base.agencia || "de checagem"} avaliou: “${dito}”.`;
  return { nivel: d.nivel, resultado: { rotulo: d.rotulo, tom: d.tom, origem: "agencia", confianca: "alta", resumo } };
}

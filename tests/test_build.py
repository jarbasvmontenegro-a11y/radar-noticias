"""Testes do gerador do site e da verificação antes de publicar."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("RADAR_DATA", tempfile.mkdtemp())

from radar import build_site as b  # noqa: E402
from radar import collect as c  # noqa: E402


def article(i, url=None, title=None, kind="noticia", source="g1"):
    pub = datetime.now(timezone.utc) - timedelta(minutes=i)
    return {"id": f"id{i}", "title": title or f"Manchete número {i}", "desc": "Descrição curta.", "url": url or f"https://g1.globo.com/a/{i}",
            "source": source, "kind": kind, "published": pub.isoformat(timespec="seconds"), "seen": pub.isoformat(timespec="seconds")}


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.out = "site-teste"
        for mod in (c, b):
            p = mock.patch.object(mod, "DATA", self.tmp)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(lambda: shutil.rmtree(b.ROOT / self.out, ignore_errors=True))
        self.addCleanup(lambda: shutil.rmtree(b.ROOT / (self.out + ".new"), ignore_errors=True))

    def write(self, arts):
        (self.tmp / "articles.json").write_text(json.dumps({"articles": arts}), encoding="utf-8")

    def test_build_normal_passa_na_verificacao(self):
        self.write([article(i) for i in range(5)] + [article(9, kind="checagem", source="lupa")])
        path = b.build(self.out)
        self.assertTrue(Path(path).exists())
        self.assertEqual(b.verify_site(b.ROOT / self.out, 5), [])

    def test_sem_dados_ainda_gera_site_valido(self):
        b.build(self.out)
        self.assertIn("Ainda não há manchetes", (b.ROOT / self.out / "index.html").read_text(encoding="utf-8"))

    def test_registros_quebrados_ou_com_link_perigoso_sao_ignorados(self):
        bad = [article(1, url="javascript:alert(1)"), {"title": "sem campos"}, article(2, url="https://g1.globo.com/ok")]
        bad[1].pop("url", None)
        self.write(bad)
        b.build(self.out)
        home = (b.ROOT / self.out / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("javascript:", home)
        self.assertEqual(home.count('class="item"'), 1)

    def test_texto_malicioso_e_escapado(self):
        self.write([article(1, title='<script>alert(1)</script> "oi"')])
        b.build(self.out)
        home = (b.ROOT / self.out / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("<script>alert(1)</script>", home)
        # o JSON-LD também não pode conter "<" cru vindo de dados
        for chunk in home.split('application/ld+json">')[1:]:
            self.assertNotIn("<script>alert", chunk.split("</script>")[0])

    def test_verify_detecta_problemas(self):
        self.write([article(1)])
        b.build(self.out)
        site = b.ROOT / self.out
        (site / "sitemap.xml").write_text("<urlset>", encoding="utf-8")
        self.assertTrue(any("sitemap" in p for p in b.verify_site(site)))
        (site / "sitemap.xml").write_text('<urlset xmlns="x"/>', encoding="utf-8")
        (site / "sobre" / "index.html").write_text('<title>x</title><a href="javascript:alert(1)">x</a>', encoding="utf-8")
        probs = b.verify_site(site)
        self.assertTrue(any("esquema perigoso" in p for p in probs) and any("canonical" in p for p in probs))
        (site / "app.js").unlink()
        self.assertTrue(any("ausente" in p for p in b.verify_site(site)))

    def test_build_que_falha_nao_destroi_o_site_publicado(self):
        self.write([article(1)])
        b.build(self.out)
        before = (b.ROOT / self.out / "index.html").read_text(encoding="utf-8")
        with mock.patch.object(b, "verify_site", lambda *a, **k: ["quebrou"]):
            with self.assertRaises(b.BuildError):
                b.build(self.out)
        self.assertEqual((b.ROOT / self.out / "index.html").read_text(encoding="utf-8"), before)

    def test_zap_em_cada_noticia_e_destaques_por_cobertura(self):
        arts = [article(1, title="Senado aprova projeto da reforma tributária em votação apertada", source="g1"),
                article(2, url="https://oglobo.globo.com/a/2", title="Senado aprova reforma tributária após votação apertada", source="oglobo"),
                article(3, url="https://folha.uol.com.br/a/3", title="Reforma tributária aprovada no Senado em votação apertada", source="folha"),
                article(4, title="Outro assunto totalmente diferente sobre eleições municipais")]
        self.write(arts)
        b.build(self.out)
        home = (b.ROOT / self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn("https://wa.me/?text=", home)
        self.assertIn("Assuntos em alta", home)
        self.assertIn("Mais 2 manchetes sobre o mesmo assunto", home)  # as três manchetes parecidas viram uma entrada
        self.assertIn("Enviar no WhatsApp", home)
        assuntos = (b.ROOT / self.out / "assuntos" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Como cada veículo contou", assuntos)
        self.assertIn("reforma tributária", assuntos.lower())
        self.assertIn('id="aq"', assuntos)

    def test_paginas_por_estado_e_lista_de_estados(self):
        self.write([article(1, title="Governador do Ceará anuncia obras em Fortaleza"), article(2, title="Senado aprova projeto de lei")])
        b.build(self.out)
        site = b.ROOT / self.out
        ce = (site / "estado" / "ce" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Governador do Ceará anuncia obras", ce)
        self.assertNotIn("Senado aprova projeto de lei", ce)
        self.assertFalse((site / "estado" / "sp").exists())  # estado sem manchete não vira página vazia
        self.assertIn('href="/estado/ce/"', (site / "estados" / "index.html").read_text(encoding="utf-8"))
        self.assertIn("/estado/ce/", (site / "sitemap.xml").read_text(encoding="utf-8"))

    def test_paginacao_noindex_e_links_entre_paginas(self):
        self.write([article(i) for i in range(1, 131)])
        b.build(self.out)
        site = b.ROOT / self.out
        p1 = (site / "index.html").read_text(encoding="utf-8")
        p2 = (site / "pagina" / "2" / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="/pagina/2/"', p1)
        self.assertIn('rel="next"', p1)
        self.assertIn("noindex", p2)
        self.assertNotIn("noindex", p1)
        self.assertIn('rel="prev" href="/"', p2)
        self.assertNotIn("/pagina/2/", (site / "sitemap.xml").read_text(encoding="utf-8"))

    def test_cabecalhos_de_seguranca_csp_sem_inline_solto(self):
        self.write([article(1)])
        b.build(self.out)
        headers = (b.ROOT / self.out / "_headers").read_text(encoding="utf-8")
        csp = [l for l in headers.splitlines() if "Content-Security-Policy" in l][0]
        script_src = csp.split("script-src")[1].split(";")[0]
        self.assertIn("'sha256-", script_src)  # o script do tema entra por hash
        self.assertNotIn("unsafe-inline", script_src)
        self.assertIn("frame-ancestors", csp)
        self.assertIn("Strict-Transport-Security", headers)
        self.assertNotIn(" onclick=", (b.ROOT / self.out / "index.html").read_text(encoding="utf-8"))  # CSP bloquearia

    def test_paginas_de_tema_manifest_e_share_target(self):
        self.write([article(1, title="Senado aprova projeto de lei em plenário")])
        b.build(self.out)
        site = b.ROOT / self.out
        self.assertTrue((site / "tema" / "congresso" / "index.html").is_file())
        mf = json.loads((site / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(mf["share_target"]["params"]["text"], "text")
        self.assertIn("/tema/congresso/", (site / "sitemap.xml").read_text(encoding="utf-8"))
        self.assertTrue((site / "share.js").is_file())

    def test_destaques_para_notificacoes_e_pagina(self):
        titulos = ["Senado aprova projeto da reforma tributária em votação apertada",
                   "Senado aprova reforma tributária após votação apertada",
                   "Reforma tributária aprovada no Senado em votação apertada"]
        arts = [article(i + 1, url=f"https://x{i}.com/a", title=t, source=s) for i, (t, s) in enumerate(zip(titulos, ["g1", "oglobo", "folha"]))]
        arts.append(article(9, url="https://lupa.news/a", kind="checagem", source="lupa", title="É falso que político disse isso em vídeo"))
        arts.append(article(10, url="https://lupa.news/b", kind="checagem", source="lupa", title="Entenda como funciona o voto eletrônico"))
        self.write(arts)
        b.build(self.out)
        dest = json.loads((b.ROOT / self.out / "data" / "destaques.json").read_text(encoding="utf-8"))
        assunto = [d for d in dest if d["k"] == "assunto"]
        self.assertEqual(len(assunto), 1)
        self.assertEqual(assunto[0]["n"], 3)
        self.assertEqual(len(assunto[0]["id"]), 12)
        checagens = [d for d in dest if d["k"] == "checagem"]
        self.assertEqual([d["u"] for d in checagens], ["https://lupa.news/a"])  # só a que desmente algo
        page = (b.ROOT / self.out / "notificacoes" / "index.html").read_text(encoding="utf-8")
        self.assertIn('name="tema"', page)
        self.assertIn('value="CE"', page)
        self.assertIn("/push.js", page)
        self.assertTrue((b.ROOT / self.out / "sw.js").is_file())
        home = (b.ROOT / self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="/notificacoes/"', home)

    def test_mini_janela(self):
        arts = [article(1, url="https://g1.globo.com/a/1", source="g1", title="Lula sanciona projeto sobre reforma tributária"),
                article(2, url="https://oglobo.globo.com/a/2", source="oglobo", title="Flávio Bolsonaro critica Lula em entrevista javascript:alert(1)")]
        self.write(arts)
        b.build(self.out)
        root = b.ROOT / self.out
        dados = json.loads((root / "data" / "ultimas.json").read_text(encoding="utf-8"))
        self.assertEqual(set(dados), {"gerado", "assuntos", "itens"})
        self.assertEqual(len(dados["itens"]), 2)
        self.assertEqual(set(dados["itens"][0]), {"t", "s", "u", "d", "n"})
        self.assertLess(len(json.dumps(dados)), 20000)  # leve: a janela confere de 5 em 5 minutos
        mini = (root / "mini" / "index.html").read_text(encoding="utf-8")
        self.assertIn("noindex", mini)
        self.assertIn("/mini.js", mini)
        self.assertIn("/mini.css", mini)
        home = (root / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="mini-open"', home)
        self.assertIn("/mini.js?v=", home)
        js = (root / "mini.js").read_text(encoding="utf-8")
        for perigoso in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("):
            self.assertNotIn(perigoso, js)
        self.assertNotIn("/mini/", (root / "sitemap.xml").read_text(encoding="utf-8"))

    def test_conferencia_titulo_alterado_e_palavras_de_juizo(self):
        a1 = article(1, url="https://g1.globo.com/a/1", source="g1", title="Ministro acusa governo e provoca escândalo no Senado")
        a1["anterior"] = "Ministro faz críticas ao governo no Senado"
        a2 = article(2, url="https://oglobo.globo.com/a/2", source="oglobo", title="Ministro critica governo no Senado <b>x</b>")
        self.write([a1, a2])
        b.build(self.out)
        root = b.ROOT / self.out
        home = (root / "index.html").read_text(encoding="utf-8")
        self.assertIn("título alterado", home)
        self.assertIn("Ministro faz críticas ao governo no Senado", home)
        sobre = (root / "sobre" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="destaques"', sobre)
        self.assertIn("escandalo", sobre)
        # a marcação nunca deixa HTML do título passar sem escapar
        assuntos = (root / "assuntos" / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("<b>x</b>", assuntos)
        self.assertIn("frame-note", assuntos)

    def test_politica_editorial(self):
        self.write([article(1)])
        b.build(self.out)
        root = b.ROOT / self.out
        pag = (root / "politica-editorial" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Política editorial", pag)
        self.assertIn("Nenhuma correção registrada", pag)
        self.assertNotIn("noindex", pag)
        self.assertIn("/politica-editorial/", (root / "sitemap.xml").read_text(encoding="utf-8"))
        self.assertIn('href="/politica-editorial/"', (root / "index.html").read_text(encoding="utf-8"))
        self.assertIn('id="fontes"', (root / "sobre" / "index.html").read_text(encoding="utf-8"))  # âncora usada pela política

    def test_pessoas_deteccao_e_paginas(self):
        from radar import pessoas
        self.assertEqual(pessoas.detect("Caiado anuncia apoio a Flávio no 2º turno"), ["flavio-bolsonaro", "caiado"])
        self.assertEqual(pessoas.detect("Flávio Dino vota contra o projeto"), ["flavio-dino"])  # outro Flávio
        self.assertEqual(pessoas.detect("Lula e Bolsonaro se encontram"), ["lula", "jair-bolsonaro"])
        self.assertEqual(pessoas.detect("Flávio Bolsonaro critica Lula"), ["lula", "flavio-bolsonaro"])
        self.assertNotIn("jair-bolsonaro", pessoas.detect("Eduardo Bolsonaro e a família Bolsonaro"))
        self.assertEqual(pessoas.detect("Michelle Obama visita escola"), [])
        arts = [article(1, title="Lula sanciona projeto sobre reforma tributária"),
                article(2, url="https://oglobo.globo.com/a/2", source="oglobo", title="Flávio Bolsonaro critica Lula em entrevista"),
                article(3, url="https://folha.uol.com.br/a/3", source="folha", title="Lula fala sobre o Orçamento do próximo ano")]
        self.write(arts)
        b.build(self.out)
        root = b.ROOT / self.out
        home = (root / "index.html").read_text(encoding="utf-8")
        self.assertIn("Quem mais aparece nas manchetes", home)
        self.assertIn("Não mede apoio", home)
        lula = (root / "pessoa" / "lula" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Lula sanciona projeto", lula)
        self.assertEqual(lula.count('class="item"'), 3)
        idx = json.loads((root / "data" / "search-index.json").read_text(encoding="utf-8"))
        self.assertTrue(any("lula" in e.get("g", []) and e.get("i") for e in idx))
        busca = (root / "busca" / "index.html").read_text(encoding="utf-8")
        self.assertIn("noindex", busca)
        self.assertIn("/busca.js", busca)
        self.assertIn('action="/busca/"', home)

    def test_home_usa_assuntos_da_ia_quando_ha_arquivo_valido(self):
        fontes = ["g1", "oglobo", "folha", "uol"]
        arts = [article(i + 1, url=f"https://{s}.com/{i}", source=s, title=f"Manchete {i} {s}") for i, s in enumerate(fontes * 3)]
        self.write(arts)
        ids = [a["id"] for a in arts]
        assuntos = [{"titulo": f"Assunto da IA {k}", "resumo": f"Resumo {k}.", "ids": ids[k * 4:(k + 1) * 4]} for k in range(3)]
        (self.tmp / "destaques_ia.json").write_text(json.dumps({"gerado": datetime.now(timezone.utc).isoformat(), "assuntos": assuntos}), encoding="utf-8")
        b.build(self.out)
        home = (b.ROOT / self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn("Assunto da IA 0", home)
        self.assertIn("Agrupados por IA", home)
        assuntos = (b.ROOT / self.out / "assuntos" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Assunto da IA 2", assuntos)
        self.assertIn("agrupados por IA", assuntos)
        # o agrupamento da IA também esconde repetições nas listas: 4 manchetes de cada assunto viram uma entrada
        self.assertGreaterEqual(home.count("sobre o mesmo assunto"), 3)
        # sem arquivo: volta ao agrupamento por palavras e não promete IA
        (self.tmp / "destaques_ia.json").unlink()
        b.build(self.out)
        self.assertNotIn("Agrupados por IA", (b.ROOT / self.out / "index.html").read_text(encoding="utf-8"))

    def test_mensagem_do_zap_tem_descricao_e_link_no_fim(self):
        a = {"source_name": "Poder360", "title": "Título", "url": "https://p.com/x", "kind": "noticia",
             "desc": "Partido decidiu não apoiar candidatos no 1º turno. Leia no Poder360."}
        cfg = {"name": "Radar", "site_url": "https://x.org"}
        txt = b.share_text(a, cfg)
        self.assertTrue(txt.startswith("*Título*"))
        self.assertIn("Partido decidiu", txt)
        self.assertNotIn("Leia no Poder360", txt)
        self.assertTrue(txt.endswith("https://p.com/x"))
        self.assertFalse(any(ord(ch) > 0xFFFF for ch in txt))

    def test_mensagem_do_zap_de_checagem_nao_afirma_falso(self):
        a = {"source_name": "Lupa", "title": "Título", "url": "https://lupa.news/x", "kind": "checagem", "desc": ""}
        txt = b.share_text(a, {"name": "Radar", "site_url": "https://x.org"})
        self.assertIn("Checagem publicada por Lupa", txt)
        self.assertNotIn("FALSO", txt)
        self.assertTrue(b.wa_link(txt).startswith("https://wa.me/?text="))
        self.assertNotIn("\n", b.wa_link(txt))


if __name__ == "__main__":
    unittest.main()


class DestaquesIATests(unittest.TestCase):
    def setUp(self):
        from radar import destaques_ia as ia
        self.ia = ia
        self.now = datetime.now(timezone.utc)
        mk = lambda i, src: {"id": f"id{i}", "title": f"Manchete {i}", "source": src, "source_name": src.upper(), "dt": self.now - timedelta(minutes=i)}
        self.arts = [mk(1, "g1"), mk(2, "folha"), mk(3, "oglobo"), mk(4, "g1"), mk(5, "uol"), mk(6, "estadao")]
        self.por_num = {i + 1: a for i, a in enumerate(self.arts)}
        self.por_id = {a["id"]: a for a in self.arts}

    def test_validar_descarta_numero_inventado_repetido_e_assunto_de_um_so_veiculo(self):
        resp = {"assuntos": [
            {"titulo": "Assunto A", "resumo": "Fato A https://x.com", "ids": [1, 2, 3, 99]},
            {"titulo": "Assunto B", "resumo": "", "ids": [3, 4]},          # 3 já usado: sobra só o 4 (g1) -> um veículo só
            {"titulo": "Assunto C", "resumo": "ok", "ids": [5, 6]},
            {"titulo": "", "resumo": "sem título", "ids": [1, 2]},
            "lixo", {"titulo": "X", "ids": "não é lista"}]}
        out = self.ia.validar(resp, self.por_num)
        self.assertEqual([s["titulo"] for s in out], ["Assunto A", "Assunto C"])
        self.assertEqual(out[0]["ids"], ["id1", "id2", "id3"])
        self.assertNotIn("http", out[0]["resumo"])
        self.assertEqual(self.ia.validar(None, self.por_num), [])
        self.assertEqual(self.ia.validar({"assuntos": "x"}, self.por_num), [])

    def test_aplicar_ordena_por_veiculos_e_cai_para_palavras_quando_velho_ou_pouco(self):
        dados = {"gerado": self.now.isoformat(), "assuntos": [
            {"titulo": "Pequeno", "resumo": "", "ids": ["id1", "id2"]},
            {"titulo": "Grande", "resumo": "r", "ids": ["id3", "id5", "id6", "id4"]},
            {"titulo": "Médio", "resumo": "", "ids": ["id1", "id5", "id2"]},
            {"titulo": "Fantasma", "resumo": "", "ids": ["nao-existe", "tambem-nao"]}]}
        r = self.ia.aplicar(dados, self.por_id, self.now)
        self.assertEqual([h["titulo"] for h in r], ["Grande", "Médio", "Pequeno"])
        self.assertEqual(r[0]["n"], 4)
        self.assertTrue(all(h["ia"] for h in r))
        self.assertEqual(r[0]["lead"]["id"], "id3")  # o mais recente do grupo
        velho = {**dados, "gerado": (self.now - timedelta(hours=40)).isoformat()}
        self.assertIsNone(self.ia.aplicar(velho, self.por_id, self.now))
        self.assertIsNone(self.ia.aplicar({**dados, "assuntos": dados["assuntos"][:2]}, self.por_id, self.now))
        self.assertIsNone(self.ia.aplicar(None, self.por_id, self.now))
        self.assertIsNone(self.ia.aplicar({"gerado": "lixo", "assuntos": dados["assuntos"]}, self.por_id, self.now))

    def test_so_gera_duas_vezes_por_dia_dentro_do_horario(self):
        utc = lambda h, d=6: datetime(2026, 10, d, h, 7, tzinfo=timezone.utc)  # Brasília = UTC-3
        antigo = {"gerado": utc(11, 5).isoformat()}
        self.assertTrue(self.ia.precisa_gerar(utc(11), None))                       # 08h07 e sem arquivo
        self.assertTrue(self.ia.precisa_gerar(utc(11), antigo))                     # 08h07, arquivo de ontem
        self.assertFalse(self.ia.precisa_gerar(utc(12), {"gerado": utc(11).isoformat()}))   # 09h07, gerado há 1 h
        self.assertFalse(self.ia.precisa_gerar(utc(19), {"gerado": utc(11).isoformat()}))   # 16h07, 8 h depois
        self.assertTrue(self.ia.precisa_gerar(utc(20), {"gerado": utc(11).isoformat()}))    # 17h07, 9 h depois
        self.assertFalse(self.ia.precisa_gerar(utc(3), antigo))                     # 00h07: fora do horário
        self.assertFalse(self.ia.precisa_gerar(utc(1, 7), None))                    # 22h07 de Brasília

    def test_chamada_a_ia_usa_segredo_derivado_e_falha_com_erro_http(self):
        visto = {}

        class R:
            def __init__(self, code): self.status_code = code
            def json(self): return {"assuntos": []}

        def post_ok(url, **k):
            visto.update(url=url, auth=k["headers"]["Authorization"], itens=k["json"]["itens"])
            return R(200)
        self.ia.chamar_ia("https://site.exemplo.org/", "token-cf", ["1|G1|x"], post=post_ok)
        self.assertEqual(visto["url"], "https://site.exemplo.org/api/ia/agrupar")
        self.assertEqual(visto["auth"], "Bearer " + self.ia.segredo("token-cf"))
        self.assertEqual(len(self.ia.segredo("token-cf")), 64)
        with self.assertRaises(RuntimeError):
            self.ia.chamar_ia("https://site.exemplo.org", "t", ["1|G1|x"], post=lambda u, **k: R(401))

    def test_candidatos_sao_as_manchetes_recentes_numeradas(self):
        mk = lambda i, h: {"id": f"a{i}", "title": f"Título {i} | com barra", "source": f"s{i}", "source_name": f"S{i}", "dt": self.now - timedelta(hours=h)}
        arts = [mk(1, 1), mk(2, 5), mk(3, 31)]  # a terceira é velha demais
        cands = self.ia.candidatos(arts, self.now)
        self.assertEqual([a["id"] for a in cands], ["a1", "a2"])
        linhas, por_num = self.ia.numerar(cands)
        self.assertTrue(linhas[0].startswith("1|S1|") and len(por_num) == 2)
        self.assertEqual(linhas[0].count("|"), 2)  # barra no título não quebra o formato


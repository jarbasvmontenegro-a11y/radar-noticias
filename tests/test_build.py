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
        self.assertIn("Como cada veículo contou", home)
        self.assertIn("Também em", home)
        self.assertIn("Enviar no WhatsApp", home)

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

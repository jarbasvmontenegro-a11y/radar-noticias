"""Testes do coletor (sem rede). Rode com:  python -m unittest discover -s tests -v"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("RADAR_DATA", tempfile.mkdtemp())

from radar import collect as c  # noqa: E402


def rss(items):
    body = "".join(
        f"<item><title>{t}</title><link>{u}</link><description>{d}</description><pubDate>{format_datetime(p)}</pubDate></item>"
        for t, u, d, p in items
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel>{body}</channel></rss>'.encode()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        p = mock.patch.object(c, "DATA", self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def run_collect(self, sources, fetch):
        with mock.patch.object(c, "load_sources", lambda *a, **k: sources), mock.patch.object(c, "fetch_feed", fetch):
            return c.collect(7, 40)

    @staticmethod
    def src(i="t"):
        return {"id": i, "name": i.upper(), "kind": "noticia", "url": f"https://x.com/{i}"}


class ParseTests(unittest.TestCase):
    def test_rss_limpa_html_e_corta_descricao(self):
        long_desc = "<p>" + "palavra " * 100 + "</p>"
        items = c.parse_feed(rss([("Título &amp; mais", "https://x.com/a?utm_source=zap", long_desc, datetime.now(timezone.utc))]))
        self.assertEqual(items[0]["title"], "Título & mais")
        self.assertLessEqual(len(items[0]["desc"]), c.MAX_DESC + 1)
        self.assertNotIn("<p>", items[0]["desc"])

    def test_atom(self):
        atom = (b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link rel="alternate" href="https://x.com/b"/>'
                b"<summary>Resumo</summary><updated>2026-10-04T15:00:00Z</updated></entry></feed>")
        items = c.parse_feed(atom)
        self.assertEqual(items[0]["url"], "https://x.com/b")
        self.assertEqual(items[0]["published"].hour, 15)

    def test_descricao_que_repete_titulo_e_descartada(self):
        items = c.parse_feed(rss([("Governo anuncia pacote", "https://x.com/c", "Governo anuncia pacote", datetime.now(timezone.utc))]))
        self.assertEqual(items[0]["desc"], "")

    def test_url_canonica_ignora_rastreamento(self):
        self.assertEqual(c.canonical_url("https://X.com/p?id=1&utm_source=a&fbclid=z#topo"), c.canonical_url("https://x.com/p?id=1"))
        self.assertEqual(c.article_id("https://x.com/p?id=1&utm_medium=m"), c.article_id("https://x.com/p?id=1"))

    def test_so_aceita_links_http_https(self):
        for bad in ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "ftp://x.com/a", "//x.com/a", "https://u:p@x.com/a",
                    "https://x.com/a b", "", "https://" + "a" * 2100 + ".com"]:
            self.assertEqual(c.safe_url(bad), "", bad)
        self.assertEqual(c.safe_url("https://x.com/a?b=1"), "https://x.com/a?b=1")

    def test_item_com_link_perigoso_vira_url_vazia(self):
        items = c.parse_feed(rss([("Título", "javascript:alert(1)", "d", datetime.now(timezone.utc))]))
        self.assertEqual(items[0]["url"], "")

    def test_rejeita_xml_com_entidades(self):
        evil = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss><channel><item><title>&b;</title></item></channel></rss>'
        with self.assertRaises(ValueError):
            c.parse_feed(evil)

    def test_tolera_e_comercial_solto_e_caracteres_invalidos(self):
        raw = b'<?xml version="1.0"?><rss><channel><item><title>Saude & Educacao\x0b</title><link>https://x.com/a</link></item></channel></rss>'
        self.assertEqual(c.parse_feed(raw)[0]["title"], "Saude & Educacao")

    def test_limpa_caracteres_de_controle_e_bidi(self):
        self.assertEqual(c.clean("a‮b\x07c"), "abc")


class CollectTests(Base):
    def test_deduplica_por_url_e_por_titulo_e_respeita_janela(self):
        now = datetime.now(timezone.utc)
        feed = rss([
            ("Nova", "https://x.com/nova", "d", now - timedelta(hours=1)),
            ("Antiga", "https://x.com/antiga", "d", now - timedelta(days=30)),
            ("Nova repetida", "https://x.com/nova?utm_source=x", "d", now - timedelta(hours=1)),
            ("NOVA!", "https://x.com/outra-url", "d", now - timedelta(hours=2)),  # mesmo título, URL diferente
        ])
        fetch = lambda s: c.parse_feed(feed)
        r1 = self.run_collect([self.src()], fetch)
        r2 = self.run_collect([self.src()], fetch)
        self.assertEqual(r1["novas"], 1)
        self.assertEqual(r2["novas"], 0)
        self.assertEqual(r1["total"], 1)

    def test_feed_quebrado_nao_derruba_os_outros(self):
        good = c.parse_feed(rss([("Boa", "https://y.com/boa", "d", datetime.now(timezone.utc))]))

        def fetch(src):
            if src["id"] == "ruim":
                raise RuntimeError("fora do ar")
            return good

        r = self.run_collect([self.src("ruim"), self.src("bom")], fetch)
        self.assertEqual((r["fontes"], r["fontes_ok"], r["fora_do_ar"]), (2, 1, ["ruim"]))

    def test_link_perigoso_nunca_entra_no_arquivo(self):
        feed = rss([("Ruim", "javascript:alert(1)", "d", datetime.now(timezone.utc)), ("Boa", "https://x.com/ok", "d", datetime.now(timezone.utc))])
        self.run_collect([self.src()], lambda s: c.parse_feed(feed))
        arts = json.loads((self.tmp / "articles.json").read_text())["articles"]
        self.assertEqual([a["title"] for a in arts], ["Boa"])

    def test_se_todos_os_feeds_falham_o_historico_e_mantido(self):
        feed = rss([("Guardada", "https://x.com/g", "d", datetime.now(timezone.utc))])
        self.run_collect([self.src()], lambda s: c.parse_feed(feed))

        def down(src):
            raise RuntimeError("rede caiu")

        r = self.run_collect([self.src()], down)
        self.assertEqual(r["fontes_ok"], 0)
        self.assertEqual(r["total"], 1)  # nada foi perdido

    def test_arquivo_corrompido_nao_e_sobrescrito(self):
        (self.tmp / "articles.json").write_text("{quebrado", encoding="utf-8")
        with self.assertRaises(c.StoreCorrupted):
            self.run_collect([self.src()], lambda s: [])
        self.assertTrue((self.tmp / "articles.corrompido.json").exists())

    def test_escrita_atomica_nao_deixa_arquivo_temporario(self):
        self.run_collect([self.src()], lambda s: [])
        self.assertEqual(list(self.tmp.glob("*.tmp")), [])

    def test_saude_so_muda_em_transicao(self):
        down = lambda s: (_ for _ in ()).throw(RuntimeError("x"))
        up = lambda s: []
        self.run_collect([self.src()], down)
        h1 = json.loads((self.tmp / "health.json").read_text())["t"]["down_since"]
        self.assertTrue(h1)
        mtime = (self.tmp / "health.json").stat().st_mtime_ns
        self.run_collect([self.src()], down)  # continua fora do ar: arquivo não muda
        self.assertEqual((self.tmp / "health.json").stat().st_mtime_ns, mtime)
        self.assertEqual(json.loads((self.tmp / "health.json").read_text())["t"]["down_since"], h1)
        self.run_collect([self.src()], up)  # voltou
        self.assertEqual(json.loads((self.tmp / "health.json").read_text())["t"]["down_since"], "")

    def test_teto_de_artigos(self):
        now = datetime.now(timezone.utc)
        feed = rss([(f"Titulo numero {i}", f"https://x.com/{i}", "d", now - timedelta(minutes=i)) for i in range(30)])
        with mock.patch.object(c, "MAX_ARTICLES", 10):
            r = self.run_collect([self.src()], lambda s: c.parse_feed(feed))
        self.assertEqual(r["total"], 10)


class DownloadTests(unittest.TestCase):
    def test_nao_repete_em_erro_definitivo_mas_repete_em_erro_passageiro(self):
        import requests

        class Resp:
            def __init__(self, code):
                self.status_code, self.headers = code, {}
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def raise_for_status(self):
                if self.status_code >= 400:
                    raise requests.HTTPError(f"HTTP {self.status_code}")
            def iter_content(self, n): yield b"<rss/>"

        calls = []

        def fake_get(url, **kw):
            calls.append(url)
            return Resp(404 if "404" in url else (503 if len(calls) == 1 else 200))

        with mock.patch.object(c.requests, "get", fake_get), mock.patch.object(c.time, "sleep", lambda s: None):
            with self.assertRaises(requests.HTTPError):
                c._download("https://x.com/404")
            self.assertEqual(len(calls), 1)
            calls.clear()
            self.assertEqual(c._download("https://x.com/ok"), b"<rss/>")
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()


class ValidacaoTests(Base):
    def test_titulos_ruins(self):
        from radar import validar as v
        self.assertTrue(v.titulo_ruim("Oi"))
        self.assertTrue(v.titulo_ruim("Sem título"))
        self.assertTrue(v.titulo_ruim("https://g1.globo.com/politica/noticia/2026/10/06/abc.ghtml"))
        self.assertTrue(v.titulo_ruim("!!!! 1234 ???? 5678 !!!!"))
        self.assertEqual(v.titulo_ruim("Senado aprova projeto da reforma tributária"), "")

    def test_link_morto_so_quando_o_veiculo_diz_que_nao_existe(self):
        from radar import validar as v

        class Resp:
            def __init__(self, status, url):
                self.status_code, self.url = status, url
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def get_com(status, final=None):
            return lambda url, **k: Resp(status, final or url)

        u = "https://g1.globo.com/politica/noticia/a.ghtml"
        self.assertEqual(v.checar_link(u, get=get_com(200))[0], "ok")
        self.assertEqual(v.checar_link(u, get=get_com(404))[0], "morto")
        self.assertEqual(v.checar_link(u, get=get_com(410))[0], "morto")
        self.assertEqual(v.checar_link(u, get=get_com(200, "https://g1.globo.com/"))[0], "morto")  # soft 404
        self.assertEqual(v.checar_link("https://g1.globo.com/", get=get_com(200))[0], "ok")  # a própria home não é soft 404
        for status in (403, 429, 500, 503):  # bloqueio de robô ou instabilidade: a notícia entra
            self.assertEqual(v.checar_link(u, get=get_com(status))[0], "incerto")

        import requests

        def cai(url, **k):
            raise requests.Timeout("lento")
        self.assertEqual(v.checar_link(u, get=cai)[0], "incerto")

    def test_coleta_descarta_link_morto_e_titulo_ruim_e_mantem_incertos(self):
        from radar import validar as v
        now = datetime.now(timezone.utc)
        feed = [("Matéria que existe e abre normalmente", "https://x.com/ok", "d", now),
                ("Matéria que o veículo apagou do ar", "https://x.com/morta", "d", now),
                ("Matéria que o veículo bloqueia robôs", "https://x.com/bloqueada", "d", now),
                ("Oi", "https://x.com/curto", "d", now)]
        est = {"https://x.com/ok": ("ok", ""), "https://x.com/morta": ("morto", "HTTP 404"), "https://x.com/bloqueada": ("incerto", "HTTP 403")}
        with mock.patch.object(v, "checar_link", lambda url, **k: est.get(url, ("ok", ""))):
            def fetch(src):
                return c.parse_feed(rss(feed))
            with mock.patch.object(c, "load_sources", lambda *a, **k: [self.src()]), mock.patch.object(c, "fetch_feed", fetch):
                # o validador usa o checar padrão por dentro: troca a função que ele chama por padrão
                orig = v.validar_novas
                with mock.patch.object(v, "validar_novas", lambda novas, **k: orig(novas, checar=v.checar_link, **k)):
                    stats = c.collect(7, 40, validar=True)
        guardadas = {a["url"] for a in c.load_json(self.tmp / "articles.json", {})["articles"]}
        self.assertEqual(guardadas, {"https://x.com/ok", "https://x.com/bloqueada"})
        self.assertEqual(stats["validacao"]["mortas"], 1)
        self.assertEqual(stats["novas"], 2)

    def test_sem_validar_nada_e_descartado(self):
        now = datetime.now(timezone.utc)
        feed = [("Matéria qualquer com título bom", "https://x.com/a", "d", now)]
        self.run_collect([self.src()], lambda s: c.parse_feed(rss(feed)))
        self.assertEqual(len(c.load_json(self.tmp / "articles.json", {})["articles"]), 1)

    def test_orcamento_de_tempo_esgotado_nao_descarta(self):
        from radar import validar as v
        novas = [{"title": f"Manchete de teste número {i} sobre política", "url": f"https://x.com/{i}", "source": "t"} for i in range(5)]
        aceitos, descartados, cont = v.validar_novas(novas, orcamento_s=-1, checar=lambda u: ("morto", "x"))
        self.assertEqual(len(aceitos), 5)
        self.assertEqual(cont["sem_tempo"], 5)

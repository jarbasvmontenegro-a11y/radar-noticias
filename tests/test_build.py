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


if __name__ == "__main__":
    unittest.main()

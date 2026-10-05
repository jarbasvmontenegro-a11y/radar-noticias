"""Testes do coletor (sem rede). Rode com:  python -m unittest discover -s tests -v"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["RADAR_DATA"] = tempfile.mkdtemp()

from radar import collect as c  # noqa: E402


def rss(items):
    body = "".join(
        f"<item><title>{t}</title><link>{u}</link><description>{d}</description><pubDate>{format_datetime(p)}</pubDate></item>"
        for t, u, d, p in items
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel>{body}</channel></rss>'.encode()


class CollectTests(unittest.TestCase):
    def test_parse_rss_limpa_html_e_corta_descricao(self):
        now = datetime.now(timezone.utc)
        long_desc = "<p>" + "palavra " * 100 + "</p>"
        items = c.parse_feed(rss([("Título &amp; mais", "https://x.com/a?utm_source=zap", long_desc, now)]))
        self.assertEqual(items[0]["title"], "Título & mais")
        self.assertLessEqual(len(items[0]["desc"]), c.MAX_DESC + 1)
        self.assertNotIn("<p>", items[0]["desc"])

    def test_parse_atom(self):
        atom = (b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link rel="alternate" href="https://x.com/b"/>'
                b"<summary>Resumo</summary><updated>2026-10-04T15:00:00Z</updated></entry></feed>")
        items = c.parse_feed(atom)
        self.assertEqual(items[0]["url"], "https://x.com/b")
        self.assertEqual(items[0]["published"].hour, 15)

    def test_descricao_que_repete_titulo_e_descartada(self):
        items = c.parse_feed(rss([("Governo anuncia pacote", "https://x.com/c", "Governo anuncia pacote", datetime.now(timezone.utc))]))
        self.assertEqual(items[0]["desc"], "")

    def test_url_canonica_ignora_rastreamento(self):
        a = c.canonical_url("https://X.com/p?id=1&utm_source=a&fbclid=z#topo")
        b = c.canonical_url("https://x.com/p?id=1")
        self.assertEqual(a, b)
        self.assertEqual(c.article_id("https://x.com/p?id=1&utm_medium=m"), c.article_id("https://x.com/p?id=1"))

    def test_collect_deduplica_e_respeita_janela(self):
        now = datetime.now(timezone.utc)
        feed = rss([
            ("Nova", "https://x.com/nova", "d", now - timedelta(hours=1)),
            ("Antiga", "https://x.com/antiga", "d", now - timedelta(days=30)),
            ("Nova repetida", "https://x.com/nova?utm_source=x", "d", now - timedelta(hours=1)),
        ])
        c.load_sources = lambda *a, **k: [{"id": "t", "name": "Teste", "kind": "noticia", "url": "https://x.com/feed"}]
        c.fetch_feed = lambda src: c.parse_feed(feed)
        c.time.sleep = lambda s: None
        r1 = c.collect(7, 40)
        r2 = c.collect(7, 40)
        self.assertEqual(r1["novas"], 1)
        self.assertEqual(r2["novas"], 0)
        self.assertEqual(r1["total"], 1)

    def test_feed_quebrado_nao_derruba_os_outros(self):
        now = datetime.now(timezone.utc)
        good = c.parse_feed(rss([("Boa", "https://y.com/boa", "d", now)]))

        def fetch(src):
            if src["id"] == "ruim":
                raise RuntimeError("fora do ar")
            return good

        c.load_sources = lambda *a, **k: [
            {"id": "ruim", "name": "Ruim", "kind": "noticia", "url": "u1"},
            {"id": "bom", "name": "Bom", "kind": "noticia", "url": "u2"},
        ]
        c.fetch_feed = fetch
        r = c.collect(7, 40)
        self.assertEqual(r["fontes"], 2)
        self.assertEqual(r["fontes_ok"], 1)


if __name__ == "__main__":
    unittest.main()

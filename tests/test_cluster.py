import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from radar.cluster import cluster, topic_of  # noqa: E402

T = [{"id": "mundo", "name": "Mundo", "keywords": ["eua", "trump"]}, {"id": "congresso", "name": "C", "keywords": ["senado"]}]


class ClusterTests(unittest.TestCase):
    def test_agrupa_mesmo_assunto_de_veiculos_diferentes(self):
        a = [{"title": "Senado aprova reforma tributária em votação apertada", "source": "g1"},
             {"title": "Reforma tributária é aprovada no Senado em votação apertada", "source": "folha"},
             {"title": "Prefeito inaugura ponte em cidade do interior", "source": "g1"}]
        g = cluster(a)
        self.assertEqual(len(g), 1)
        self.assertEqual({x["source"] for x in g[0]}, {"g1", "folha"})

    def test_mesmo_veiculo_repetido_nao_conta_como_cobertura(self):
        a = [{"title": "Senado aprova reforma tributária em votação apertada", "source": "g1"},
             {"title": "Reforma tributária aprovada no Senado em votação apertada", "source": "g1"}]
        self.assertEqual(cluster(a), [])

    def test_assuntos_parecidos_mas_diferentes_nao_se_misturam(self):
        a = [{"title": "Senado aprova reforma tributária", "source": "g1"},
             {"title": "Câmara rejeita reforma administrativa", "source": "folha"}]
        self.assertEqual(cluster(a), [])

    def test_tema_casa_inicio_de_palavra(self):
        self.assertEqual(topic_of({"title": "Trump anuncia tarifa", "desc": ""}, T), ["mundo"])
        self.assertEqual(topic_of({"title": "Continuação do debate sobre saúde", "desc": ""}, T), [])
        self.assertEqual(topic_of({"title": "Senadores votam hoje", "desc": ""}, T), ["congresso"])


if __name__ == "__main__":
    unittest.main()

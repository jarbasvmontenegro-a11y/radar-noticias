"""Uso:  python -m radar <comando>

  check-feeds   testa cada feed RSS
  collect       baixa as notícias novas (sem IA) e atualiza data/
  build         gera o site em site/ (só substitui o anterior se passar na verificação)
  verify        confere o site já gerado (HTML, JSON-LD, sitemap, links perigosos)
  update        collect + build (o que o monitoramento roda a cada 30 min)
  demo          dados fictícios + site em site-demo/ (não mexe em data/ nem em site/)
"""
import argparse
import json
import os
import sys


def write_summary(stats: dict) -> None:
    """Escreve a saúde das fontes no resumo do job do GitHub Actions (se estiver rodando lá)."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    from .collect import DATA, load_json
    status, health = load_json(DATA / "status.json", {}), load_json(DATA / "health.json", {})
    lines = [f"### Coleta: {stats['novas']} novas, {stats['total']} no arquivo, {stats['fontes_ok']}/{stats['fontes']} fontes ok", "",
             "| Fonte | Situação | Novas | Observação |", "|---|---|---|---|"]
    for sid, st in sorted(status.items()):
        down = health.get(sid, {}).get("down_since", "")
        lines.append(f"| {st['name']} | {'ok' if st['ok'] else 'FALHOU'} | {st['new']} | {('fora do ar desde ' + down) if down else ''} {st['error']} |")
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main() -> int:
    p = argparse.ArgumentParser(prog="radar", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["check-feeds", "collect", "build", "verify", "update", "demo"])
    args = p.parse_args()

    if args.command == "demo":  # dados de exemplo ficam isolados para nunca irem parar no repositório
        os.environ["RADAR_DATA"] = "data-demo"

    from .collect import ROOT, StoreCorrupted, check_feeds, collect

    cfg = json.loads((ROOT / "config" / "site.json").read_text(encoding="utf-8"))

    def run_collect() -> bool:
        try:
            stats = collect(cfg["window_days"], cfg["per_source_limit"])
        except StoreCorrupted as exc:
            print("ERRO:", exc, file=sys.stderr)
            return False
        print("coleta:", stats)
        write_summary(stats)
        if stats["fontes_ok"] == 0:
            print("ERRO: nenhuma fonte respondeu (problema de rede?). O histórico foi mantido.", file=sys.stderr)
            return False
        return True

    if args.command == "check-feeds":
        check_feeds()
    elif args.command == "collect":
        return 0 if run_collect() else 1
    elif args.command in ("build", "update"):
        from .build_site import BuildError, build
        if args.command == "update" and not run_collect():
            return 1
        try:
            print("site gerado em", build())
        except BuildError as exc:
            print("ERRO:", exc, file=sys.stderr)
            return 1
    elif args.command == "verify":
        from .build_site import verify_site
        problems = verify_site(ROOT / "site")
        print("\n".join(problems) if problems else "site ok")
        return 1 if problems else 0
    elif args.command == "demo":
        from .build_site import build
        from .demo import seed_demo
        seed_demo()
        print("site gerado em", build("site-demo"), "\nAbra com: python -m http.server -d site-demo")
    return 0


if __name__ == "__main__":
    sys.exit(main())

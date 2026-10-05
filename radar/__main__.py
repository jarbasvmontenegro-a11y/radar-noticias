"""Uso:  python -m radar <comando>

  check-feeds   testa cada feed RSS
  collect       baixa as notícias novas (sem IA) e atualiza data/
  build         gera o site estático em site/
  update        collect + build (o que o monitoramento roda a cada 30 min)
  demo          dados fictícios + site em site-demo/ (não mexe em data/ nem em site/)
"""
import argparse
import os


def main() -> None:
    p = argparse.ArgumentParser(prog="radar", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["check-feeds", "collect", "build", "update", "demo"])
    args = p.parse_args()

    if args.command == "demo":  # dados de exemplo ficam isolados para nunca irem parar no repositório
        os.environ["RADAR_DATA"] = "data-demo"

    import json
    from .collect import ROOT, check_feeds, collect

    cfg = json.loads((ROOT / "config" / "site.json").read_text(encoding="utf-8"))

    if args.command == "check-feeds":
        check_feeds()
    elif args.command == "collect":
        print(collect(cfg["window_days"], cfg["per_source_limit"]))
    elif args.command == "build":
        from .build_site import build
        print("site gerado em", build())
    elif args.command == "update":
        from .build_site import build
        print("coleta:", collect(cfg["window_days"], cfg["per_source_limit"]))
        print("site gerado em", build())
    elif args.command == "demo":
        from .build_site import build
        from .demo import seed_demo
        seed_demo()
        print("site gerado em", build("site-demo"), "\nAbra com: python -m http.server -d site-demo")


if __name__ == "__main__":
    main()

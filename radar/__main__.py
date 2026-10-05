"""Uso:  python -m radar <comando>

  check-feeds   testa cada feed RSS
  collect       baixa as notícias novas
  summarize     agrupa e resume (hoje, ou --day AAAA-MM-DD)
  build         gera o site em site/
  daily         collect + summarize + build (o que roda todo dia)
  demo          popula o banco com dados de exemplo e gera o site (sem internet, sem IA)
"""
import argparse
from datetime import datetime
from zoneinfo import ZoneInfo

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

TZ = ZoneInfo("America/Sao_Paulo")


def today() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d")


def main() -> None:
    p = argparse.ArgumentParser(prog="radar", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["check-feeds", "collect", "summarize", "build", "daily", "demo"])
    p.add_argument("--day", default=None, help="AAAA-MM-DD (padrão: hoje)")
    args = p.parse_args()
    day = args.day or today()

    if args.command == "check-feeds":
        from .collect import check_feeds
        check_feeds()
    elif args.command == "collect":
        from .collect import collect
        print(collect())
    elif args.command == "summarize":
        from .summarize import summarize_day
        print(summarize_day(day))
    elif args.command == "build":
        from .build_site import build
        print("site gerado em", build())
    elif args.command == "daily":
        from .build_site import build
        from .collect import collect
        from .summarize import summarize_day
        stats = collect()
        print("coleta:", stats)
        # reprocessa hoje e ontem (matérias de madrugada caem no dia certo)
        from datetime import timedelta
        ontem = (datetime.now(TZ) - timedelta(days=1)).strftime("%Y-%m-%d")
        for d in (ontem, day):
            print("resumo:", summarize_day(d))
        print("site gerado em", build())
    elif args.command == "demo":
        from .demo import seed_demo
        from .build_site import build
        seed_demo()
        print("site gerado em", build())


if __name__ == "__main__":
    main()

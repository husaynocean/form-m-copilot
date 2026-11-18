"""
SYNTHETIC demo set for PriceCheck week 4: renders the 30 proformas planned by
scripts/pc-demo-plan.ts (samples/pricecheck/demo/plan.json) as PDFs and phone
photos. Every company, number and person is invented.

Run:  npx tsx scripts/pc-demo-plan.ts && python3 scripts/generate_pricecheck_demo.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_samples import make_proforma, photo_from_pdf  # noqa: E402

DIR = Path(__file__).resolve().parent.parent / "samples" / "pricecheck" / "demo"

PORTS = {"China": "Shanghai", "India": "Nhava Sheva", "Thailand": "Laem Chabang", "Canada": "Vancouver",
         "Netherlands": "Rotterdam", "USA": "Houston", "United Kingdom": "Felixstowe", "Norway": "Bergen",
         "Saudi Arabia": "Jeddah", "Brazil": "Santos", "Germany": "Hamburg", "New Zealand": "Tauranga",
         "Ireland": "Dublin"}


def proforma(d):
    goods = round(sum(l["line_total"] for l in d["lines"]), 2)
    return {
        "importer": {"name": d["buyer"], "rc_number": "RC 31" + d["invoice_number"][-5:].replace("-", ""),
                     "address": "12 Industrial Avenue, Ikeja, Lagos", "phone": "08030000000"},
        "beneficiary": {"name": d["supplier"], "address": f"Export Zone, {PORTS.get(d['country_of_origin'], 'Port')}, {d['supplier_country']}",
                        "country": d["supplier_country"]},
        "proforma": {"number": d["invoice_number"], "date": d["invoice_date"], "valid_until": "2027-01-31", "currency": d["currency"],
                     "incoterm": d["incoterm"], "country_of_origin": d["country_of_origin"], "country_of_supply": d["country_of_supply"],
                     "port_of_loading": PORTS.get(d["country_of_origin"], "Port"), "port_of_discharge": "Apapa, Lagos",
                     "mode_of_transport": "Sea", "payment_terms": "Letter of credit at sight",
                     "items": [dict(l) for l in d["lines"]], "goods_value": goods, "freight": 0.0, "insurance": 0.0,
                     "total": goods, "printed_total": d["total"]},
    }


def main():
    plan = json.loads((DIR / "plan.json").read_text())
    (DIR / "pdf").mkdir(exist_ok=True)
    (DIR / "photos").mkdir(exist_ok=True)
    for c in plan:
        pdf = DIR / "pdf" / f"{c['id']}.pdf"
        make_proforma(proforma(c["doc"]), pdf)
        photo_from_pdf(pdf, DIR / "photos" / f"{c['id']}.jpg", f"pc-demo-{c['id']}")
    print(f"Rendered {len(plan)} demo proformas")


if __name__ == "__main__":
    main()

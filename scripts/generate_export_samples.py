"""
Generate a SYNTHETIC export (Form NXP) test pack.

Every company, vessel, address and certificate number here is invented.
HS codes are real public tariff headings.

Output (samples/export_cases/<id>/):
  commercial_invoice.pdf, packing_list.pdf, bill_of_lading.pdf, nepc_certificate.pdf
  photos/*.jpg        phone-style photos of each page
  answer_key.json     {"truth": <documents as printed>, "expected_issues": [...], "today": ...}

Run:  python3 scripts/generate_export_samples.py
"""
import json
import shutil
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_samples import H, N, S, fmt, money, photo_from_pdf, tbl  # noqa: E402

from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "samples" / "export_cases"
TODAY = date(2026, 11, 14)  # fixed "today" for the repatriation tests

# (name, RC, address, NEPC cert no.)
EXPORTERS = [
    ("Dala Sesame Exports Ltd", "RC 1903344", "22 Sharada Industrial Estate, Kano", "NEPC/KN/0042871"),
    ("Tiga Agro Commodities Ltd", "RC 2056710", "7 Zaria Road, Kano", "NEPC/KN/0051392"),
    ("Gongola Ginger Traders Ltd", "RC 1811905", "14 Kachia Road, Kaduna", "NEPC/KD/0038820"),
]
# (name, address, discharge port)
BUYERS = [
    ("Rotterdam Seed Import B.V.", "Waalhaven 112, Rotterdam, Netherlands", "Rotterdam"),
    ("Hanse Naturkost GmbH", "Speicherstrasse 9, Hamburg, Germany", "Hamburg"),
    ("Qingdao Golden Grain Trading Co., Ltd", "66 Gangwan Road, Qingdao, China", "Qingdao"),
]
# (description, HS, unit price USD per MT, kg per bag)
GOODS = [
    ("Natural white sesame seeds, 99% purity, 50 kg bags", "1207.40", 1480.0, 50),
    ("Dried hibiscus flowers (sifted), 25 kg bags", "1211.90", 1320.0, 25),
    ("Dried split ginger, 40 kg bags", "0910.11", 2150.0, 40),
    ("Raw cashew nuts in shell, 80 kg jute bags", "0801.31", 1180.0, 80),
]
VESSELS = ["MV Sahel Trader", "MV Atlantic Kestrel", "MV Niger Pearl"]

# case id -> (exporter, buyer, [(goods index, MT)], days since shipment, injected issues)
PLAN = {
    "x01": (0, 0, [(0, 100)], 20, []),
    "x02": (1, 1, [(1, 40), (2, 25)], 35, ["EXPORTER_NAME_MISMATCH", "WEIGHT_MISMATCH"]),
    "x03": (2, 1, [(2, 60)], 28, ["NEPC_EXPIRED", "INVOICE_TOTAL_MISMATCH"]),
    "x04": (0, 2, [(0, 200), (3, 50)], 15, ["PACKAGES_MISMATCH", "PORT_MISMATCH"]),
    "x05": (1, 0, [(3, 120)], 162, ["REPATRIATION_DUE_SOON", "CONSIGNEE_MISMATCH"]),
    "x06": (2, 2, [(1, 80)], 205, ["REPATRIATION_OVERDUE", "NEPC_NAME_MISMATCH"]),
}


def build(cid):
    ex_i, by_i, goods, days_ago, issues = PLAN[cid]
    ex, by = EXPORTERS[ex_i], BUYERS[by_i]
    n = int(cid[1:])
    shipped = TODAY - timedelta(days=days_ago)
    inv_date = shipped - timedelta(days=6)
    lines, plines = [], []
    for gi, mt in goods:
        desc, hs, price, bag = GOODS[gi]
        bags = int(mt * 1000 / bag)
        lines.append({"description": desc, "hs_code": hs, "quantity": mt, "unit": "MT",
                      "unit_price": price, "line_total": money(mt * price)})
        plines.append({"description": desc, "quantity": mt, "unit": "MT", "packages": bags,
                       "net_weight_kg": float(mt * 1000), "gross_weight_kg": round(mt * 1000 * 1.012, 1)})
    goods_value = money(sum(l["line_total"] for l in lines))
    inv = {
        "doc_type": "proforma_invoice",
        "seller": {"name": ex[0], "address": ex[2], "rc_number": None},
        "buyer": {"name": by[0], "address": by[1], "rc_number": None},
        "invoice_number": f"CI-{inv_date:%y%m}-{410 + n * 37}",
        "invoice_date": inv_date.isoformat(), "valid_until": None,
        "currency": "USD", "incoterm": "FOB",
        "country_of_origin": "Nigeria", "country_of_supply": "Nigeria",
        "port_of_loading": "Apapa, Lagos", "port_of_discharge": by[2],
        "mode_of_transport": "Sea", "payment_terms": "Cash against documents",
        "lines": lines, "goods_value": goods_value, "freight": None, "insurance": None, "total": goods_value,
    }
    pl = {
        "doc_type": "packing_list",
        "seller": {"name": ex[0], "address": ex[2], "rc_number": None},
        "buyer": {"name": by[0], "address": by[1], "rc_number": None},
        "packing_list_number": f"PL-{inv_date:%y%m}-{720 + n * 23}", "date": inv_date.isoformat(),
        "proforma_reference": inv["invoice_number"], "port_of_discharge": by[2], "lines": plines,
    }
    bl = {
        "doc_type": "bill_of_lading",
        "bl_number": f"LOS{2610000 + n * 4127}", "shipper": ex[0], "consignee": by[0], "notify_party": by[0],
        "vessel": VESSELS[n % len(VESSELS)], "port_of_loading": "Apapa, Lagos", "port_of_discharge": by[2],
        "shipped_on_board_date": shipped.isoformat(),
        "description": "; ".join(l["description"] for l in lines),
        "packages": sum(p["packages"] for p in plines),
        "gross_weight_kg": round(sum(p["gross_weight_kg"] for p in plines), 1),
        "freight_terms": "Freight collect",
    }
    nepc = {
        "doc_type": "nepc_certificate", "exporter_name": ex[0], "certificate_number": ex[3], "rc_number": ex[1],
        "issue_date": (shipped - timedelta(days=300)).isoformat(), "expiry_date": (shipped + timedelta(days=430)).isoformat(),
    }
    # ---- inject errors: the truth records what is PRINTED ----
    if "EXPORTER_NAME_MISMATCH" in issues:
        bl["shipper"] = "Tiga Global Logistics Ltd"
    if "WEIGHT_MISMATCH" in issues:
        bl["gross_weight_kg"] = round(bl["gross_weight_kg"] - 2400, 1)
    if "NEPC_EXPIRED" in issues:
        nepc["issue_date"] = (shipped - timedelta(days=800)).isoformat()
        nepc["expiry_date"] = (shipped - timedelta(days=70)).isoformat()
    if "INVOICE_TOTAL_MISMATCH" in issues:
        inv["total"] = money(inv["total"] + 1000)
    if "PACKAGES_MISMATCH" in issues:
        bl["packages"] -= 125
    if "PORT_MISMATCH" in issues:
        bl["port_of_discharge"] = "Shanghai"
    if "CONSIGNEE_MISMATCH" in issues:
        bl["consignee"] = "Maas Commodity Finance B.V."
    if "NEPC_NAME_MISMATCH" in issues:
        nepc["exporter_name"] = "Gongola Farms and Allied Ltd"
    truth = {"proforma_invoice": inv, "packing_list": pl, "bill_of_lading": bl, "nepc_certificate": nepc}
    return {"case_id": cid, "today": TODAY.isoformat(), "category": "non-oil", "expected_issues": issues,
            "exporter_rc": ex[1], "truth": truth}


def page(path):
    return SimpleDocTemplate(str(path), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm)


def parties(seller, buyer, rc=None):
    return tbl([[Paragraph(f"<b>Seller / Exporter</b><br/>{seller['name']}{f' ({rc})' if rc else ''}<br/>{seller['address']}", N),
                 Paragraph(f"<b>Buyer</b><br/>{buyer['name']}<br/>{buyer['address']}", N)]], [90 * mm, 90 * mm], header=False)


def make_invoice(c, path):
    v = c["truth"]["proforma_invoice"]
    el = [Paragraph(v["seller"]["name"].upper(), S), Paragraph("COMMERCIAL INVOICE", H), parties(v["seller"], v["buyer"]), Spacer(1, 6),
          tbl([["Invoice No.", v["invoice_number"], "Date", v["invoice_date"]],
               ["Currency", v["currency"], "Incoterm", f"{v['incoterm']} {v['port_of_loading']}"],
               ["Port of loading", v["port_of_loading"], "Port of discharge", v["port_of_discharge"]],
               ["Country of origin", v["country_of_origin"], "Mode of transport", v["mode_of_transport"]],
               ["Payment terms", v["payment_terms"], "", ""]], [32 * mm, 58 * mm, 32 * mm, 58 * mm], header=False), Spacer(1, 8)]
    rows = [["#", "Description of goods", "HS code", "Qty", "Unit", "Unit price (USD)", "Amount (USD)"]]
    for n, l in enumerate(v["lines"], 1):
        rows.append([str(n), Paragraph(l["description"], N), l["hs_code"], f"{l['quantity']:,}", l["unit"], fmt(l["unit_price"]), fmt(l["line_total"])])
    rows.append(["", "", "", "", "", "Goods value", fmt(v["goods_value"])])
    rows.append(["", "", "", "", "", "TOTAL", fmt(v["total"])])
    el += [tbl(rows, [8 * mm, 62 * mm, 18 * mm, 16 * mm, 14 * mm, 30 * mm, 32 * mm]), Spacer(1, 14),
           Paragraph("SYNTHETIC document generated for software testing.", N)]
    page(path).build(el)


def make_packing(c, path):
    v = c["truth"]["packing_list"]
    el = [Paragraph(v["seller"]["name"].upper(), S), Paragraph("PACKING LIST", H), parties(v["seller"], v["buyer"]), Spacer(1, 6),
          tbl([["Packing list No.", v["packing_list_number"], "Date", v["date"]],
               ["Ref. invoice", v["proforma_reference"], "Port of discharge", v["port_of_discharge"]]],
              [32 * mm, 58 * mm, 32 * mm, 58 * mm], header=False), Spacer(1, 8)]
    rows = [["#", "Description", "Qty", "Unit", "Packages", "Net wt (kg)", "Gross wt (kg)"]]
    for n, l in enumerate(v["lines"], 1):
        rows.append([str(n), Paragraph(l["description"], N), f"{l['quantity']:,}", l["unit"], f"{l['packages']:,}",
                     f"{l['net_weight_kg']:,.1f}", f"{l['gross_weight_kg']:,.1f}"])
    rows.append(["", "TOTAL", "", "", f"{sum(l['packages'] for l in v['lines']):,}",
                 f"{sum(l['net_weight_kg'] for l in v['lines']):,.1f}", f"{sum(l['gross_weight_kg'] for l in v['lines']):,.1f}"])
    el += [tbl(rows, [8 * mm, 66 * mm, 18 * mm, 14 * mm, 20 * mm, 26 * mm, 28 * mm]), Spacer(1, 14),
           Paragraph("SYNTHETIC document generated for software testing.", N)]
    page(path).build(el)


def make_bl(c, path):
    v = c["truth"]["bill_of_lading"]
    el = [Paragraph("HARMATTAN OCEAN LINES", S), Paragraph("BILL OF LADING", H), Spacer(1, 6),
          tbl([["B/L No.", v["bl_number"]], ["Shipper", v["shipper"]], ["Consignee", v["consignee"]],
               ["Notify party", v["notify_party"]], ["Vessel", v["vessel"]],
               ["Port of loading", v["port_of_loading"]], ["Port of discharge", v["port_of_discharge"]],
               ["Description of goods", Paragraph(v["description"], N)],
               ["Number of packages", f"{v['packages']:,} bags"], ["Gross weight", f"{v['gross_weight_kg']:,.1f} kg"],
               ["Freight", v["freight_terms"]], ["Shipped on board", v["shipped_on_board_date"]]],
              [45 * mm, 135 * mm], header=False), Spacer(1, 14),
          Paragraph("SYNTHETIC document generated for software testing. Not a document of title.", N)]
    page(path).build(el)


def make_nepc(c, path):
    v = c["truth"]["nepc_certificate"]
    el = [Paragraph("NIGERIAN EXPORT PROMOTION COUNCIL (SPECIMEN)", S), Paragraph("EXPORTER'S CERTIFICATE", H), Spacer(1, 6),
          tbl([["Certificate No.", v["certificate_number"]], ["Name of exporter", v["exporter_name"]],
               ["RC number", v["rc_number"]], ["Date of issue", v["issue_date"]], ["Expiry date", v["expiry_date"]]],
              [45 * mm, 135 * mm], header=False), Spacer(1, 14),
          Paragraph("SYNTHETIC specimen generated for software testing. Not issued by the NEPC.", N)]
    page(path).build(el)


MAKERS = {"proforma_invoice": ("commercial_invoice", make_invoice), "packing_list": ("packing_list", make_packing),
          "bill_of_lading": ("bill_of_lading", make_bl), "nepc_certificate": ("nepc_certificate", make_nepc)}


def main():
    for cid in PLAN:
        c = build(cid)
        d = ROOT / cid
        (d / "photos").mkdir(parents=True, exist_ok=True)
        for _, (name, fn) in MAKERS.items():
            fn(c, d / f"{name}.pdf")
            photo_from_pdf(d / f"{name}.pdf", d / "photos" / f"{name}.jpg", f"{cid}-{name}")
        (d / "answer_key.json").write_text(json.dumps(c, indent=2))
    # demo files for the web app: one clean, one with problems
    demo = REPO / "public" / "demo"
    for label, cid in (("export_clean", "x01"), ("export_problem", "x02")):
        for _, (name, _fn) in MAKERS.items():
            shutil.copy(ROOT / cid / "photos" / f"{name}.jpg", demo / f"{label}_{name}.jpg")
    print(f"Generated {len(PLAN)} export cases in {ROOT}")


if __name__ == "__main__":
    main()

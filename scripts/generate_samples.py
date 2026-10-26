"""
Generate a SYNTHETIC test pack for Form M Copilot.

Every company, person, address, RC number and policy number here is invented.
HS codes are real public tariff headings so the HS-code assistant can be tested.

Output (samples/):
  cases/<case_id>/proforma_invoice.pdf
  cases/<case_id>/packing_list.pdf
  cases/<case_id>/insurance_certificate.pdf
  cases/<case_id>/photos/*.jpg      # phone-style photos of each page
  cases/<case_id>/answer_key.json   # ground-truth fields + expected issues
  index.json

Run:  python3 scripts/generate_samples.py
"""
import copy
import json
import random
import subprocess
import tempfile
from datetime import date, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parent.parent / "samples"
random.seed(42)

# ---------------------------------------------------------------- fixtures
# Each importer is paired with a plausible supplier and product range.
# (importer name, RC, address, phone, supplier index, product indices)
IMPORTERS = [
    ("Arewa Fresh Agro Ltd", "RC 1849302", "12 Bompai Road, Kano", "08031110001", 2, [1]),
    ("Kogi Star Packaging Ltd", "RC 2011987", "4 Industrial Layout, Lokoja", "08031110002", 3, [2, 9]),
    ("Lagoon Bright Electricals Ltd", "RC 1734451", "27 Creek Road, Apapa, Lagos", "08031110003", 4, [3, 8, 0]),
    ("Sahel Grain Mills Ltd", "RC 1920048", "Plot 9, Challawa Industrial Estate, Kano", "08031110004", 2, [7]),
    ("Delta Cool Systems Ltd", "RC 1688213", "15 Refinery Road, Warri", "08031110005", 0, [3, 0, 6]),
    ("Zuma Pharma Supplies Ltd", "RC 2104456", "3 Aminu Kano Crescent, Wuse 2, Abuja", "08031110006", 5, [5]),
    ("Kurmi Textiles Ltd", "RC 1777120", "18 Murtala Mohammed Way, Kano", "08031110007", 1, [4]),
]
SUPPLIERS = [
    ("Yangtze Harbor Machinery Co., Ltd", "88 Binhai Avenue, Ningbo, China", "China", "Ningbo"),
    ("Anatolia Textile Export A.S.", "Organize Sanayi Bolgesi 14, Bursa, Turkey", "Turkey", "Gemlik"),
    ("Malabar Agro Traders Pvt Ltd", "21 Marine Drive, Kochi, India", "India", "Cochin"),
    ("Rhein Polymer Handels GmbH", "Hafenstrasse 5, Hamburg, Germany", "Germany", "Hamburg"),
    ("Gulf Horizon General Trading LLC", "Warehouse 7, Jebel Ali, Dubai, UAE", "United Arab Emirates", "Jebel Ali"),
    ("Deccan Generics Pvt Ltd", "Plot 40, Genome Valley, Hyderabad, India", "India", "Nhava Sheva"),
]
INSURERS = ["Savannah Shield Insurance Plc", "Niger Delta Marine Assurance Ltd", "Harmattan General Insurance Plc"]
PORTS_NG = ["Apapa, Lagos", "Tin Can Island, Lagos", "Onne, Rivers"]
INCOTERMS = ["FOB", "CFR", "CIF"]

# (description, HS code, unit, unit price range, kg per unit)
PRODUCTS = [
    ("Diesel generating set, 100 kVA, 3-phase", "8502.13", "set", (6500, 9000), 1450),
    ("Tomato paste in drums, 28-30% brix, 220 L", "2002.90", "drum", (180, 240), 235),
    ("Polypropylene granules, injection grade", "3902.10", "MT", (1050, 1300), 1000),
    ("Split air conditioner, 1.5 HP, inverter", "8415.10", "unit", (210, 290), 38),
    ("Woven cotton fabric, dyed, 150 cm width", "5208.32", "metre", (1.8, 3.2), 0.18),
    ("Paracetamol tablets 500 mg, 10x10 blister", "3004.90", "carton", (14, 22), 6),
    ("Plastic injection moulding machine, 250 T", "8477.10", "set", (38000, 52000), 9800),
    ("Durum wheat, unmilled", "1001.19", "MT", (290, 360), 1000),
    ("LED floodlight 200 W, IP65", "9405.42", "unit", (28, 45), 3.5),
    ("Corrugated carton boxes, flat-packed", "4819.10", "piece", (0.35, 0.7), 0.4),
]

# Issue catalogue (codes the validation engine should eventually emit)
ISSUES = {
    "INVOICE_TOTAL_MISMATCH": "Invoice grand total does not equal sum of line totals (+ freight/insurance).",
    "PACKING_QTY_MISMATCH": "Quantity on packing list differs from proforma invoice.",
    "BENEFICIARY_NAME_MISMATCH": "Supplier/beneficiary name differs between documents.",
    "IMPORTER_NAME_MISMATCH": "Importer name differs between documents.",
    "MISSING_INCOTERM": "Proforma invoice does not state an Incoterm.",
    "VAGUE_DESCRIPTION": "Goods description too vague to classify (no HS-relevant detail).",
    "CURRENCY_MISMATCH": "Currency differs between invoice and insurance certificate.",
    "INSURED_VALUE_TOO_LOW": "Insured value is below the invoice value of the goods.",
    "PORT_MISMATCH": "Port of discharge differs between documents.",
    "PROFORMA_EXPIRED": "Proforma invoice validity date has passed.",
    "MISSING_COUNTRY_OF_ORIGIN": "Country of origin not stated on proforma invoice.",
}

# case_id -> issues to inject (empty = clean)
CASE_PLAN = [
    [],
    [],
    [],
    ["INVOICE_TOTAL_MISMATCH"],
    ["PACKING_QTY_MISMATCH"],
    ["BENEFICIARY_NAME_MISMATCH"],
    ["MISSING_INCOTERM", "MISSING_COUNTRY_OF_ORIGIN"],
    ["VAGUE_DESCRIPTION"],
    ["CURRENCY_MISMATCH", "INSURED_VALUE_TOO_LOW"],
    ["PORT_MISMATCH", "IMPORTER_NAME_MISMATCH"],
    ["PROFORMA_EXPIRED"],
    ["INVOICE_TOTAL_MISMATCH", "PACKING_QTY_MISMATCH", "VAGUE_DESCRIPTION"],
]


# ---------------------------------------------------------------- data
def money(x):
    return round(x + 1e-9, 2)


def build_case(idx, issues):
    imp = IMPORTERS[idx % len(IMPORTERS)]
    sup = SUPPLIERS[imp[4]]
    pool = [PRODUCTS[k] for k in imp[5]]
    prods = random.sample(pool, random.randint(1, len(pool)))
    items = []
    for p in prods:
        qty = random.choice({
            "set": [1, 2, 3], "MT": [25, 50, 120], "drum": [40, 80, 160],
            "unit": [50, 120, 300, 500], "carton": [200, 600, 1500],
            "metre": [5000, 12000, 30000], "piece": [20000, 50000, 100000],
        }[p[2]])
        price = money(random.uniform(*p[3]))
        items.append({
            "description": p[0], "hs_code": p[1], "unit": p[2], "quantity": qty,
            "unit_price": price, "line_total": money(qty * price),
            "gross_weight_kg": round(qty * p[4] * 1.05, 1), "net_weight_kg": round(qty * p[4], 1),
            "packages": max(1, int(qty if p[2] in ("set", "drum") else qty / 20)),
        })
    goods = money(sum(i["line_total"] for i in items))
    incoterm = random.choice(INCOTERMS)
    freight = money(goods * 0.06) if incoterm in ("CFR", "CIF") else 0.0
    insurance = money(goods * 0.01) if incoterm == "CIF" else 0.0
    total = money(goods + freight + insurance)
    pi_date = date(2026, 10, 1) + timedelta(days=random.randint(0, 20))
    port = random.choice(PORTS_NG)
    currency = "USD" if sup[2] != "Germany" else "EUR"
    case = {
        "case_id": f"case_{idx + 1:02d}",
        "importer": {"name": imp[0], "rc_number": imp[1], "address": imp[2], "phone": imp[3]},
        "beneficiary": {"name": sup[0], "address": sup[1], "country": sup[2]},
        "proforma": {
            "number": f"PI-{pi_date:%y%m}-{random.randint(100, 999)}",
            "date": pi_date.isoformat(),
            "valid_until": (pi_date + timedelta(days=90)).isoformat(),
            "currency": currency, "incoterm": incoterm,
            "country_of_origin": sup[2], "country_of_supply": sup[2],
            "port_of_loading": sup[3], "port_of_discharge": port,
            "mode_of_transport": "Sea", "payment_terms": random.choice(
                ["Letter of Credit at sight", "Bills for Collection", "100% advance via bank transfer"]),
            "items": items, "goods_value": goods, "freight": freight,
            "insurance": insurance, "total": total,
        },
        "packing_list": {
            "number": f"PL-{pi_date:%y%m}-{random.randint(100, 999)}",
            "date": pi_date.isoformat(),
            "beneficiary_name": sup[0], "importer_name": imp[0],
            "port_of_discharge": port,
            "items": [{k: i[k] for k in ("description", "quantity", "unit", "packages",
                                          "net_weight_kg", "gross_weight_kg")} for i in items],
        },
        "insurance_certificate": {
            "insurer": random.choice(INSURERS),
            "policy_number": f"MC/{random.randint(10000, 99999)}/26",
            "certificate_number": f"CERT-{random.randint(100000, 999999)}",
            "insured": imp[0], "currency": currency,
            "sum_insured": money(total * 1.10),
            "voyage": f"{sup[3]} to {port}", "conveyance": "Sea - containerised",
            "date": (pi_date + timedelta(days=2)).isoformat(),
            "cover": "Institute Cargo Clauses (A)",
        },
        "expected_issues": list(issues),
    }
    apply_issues(case, issues)
    return case


def apply_issues(c, issues):
    pf, pl, ins = c["proforma"], c["packing_list"], c["insurance_certificate"]
    for code in issues:
        if code == "INVOICE_TOTAL_MISMATCH":
            pf["printed_total"] = money(pf["total"] + random.choice([150, 1000, 2350.5]))
        elif code == "PACKING_QTY_MISMATCH":
            pl["items"][0]["quantity"] = pl["items"][0]["quantity"] + random.choice([1, 2, 10])
        elif code == "BENEFICIARY_NAME_MISMATCH":
            pl["beneficiary_name"] = c["beneficiary"]["name"].replace("Co., Ltd", "Trading Co.").replace("GmbH", "Intl GmbH").replace("LLC", "FZE").replace("A.S.", "Ltd").replace("Pvt Ltd", "Exports")
        elif code == "IMPORTER_NAME_MISMATCH":
            ins["insured"] = c["importer"]["name"].replace(" Ltd", " Enterprises")
        elif code == "MISSING_INCOTERM":
            pf["incoterm"] = None
        elif code == "MISSING_COUNTRY_OF_ORIGIN":
            pf["country_of_origin"] = None
        elif code == "VAGUE_DESCRIPTION":
            pf["items"][0]["printed_description"] = random.choice(
                ["General goods", "Assorted items", "Spare parts", "Machine accessories"])
        elif code == "CURRENCY_MISMATCH":
            ins["currency"] = "EUR" if pf["currency"] == "USD" else "USD"
        elif code == "INSURED_VALUE_TOO_LOW":
            ins["sum_insured"] = money(pf["goods_value"] * 0.6)
        elif code == "PORT_MISMATCH":
            other = [p for p in PORTS_NG if p != pf["port_of_discharge"]][0]
            pl["port_of_discharge"] = other
            ins["voyage"] = f"{pf['port_of_loading']} to {other}"
        elif code == "PROFORMA_EXPIRED":
            d = date(2026, 3, 2)
            pf["date"], pf["valid_until"] = d.isoformat(), (d + timedelta(days=60)).isoformat()


# ---------------------------------------------------------------- PDFs
styles = getSampleStyleSheet()
H = styles["Title"]
N = styles["Normal"]
S = styles["Heading4"]


def tbl(rows, widths, header=True):
    t = Table(rows, colWidths=widths)
    st = [("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
          ("FONTSIZE", (0, 0), (-1, -1), 8.5), ("VALIGN", (0, 0), (-1, -1), "TOP")]
    if header:
        st += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eef6")),
               ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")]
    t.setStyle(TableStyle(st))
    return t


def fmt(x):
    return f"{x:,.2f}"


def party_block(c):
    b, i = c["beneficiary"], c["importer"]
    return tbl([
        [Paragraph(f"<b>Seller / Beneficiary</b><br/>{b['name']}<br/>{b['address']}", N),
         Paragraph(f"<b>Buyer / Importer</b><br/>{i['name']} ({i['rc_number']})<br/>{i['address']}<br/>Tel: {i['phone']}", N)]
    ], [90 * mm, 90 * mm], header=False)


def make_proforma(c, path):
    pf = c["proforma"]
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm)
    el = [Paragraph(c["beneficiary"]["name"].upper(), S), Paragraph("PROFORMA INVOICE", H), party_block(c), Spacer(1, 6)]
    meta = [["PI No.", pf["number"], "Date", pf["date"]],
            ["Valid until", pf["valid_until"], "Currency", pf["currency"]],
            ["Incoterm", f"{pf['incoterm']} {pf['port_of_discharge'] if pf['incoterm'] in ('CFR','CIF') else pf['port_of_loading']}" if pf["incoterm"] else "", "Mode of transport", pf["mode_of_transport"]],
            ["Port of loading", pf["port_of_loading"], "Port of discharge", pf["port_of_discharge"]],
            ["Country of origin", pf["country_of_origin"] or "", "Country of supply", pf["country_of_supply"]],
            ["Payment terms", pf["payment_terms"], "", ""]]
    el += [tbl(meta, [32 * mm, 58 * mm, 32 * mm, 58 * mm], header=False), Spacer(1, 8)]
    rows = [["#", "Description of goods", "HS code", "Qty", "Unit", f"Unit price ({pf['currency']})", f"Amount ({pf['currency']})"]]
    for n, it in enumerate(pf["items"], 1):
        rows.append([str(n), Paragraph(it.get("printed_description", it["description"]), N),
                     "" if "printed_description" in it else it["hs_code"],
                     f"{it['quantity']:,}", it["unit"], fmt(it["unit_price"]), fmt(it["line_total"])])
    rows.append(["", "", "", "", "", "Goods value", fmt(pf["goods_value"])])
    if pf["freight"]:
        rows.append(["", "", "", "", "", "Freight", fmt(pf["freight"])])
    if pf["insurance"]:
        rows.append(["", "", "", "", "", "Insurance", fmt(pf["insurance"])])
    rows.append(["", "", "", "", "", "TOTAL", fmt(pf.get("printed_total", pf["total"]))])
    el += [tbl(rows, [8 * mm, 62 * mm, 18 * mm, 16 * mm, 14 * mm, 30 * mm, 32 * mm]), Spacer(1, 14),
           Paragraph("Bank details: provided on request. This is a SYNTHETIC document generated for software testing.", N),
           Spacer(1, 20), Paragraph("Authorised signature: ____________________", N)]
    doc.build(el)


def make_packing(c, path):
    pl = c["packing_list"]
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm)
    b = dict(c["beneficiary"], name=pl["beneficiary_name"])
    i = dict(c["importer"], name=pl["importer_name"])
    el = [Paragraph(b["name"].upper(), S), Paragraph("PACKING LIST", H),
          party_block(dict(c, beneficiary=b, importer=i)), Spacer(1, 6),
          tbl([["Packing list No.", pl["number"], "Date", pl["date"]],
               ["Ref. proforma", c["proforma"]["number"], "Port of discharge", pl["port_of_discharge"]]],
              [32 * mm, 58 * mm, 32 * mm, 58 * mm], header=False), Spacer(1, 8)]
    rows = [["#", "Description", "Qty", "Unit", "Packages", "Net wt (kg)", "Gross wt (kg)"]]
    for n, it in enumerate(pl["items"], 1):
        rows.append([str(n), Paragraph(it["description"], N), f"{it['quantity']:,}", it["unit"],
                     str(it["packages"]), f"{it['net_weight_kg']:,}", f"{it['gross_weight_kg']:,}"])
    rows.append(["", "TOTAL", "", "", str(sum(i["packages"] for i in pl["items"])),
                 f"{sum(i['net_weight_kg'] for i in pl['items']):,.1f}",
                 f"{sum(i['gross_weight_kg'] for i in pl['items']):,.1f}"])
    el += [tbl(rows, [8 * mm, 66 * mm, 18 * mm, 14 * mm, 20 * mm, 26 * mm, 28 * mm]), Spacer(1, 14),
           Paragraph("SYNTHETIC document generated for software testing.", N)]
    doc.build(el)


def make_insurance(c, path):
    ins = c["insurance_certificate"]
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm)
    el = [Paragraph(ins["insurer"].upper(), S), Paragraph("MARINE INSURANCE CERTIFICATE", H), Spacer(1, 6),
          tbl([["Certificate No.", ins["certificate_number"]], ["Open policy No.", ins["policy_number"]],
               ["Date of issue", ins["date"]], ["Insured", ins["insured"]],
               ["Interest", "; ".join(i["description"] for i in c["proforma"]["items"])],
               ["Proforma invoice ref.", c["proforma"]["number"]],
               ["Sum insured", f"{ins['currency']} {fmt(ins['sum_insured'])}"],
               ["Voyage", ins["voyage"]], ["Conveyance", ins["conveyance"]], ["Conditions", ins["cover"]]],
              [45 * mm, 135 * mm], header=False), Spacer(1, 14),
          Paragraph("SYNTHETIC document generated for software testing.", N)]
    doc.build(el)


# ---------------------------------------------------------------- photos
def photo_from_pdf(pdf, out_jpg, seed):
    rnd = random.Random(seed)
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["pdftoppm", "-r", "110", "-png", "-singlefile", str(pdf), f"{td}/p"], check=True)
        page = Image.open(f"{td}/p.png").convert("RGB")
    w, h = page.size
    bg = Image.new("RGB", (int(w * 1.25), int(h * 1.2)), tuple(rnd.randint(70, 140) for _ in range(3)))
    bg.paste(page, ((bg.width - w) // 2, (bg.height - h) // 2))
    img = bg.rotate(rnd.uniform(-6, 6), resample=Image.BICUBIC, expand=False, fillcolor=bg.getpixel((0, 0)))
    # uneven lighting: smooth diagonal shadow
    grad = Image.linear_gradient("L").rotate(rnd.choice([45, 135, 225, 315])).resize(img.size)
    k = rnd.uniform(0.25, 0.4)
    shade = grad.point(lambda v: int(v * k))
    img = Image.composite(Image.new("RGB", img.size, (20, 15, 10)), img, shade)
    img = ImageEnhance.Brightness(img).enhance(rnd.uniform(0.9, 1.1))
    img = img.filter(ImageFilter.GaussianBlur(rnd.uniform(0.3, 0.9)))
    img.save(out_jpg, "JPEG", quality=rnd.randint(55, 75))


# ---------------------------------------------------------------- main
def main():
    (ROOT / "cases").mkdir(parents=True, exist_ok=True)
    index = []
    for idx, issues in enumerate(CASE_PLAN):
        c = build_case(idx, issues)
        d = ROOT / "cases" / c["case_id"]
        (d / "photos").mkdir(parents=True, exist_ok=True)
        docs = {"proforma_invoice": make_proforma, "packing_list": make_packing,
                "insurance_certificate": make_insurance}
        for name, fn in docs.items():
            fn(c, d / f"{name}.pdf")
            photo_from_pdf(d / f"{name}.pdf", d / "photos" / f"{name}.jpg", f"{c['case_id']}-{name}")
        key = copy.deepcopy(c)
        key["note"] = "Ground truth. 'printed_*' fields show what is printed when an error was injected."
        (d / "answer_key.json").write_text(json.dumps(key, indent=2))
        index.append({"case_id": c["case_id"], "expected_issues": issues,
                      "importer": c["importer"]["name"], "beneficiary": c["beneficiary"]["name"]})
    (ROOT / "index.json").write_text(json.dumps({"issue_catalogue": ISSUES, "cases": index}, indent=2))
    print(f"Generated {len(index)} cases in {ROOT}")


if __name__ == "__main__":
    main()

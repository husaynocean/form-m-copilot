"""
SYNTHETIC documents for PriceCheck. Week 1: one Form M application, used to
test extraction. (Week 4 adds 30 invoices with planted mispricing.)

Every company, number and person here is invented. Output:
  samples/pricecheck/form_m_01.pdf, photos/form_m_01.jpg, form_m_01.json (ground truth)

Run:  python3 scripts/generate_pricecheck_samples.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_samples import H, N, S, fmt, photo_from_pdf, tbl  # noqa: E402

from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "samples" / "pricecheck"

FORM_M = {
    "form_m_number": "MF20260098761",
    "applicant": "Sabon Gari Power Solutions Ltd", "applicant_rc": "RC 2210984", "applicant_address": "14 Murtala Mohammed Way, Kano",
    "beneficiary": "Ningbo Everbright Power Co., Ltd", "beneficiary_address": "56 Zhongshan Road, Ningbo, China",
    "country_of_origin": "China", "country_of_supply": "China", "port_of_loading": "Ningbo", "port_of_discharge": "Apapa, Lagos",
    "proforma_number": "NEP-2610-447", "proforma_date": "2026-10-20", "currency": "USD", "incoterm": "FOB",
    "items": [
        {"hs_code": "8502.12.00.00", "description": "Diesel generating set, 150 kVA, 3-phase, soundproof", "quantity": 4, "unit": "set", "unit_price": 13800.0},
        {"hs_code": "8544.49.00.00", "description": "Copper power cable, 4 core, 35 mm2, 0.6/1 kV", "quantity": 2000, "unit": "metre", "unit_price": 9.6},
    ],
}


def build(path):
    v = FORM_M
    for it in v["items"]:
        it["line_total"] = round(it["quantity"] * it["unit_price"], 2)
    total = round(sum(i["line_total"] for i in v["items"]), 2)
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm)
    el = [Paragraph("SPECIMEN · NOT ISSUED BY ANY BANK", S), Paragraph("FORM M · APPLICATION TO IMPORT", H), Spacer(1, 6),
          tbl([["Form M No.", v["form_m_number"], "Currency", v["currency"]],
               ["Applicant", Paragraph(f"{v['applicant']} ({v['applicant_rc']})", N), "Terms of delivery", v["incoterm"]],
               ["Applicant address", v["applicant_address"], "Proforma invoice No.", v["proforma_number"]],
               ["Beneficiary", v["beneficiary"], "Proforma invoice date", v["proforma_date"]],
               ["Beneficiary address", Paragraph(v["beneficiary_address"], N), "Country of origin", v["country_of_origin"]],
               ["Port of loading", v["port_of_loading"], "Country of supply", v["country_of_supply"]],
               ["Port of discharge", v["port_of_discharge"], "", ""]],
              [32 * mm, 62 * mm, 34 * mm, 52 * mm], header=False), Spacer(1, 8)]
    rows = [["#", "HS code", "Description of goods", "Qty", "Unit", "Unit price", "FOB value"]]
    for n, it in enumerate(v["items"], 1):
        rows.append([str(n), it["hs_code"], Paragraph(it["description"], N), f"{it['quantity']:,}", it["unit"], fmt(it["unit_price"]), fmt(it["line_total"])])
    rows.append(["", "", "", "", "", "Total FOB", fmt(total)])
    el += [tbl(rows, [8 * mm, 26 * mm, 62 * mm, 16 * mm, 14 * mm, 24 * mm, 30 * mm]), Spacer(1, 14),
           Paragraph("SYNTHETIC document generated for software testing.", N)]
    doc.build(el)
    return {
        "doc_kind": "form_m", "form_m_number": v["form_m_number"], "supplier": v["beneficiary"], "buyer": v["applicant"],
        "invoice_number": v["proforma_number"], "invoice_date": v["proforma_date"], "currency": "USD", "incoterm": "FOB",
        "country_of_origin": "China", "total": total,
        "lines": [{k: it[k] for k in ("description", "hs_code", "quantity", "unit", "unit_price", "line_total")} for it in v["items"]],
    }


def main():
    (ROOT / "photos").mkdir(parents=True, exist_ok=True)
    truth = build(ROOT / "form_m_01.pdf")
    photo_from_pdf(ROOT / "form_m_01.pdf", ROOT / "photos" / "form_m_01.jpg", "pc-form-m-01")
    (ROOT / "form_m_01.json").write_text(json.dumps(truth, indent=2))
    print("Generated", ROOT / "form_m_01.pdf")


if __name__ == "__main__":
    main()

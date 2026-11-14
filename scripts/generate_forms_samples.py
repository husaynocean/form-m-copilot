"""
Generate SYNTHETIC test packs for Form Q (small importers) and Form A
(school fees / medical bills).

Every person, company, school, hospital and account number here is invented.

Output:
  samples/formq_cases/<id>/proforma_invoice.pdf, photos/*.jpg, answer_key.json
  samples/forma_cases/<id>/school_bill.pdf, admission_letter.pdf (or hospital docs), photos/*.jpg, answer_key.json
  public/demo/formq_{clean,problem}_*.jpg, public/demo/forma_{clean,problem}_*.jpg

Run:  python3 scripts/generate_forms_samples.py
"""
import json
import shutil
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_samples import H, N, S, fmt, make_proforma, money, photo_from_pdf, tbl  # noqa: E402

from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TODAY = date(2026, 11, 14)

# ------------------------------------------------------------------ Form Q
SME = [
    ("Fagge Tailoring Hub Ltd", "RC 3011842", "41 Fagge Road, Kano", "08031220001"),
    ("Sabon Gari Solar Ventures Ltd", "RC 3098117", "9 Ibrahim Taiwo Road, Kano", "08031220002"),
    ("Zaria Print & Office Supplies Ltd", "RC 2987405", "5 Kaduna Road, Zaria", "08031220003"),
]
SELLERS = [
    ("Guangzhou Brightstar Equipment Co., Ltd", "120 Huangpu Avenue, Guangzhou, China", "China", "Huangpu"),
    ("Shenzhen Sunpeak Energy Co., Ltd", "8 Keji Road, Shenzhen, China", "China", "Shekou"),
]
# id -> (sme, seller, [(description, hs, unit, qty, price)], used this quarter, invoice date, issues, total override)
QPLAN = {
    "q01": (0, 0, [("Industrial sewing machine, single needle lockstitch, 550 W", "8452.21", "unit", 30, 380.0)], 0, "2026-11-02", [], None),
    "q02": (1, 1, [("Solar PV module, monocrystalline, 450 W", "8541.43", "unit", 150, 95.0)], 9000, "2026-10-28", ["FORM_Q_LIMIT_EXCEEDED"], None),
    "q03": (2, 0, [("Laser printer, monochrome, 40 ppm", "8443.32", "unit", 12, 610.0),
                   ("Installation and staff training services", "", "lot", 1, 1500.0)], 0, "2026-11-05", ["FORM_Q_NOT_GOODS"], None),
    "q04": (0, 0, [("Hair dryer, 1200 W, handheld", "8516.31", "carton", 40, 96.0),
                   ("Spare parts", "", "lot", 1, 650.0)], 0, "2026-10-30", ["INVOICE_TOTAL_MISMATCH", "VAGUE_DESCRIPTION"], 5000.0),
}


def q_case(cid):
    sme_i, sel_i, goods, used, d, issues, total_override = QPLAN[cid]
    sme, sel = SME[sme_i], SELLERS[sel_i]
    items = [{"description": g[0], "hs_code": g[1], "unit": g[2], "quantity": g[3], "unit_price": g[4],
              "line_total": money(g[3] * g[4])} for g in goods]
    goods_value = money(sum(i["line_total"] for i in items))
    pf = {"number": f"PI-Q{cid[1:]}-{d[2:4]}{d[5:7]}", "date": d, "valid_until": None, "currency": "USD", "incoterm": "CIF",
          "country_of_origin": sel[2], "country_of_supply": sel[2], "port_of_loading": sel[3], "port_of_discharge": "Apapa, Lagos",
          "mode_of_transport": "Sea", "payment_terms": "100% telegraphic transfer before shipment", "items": items,
          "goods_value": goods_value, "freight": 0.0, "insurance": 0.0, "total": goods_value}
    if total_override:
        pf["printed_total"] = total_override
    c = {"case_id": cid, "importer": {"name": sme[0], "rc_number": sme[1], "address": sme[2], "phone": sme[3]},
         "beneficiary": {"name": sel[0], "address": sel[1], "country": sel[2]}, "proforma": pf}
    truth = {"proforma_invoice": {
        "doc_type": "proforma_invoice", "seller": {"name": sel[0], "address": sel[1], "rc_number": None},
        "buyer": {"name": sme[0], "address": f"{sme[2]} Tel: {sme[3]}", "rc_number": sme[1]},
        "invoice_number": pf["number"], "invoice_date": d, "valid_until": None, "currency": "USD", "incoterm": "CIF",
        "country_of_origin": sel[2], "country_of_supply": sel[2], "port_of_loading": sel[3], "port_of_discharge": "Apapa, Lagos",
        "mode_of_transport": "Sea", "payment_terms": pf["payment_terms"],
        "lines": [{k: (i[k] or None) if k == "hs_code" else i[k] for k in ("description", "hs_code", "quantity", "unit", "unit_price", "line_total")} for i in items],
        "goods_value": goods_value, "freight": None, "insurance": None, "total": total_override or goods_value}}
    return c, {"case_id": cid, "today": TODAY.isoformat(), "used_this_quarter": used, "expected_issues": issues, "truth": truth}


# ------------------------------------------------------------------ Form A
PEOPLE = ["Aisha Musa Bello", "Ibrahim Sani Kabir", "Hauwa Ladi Yusuf", "Usman Garba Danjuma"]
SCHOOLS = [
    ("Northbridge University (specimen)", "United Kingdom", "Albion Commercial Bank", "GB29 ALBN 6016 1331 9268 19", "GBP"),
    ("Kestrel Valley College (specimen)", "Canada", "Laurentian Trust Bank", "00412-003-5571908", "USD"),
    ("Lakeview Specialist Hospital (specimen)", "Egypt", "Nile Delta Bank", "EG38 0019 0005 0000 0000 2631 8000 2", "USD"),
]
# id -> (person, school, purpose, amount, currency, due, issues, tweaks)
APLAN = {
    "a01": (0, 1, "tuition", 9800.0, "USD", "2027-01-10", [], {}),
    "a02": (1, 1, "tuition", 11250.0, "USD", "2027-01-15", ["NAME_MISMATCH", "BANK_DETAILS_MISSING"], {"letter_name": "Ibrahim Sani Kabiru", "no_bank": True}),
    "a03": (2, 1, "tuition", 31500.0, "USD", "2027-02-01", ["FEE_LIMIT_EXCEEDED", "INSTITUTION_MISMATCH"], {"letter_school": "Kestrel Ridge Polytechnic (specimen)"}),
    "a04": (3, 2, "medical", 18400.0, "USD", "2026-10-20", ["FEE_DUE_DATE_PASSED"], {}),
}


def a_case(cid):
    p_i, s_i, purpose, amount, cur, due, issues, tw = APLAN[cid]
    person, (school, country, bank, acct, _c) = PEOPLE[p_i], SCHOOLS[s_i]
    n = int(cid[1:])
    bill = {"doc_type": "fee_invoice", "institution": school, "institution_country": country, "person_name": person,
            "purpose": purpose, "reference": f"{'STU' if purpose == 'tuition' else 'PAT'}-{20260 + n * 17}",
            "period": "Spring semester 2027" if purpose == "tuition" else "Cardiac surgery and 3 weeks' care",
            "issue_date": "2026-10-12", "due_date": due, "currency": cur, "amount": amount,
            "beneficiary_bank": None if tw.get("no_bank") else bank, "beneficiary_account": None if tw.get("no_bank") else acct}
    letter = {"doc_type": "support_letter", "kind": "admission" if purpose == "tuition" else "medical",
              "institution": tw.get("letter_school", school), "person_name": tw.get("letter_name", person),
              "programme": "MSc Agricultural Economics" if purpose == "tuition" else "Coronary artery bypass surgery",
              "start_date": "2027-01-18" if purpose == "tuition" else "2026-12-02", "date": "2026-09-30"}
    return {"case_id": cid, "today": TODAY.isoformat(), "purpose": purpose, "expected_issues": issues,
            "truth": {"fee_invoice": bill, "support_letter": letter}}


def page(path):
    return SimpleDocTemplate(str(path), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm)


def make_bill(c, path):
    v = c["truth"]["fee_invoice"]
    med = v["purpose"] == "medical"
    rows = [["Invoice / reference", v["reference"]], ["Issue date", v["issue_date"]], ["Payment due by", v["due_date"]],
            ["Patient" if med else "Student", v["person_name"]], ["Treatment" if med else "Period", v["period"]],
            ["Amount due", f"{v['currency']} {fmt(v['amount'])}"]]
    if v["beneficiary_account"]:
        rows += [["Pay to (bank)", v["beneficiary_bank"]], ["Account / IBAN", v["beneficiary_account"]]]
    el = [Paragraph(f"{v['institution'].upper()} · {v['institution_country']}", S),
          Paragraph("TREATMENT COST ESTIMATE" if med else "TUITION FEE INVOICE", H), Spacer(1, 6),
          tbl(rows, [45 * mm, 135 * mm], header=False), Spacer(1, 14),
          Paragraph("SYNTHETIC document generated for software testing.", N)]
    page(path).build(el)


def make_letter(c, path):
    v = c["truth"]["support_letter"]
    med = v["kind"] == "medical"
    body = (f"This is to confirm that {v['person_name']} is scheduled for {v['programme']} at our hospital, "
            f"starting {v['start_date']}." if med else
            f"We are pleased to offer {v['person_name']} admission to the {v['programme']} programme, "
            f"starting {v['start_date']}.")
    el = [Paragraph(v["institution"].upper(), S), Paragraph("LETTER OF CONFIRMATION" if med else "LETTER OF ADMISSION", H), Spacer(1, 6),
          Paragraph(f"Date: {v['date']}", N), Spacer(1, 8), Paragraph(body, N), Spacer(1, 20),
          Paragraph("Registrar" if not med else "Consultant Cardiothoracic Surgeon", N), Spacer(1, 14),
          Paragraph("SYNTHETIC document generated for software testing.", N)]
    page(path).build(el)


def main():
    demo = REPO / "public" / "demo"
    for cid in QPLAN:
        c, key = q_case(cid)
        d = REPO / "samples" / "formq_cases" / cid
        (d / "photos").mkdir(parents=True, exist_ok=True)
        make_proforma(c, d / "proforma_invoice.pdf")
        photo_from_pdf(d / "proforma_invoice.pdf", d / "photos" / "proforma_invoice.jpg", f"{cid}-pi")
        (d / "answer_key.json").write_text(json.dumps(key, indent=2))
    for cid in APLAN:
        key = a_case(cid)
        d = REPO / "samples" / "forma_cases" / cid
        (d / "photos").mkdir(parents=True, exist_ok=True)
        for name, fn in (("fee_invoice", make_bill), ("support_letter", make_letter)):
            fn(key, d / f"{name}.pdf")
            photo_from_pdf(d / f"{name}.pdf", d / "photos" / f"{name}.jpg", f"{cid}-{name}")
        (d / "answer_key.json").write_text(json.dumps(key, indent=2))
    for label, folder, cid, names in (("formq_clean", "formq_cases", "q01", ["proforma_invoice"]),
                                      ("formq_problem", "formq_cases", "q03", ["proforma_invoice"]),
                                      ("forma_clean", "forma_cases", "a01", ["fee_invoice", "support_letter"]),
                                      ("forma_problem", "forma_cases", "a02", ["fee_invoice", "support_letter"])):
        for nm in names:
            shutil.copy(REPO / "samples" / folder / cid / "photos" / f"{nm}.jpg", demo / f"{label}_{nm}.jpg")
    print("Generated Form Q and Form A cases")


if __name__ == "__main__":
    main()

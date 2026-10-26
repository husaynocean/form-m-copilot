"""
Build lib/data/hs6.json from data/hs-2022.csv.

Source: github.com/datasets/harmonized-system (HS 2022 nomenclature, ODC PDDL).
Each 6-digit subheading gets the text of its chapter and heading prepended,
because many subheadings only say "Other" on their own.
"""
import csv, json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
rows = list(csv.DictReader(open(root / "data" / "hs-2022.csv", encoding="utf-8")))
by_code = {r["hscode"]: r for r in rows}
out = []
for r in rows:
    if r["level"] != "6" or r["hscode"][:2] in ("98", "99"):  # 98/99 are not HS chapters
        continue
    heading = by_code.get(r["parent"], {})
    chapter = by_code.get(heading.get("parent", ""), {})
    code = r["hscode"]
    out.append({
        "code": f"{code[:4]}.{code[4:]}",
        "desc": r["description"],
        "heading": heading.get("description", ""),
        "chapter": chapter.get("description", ""),
    })
(root / "lib" / "data").mkdir(parents=True, exist_ok=True)
(root / "lib" / "data" / "hs6.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"{len(out)} subheadings")

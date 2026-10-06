#!/usr/bin/env python3
"""Extract numbered bibliography entries from DOCX without changing the source.

Only explicit DOI fields are imported. Source titles, indices, DOI spelling, and
status labels are preserved. DOI syntax checks do not establish DOI resolution,
title matching, or full-text availability.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote
import xml.etree.ElementTree as ET
from zipfile import ZipFile


NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ENTRY = re.compile(r"^(\d{4})\. (.+)$")
DOI_FIELD = re.compile(r"^DOI\s+(.+?)\s+(\[[^\]]+\](?:\s+\[[^\]]+\])*)(?:\s.*)?$")
DOI_SYNTAX = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
MISSING_DOI = {"未确认", "未提供", "未列出", "无", "N/A", "NA", ""}


def paragraph_text(paragraph: ET.Element) -> str:
    """Read visible run/hyperlink text, avoiding field codes and XML metadata."""
    parts: list[str] = []
    for element in paragraph.iter():
        if element.tag == f"{{{NS['w']}}}t":
            parts.append(element.text or "")
        elif element.tag == f"{{{NS['w']}}}tab":
            parts.append("\t")
        elif element.tag in {f"{{{NS['w']}}}br", f"{{{NS['w']}}}cr"}:
            parts.append("\n")
    return "".join(parts)


def normalize_doi(value: str) -> str:
    """Remove an explicit resolver/label only; retain DOI case and punctuation."""
    value = value.strip()
    if value in MISSING_DOI:
        return ""
    if re.match(r"^https?://(?:dx\.)?doi\.org/", value, re.IGNORECASE):
        value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value, flags=re.IGNORECASE)
        value = unquote(value)
    else:
        value = re.sub(r"^doi:\s*", "", value, flags=re.IGNORECASE)
    if not DOI_SYNTAX.fullmatch(value):
        raise ValueError(f"Unrecognized explicit DOI field: {value!r}")
    return value


def extract(source: Path, output_root: Path, expected_count: int | None) -> dict:
    raw_source = source.read_bytes()
    with ZipFile(source) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))

    paragraphs = document.findall("w:body/w:p", NS)
    source_entries: list[dict] = []
    for paragraph in paragraphs:
        text = paragraph_text(paragraph)
        match = ENTRY.fullmatch(text)
        if match:
            source_entries.append({
                "sourceIndex": match[1],
                "title": match[2],
                "paragraphs": [],
            })
        elif source_entries:
            source_entries[-1]["paragraphs"].append(text)

    if not source_entries:
        raise ValueError("No numbered bibliography entries found.")
    if expected_count is not None and len(source_entries) != expected_count:
        raise ValueError(f"Expected {expected_count} entries; found {len(source_entries)}.")
    indices = [entry["sourceIndex"] for entry in source_entries]
    if len(indices) != len(set(indices)):
        raise ValueError("Duplicate source record indices; refusing to overwrite records.")
    expected_indices = [f"{i:04d}" for i in range(1, len(indices) + 1)]
    if indices != expected_indices:
        raise ValueError("Source record indices are not the full ordered sequence starting at 0001.")

    papers = []
    normalization_changes = []
    for entry in source_entries:
        fields = [text for text in entry["paragraphs"] if re.match(r"^DOI\s", text)]
        if len(fields) != 1:
            raise ValueError(f"Entry {entry['sourceIndex']} has {len(fields)} explicit DOI fields.")
        field = DOI_FIELD.fullmatch(fields[0])
        if field is None:
            raise ValueError(f"Malformed DOI/status field for {entry['sourceIndex']}: {fields[0]!r}")
        raw_doi, source_status = field.groups()
        doi = normalize_doi(raw_doi)
        if doi and doi != raw_doi:
            normalization_changes.append({
                "sourceIndex": entry["sourceIndex"], "sourceDoi": raw_doi, "doi": doi,
            })
        papers.append({
            "id": f"paper-{entry['sourceIndex']}",
            "sourceIndex": entry["sourceIndex"],
            "title": entry["title"],
            "doi": doi,
            "sourceStatus": source_status,
        })

    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    bundle = {"sourceName": source.name, "importedAt": imported_at, "papers": papers}
    doi_groups: dict[str, list[dict]] = defaultdict(list)
    for paper in papers:
        if paper["doi"]:
            doi_groups[paper["doi"].lower()].append(paper)
    duplicates = [
        {"doi": group[0]["doi"], "records": group}
        for group in doi_groups.values() if len(group) > 1
    ]
    missing = [paper for paper in papers if not paper["doi"]]
    audit = {
        "sourceName": source.name,
        "sourcePath": str(source.resolve()),
        "sourceSha256": hashlib.sha256(raw_source).hexdigest(),
        "importedAt": imported_at,
        "counts": {
            "totalRecords": len(papers),
            "withDoi": len(papers) - len(missing),
            "missingDoi": len(missing),
            "uniqueDoi": len(doi_groups),
            "duplicateDoiGroups": len(duplicates),
            "duplicateDoiExtraRecords": sum(len(group["records"]) - 1 for group in duplicates),
        },
        "sourceStatusCounts": dict(Counter(paper["sourceStatus"] for paper in papers)),
        "normalizationChanges": normalization_changes,
        "duplicateDoiGroups": duplicates,
        "missingDoiRecords": missing,
        "validation": {
            "continuousSourceIndices": True,
            "oneExplicitDoiFieldPerRecord": True,
            "doiSyntaxValid": True,
            "doiResolutionChecked": False,
            "sourceTitleMatchingChecked": False,
            "fullTextAvailabilityChecked": False,
            "notes": "仅提取原文显式 DOI，不推测或补全。重复 DOI 记录全部保留；唯一 DOI 按不区分大小写计算。",
        },
    }

    data_dir = output_root / "data"
    extension_dir = output_root / "extension"
    data_dir.mkdir(parents=True, exist_ok=True)
    extension_dir.mkdir(parents=True, exist_ok=True)
    (extension_dir / "bundled-papers.json").write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (data_dir / "source-audit.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (data_dir / "文献清单.tsv").open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.writer(output, delimiter="\t")
        writer.writerow(["原编号", "论文题目", "DOI", "原文状态", "记录ID"])
        for paper in papers:
            writer.writerow([paper["sourceIndex"], paper["title"], paper["doi"], paper["sourceStatus"], paper["id"]])
    missing_lines = [
        "缺少 DOI 待核对文献",
        f"来源：{source.name}",
        f"记录数：{len(missing)}；这些记录的源文件 DOI 字段为未确认，尚未执行全文下载。",
        "未确认 DOI 不表示文献没有 DOI，也不表示无法获取全文。",
        "",
    ]
    for paper in missing:
        missing_lines.extend([
            f"{paper['sourceIndex']}. {paper['title']}",
            "DOI：未确认",
            f"原文状态：{paper['sourceStatus']}",
            "",
        ])
    (data_dir / "缺少DOI待核对.txt").write_text("\n".join(missing_lines), encoding="utf-8-sig")
    return audit


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source .docx (read only)")
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--expected-count", type=int)
    args = parser.parse_args()
    audit = extract(args.source, args.output_root, args.expected_count)
    print(json.dumps(audit["counts"], ensure_ascii=True))


if __name__ == "__main__":
    main()

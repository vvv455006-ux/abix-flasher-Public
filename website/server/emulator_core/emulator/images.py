"""Firmware images the emulator can boot.

A zip is classified from info.json. A raw file is classified from its
header. Encrypted payloads stay encrypted until a load asks for them.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCAN = (
    ROOT / "BLE PROJECT",
    ROOT / "visuals-ble" / "dist",
    ROOT / "firmware",
    ROOT / "learned_firmwares",
    ROOT / "encrypted files",
)
VCU_SP = 0x20006E78
MCU_SP = 0x200047C0


def resolve(rel: str) -> Path:
    root = ROOT.resolve()
    path = (root / rel).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("unknown image")
    return path


def _zip_kind(path: Path) -> str | None:
    try:
        with zipfile.ZipFile(path) as zf:
            info = json.loads(zf.read("info.json"))
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, OSError):
        return None
    kind = str((info.get("firmware") or {}).get("type") or "").upper()
    if kind in {"BLE", "VCU", "MCU"}:
        return kind
    return None


def _bin_kind(data: bytes) -> str | None:
    if data.startswith(b"RAW4TFT\x00"):
        return "BLE"
    if len(data) < 8:
        return None
    sp = int.from_bytes(data[:4], "little")
    if sp == VCU_SP:
        return "VCU"
    if sp == MCU_SP:
        return "MCU"
    return None


def catalog() -> dict[str, list[dict[str, str]]]:
    found: dict[str, list[dict[str, str]]] = {"BLE": [], "VCU": [], "MCU": []}
    seen: set[Path] = set()
    for folder in SCAN:
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in {".bin", ".zip"}:
                continue
            if path in seen or "__pycache__" in path.parts:
                continue
            seen.add(path)
            if path.suffix.lower() == ".zip":
                kind = _zip_kind(path)
            else:
                kind = _bin_kind(path.read_bytes()[:16])
            if kind is None:
                continue
            rel = path.relative_to(ROOT).as_posix()
            found[kind].append({"id": rel, "label": path.name})
    return found


def plaintext(rel: str) -> tuple[str, bytes]:
    """Return (kind, decrypted-or-raw bytes) for one catalog id."""
    path = resolve(rel)
    if path.suffix.lower() == ".zip":
        kind = _zip_kind(path)
        if kind is None:
            raise ValueError(f"{rel} has no BLE, VCU, or MCU type")
        import sys

        sys.path.insert(0, str(ROOT / "visuals-ble"))
        from package_ble import tea_crypt

        with zipfile.ZipFile(path) as zf:
            data = tea_crypt(zf.read("FIRM.bin.enc"), False)
    else:
        data = path.read_bytes()
        kind = _bin_kind(data)
        if kind is None:
            raise ValueError(f"{rel} is not a BLE, VCU, or MCU image")
    return kind, data

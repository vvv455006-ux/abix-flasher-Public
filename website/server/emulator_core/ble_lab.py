"""Local G3 Max BLE 0.4.5 panel lab. Run a firmware image through Unicorn."""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import zipfile
import zlib
from pathlib import Path

from unicorn import UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R4

CORE = Path(__file__).resolve().parent
sys.path.insert(0, str(CORE / "emulator"))
sys.path.insert(0, str(CORE / "visuals-ble"))
from package_ble import tea_checksum, tea_crypt
from session import Session, boot_firmware, parse_keys

WIDTH, HEIGHT = 240, 320
CATALOG = {
    "g3_blackwave": ("Blackwave G3", CORE.parent / "firmware_storage/g3_blackwave/FIRM.bin.enc"),
    "g3_smoke": ("Stone Island G3", CORE.parent / "firmware_storage/g3_smoke/FIRM.bin.enc"),
}
PANEL_GATE = 0x0C02EBEC
PANEL_DRIVER = 0x200175F0
STOCK_HOME_UPDATE = 0x0C042534
AURORA_TICK = 0x0C1F72A0
KNOWN_AURORA_IMAGES = {
    "647e546b4d06df22ea3d7a12acdd966dd24c089edaa80d93579feda433be09e0",
    "16f924a191d70c71b13c98e641944f8a022e78c0a90badcb2933300d3b469721",
}
GEARS = {"Walk": 1, "Eco": 2, "Drive": 5, "Sport": 3}
INPUTS = {
    "power_on_mode": (2,),
    "current_speed": range(100),
    "battery_total": range(101),
    "gear_mode": GEARS.values(),
    "parking_state": (0, 1),
    "ctl_headlight": (0, 1),
    "charging_status": (0, 1),
    "bt_connect_status": (0, 1),
    "bt_ble_connect_status": (0, 1),
}
SCENARIOS = (
    ("ride", {"power_on_mode": 2, "current_speed": 24, "battery_total": 43, "gear_mode": 5}),
    ("ride_next", {}),
    ("sport", {"gear_mode": 3}),
    ("park", {"current_speed": 0, "parking_state": 1}),
    ("low_battery", {"parking_state": 0, "battery_total": 8}),
    ("charging", {"charging_status": 1}),
)


def load_image(path: Path) -> tuple[bytes, dict]:
    max_size = boot_firmware.FLASH
    if path.stat().st_size > max_size + 128 * 1024:
        raise ValueError("Image or ZIP exceeds the lab input limit")

    info = None
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            for name, limit in (("info.json", 16384), ("FIRM.bin.enc", max_size + 8)):
                entries = [entry for entry in archive.infolist() if entry.filename == name]
                if len(entries) != 1 or entries[0].file_size > limit:
                    raise ValueError(f"ZIP requires exactly one bounded {name} entry")
            info = json.loads(archive.read("info.json"))
            encrypted = archive.read("FIRM.bin.enc")
    elif path.name.lower().endswith(".bin.enc"):
        meta = path.with_name("info.json")
        if meta.stat().st_size > 16384:
            raise ValueError("info.json exceeds the lab metadata limit")
        info = json.loads(meta.read_text(encoding="utf-8-sig"))
        encrypted = path.read_bytes()
    else:
        data = path.read_bytes()

    if info is not None:
        fw = info["firmware"]
        if fw.get("model") != "g3" or fw.get("type") != "BLE" or fw.get("compatible") != ["g3_BLE"]:
            raise ValueError("This lab uses G3 Max BLE images")
        if hashlib.md5(encrypted).hexdigest() != fw["md5"]["enc"]:
            raise ValueError("Encrypted firmware MD5 differs from info.json")
        if len(encrypted) < 8 or len(encrypted) % 8 or len(encrypted) > max_size + 8:
            raise ValueError("Invalid encrypted firmware size")
        payload = tea_crypt(encrypted, False)
        data = payload[:-4]
        if tea_checksum(data) != int.from_bytes(payload[-4:], "little"):
            raise ValueError("Ninebot TEA checksum mismatch")

    if len(data) < 0x408 or data[:8] != b"RAW4TFT\0":
        raise ValueError("Expected a decrypted RAW4TFT image")
    length = struct.unpack_from("<I", data, 12)[0]
    start = struct.unpack_from("<I", data, 24)[0]
    end = start + length
    if start != 0x400 or end < 0x408 or end > min(len(data), max_size):
        raise ValueError("RAW4TFT payload bounds are invalid")
    if len(data) - end > 7 or any(data[end:]):
        raise ValueError("Unexpected trailing data after the declared RAW4TFT payload")
    image = data[:end]
    if image[44] != 0x45 or b"g3_0045_20260108" not in image:
        raise ValueError("This board profile requires G3 Max BLE 0.4.5")
    if struct.unpack_from("<II", image, 0x400) != (0x20080000, boot_firmware.RESET):
        raise ValueError("Reset vectors do not match the G3 Max BLE board profile")
    if hashlib.md5(image[start:end]).digest() != image[28:44]:
        raise ValueError("RAW4TFT payload MD5 mismatch")
    page_tail = ((start + 4095) & ~4095) - 1
    sampled = image[start:end:4096] + image[page_tail:end:4096] + image[end & ~4095:end]
    if zlib.crc32(sampled) != struct.unpack_from("<I", image, 16)[0]:
        raise ValueError("RAW4TFT sparse CRC mismatch")
    metadata = {
        "file": path.name,
        "display_name": info["firmware"]["displayName"] if info else path.name,
        "base": "G3 BLE 0.4.5",
        "bytes": len(image),
        "sha256": hashlib.sha256(image).hexdigest(),
    }
    return image, metadata


class Panel:
    """A single BLE session driven by synthetic cluster register writes."""

    def __init__(self, path: Path):
        image, self.metadata = load_image(path)
        self.session = Session()
        self.session.keys = parse_keys(image)
        self.session.by_name = {key["name"]: key for key in self.session.keys}
        self.state = boot_firmware.boot(
            slices=2700, advance_lvgl=True, ble_bytes=image, capture_limit=16
        )
        self.session.st = self.state
        self.backlight_writes = 0
        self.home_updates = 0
        self.aurora_ticks = 0 if self.metadata["sha256"] in KNOWN_AURORA_IMAGES else None
        self.install_panel_model(image)

    def install_panel_model(self, image: bytes) -> None:
        mu = self.state["mu"]
        gate = PANEL_GATE - boot_firmware.BASE
        self.models_backlight = image[gate:gate + 6] == bytes.fromhex("a38b002b7fd1")

        def supply_backlight(uc, _address, _size, _user):
            # The display's backlight is powered in this panel fixture.
            # Keep the firmware's own task and callback dispatch in control.
            if uc.reg_read(UC_ARM_REG_R4) == PANEL_DRIVER:
                field = PANEL_DRIVER + 0x1C
                if uc.mem_read(field, 2) == b"\0\0":
                    uc.mem_write(field, b"\x01\0")
                    self.backlight_writes += 1

        def count_home(_uc, _address, _size, _user):
            self.home_updates += 1

        def count_aurora(_uc, _address, _size, _user):
            self.aurora_ticks += 1

        if self.models_backlight:
            mu.hook_add(UC_HOOK_CODE, supply_backlight, begin=PANEL_GATE, end=PANEL_GATE)
        mu.hook_add(UC_HOOK_CODE, count_home, begin=STOCK_HOME_UPDATE, end=STOCK_HOME_UPDATE)
        if self.aurora_ticks is not None:
            mu.hook_add(UC_HOOK_CODE, count_aurora, begin=AURORA_TICK, end=AURORA_TICK)

    def summary(self) -> dict:
        return {
            "flushes": self.state["flush_cb"],
            "rows": sum(self.state["rows"]),
            "fault": self.state["fault"],
            "stopped": self.state["dead"],
            "panel_ready": self.ready,
            "backlight_fixture": self.models_backlight,
            "backlight_writes": self.backlight_writes,
            "home_updates": self.home_updates,
            "aurora_ticks": self.aurora_ticks,
        }

    @property
    def ready(self) -> bool:
        return all(self.state["rows"]) and not (self.state["dead"] or self.state["fault"])

    def apply(self, changes: dict[str, int]) -> dict:
        if not self.ready:
            raise RuntimeError("Emulated panel did not reach a complete, fault-free frame")
        keys = {}
        for name, value in changes.items():
            key = self.session.by_name.get(name)
            if name not in INPUTS or value not in INPUTS[name]:
                raise ValueError(f"Unsupported input {name}={value}")
            if key is None or key["size"] not in (1, 2, 4):
                raise ValueError(f"{name} is unavailable in this image")
            keys[name] = key
        before = bytes(self.state["fb"])
        home_before, aurora_before = self.home_updates, self.aurora_ticks
        for name, key in keys.items():
            self.session._write(key, changes[name])
        readback = {name: self.session._read(key) for name, key in keys.items()}
        flushes = self.state["more_frames"]()
        after = self.state["fb"]
        return {
            **self.summary(),
            "writes": changes,
            "readback_before_advance": readback,
            "new_flushes": flushes,
            "new_home_updates": self.home_updates - home_before,
            "new_aurora_ticks": self.aurora_ticks - aurora_before if aurora_before is not None else None,
            "pixels_changed": sum(
                before[i] != after[i] or before[i + 1] != after[i + 1]
                for i in range(0, len(before), 2)
            ),
        }

    def frame_png(self) -> bytes:
        return self.session.frame_png()


def capture(path: Path, out: Path) -> bool:
    if out.exists():
        raise FileExistsError(f"Choose a new capture directory: {out}")
    panel = Panel(path)
    out.mkdir(parents=True, exist_ok=False)
    report = {"image": panel.metadata, "boot": panel.summary(), "scenes": {}}
    first = panel.state.get("first_full_frame")
    if first is not None:
        boot_firmware.rgb565_png(first, out / "first-panel-frame.png", WIDTH, HEIGHT)
    (out / "boot.png").write_bytes(panel.frame_png())
    print(f"Boot {panel.summary()}", flush=True)
    for name, changes in SCENARIOS:
        if not panel.ready:
            break
        result = panel.apply(changes)
        report["scenes"][name] = result
        (out / f"{name}.png").write_bytes(panel.frame_png())
        print(f"{name}: {result['new_flushes']} flushes, {result['pixels_changed']} pixels changed", flush=True)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return panel.ready


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    batch = sub.add_parser("capture", help="boot, run the built-in scenarios, and save panel PNGs")
    batch.add_argument("image", help="catalog ID, BLE ZIP, encrypted payload, or decrypted BIN")
    batch.add_argument("--out", type=Path, required=True)
    sub.add_parser("gui", help="open the local interactive G3 panel lab")
    args = parser.parse_args()
    try:
        if args.command == "gui":
            from lab_gui import launch

            launch()
            return 0
        path = CATALOG[args.image][1] if args.image in CATALOG else Path(args.image)
        return 0 if capture(path, args.out) else 1
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        print(f"G3 lab: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # Keep the CLI and GUI on one module instance.
    sys.modules.setdefault("ble_lab", sys.modules[__name__])
    raise SystemExit(main())


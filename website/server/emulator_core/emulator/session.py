"""One running G3 Max: a chosen BLE, VCU, and MCU, plus the cluster buttons.

The screen is the BLE image's own flush. A button writes the cluster
buffer that image already reads, then lets LVGL flush again.
"""

from __future__ import annotations

import struct
import sys
import threading
from pathlib import Path

EMU = Path(__file__).resolve().parent
ROOT = EMU.parent
sys.path.insert(0, str(ROOT / "visuals-ble" / "emulator"))
sys.path.insert(0, str(EMU))

import boot_firmware
import images

HEADER = 0x20015BE4
BASE = 0x0C028000

# gear_mode values the ride view compares, matched to the popup it draws.
# 1 blue WALK, 2 green ECO, 3 red SPORT, 5 orange DRIVE.
GEAR = (("Walk", 1), ("Eco", 2), ("Sport", 3), ("Drive", 5))

# Telemetry and internal flags. These are not rider buttons.
SKIP = {
    "current_speed",
    "current_power",
    "remaining_mileage",
    "remaining_mileage_h",
    "remaining_mileage_percentage",
    "rid_mil_total",
    "battery1_electric_quantity",
    "battery2_electric_quantity",
    "battery_total",
    "battery_total_shutdown_time",
    "error_flag1",
    "error_flag2",
    "error_flag3",
    "error_flag4",
    "error_flag5",
    "input_password",
    "password_input_feedback",
    "password_remaining_time",
    "combination_password",
    "vcu_version",
    "vcu_support_feat",
    "is_iap_status",
    "is_reinit_sub",
    "more_data",
    "bool_data",
    "is_tft_start",
    "is_pub_connect",
    "bt_navi_app_finish_state",
    "bt_navi_status",
    "bt_navi_video_status",
    "bt_navi_icon_type",
    "bt_navi_signal_strength",
    "bt_navi_traffic_light_num",
    "bt_navi_cur_step_diatance",
    "bt_navi_driven_diatance",
    "bt_navi_driven_time",
    "bt_navi_remaining_distance",
    "bt_navi_remaining_time",
    "bt_navi_total_distance",
    "charging_remaining_time",
    "reservation_charging_time",
    "vacation_countdown",
    "photosensitive_value",
    "tft_upgrade_status",
    "tire_pressure_check",
    "last_power_mode",
    "popup_hide_event",
    "popup_is_hide",
    "popup_is_show",
    "current_group_state",
    "bts_incoming_status",
    "turn_light",
}

WIDGETS = {
    "gear_mode": {
        "label": "Gear",
        "kind": "choice",
        "group": "Ride",
        "options": [{"label": label, "value": value} for label, value in GEAR],
    },
    "ctl_headlight": {"label": "Headlight", "kind": "toggle", "group": "Lights"},
    "ctl_turn_light": {
        "label": "Turn light",
        "kind": "choice",
        "group": "Lights",
        "options": [
            {"label": "Off", "value": 0},
            {"label": "Left", "value": 1},
            {"label": "Right", "value": 2},
            {"label": "Both", "value": 3},
        ],
    },
    "brake_on": {"label": "Brake", "kind": "hold", "group": "Ride"},
    "cruise_onoff": {"label": "Cruise", "kind": "toggle", "group": "Ride"},
    "boost_mode": {"label": "Boost", "kind": "toggle", "group": "Ride"},
    "tcs_onoff": {"label": "TCS", "kind": "toggle", "group": "Ride"},
    "auto_hold": {"label": "Auto hold", "kind": "toggle", "group": "Ride"},
    "parking_state": {"label": "Parking", "kind": "toggle", "group": "Ride"},
    "double_drive": {"label": "2WD", "kind": "toggle", "group": "Ride"},
    "downhill_assist": {"label": "Downhill assist", "kind": "toggle", "group": "Ride"},
    "uphill_walking_assist": {"label": "Uphill walk", "kind": "toggle", "group": "Ride"},
    "uphill_cycling_assist": {"label": "Uphill ride", "kind": "toggle", "group": "Ride"},
    "bump_road_assist": {"label": "Bump assist", "kind": "toggle", "group": "Ride"},
    "charging_status": {"label": "Charging", "kind": "toggle", "group": "Ride"},
    "external_battery": {"label": "External battery", "kind": "toggle", "group": "Ride"},
    "high_speed_warning": {"label": "High speed warning", "kind": "toggle", "group": "Ride"},
    "energy_recover_onoff": {
        "label": "Energy recovery",
        "kind": "choice",
        "group": "Ride",
        "options": [{"label": str(n), "value": n} for n in range(4)],
    },
    "sabs": {"label": "SABS", "kind": "toggle", "group": "Ride"},
    "sdtc": {"label": "SDTC", "kind": "toggle", "group": "Ride"},
    "odo_or_trip": {
        "label": "Distance",
        "kind": "choice",
        "group": "Screen",
        "options": [{"label": "Trip", "value": 0}, {"label": "ODO", "value": 1}],
    },
    "unit_eu": {
        "label": "Unit",
        "kind": "choice",
        "group": "Screen",
        "options": [{"label": "km/h", "value": 0}, {"label": "mph", "value": 1}],
    },
    "power_on_mode": {"label": "Power", "kind": "hold", "group": "Power"},
    "button_switch": {
        "label": "Controller",
        "kind": "bits",
        "group": "Buttons",
        "bits": ["Button 1", "Button 2", "Button 3", "Button 4"],
    },
    "bt_connect_status": {"label": "Bluetooth", "kind": "toggle", "group": "Link"},
    "bt_ble_connect_status": {"label": "BLE link", "kind": "toggle", "group": "Link"},
    "bt_music_connect_status": {"label": "Music link", "kind": "toggle", "group": "Link"},
    "bt_unlock_status": {"label": "Unlock", "kind": "toggle", "group": "Link"},
}


def parse_keys(data: bytes) -> list[dict]:
    """The 24-byte cluster table. Found from the brake_on entry, not a fixed offset."""
    at = data.find(b"brake_on\x00")
    if at < 0:
        return []
    needle = struct.pack("<I", BASE + at)
    table = None
    start = 0
    while True:
        hit = data.find(needle, start)
        if hit < 0:
            break
        if hit + 0x18 <= len(data):
            words = struct.unpack_from("<6I", data, hit)
            if words[1] == 0x00040101 and words[5] == 0xFFFFFF00:
                table = hit
                break
        start = hit + 1
    if table is None:
        return []
    begin = table
    while begin >= 0x18:
        words = struct.unpack_from("<6I", data, begin - 0x18)
        if words[5] != 0xFFFFFF00 or not (BASE <= words[0] < BASE + len(data)):
            break
        begin -= 0x18
    keys = []
    off = begin
    while off + 0x18 <= len(data):
        sp, ident, _z, _cb, _a, tail = struct.unpack_from("<6I", data, off)
        if tail != 0xFFFFFF00 or not (BASE <= sp < BASE + len(data)):
            break
        name = data[sp - BASE:sp - BASE + 64].split(b"\x00", 1)[0].decode("latin1")
        keys.append({
            "name": name,
            "id": ident,
            "size": ident & 0xFF,
            "index": (ident >> 8) & 0x3FF,
        })
        off += 0x18
    return keys


def _widget(key: dict) -> dict | None:
    name = key["name"]
    if name in SKIP:
        return None
    spec = WIDGETS.get(name)
    if spec is None:
        if key["size"] != 1:
            return None
        spec = {"label": name.replace("_", " "), "kind": "toggle", "group": "Other"}
    out = {"name": name, "id": key["id"], "size": key["size"], **spec}
    return out


class Session:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.st = None
        self.keys: list[dict] = []
        self.by_name: dict[str, dict] = {}
        self.ble = ""
        self.vcu = ""
        self.mcu = ""
        self.vcu_passes = 0
        self.mcu_passes = 0
        self.vcu_fault = ""
        self.mcu_fault = ""
        self.error = ""

    def load(self, ble: str, vcu: str, mcu: str) -> dict:
        ble_kind, ble_bytes = images.plaintext(ble)
        vcu_kind, vcu_bytes = images.plaintext(vcu)
        mcu_kind, mcu_bytes = images.plaintext(mcu)
        if ble_kind != "BLE" or vcu_kind != "VCU" or mcu_kind != "MCU":
            raise ValueError("pick one BLE, one VCU, and one MCU")
        keys = parse_keys(ble_bytes)
        st = boot_firmware.boot(slices=2700, advance_lvgl=True, ble_bytes=ble_bytes)
        vcu_board, mcu_board = _step_controllers(vcu, vcu_bytes, mcu, mcu_bytes)
        self.st = st
        self.keys = keys
        self.by_name = {item["name"]: item for item in keys}
        self.ble = ble
        self.vcu = vcu
        self.mcu = mcu
        self.vcu_passes = vcu_board._hits.get(boards.VCU_LOOP, 0)
        self.mcu_passes = mcu_board._hits.get(boards.MCU_LOOP, 0)
        self.vcu_fault = vcu_board.fault
        self.mcu_fault = mcu_board.fault
        self.error = st.get("fault") or ""
        return self.state()

    def state(self) -> dict:
        loaded = self.st is not None
        controls = []
        if loaded:
            for key in self.keys:
                spec = _widget(key)
                if spec is None:
                    continue
                try:
                    spec["value"] = self._read(key)
                except (RuntimeError, ValueError):
                    spec["value"] = 0
                controls.append(spec)
        return {
            "loaded": loaded,
            "ble": self.ble,
            "vcu": self.vcu,
            "mcu": self.mcu,
            "flushes": 0 if not loaded else self.st["flush_cb"],
            "rows": 0 if not loaded else int(sum(self.st["rows"])),
            "fault": self.error,
            "vcu_passes": self.vcu_passes,
            "mcu_passes": self.mcu_passes,
            "vcu_fault": self.vcu_fault,
            "mcu_fault": self.mcu_fault,
            "controls": controls,
        }

    def press(self, name: str, value: int) -> dict:
        if self.st is None:
            raise RuntimeError("load a BLE, VCU, and MCU first")
        key = self.by_name.get(name)
        if key is None or _widget(key) is None:
            raise ValueError(f"{name} is not a button on this image")
        if name == "current_speed":
            raise ValueError("current_speed is telemetry")
        self._write(key, int(value))
        flushes = self.st["more_frames"]()
        return {"ok": True, "name": name, "value": self._read(key), "flushes": flushes}

    def frame_png(self) -> bytes:
        if self.st is None:
            raise RuntimeError("load a BLE, VCU, and MCU first")
        from PIL import Image
        import io

        fb = bytes(self.st["fb"])
        width, height = 240, 320
        rgb = bytearray(width * height * 3)
        for i in range(width * height):
            pix = fb[i * 2] | (fb[i * 2 + 1] << 8)
            red = (pix >> 11) & 0x1F
            green = (pix >> 5) & 0x3F
            blue = pix & 0x1F
            rgb[i * 3] = (red << 3) | (red >> 2)
            rgb[i * 3 + 1] = (green << 2) | (green >> 4)
            rgb[i * 3 + 2] = (blue << 3) | (blue >> 2)
        image = Image.frombytes("RGB", (width, height), bytes(rgb))
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()

    def _mu(self):
        return self.st["mu"]

    def _buffer(self) -> int:
        base = _u32(self._mu(), HEADER + 0x10)
        if not 0x20000000 <= base < 0x20100000:
            raise RuntimeError("cluster buffer is not in SRAM")
        return base

    def _read(self, key: dict) -> int:
        addr = self._buffer() + (key["id"] >> 18)
        size = key["size"]
        raw = bytes(self._mu().mem_read(addr, size))
        if size == 1:
            return raw[0]
        if size == 2:
            return struct.unpack("<H", raw)[0]
        if size == 4:
            return struct.unpack("<I", raw)[0]
        raise ValueError(f"unsupported size {size}")

    def _write(self, key: dict, value: int) -> None:
        size = key["size"]
        if size not in (1, 2, 4):
            raise ValueError(f"unsupported size {size}")
        value &= (1 << (8 * size)) - 1
        addr = self._buffer() + (key["id"] >> 18)
        if size == 1:
            blob = bytes([value])
        elif size == 2:
            blob = struct.pack("<H", value)
        else:
            blob = struct.pack("<I", value)
        self._mu().mem_write(addr, blob)
        _mark_dirty(self._mu(), key["index"])


def _u32(mu, addr: int) -> int:
    return struct.unpack("<I", bytes(mu.mem_read(addr, 4)))[0]


def _mark_dirty(mu, index: int) -> None:
    bitmap = _u32(mu, HEADER + 0x18)
    if not 0x20000000 <= bitmap < 0x20100000:
        return
    word = index >> 5
    bit = index & 31
    addr = bitmap + word * 4
    cur = _u32(mu, addr)
    mu.mem_write(addr, struct.pack("<I", cur | (1 << bit)))


def _step_controllers(vcu_name: str, vcu_bytes: bytes, mcu_name: str, mcu_bytes: bytes):
    import run as boards

    vcu_path = Path("/tmp") / "g3-emu-vcu.bin"
    mcu_path = Path("/tmp") / "g3-emu-mcu.bin"
    vcu_path.write_bytes(vcu_bytes)
    mcu_path.write_bytes(mcu_bytes)
    vcu = boards.At32("VCU", vcu_path, boards.VCU_ENTRY, boards.VCU_LOOP)
    mcu = boards.At32("MCU", mcu_path, boards.MCU_ENTRY, boards.MCU_LOOP)
    for _ in range(80):
        vcu.step(8000)
        mcu.step(8000)
        if vcu.fault and mcu.fault:
            break
        moved = 0
        while vcu.tx and moved < 64:
            _, byte = vcu.tx.pop(0)
            mcu.rx.append(byte)
            moved += 1
        while mcu.tx and moved < 128:
            _, byte = mcu.tx.pop(0)
            vcu.rx.append(byte)
            moved += 1
    return vcu, mcu


def _diff(a: bytes, b: bytes) -> int:
    count = 0
    for i in range(0, min(len(a), len(b)), 2):
        if a[i:i + 2] != b[i:i + 2]:
            count += 1
    return count


def check() -> int:
    """Boot stock BLE and prove a cluster write changes flushed pixels."""
    stock = ROOT / "BLE PROJECT" / "FIRM_0.4.5.bin"
    data = stock.read_bytes()
    keys = {item["name"]: item for item in parse_keys(data)}
    missing = [name for name in ("ctl_headlight", "gear_mode", "button_switch") if name not in keys]
    if missing:
        print("missing keys", missing)
        return 1
    print(f"keys {len(keys)} headlight id={keys['ctl_headlight']['id']:#x}")
    st = boot_firmware.boot(slices=2700, advance_lvgl=True, ble_bytes=data)
    session = Session()
    session.st = st
    session.keys = list(keys.values())
    session.by_name = keys
    mu = st["mu"]
    print(
        "header",
        f"+10={_u32(mu, HEADER + 0x10):#x}",
        f"+14={_u32(mu, HEADER + 0x14):#x}",
        f"+18={_u32(mu, HEADER + 0x18):#x}",
        f"+1c={struct.unpack('<H', bytes(mu.mem_read(HEADER + 0x1C, 2)))[0]}",
        f"+1e={struct.unpack('<H', bytes(mu.mem_read(HEADER + 0x1E, 2)))[0]}",
    )
    print("boot", f"flushes={st['flush_cb']}", f"rows={sum(st['rows'])}", f"fault={st['fault']!r}")
    out = Path("/opt/cursor/artifacts")
    out.mkdir(parents=True, exist_ok=True)
    before = bytes(st["fb"])
    boot_firmware.rgb565_png(before, out / "emu-headlight-off.png", 240, 320, scale=2)
    light = keys["ctl_headlight"]
    print("headlight was", session._read(light))
    session._write(light, 1)
    got = st["more_frames"]()
    after = bytes(st["fb"])
    boot_firmware.rgb565_png(after, out / "emu-headlight-on.png", 240, 320, scale=2)
    changed = _diff(before, after)
    print(f"headlight flushes={got} pixels={changed} value={session._read(light)}")
    gear = keys["gear_mode"]
    session._write(gear, 1)
    st["more_frames"]()
    walk = bytes(st["fb"])
    boot_firmware.rgb565_png(walk, out / "emu-gear-walk.png", 240, 320, scale=2)
    session._write(gear, 3)
    st["more_frames"]()
    sport = bytes(st["fb"])
    boot_firmware.rgb565_png(sport, out / "emu-gear-sport.png", 240, 320, scale=2)
    gear_changed = _diff(walk, sport)
    print(f"gear pixels={gear_changed} value={session._read(gear)}")
    if changed < 1:
        print("headlight did not change the flush")
        return 1
    return 0


if __name__ == "__main__":
    if "--list" in sys.argv:
        cat = images.catalog()
        for kind, rows in cat.items():
            print(kind)
            for row in rows:
                print(" ", row["id"])
        data = (ROOT / "BLE PROJECT" / "FIRM_0.4.5.bin").read_bytes()
        shown = [item["name"] for item in parse_keys(data) if _widget(item)]
        print("buttons", len(shown))
        print(" ".join(shown))
    elif "--check" in sys.argv:
        raise SystemExit(check())
    else:
        raise SystemExit("use --list or --check")

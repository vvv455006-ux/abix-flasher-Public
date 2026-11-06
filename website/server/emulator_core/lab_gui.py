"""Desktop controls for the local G3 BLE panel lab."""
from __future__ import annotations

import io
import tkinter as tk
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import filedialog, ttk

from PIL import Image, ImageTk

from ble_lab import CATALOG, GEARS, HEIGHT, INPUTS, WIDTH, Panel

BG = "#101217"
SURFACE = "#181c24"
TEXT = "#e9edf4"
MUTED = "#aab6c8"


class LabWindow:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.panel: Panel | None = None
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.future = None
        self.controls = []
        self.changed = {}
        root.title("StarCFW G3 Max BLE Lab")
        root.configure(bg=BG, padx=22, pady=18)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.columnconfigure(1, weight=1)

        self.label(root, "G3 Max BLE Lab", 20, bold=True).grid(row=0, columnspan=2, sticky="w")
        self.label(root, "Firmware output · 240 × 320 RGB565 · BLE 0.4.5", 10, color=MUTED).grid(
            row=1, columnspan=2, sticky="w", pady=(0, 12)
        )

        self.screen = tk.Canvas(root, width=WIDTH * 2, height=HEIGHT * 2,
                                bg="#040508", highlightthickness=1, highlightbackground="#303949")
        self.screen.grid(row=2, column=0, sticky="n", padx=(0, 22))
        self.screen_item = self.screen.create_image(0, 0, anchor="nw")
        self.placeholder = self.screen.create_text(WIDTH, HEIGHT, text="Load a G3 BLE image", fill=MUTED)

        right = tk.Frame(root, bg=BG)
        right.grid(row=2, column=1, sticky="nsew")
        self.label(right, "Firmware", 12, bold=True).pack(anchor="w", pady=(0, 5))
        self.catalog_name = tk.StringVar(value=CATALOG["g3_blackwave"][0])
        catalog = {label: path for label, path in CATALOG.values()}
        ttk.Combobox(right, textvariable=self.catalog_name, values=list(catalog), state="readonly").pack(fill="x")
        self.catalog_button = ttk.Button(right, text="Boot catalog image",
                                         command=lambda: self.load(catalog[self.catalog_name.get()]))
        self.catalog_button.pack(fill="x", pady=(6, 3))
        self.open_button = ttk.Button(right, text="Open ZIP or BIN…", command=self.choose)
        self.open_button.pack(fill="x")

        self.label(right, "Synthetic inputs", 12, bold=True).pack(anchor="w", pady=(15, 5))
        self.inputs = {name: tk.IntVar(value=0) for name in INPUTS}
        for name, title, maximum in (
            ("current_speed", "Speed (km/h)", 99), ("battery_total", "Battery (%)", 100)
        ):
            slider = tk.Scale(right, label=title, from_=0, to=maximum, variable=self.inputs[name],
                              orient="horizontal", bg=BG, fg=TEXT, troughcolor=SURFACE,
                              activebackground="#7bc1f8", highlightthickness=0)
            slider.pack(fill="x")
            self.controls.append((name, slider, "normal"))
        self.gear = tk.StringVar(value="")
        combo = ttk.Combobox(right, textvariable=self.gear, values=list(GEARS), state="readonly")
        combo.pack(fill="x", pady=(5, 3))
        self.controls.append(("gear_mode", combo, "readonly"))
        for name, title in (
            ("parking_state", "Park"), ("ctl_headlight", "Headlight"), ("charging_status", "Charging"),
            ("bt_connect_status", "Bluetooth"), ("bt_ble_connect_status", "BLE link"),
        ):
            button = ttk.Checkbutton(right, text=title, variable=self.inputs[name])
            button.pack(anchor="w", pady=1)
            self.controls.append((name, button, "normal"))
        self.activate_button = ttk.Button(
            right, text="Activate ride state", command=lambda: self.step({"power_on_mode": 2})
        )
        self.activate_button.pack(fill="x", pady=(8, 3))
        self.apply_button = ttk.Button(right, text="Apply inputs", command=self.apply)
        self.apply_button.pack(fill="x", pady=(12, 3))
        self.advance_button = ttk.Button(right, text="Advance firmware", command=lambda: self.step({}))
        self.advance_button.pack(fill="x")
        self.status = tk.StringVar(value="Ready. Choose a firmware image.")
        tk.Label(right, textvariable=self.status, bg=BG, fg=MUTED, justify="left",
                 wraplength=300, width=38, anchor="w", padx=0, pady=12).pack(fill="x")
        self.refresh_controls()

    @staticmethod
    def label(parent, text, size, *, bold=False, color=TEXT):
        return tk.Label(parent, text=text, bg=BG, fg=color,
                        font=("Segoe UI", size, "bold" if bold else "normal"), padx=0)

    def refresh_controls(self):
        busy = self.future is not None
        loaded = not busy and self.panel is not None and self.panel.ready
        for widget in (self.catalog_button, self.open_button):
            widget.configure(state="disabled" if busy else "normal")
        for name, widget, active_state in self.controls:
            enabled = loaded and name in self.panel.session.by_name
            widget.configure(state=active_state if enabled else "disabled")
        self.activate_button.configure(
            state="normal" if loaded and "power_on_mode" in self.panel.session.by_name else "disabled"
        )
        for widget in (self.apply_button, self.advance_button):
            widget.configure(state="normal" if loaded else "disabled")

    def choose(self):
        path = filedialog.askopenfilename(
            parent=self.root, filetypes=[("G3 BLE firmware", "*.zip *.bin *.enc"), ("All files", "*.*")]
        )
        if path:
            self.load(Path(path))

    def load(self, path):
        self.panel = None
        self.changed = {}
        self.screen.itemconfigure(self.screen_item, image="")
        self.screen.itemconfigure(self.placeholder, text="Booting in Unicorn…")
        self.submit(lambda: Panel(path), self.show_boot, f"Booting {path.name}…")

    def apply(self):
        values = {name: var.get() for name, var in self.inputs.items() if name not in {"gear_mode", "power_on_mode"}}
        if self.gear.get() in GEARS:
            values["gear_mode"] = GEARS[self.gear.get()]
        changes = {
            name: value for name, value in values.items()
            if name in self.panel.session.by_name and self.changed.get(name) != value
        }
        self.step(changes)

    def step(self, changes):
        panel = self.panel
        self.submit(lambda: panel.apply(changes), self.show_step, "Advancing firmware…")

    def submit(self, task, done, message):
        self.status.set(message)
        self.future = self.executor.submit(task)
        self.refresh_controls()
        self.root.after(80, self.poll, done)

    def poll(self, done):
        if not self.future.done():
            self.root.after(80, self.poll, done)
            return
        future, self.future = self.future, None
        try:
            done(future.result())
        except Exception as exc:
            self.status.set(str(exc))
            self.screen.itemconfigure(self.placeholder, text="" if self.panel else "Load a G3 BLE image")
        self.refresh_controls()

    def show_boot(self, panel):
        self.panel = panel
        for name, variable in self.inputs.items():
            key = panel.session.by_name.get(name)
            value = panel.session._read(key) if key is not None and panel.ready else 0
            if value in INPUTS[name]:
                self.changed[name] = value
                variable.set(value)
        self.gear.set(next((label for label, value in GEARS.items()
                            if value == self.inputs["gear_mode"].get()), ""))
        self.show_frame(panel.summary(), panel.metadata["display_name"])

    def show_step(self, result):
        self.changed.update(result["readback_before_advance"])
        self.show_frame(result, f"{result['new_flushes']} new flushes · {result['pixels_changed']:,} pixels changed")

    def show_frame(self, result, detail):
        if result["rows"]:
            with Image.open(io.BytesIO(self.panel.frame_png())) as image:
                scaled = image.resize((WIDTH * 2, HEIGHT * 2), Image.Resampling.NEAREST)
            self.photo = ImageTk.PhotoImage(scaled)
            self.screen.itemconfigure(self.screen_item, image=self.photo)
            self.screen.itemconfigure(self.placeholder, text="")
        else:
            self.screen.itemconfigure(self.placeholder, text="No panel output")
        state = "Panel ready" if result["panel_ready"] else result["fault"] or "Panel did not finish booting"
        counts = f"{result['rows']}/320 rows · {result['flushes']} flushes · {result['home_updates']} home updates"
        if result["aurora_ticks"] is not None:
            counts += f" · {result['aurora_ticks']} aurora ticks"
        self.status.set(f"{state}\n{detail}\n{counts}")

    def close(self):
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()


def launch():
    root = tk.Tk()
    LabWindow(root)
    root.mainloop()


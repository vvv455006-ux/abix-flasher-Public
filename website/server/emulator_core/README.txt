StarCFW G3 Max BLE Lab
=====================

On this PC, double-click Start-G3-Lab.cmd in the project root. Boot a
catalog G3 image or open the stock, v5.1 or r7 BLE ZIP from disk. The
window shows the firmware's own 240 × 320 panel pixels. Use Activate ride
state to select the synthetic ride state. Apply synthetic speed, battery, gear, parking, lights, charging or Bluetooth inputs,
then advance the firmware and check the flush and pixel-change counts.

On a new Windows setup with 64-bit Python 3.12 and Tk installed, run
these commands from the project root:

  py -3.12 -m venv server/emulator_core/.venv
  server/emulator_core/.venv/Scripts/python.exe -m pip install -r server/emulator_core/requirements.txt

For repeatable captures, use a new output folder for each run:

  server/emulator_core/.venv/Scripts/python.exe -B server/emulator_core/ble_lab.py capture g3_blackwave --out server/emulator_core/captures/blackwave-run2
  server/emulator_core/.venv/Scripts/python.exe -B server/emulator_core/ble_lab.py capture "C:/path/to/your-g3-ble-update.zip" --out server/emulator_core/captures/candidate-run1

Supported inputs are G3 BLE 0.4.5 updater ZIPs, a catalog FIRM.bin.enc
beside its info.json, or a decrypted RAW4TFT binary. Each capture saves
the first full panel frame, post-boot frame, scene PNGs and report.json.
Files inside a firmware ZIP are read in memory. The lab has no Bluetooth
or flash transport and runs independently of the Vercel website.

Scope: Unicorn executes the BLE image with modeled MMIO, interrupt
delivery, and SPI transfer completion. After boot, the lab supplies the
backlight-on state at the verified G3 panel poll site so the firmware's
UI loop dispatches its own view update. Inputs are written to the cluster
register buffer. A readback confirms the value was written. The new
flushes and changed-pixel counts show whether the screen responded.
Reports include home update counts and aurora tick counts for the known
v5.1 and r7 images. A zero-flush scene is inconclusive for the corresponding
visual behavior.
VCU, MCU, the battery controller, the radio, and timing on real hardware
are outside this lab's scope. The legacy emutools scripts are research
fixtures. Use ble_lab.py as the Windows entry point.

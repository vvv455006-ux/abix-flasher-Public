/**
 * Exact model identity for Ninebot x3 vehicles (MAX G3 / F3 / GT3 / ZT3).
 *
 * Why this file exists: every "my G3 is detected as F3" bug in this codebase
 * traced back to a *default*. Family-prefix matching, `startsWith("g3")`, a
 * fallback branch, a duplicate display name - each of them turned "I do not
 * know this device" into "it is an F3". Identity here is evidence-based and
 * fails closed: no reading is never a model.
 *
 * Facts and where they come from:
 *  - HW id 258 = "Segway eKickscooter Ninebot MAX G3/MAX G3 Plus" (serverId
 *    10258), HW id 259 = "eKickScooter F3" (serverId 10259), both
 *    ble_protocol 2 / encrypt 2. Vendor device-config packages, tabulated at
 *    nootnooot.codeberg.page/segway-ninebot-ble/board-addressing/
 *  - Serial prefixes 1CG = G3, 1EF = F3/F3 Pro, 1K1 = ZT3, 03S = GT3.
 *    github.com/ztakis/x3utils device_spec.dart (read from flash at 0x1F020).
 *  - VCU banner "SCOOTER_VCU_<code>" at 0x400, code contains G3 or F3.
 *    Same source; ScooterHacking gates VCU images on it because a wrong-model
 *    image can brick a controller.
 *  - MCU banner "SCOOTER_MCU_0001" is identical on every model and the F3 motor
 *    controller is different hardware - the banner cannot tell them apart, so
 *    it is deliberately not accepted as model evidence.
 */

/** Canonical model records. `catalogIds` are this project's firmware ids. */
export const MODELS = Object.freeze({
  g3: Object.freeze({
    model: "g3",
    canonicalName: "Ninebot MAX G3",
    hardwareId: 258,
    serverId: 10258,
    serialPrefixes: Object.freeze(["1CG"]),
    bannerCode: "G3",
    dashboard: "NB-BT100",
    catalogIds: Object.freeze(["g3_blackwave", "g3_smoke"]),
  }),
  f3: Object.freeze({
    model: "f3",
    canonicalName: "Ninebot F3",
    hardwareId: 259,
    serverId: 10259,
    serialPrefixes: Object.freeze(["1EF"]),
    bannerCode: "F3",
    dashboard: "NB-BT100",
    catalogIds: Object.freeze(["f3_smoke", "f3_display"]),
  }),
});

/** Other x3 family members. Recognised so they can be refused by name. */
const OTHER_X3 = Object.freeze({
  256: "Ninebot ZT3 Pro",
  257: "Segway SuperScooter GT3",
  261: "Ninebot E3 series",
});

const CATALOG_TO_MODEL = new Map(
  Object.values(MODELS).flatMap((entry) =>
    entry.catalogIds.map((id) => [id, entry.model]),
  ),
);

/** Strongest -> weakest. Only these may contribute to a model decision. */
export const EVIDENCE_SOURCE = Object.freeze({
  HARDWARE_ID: "hardware-id",
  VCU_BANNER: "vcu-banner",
  SERIAL: "serial",
});

export const IDENTITY_STATUS = Object.freeze({
  VERIFIED: "verified",
  PROVISIONAL: "provisional",
  CONFLICT: "conflict",
  UNKNOWN: "unknown",
  FOREIGN: "foreign",
});

/** @returns {{model: string|null, name: string|null}} */
export function modelFromHardwareId(id) {
  const value = Number(id);
  if (Number.isInteger(value)) {
    for (const entry of Object.values(MODELS))
      if (entry.hardwareId === value)
        return { model: entry.model, name: entry.canonicalName };
    if (OTHER_X3[value]) return { model: null, name: OTHER_X3[value] };
  }
  return { model: null, name: null };
}

/**
 * Serial numbers are 14 ASCII characters; the first three encode the family.
 * Anything shorter than 3 characters is not evidence.
 */
export function modelFromSerial(serial) {
  const text = String(serial ?? "").trim().toUpperCase();
  if (text.length < 3) return { model: null, name: null };
  const prefix = text.slice(0, 3);
  for (const entry of Object.values(MODELS))
    if (entry.serialPrefixes.includes(prefix))
      return { model: entry.model, name: entry.canonicalName };
  return { model: null, name: null };
}

/**
 * "SCOOTER_VCU_xxG3" / "SCOOTER_VCU_xxF3". The MCU banner is shared across
 * models and is explicitly rejected.
 */
export function modelFromVcuBanner(banner) {
  const text = String(banner ?? "").trim().toUpperCase();
  if (!text.startsWith("SCOOTER_VCU_")) return { model: null, name: null };
  for (const entry of Object.values(MODELS))
    if (text.endsWith(entry.bannerCode) || text.includes(`_${entry.bannerCode}`))
      return { model: entry.model, name: entry.canonicalName };
  return { model: null, name: null };
}

/**
 * Combine independent readings.
 *
 * - Any two readings that disagree are a hard conflict, whatever their count.
 * - Only agreement between two independent sources reaches `verified`. One
 *   source is `provisional`: enough for a read-only diagnosis, never enough to
 *   choose a firmware image. This is the rule that removes the F3 default.
 *
 * @param {{hardwareId?: number, serial?: string, vcuBanner?: string, bleName?: string}} evidence
 */
export function identifyDevice(evidence = {}) {
  const readings = [];
  const notes = [];

  const hw = modelFromHardwareId(evidence.hardwareId);
  if (hw.model)
    readings.push({ source: EVIDENCE_SOURCE.HARDWARE_ID, model: hw.model });
  else if (hw.name)
    return refuse(
      IDENTITY_STATUS.FOREIGN,
      `${hw.name} is an x3 family vehicle but not a G3/F3; no image is valid for it.`,
      ["unsupported-family"],
    );
  else if (evidence.hardwareId !== undefined && evidence.hardwareId !== null)
    notes.push(`hardware id ${evidence.hardwareId} is not a known x3 family id`);

  const serial = modelFromSerial(evidence.serial);
  if (serial.model)
    readings.push({ source: EVIDENCE_SOURCE.SERIAL, model: serial.model });
  else if (evidence.serial) notes.push("serial prefix is not a known family code");

  const banner = modelFromVcuBanner(evidence.vcuBanner);
  if (banner.model)
    readings.push({ source: EVIDENCE_SOURCE.VCU_BANNER, model: banner.model });
  else if (evidence.vcuBanner)
    notes.push("VCU banner is not a known model code");

  if (evidence.bleName)
    notes.push("BLE name carries no model information and was not used");

  if (readings.length === 0)
    return refuse(
      IDENTITY_STATUS.UNKNOWN,
      "No model evidence. Refused rather than guessed - a wrong image bricks the display.",
      notes,
    );

  const distinct = new Set(readings.map((r) => r.model));
  const sources = readings.map((r) => r.source);
  if (distinct.size > 1)
    return {
      status: IDENTITY_STATUS.CONFLICT,
      model: null,
      canonicalName: null,
      sources,
      readings,
      notes: [
        ...notes,
        `conflicting readings: ${readings.map((r) => `${r.source}=${r.model}`).join(", ")}`,
        "A changed or cloned serial is the usual cause. Refused; do not overwrite identity.",
      ],
    };

  const model = readings[0].model;
  const entry = MODELS[model];
  return {
    status:
      sources.length >= 2
        ? IDENTITY_STATUS.VERIFIED
        : IDENTITY_STATUS.PROVISIONAL,
    model,
    canonicalName: entry.canonicalName,
    sources,
    readings,
    notes,
  };
}

function refuse(status, reason, notes) {
  return {
    status,
    model: null,
    canonicalName: null,
    sources: [],
    readings: [],
    notes: [...notes, reason],
  };
}

/**
 * Back-compat wrapper for the old `identifyModel({rawModelCode})` call site.
 *
 * `rawModelCode` is a *declaration*, not a reading - it is whatever the caller
 * already established. It is kept because the simulator and the flow reducer
 * use it, and it is labelled so nothing downstream mistakes it for evidence.
 * Never feed it a BLE name.
 */
export function identifyModel({ rawModelCode = "" } = {}) {
  const code = String(rawModelCode).trim().toLowerCase();
  if (code === "g3" || code === "f3")
    return {
      modelCode: code,
      canonicalName: MODELS[code].canonicalName,
      confidence: "declared",
      evidence: [],
    };
  return {
    modelCode: "unknown",
    canonicalName: "Unverified hardware",
    confidence: "unknown",
    evidence: [],
  };
}

/** Firmware id -> model, or null. Replaces `id.startsWith("g3") ? ... : "f3"`. */
export function modelForFirmwareId(fileId) {
  return CATALOG_TO_MODEL.get(String(fileId ?? "")) ?? null;
}

/** Every catalog id this model may receive. Empty array => never flash it. */
export function firmwareIdsForModel(model) {
  return MODELS[model]?.catalogIds ?? [];
}

/**
 * Gate before any transfer. Throws instead of coercing.
 *
 * @param {{status: string, model: string|null}} identity
 * @param {{model: string, id?: string}} firmware
 */
export function requireExactModel(identity, firmware) {
  if (!identity || identity.status === IDENTITY_STATUS.CONFLICT)
    throw new Error(
      "Device identity conflict: refusing to flash. Re-read the serial and VCU banner before retrying.",
    );
  if (identity.status !== IDENTITY_STATUS.VERIFIED)
    throw new Error(
      `Device identity is ${identity.status ?? "unknown"}; exact G3 or F3 hardware could not be proven. Refusing to flash.`,
    );
  if (!firmware?.model)
    throw new Error("Firmware has no declared model");
  if (identity.model !== firmware.model)
    throw new Error(
      `Model mismatch: device is ${identity.model?.toUpperCase()}, firmware is for ${firmware.model.toUpperCase()}. Refused.`,
    );
  if (firmware.id && modelForFirmwareId(firmware.id) !== firmware.model)
    throw new Error(
      `Firmware ${firmware.id} is not registered for ${firmware.model.toUpperCase()}. Refused.`,
    );
  return true;
}

/**
 * Validate a ScooterHacking-style ZIP-v3 style manifest before use.
 * `enforceModel` and `compatible` were previously parsed and then ignored.
 */
export function assertManifestForModel(manifest, model) {
  const firmware = manifest?.firmware;
  if (!firmware) throw new Error("Manifest has no firmware block");
  if (firmware.enforceModel !== true)
    throw new Error("Manifest does not enforce its model; refusing a cross-model image");
  if (firmware.model !== model)
    throw new Error(
      `Manifest model ${firmware.model} does not match device ${model}`,
    );
  const compatible = firmware.compatible ?? [];
  if (!compatible.includes(`${model}_BLE`))
    throw new Error(`Manifest is not marked compatible with ${model}_BLE`);
  if (firmware.type !== "BLE")
    throw new Error(`Manifest type ${firmware.type} is not a BLE display image`);
  if (firmware.mcuBanner) {
    // Shared across models - explicitly not usable to prove identity.
    if (!firmware.mcuBanner.startsWith("SCOOTER_MCU_"))
      throw new Error("Unexpected MCU banner form");
  }
  return true;
}

/** True when two records may ever be used on the same device. */
export function sameFamily(a, b) {
  const left = MODELS[a];
  const right = MODELS[b];
  return !!left && !!right && left.model === right.model;
}

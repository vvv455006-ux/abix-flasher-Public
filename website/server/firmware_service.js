import fs from "node:fs";
import crypto from "node:crypto";
import {
  MODELS,
  assertManifestForModel,
  modelForFirmwareId,
} from "../client/src/services/ninebotModel.js";
import { brandFor, sourceFor } from "../client/src/data/imageBrands.js";

/**
 * Catalog ids are the only firmware identifiers the API accepts. The model is
 * looked up in the shared registry - never derived from the id's spelling.
 *
 * The previous version kept `name` as a bare skin name, so g3_smoke and
 * f3_smoke both published as "Stone Island". Any client that showed or matched
 * firmware by name saw two identical entries and could pick the F3 image for a
 * G3 licence. Names are now model-qualified and proven unique.
 */
const DEFINITIONS = Object.freeze([
  "g3_blackwave",
  "g3_smoke",
  "f3_smoke",
  "f3_display",
]);

let cache;

/**
 * Customer-facing name: the brand from imageBrands.js plus the model.
 *
 * The manifest name is kept separately as `displayName`, so provenance stays
 * readable while the studio shows "Under Armour · MAX G3" instead of the
 * vendor file name. A collision here is still a hard startup failure.
 */
function qualifiedName(id, model) {
  const brand = brandFor(id);
  if (!brand) throw new Error(`Firmware ${id} has no brand name`);
  return `${brand} ${model.toUpperCase()}`;
}

export function getCatalog() {
  if (cache) return cache;
  const seen = new Map();
  cache = DEFINITIONS.map((id) => {
    const model = modelForFirmwareId(id);
    if (!model)
      throw new Error(`Firmware ${id} is not registered to a model`);
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL(`./firmware_storage/${id}/info.json`, import.meta.url),
        "utf8",
      ),
    );
    const bytes = fs.readFileSync(
      new URL(`./firmware_storage/${id}/FIRM.bin.enc`, import.meta.url),
    );
    // Manifest gate: enforceModel + compatible are now actually enforced.
    if (manifest.schemaVersion !== 1)
      throw new Error(`Firmware ${id} has an unsupported manifest schema`);
    assertManifestForModel(manifest, model);
    if (
      bytes.length > 4 * 1024 * 1024 ||
      crypto.createHash("md5").update(bytes).digest("hex") !==
        manifest.firmware.md5?.enc
    )
      throw new Error("Firmware catalog integrity failure");

    const name = qualifiedName(id, model);
    if (seen.has(name))
      throw new Error(
        `Firmware catalog name collision: "${name}" is used by ${seen.get(name)} and ${id}`,
      );
    seen.set(name, id);

    return Object.freeze({
      id,
      name,
      brand: brandFor(id),
      source: sourceFor(id),
      displayName: manifest.firmware.displayName,
      model,
      modelLabel: MODELS[model].canonicalName,
      component: manifest.firmware.type,
      compatible: Object.freeze([...manifest.firmware.compatible]),
      enforceModel: true,
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  });
  return cache;
}

export function firmwareBytes(id) {
  if (!getCatalog().some((x) => x.id === id))
    throw new Error("Unknown firmware");
  return fs.readFileSync(
    new URL(`./firmware_storage/${id}/FIRM.bin.enc`, import.meta.url),
  );
}

/** Catalog entry for an id, or null. Used to refuse unregistered delivery. */
export function firmwareFor(id) {
  return getCatalog().find((x) => x.id === id) ?? null;
}

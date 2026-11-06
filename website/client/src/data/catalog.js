import { MODELS } from "../services/ninebotModel.js";

/**
 * Catalogue metadata that ships inside the page.
 *
 * The studio has to open and work for anyone, including when the API is not
 * reachable (static hosting, a friend's laptop, no database configured). The
 * server catalogue stays authoritative when it answers - it carries the byte
 * size and the digest of the image it will actually deliver - but the page is
 * never empty just because nothing is listening on port 3001.
 *
 * Ids and display names mirror server/firmware_storage/<id>/info.json. The
 * model is resolved through the shared registry, never from the id's spelling,
 * so a renamed skin cannot silently change which scooter an image belongs to.
 */
const SKINS = Object.freeze({
  g3_blackwave: "Under Armour G3",
  g3_smoke: "Stone Island G3",
  f3_smoke: "Stone Island F3",
  f3_display: "Under Armour F3",
});

function modelForFirmware(id) {
  return (
    Object.keys(MODELS).find((model) =>
      MODELS[model].catalogIds.includes(id),
    ) ?? null
  );
}

export const LOCAL_CATALOG = Object.freeze(
  Object.entries(SKINS).map(([id, displayName]) => {
    const model = modelForFirmware(id);
    if (!model) throw new Error(`Bundled firmware ${id} has no model`);
    return Object.freeze({
      id,
      name: displayName,
      displayName,
      model,
      modelLabel: MODELS[model].canonicalName,
      component: "BLE",
      compatible: Object.freeze([`${model}_BLE`]),
      enforceModel: true,
      bytes: null,
      source: "bundled",
    });
  }),
);

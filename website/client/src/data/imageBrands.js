/**
 * Customer-facing names for the four display images.
 *
 * The manifests and digests stay authoritative; this only decides what the
 * studio and the API call an image. Ids never change, so a rename cannot move
 * an image to another model - `ninebotModel.js` owns that mapping.
 */
export const IMAGE_BRANDS = Object.freeze({
  g3_blackwave: "Under Armour",
  f3_display: "Under Armour",
  g3_smoke: "Stone Island",
  f3_smoke: "Stone Island",
});

/** Original package each image came from, shown as provenance. */
export const IMAGE_SOURCES = Object.freeze({
  g3_blackwave: "StarCFW_v0.1_blackwave_G3.zip",
  f3_display: "StarCFW_custom_display_v3c_f3.zip",
  g3_smoke: "StarCFW_v0.6_smoke_Abi_private_G3.zip",
  f3_smoke: "StarCFW_v0.6_smoke_Abi_private_F3.zip",
});

export function brandFor(id) {
  return IMAGE_BRANDS[id] ?? null;
}

export function sourceFor(id) {
  return IMAGE_SOURCES[id] ?? null;
}

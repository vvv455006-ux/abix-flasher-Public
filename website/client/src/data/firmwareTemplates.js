import { MODELS } from "../services/ninebotModel.js";
import { IMAGE_BRANDS, IMAGE_SOURCES } from "./imageBrands.js";

/**
 * The four display images, as the studio presents them.
 *
 * Ids match `server/firmware_storage/<id>/` and the model registry; the brand
 * name is what a customer sees, the vendor file name stays visible underneath
 * so nobody has to guess which zip this is. Sizes and digests come from the API
 * when it answers - the bundled list stays usable without it.
 */
export const FIRMWARE_TEMPLATES = Object.freeze(
  Object.entries(IMAGE_BRANDS).map(([id, brand]) => {
    const model = Object.keys(MODELS).find((key) =>
      MODELS[key].catalogIds.includes(id),
    );
    if (!model) throw new Error(`Template ${id} has no model`);
    return Object.freeze({
      id,
      brand,
      model,
      modelLabel: MODELS[model].canonicalName,
      file: IMAGE_SOURCES[id] ?? null,
      bytes: null,
      sha256: null,
    });
  }),
);

export function templatesForModel(model) {
  return FIRMWARE_TEMPLATES.filter((entry) => entry.model === model);
}

/** Merge server catalogue metadata into the bundled templates. */
export function withCatalogMetadata(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) return FIRMWARE_TEMPLATES;
  return FIRMWARE_TEMPLATES.map((template) => {
    const match = catalog.find((entry) => entry.id === template.id);
    if (!match) return template;
    return {
      ...template,
      file: match.source ?? IMAGE_SOURCES[template.id] ?? null,
      bytes: match.bytes ?? null,
      sha256: match.sha256 ?? null,
    };
  });
}

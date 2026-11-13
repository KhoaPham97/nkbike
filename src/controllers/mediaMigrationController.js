const path = require("path");
const { Media } = require("../models/media");
const { Product } = require("../models/products");
const { Category } = require("../models/category");

const normalizeImageName = (value) => {
  let source = String(value || "").trim();
  if (!source) return "";
  try {
    if (/^https?:\/\//i.test(source)) {
      const parsed = new URL(source);
      source = parsed.pathname;
    }
  } catch (_) {}
  try { source = decodeURIComponent(source); } catch (_) {}
  return path.basename(source)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
};

const buildUrlMap = (records) => {
  const candidates = new Map();
  for (const record of records) {
    const key = normalizeImageName(record.originalName || "");
    if (!key || !record.url) continue;
    const urls = candidates.get(key) || new Set();
    urls.add(record.url);
    candidates.set(key, urls);
  }
  const map = new Map();
  const ambiguous = new Set();
  for (const [key, urls] of candidates) {
    if (urls.size === 1) map.set(key, [...urls][0]);
    else ambiguous.add(key);
  }
  return { map, ambiguous };
};

const migrateCloudinaryUrls = async (req, res) => {
  try {
    const apply = String(req.query.apply || req.body?.apply || "") === "1" ||
      req.query.apply === true || req.body?.apply === true;

    const [productMedia, categoryMedia] = await Promise.all([
      Media.find({ storageProvider: "cloudinary", folder: "products" }).select("originalName url").lean(),
      Media.find({ storageProvider: "cloudinary", folder: "categories" }).select("originalName url").lean(),
    ]);
    const productMap = buildUrlMap(productMedia);
    const categoryMap = buildUrlMap(categoryMedia);

    const [products, categories] = await Promise.all([
      Product.find({}).select("_id title thumbnail images variants").lean(),
      Category.find({}).select("_id name image").lean(),
    ]);

    const productOps = [];
    const categoryOps = [];
    const missing = [];
    const ambiguous = [];
    let productFieldCount = 0;
    let categoryFieldCount = 0;

    const resolve = (value, map, ambiguousKeys, label) => {
      const raw = String(value || "").trim();
      if (!raw || /^https?:\/\//i.test(raw)) return raw;
      const key = normalizeImageName(raw);
      if (!key) return raw;
      if (ambiguousKeys.has(key)) {
        ambiguous.push({ field: label, image: raw });
        return raw;
      }
      const url = map.get(key);
      if (!url) {
        missing.push({ field: label, image: raw });
        return raw;
      }
      return url;
    };

    for (const product of products) {
      const set = {};
      const thumbnail = resolve(product.thumbnail, productMap.map, productMap.ambiguous, product.title + " / thumbnail");
      if (thumbnail !== product.thumbnail) { set.thumbnail = thumbnail; productFieldCount += 1; }

      if (Array.isArray(product.images)) {
        const images = product.images.map((value, index) =>
          resolve(value, productMap.map, productMap.ambiguous, product.title + " / images[" + index + "]")
        );
        if (images.some((value, index) => value !== product.images[index])) {
          set.images = images;
          productFieldCount += images.filter((value, index) => value !== product.images[index]).length;
        }
      }

      if (Array.isArray(product.variants)) {
        product.variants.forEach((variant, index) => {
          for (const field of ["thumbnail", "image"]) {
            const value = resolve(variant[field], productMap.map, productMap.ambiguous,
              product.title + " / variants[" + index + "]." + field);
            if (value !== variant[field]) {
              set["variants." + index + "." + field] = value;
              productFieldCount += 1;
            }
          }
        });
      }

      if (Object.keys(set).length) {
        productOps.push({
          updateOne: { filter: { _id: product._id }, update: { $set: set } },
        });
      }
    }

    for (const category of categories) {
      const image = resolve(category.image, categoryMap.map, categoryMap.ambiguous, category.name + " / image");
      if (image !== category.image) {
        categoryOps.push({
          updateOne: { filter: { _id: category._id }, update: { $set: { image } } },
        });
        categoryFieldCount += 1;
      }
    }

    if (apply) {
      if (productOps.length) await Product.bulkWrite(productOps, { ordered: false });
      if (categoryOps.length) await Category.bulkWrite(categoryOps, { ordered: false });
    }

    return res.json({
      success: true,
      mode: apply ? "applied" : "preview",
      message: apply
        ? "Đã chuyển các đường dẫn ảnh khớp sang Cloudinary."
        : "Đã kiểm tra và lập danh sách ảnh có thể chuyển đổi. Chưa thay đổi dữ liệu.",
      media: { products: productMedia.length, categories: categoryMedia.length },
      products: { scanned: products.length, updated: productOps.length, fieldsChanged: productFieldCount },
      categories: { scanned: categories.length, updated: categoryOps.length, fieldsChanged: categoryFieldCount },
      missingCount: missing.length,
      ambiguousCount: ambiguous.length,
      missing: missing.slice(0, 100),
      ambiguous: ambiguous.slice(0, 100),
    });
  } catch (error) {
    console.error("migrateCloudinaryUrls:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Không thể chuyển đường dẫn ảnh sang Cloudinary",
    });
  }
};

module.exports = { migrateCloudinaryUrls };

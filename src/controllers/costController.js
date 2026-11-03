const mongoose = require("mongoose");
const { Product } = require("../models/products");
const CostHistory = require("../models/CostHistory");

const toCost = (value) => {
  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) {
    throw new Error("unitCost phải là số không âm");
  }

  return Number(n.toFixed(4));
};
const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mapRows = (products) =>
  products.flatMap((product) =>
    (product.variants || []).map((variant, variantIndex) => ({
      productId: String(product._id),
      productTitle: product.title || "",
      productCode: product.code || "",
      type: product.type || "1",
      thumbnail: product.thumbnail || "",
      variantIndex,
      variantName: variant.name || "",
      sku: variant.sku || variant.code || "",
      unitCost: Number(variant.unitCost || 0),
      qty: Number(variant.qty || 0),
      price: Number(variant.price || 0),
      defaultPrice: Number(variant.defaultPrice || 0),
    })),
  );

module.exports = {
  // GET /admin/cost-management
  async list(req, res) {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
      const search = String(req.query.search || "").trim();
      const type = String(req.query.type || "all");
      const filter = {};
      if (type !== "all" && ["1", "2", "3"].includes(type)) filter.type = type;
      if (search) {
        const regex = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ title: regex }, { code: regex }, { brand: regex }];
      }

      const products = await Product.find(filter)
        .select("title code type thumbnail variants")
        .sort({ title: 1 })
        .lean();

      let rows = mapRows(products);
      const costStatus = String(req.query.costStatus || "all");
      if (costStatus === "missing") rows = rows.filter((r) => r.unitCost <= 0);
      if (costStatus === "set") rows = rows.filter((r) => r.unitCost > 0);

      const total = rows.length;
      const start = (page - 1) * limit;
      const items = rows.slice(start, start + limit);

      return res.json({
        success: true,
        items,
        summary: {
          variants: mapRows(products).length,
          missing: mapRows(products).filter((r) => r.unitCost <= 0).length,
          configured: mapRows(products).filter((r) => r.unitCost > 0).length,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: page * limit < total,
        },
      });
    } catch (error) {
      console.error("costManagement.list:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // PATCH /admin/cost-management/:productId/:variantIndex
  async updateOne(req, res) {
    try {
      const { productId, variantIndex } = req.params;
      if (!mongoose.isValidObjectId(productId)) {
        return res
          .status(400)
          .json({ success: false, message: "productId không hợp lệ" });
      }
      const index = Number(variantIndex);
      if (!Number.isInteger(index) || index < 0) {
        return res
          .status(400)
          .json({ success: false, message: "variantIndex không hợp lệ" });
      }
      const unitCost = toCost(req.body.unitCost);
      const product = await Product.findById(productId);
      if (!product)
        return res
          .status(404)
          .json({ success: false, message: "Không tìm thấy sản phẩm" });
      if (!product.variants || !product.variants[index]) {
        return res
          .status(404)
          .json({ success: false, message: "Không tìm thấy biến thể" });
      }

      const variant = product.variants[index];
      const oldUnitCost = Number(variant.unitCost || 0);
      variant.unitCost = unitCost;
      product.updated_at = new Date();
      await product.save();

      if (oldUnitCost !== unitCost) {
        await CostHistory.create({
          productId: product._id,
          productTitle: product.title,
          productCode: product.code,
          variantName: variant.name,
          oldUnitCost,
          newUnitCost: unitCost,
          changedBy: req.user?.username || req.user?.id || "",
          note: String(req.body.note || ""),
        });
      }
      return res.json({
        success: true,
        message: "Đã cập nhật giá vốn",
        unitCost,
      });
    } catch (error) {
      const status = /unitCost/.test(error.message) ? 400 : 500;
      return res
        .status(status)
        .json({ success: false, message: error.message });
    }
  },

  // PATCH /admin/cost-management/bulk
  async updateBulk(req, res) {
    try {
      const updates = req.body?.items;
      if (!Array.isArray(updates) || !updates.length) {
        return res
          .status(400)
          .json({ success: false, message: "items phải là mảng không rỗng" });
      }
      if (updates.length > 500) {
        return res
          .status(400)
          .json({ success: false, message: "Tối đa 500 biến thể mỗi lần" });
      }

      let updated = 0;
      for (const item of updates) {
        if (!mongoose.isValidObjectId(item.productId))
          throw new Error("productId không hợp lệ");
        const index = Number(item.variantIndex);
        if (!Number.isInteger(index) || index < 0)
          throw new Error("variantIndex không hợp lệ");
        const unitCost = toCost(item.unitCost);
        const product = await Product.findById(item.productId);
        if (!product?.variants?.[index]) continue;
        const variant = product.variants[index];
        const oldUnitCost = Number(variant.unitCost || 0);
        variant.unitCost = unitCost;
        product.updated_at = new Date();
        await product.save();
        if (oldUnitCost !== unitCost) {
          await CostHistory.create({
            productId: product._id,
            productTitle: product.title,
            productCode: product.code,
            variantName: variant.name,
            oldUnitCost,
            newUnitCost: unitCost,
            changedBy: req.user?.username || req.user?.id || "",
            note: String(item.note || "Cập nhật hàng loạt"),
          });
        }
        updated += 1;
      }
      return res.json({
        success: true,
        updated,
        message: `Đã cập nhật ${updated} biến thể`,
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  },

  // GET /admin/cost-management/history
  async history(req, res) {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
      const filter = {};
      if (
        req.query.productId &&
        mongoose.isValidObjectId(req.query.productId)
      ) {
        filter.productId = req.query.productId;
      }
      const [items, total] = await Promise.all([
        CostHistory.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        CostHistory.countDocuments(filter),
      ]);
      return res.json({
        success: true,
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },
  // ======================================================
  // POST /admin/cost-management/sync
  // ĐỒNG BỘ DEFAULT PRICE -> UNIT COST
  // ======================================================
  async syncUnitCostFromDefaultPrice(req, res) {
    try {
      const products = await Product.find(
        {},
        {
          _id: 1,
          variants: 1,
        },
      ).lean();

      const operations = [];

      let totalVariants = 0;
      let syncedVariants = 0;
      let skippedVariants = 0;

      for (const product of products) {
        const updates = {};

        for (let i = 0; i < (product.variants || []).length; i++) {
          const variant = product.variants[i];

          totalVariants++;

          const rawPrice = variant.defaultPrice;

          if (
            rawPrice === null ||
            rawPrice === undefined ||
            rawPrice === "" ||
            !Number.isFinite(Number(rawPrice)) ||
            Number(rawPrice) < 0
          ) {
            skippedVariants++;
            continue;
          }

          const defaultPrice = Number(rawPrice);

          if (Number(variant.unitCost) !== defaultPrice) {
            updates[`variants.${i}.unitCost`] = defaultPrice;
            syncedVariants++;
          }
        }

        if (Object.keys(updates).length > 0) {
          operations.push({
            updateOne: {
              filter: { _id: product._id },
              update: { $set: updates },
            },
          });
        }
      }

      if (operations.length > 0) {
        await Product.bulkWrite(operations);
      }

      return res.status(200).json({
        success: true,
        message: "Đồng bộ giá vốn thành công",
        currency: "CNY",
        data: {
          totalProducts: products.length,
          totalVariants,
          syncedVariants,
          skippedVariants,
          unchangedVariants: totalVariants - syncedVariants - skippedVariants,
          updatedProducts: operations.length,
        },
      });
    } catch (error) {
      console.error("SYNC UNIT COST ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Không thể đồng bộ giá vốn",
        error: error.message,
      });
    }
  },
};

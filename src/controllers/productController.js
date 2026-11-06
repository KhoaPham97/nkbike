const { Product } = require("../models/products");
const { Category } = require("../models/category");

// =====================================================
// HELPER
// Chuẩn hóa compatibleVehicles thành string[]
// Hỗ trợ cả dữ liệu cũ dạng string
// =====================================================
const normalizeCompatibleVehicles = (value) => {
  // Đã là array
  if (Array.isArray(value)) {
    return Array.from(
      new Set(value.map((item) => String(item || "").trim()).filter(Boolean)),
    );
  }

  // Dữ liệu cũ dạng string:
  // "VC 2021, Liwei I5, Liwei A5"
  if (typeof value === "string") {
    return Array.from(
      new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  }

  return [];
};
// =====================================================
// NORMALIZE VARIANT
// =====================================================

const normalizeVariantNumber = (value, fallback = 0) => {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const normalizeVariantPackageQuantity = (value) => {
  const number = Number(value);

  return Number.isInteger(number) && number >= 1 ? number : 1;
};
module.exports = {
  // =====================================================
  // LIST ALL PRODUCT
  // =====================================================
  async listAllProductsAsync(req, res) {
    try {
      const { type, search = "", compatibleVehicle = "" } = req.query;
      const compatibleVehicleFilter = compatibleVehicle.trim()
        ? {
            compatibleVehicles: {
              $regex: `^${compatibleVehicle
                .trim()
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
              $options: "i",
            },
          }
        : {};
      // =====================================================
      // SEARCH
      // =====================================================
      const keyword = search.trim();

      const searchFilter = keyword
        ? {
            $or: [
              {
                title: {
                  $regex: keyword,
                  $options: "i",
                },
              },
              {
                brand: {
                  $regex: keyword,
                  $options: "i",
                },
              },
              {
                code: {
                  $regex: keyword,
                  $options: "i",
                },
              },
            ],
          }
        : {};

      // =====================================================
      // PAGINATION
      // =====================================================
      const page = Math.max(Number(req.query.page) || 1, 1);

      const limit = Math.min(Number(req.query.limit) || 40, 100);

      const skip = (page - 1) * limit;

      // =====================================================
      // VISIBILITY
      // =====================================================
      const isAdmin = req.user?.role === "admin";

      const visibilityFilter = isAdmin
        ? {}
        : {
            isVisible: { $ne: false },
          };

      // =====================================================
      // FILTER
      // =====================================================
      const filter =
        !type || type === "all"
          ? {
              ...visibilityFilter,
              ...searchFilter,
              ...compatibleVehicleFilter,
            }
          : {
              type,
              ...visibilityFilter,
              ...searchFilter,
              ...compatibleVehicleFilter,
            };

      // =====================================================
      // GET PRODUCTS
      // =====================================================
      const products = await Product.aggregate([
        {
          $match: filter,
        },

        // qty đang là String => chuyển sang Number
        {
          $addFields: {
            qtyNumber: {
              $convert: {
                input: "$qty",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },

        // ===================================================
        // ƯU TIÊN SẢN PHẨM CÒN HÀNG
        // ===================================================
        {
          $addFields: {
            inStock: {
              $cond: [{ $gt: ["$qtyNumber", 0] }, 1, 0],
            },
          },
        },

        // ===================================================
        // SORT
        // ===================================================
        {
          $sort: {
            inStock: -1,
            title: 1,
          },
        },

        // ===================================================
        // PAGINATION
        // ===================================================
        {
          $skip: skip,
        },

        {
          $limit: limit,
        },

        // ===================================================
        // XÓA FIELD TẠM
        // ===================================================
        {
          $project: {
            qtyNumber: 0,
            inStock: 0,
          },
        },
      ]);

      // =====================================================
      // COUNT
      // =====================================================
      const total = await Product.countDocuments(filter);

      const totalPages = Math.ceil(total / limit);

      const hasMore = page < totalPages;

      // =====================================================
      // RESPONSE
      // =====================================================
      return res.status(200).json({
        products,

        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore,
        },
      });
    } catch (error) {
      console.error("listAllProductsAsync error:", error);

      return res.status(500).json({
        message: error.message,
      });
    }
  },

  // =====================================================
  // GET PRODUCT BY ID
  // =====================================================
  async getProductAsync(req, res) {
    const productId = req.params.id;

    try {
      const foundProduct = await Product.findById(productId);

      if (!foundProduct) {
        return res.status(404).send({
          message: "Không tìm thấy sản phẩm",
        });
      }

      res.status(200).send(foundProduct);
    } catch (error) {
      res.status(404).send({
        message: error.message,
      });
    }
  },

  // =====================================================
  // DELETE ALL
  // =====================================================
  async deleteAll(req, res) {
    try {
      await Product.deleteMany({});

      res.status(200).send({
        message: "product removed",
      });
    } catch (err) {
      res.status(500).send({
        message: err.message,
      });
    }
  },

  // =====================================================
  // CREATE PRODUCT
  // =====================================================
  // =====================================================
  // CREATE PRODUCT
  // =====================================================

  async createProduct(req, res) {
    try {
      const data = req.body || {};

      const compatibleVehicles = normalizeCompatibleVehicles(
        data.compatibleVehicles,
      );

      const variants = Array.isArray(data.variants)
        ? data.variants.map((variant) => ({
            name: String(variant.name || "").trim(),

            // Không nhận mã từ frontend.
            // Model tự sinh variantCode và sku.

            price: String(variant.price ?? "0"),

            defaultPrice: String(variant.defaultPrice ?? "0"),

            unitCost: normalizeVariantNumber(variant.unitCost),

            weight: normalizeVariantNumber(variant.weight),

            qty: normalizeVariantNumber(variant.qty),

            // reservedQty do hệ thống đơn hàng quản lý.
            reservedQty: 0,

            packageQuantity: normalizeVariantPackageQuantity(
              variant.packageQuantity,
            ),

            thumbnail: String(variant.thumbnail || ""),

            image: String(variant.image || ""),
          }))
        : [];

      // =====================================================
      // TÍNH TỔNG TỒN KHO
      // =====================================================

      const totalQty =
        variants.length > 0
          ? variants.reduce((total, variant) => total + variant.qty, 0)
          : normalizeVariantNumber(data.qty);

      // =====================================================
      // CREATE PRODUCT
      // =====================================================

      const product = new Product({
        title: String(data.title || "").trim(),

        price: String(data.price ?? "0"),

        rating: normalizeVariantNumber(data.rating, 5),

        originalPrice: String(data.originalPrice ?? "0"),

        thumbnail: String(data.thumbnail || ""),

        images: Array.isArray(data.images)
          ? data.images.filter((item) => typeof item === "string")
          : [],

        detail: String(data.detail || ""),

        description: String(data.description || ""),

        qty: totalQty,

        stock: String(totalQty),

        brand: String(data.brand || ""),

        categoryId: data.categoryId || null,

        category: String(data.category || ""),

        type: ["1", "2", "3"].includes(String(data.type))
          ? String(data.type)
          : "1",

        compatibleVehicles,

        variants,

        isVisible: data.isVisible !== false,

        created_at: new Date(),

        updated_at: new Date(),
      });

      await product.save();

      return res.status(201).json({
        success: true,
        message: "Thêm sản phẩm thành công",
        product,
      });
    } catch (error) {
      console.error("createProduct:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Không thể thêm sản phẩm",
      });
    }
  },

  // =====================================================
  // GET PRODUCT BY CATEGORY
  // =====================================================
  async getProductByCategory(req, res, next) {
    try {
      const categoryId = req.params.id;

      const products = await Product.find({
        categoryId: categoryId,
      });

      res.status(200).send({
        products,
      });
    } catch (error) {
      res.status(404).send({
        message: error.message,
      });
    }
  },

  // =====================================================
  // SEARCH PRODUCT
  // =====================================================
  async searchProduct(req, res, next) {
    try {
      const search = String(req.query.q || "").trim();

      const isAdmin = req.user?.role === "admin";

      const searchArray = [
        {
          title: {
            $regex: search,
            $options: "i",
          },
        },
      ];

      const filter = {
        $or: searchArray,

        ...(isAdmin
          ? {}
          : {
              isVisible: { $ne: false },
            }),
      };

      const products = await Product.find(filter);

      return res.status(200).send({
        products,
      });
    } catch (error) {
      console.error("searchProduct:", error);

      return res.status(500).send({
        message: error.message,
      });
    }
  },

  // =====================================================
  // UPDATE PRODUCT
  // =====================================================
  // =====================================================
  // UPDATE PRODUCT
  // =====================================================

  // =====================================================
  // UPDATE PRODUCT
  // BẢO VỆ VARIANT CODE, SKU, RESERVED QTY
  // =====================================================

  async updateProductAsync(req, res) {
    try {
      const updates = Array.isArray(req.body) ? req.body : [req.body];

      if (!updates.length) {
        return res.status(400).json({
          success: false,
          message: "Không có dữ liệu cập nhật",
        });
      }

      const allowedFields = [
        "title",
        "images",
        "detail",
        "price",
        "thumbnail",
        "rating",
        "originalPrice",
        "categoryId",
        "stock",
        "brand",
        "description",
        "variants",
        "type",
        "isVisible",
        "compatibleVehicles",
      ];

      const results = await Promise.all(
        updates.map(async (item) => {
          const productId = item._id || item.id;

          if (!productId) {
            throw new Error("Thiếu ID sản phẩm");
          }

          const product = await Product.findById(productId);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm: ${productId}`);
          }

          // =================================================
          // VALIDATE TYPE
          // =================================================

          if (
            item.type !== undefined &&
            !["1", "2", "3"].includes(String(item.type))
          ) {
            throw new Error("Loại sản phẩm không hợp lệ");
          }

          // =================================================
          // UPDATE PRODUCT FIELDS
          // =================================================

          for (const field of allowedFields) {
            if (
              !Object.prototype.hasOwnProperty.call(item, field) ||
              field === "variants"
            ) {
              continue;
            }

            if (field === "compatibleVehicles") {
              product.compatibleVehicles = normalizeCompatibleVehicles(
                item.compatibleVehicles,
              );
              continue;
            }

            product[field] = item[field];
          }

          // =================================================
          // UPDATE VARIANTS
          // =================================================

          if (Array.isArray(item.variants)) {
            const oldVariants = product.variants || [];
            const incomingVariants = item.variants;

            const usedOldIndexes = new Set();

            const getText = (value) => String(value ?? "").trim();

            const findOldVariant = (incoming, index) => {
              const incomingId = getText(incoming._id);
              const incomingCode = getText(incoming.variantCode);
              const incomingSku = getText(incoming.sku);
              const incomingName = getText(incoming.name);

              // 1. Khớp MongoDB subdocument ID
              if (incomingId) {
                const foundIndex = oldVariants.findIndex(
                  (old, oldIndex) =>
                    !usedOldIndexes.has(oldIndex) &&
                    getText(old._id) === incomingId,
                );

                if (foundIndex !== -1) return foundIndex;
              }

              // 2. Khớp variantCode
              if (incomingCode) {
                const foundIndex = oldVariants.findIndex(
                  (old, oldIndex) =>
                    !usedOldIndexes.has(oldIndex) &&
                    getText(old.variantCode) === incomingCode,
                );

                if (foundIndex !== -1) return foundIndex;
              }

              // 3. Khớp SKU
              if (incomingSku) {
                const foundIndex = oldVariants.findIndex(
                  (old, oldIndex) =>
                    !usedOldIndexes.has(oldIndex) &&
                    getText(old.sku) === incomingSku,
                );

                if (foundIndex !== -1) return foundIndex;
              }

              // 4. Khớp tên chính xác
              if (incomingName) {
                const foundIndex = oldVariants.findIndex(
                  (old, oldIndex) =>
                    !usedOldIndexes.has(oldIndex) &&
                    getText(old.name) === incomingName,
                );

                if (foundIndex !== -1) return foundIndex;
              }

              // 5. Dự phòng khi số lượng variant không đổi
              // Trường hợp đổi tên nhưng FE chưa gửi _id/mã
              if (
                oldVariants.length === incomingVariants.length &&
                oldVariants[index] &&
                !usedOldIndexes.has(index)
              ) {
                return index;
              }

              return -1;
            };

            const newVariants = incomingVariants.map((incoming, index) => {
              const oldIndex = findOldVariant(incoming, index);

              const old = oldIndex !== -1 ? oldVariants[oldIndex] : null;

              if (oldIndex !== -1) {
                usedOldIndexes.add(oldIndex);
              }

              const qty = normalizeVariantNumber(incoming.qty, old?.qty ?? 0);

              const reservedQty = Number(old?.reservedQty || 0);

              // Không cho tồn kho thấp hơn số lượng đang giữ chỗ
              if (qty < reservedQty) {
                throw new Error(
                  `Variant "${incoming.name || old?.name}" có ${reservedQty} sản phẩm đang giữ chỗ. Không thể cập nhật tồn kho xuống ${qty}.`,
                );
              }

              return {
                // Giữ ID subdocument cũ
                ...(old?._id ? { _id: old._id } : {}),

                name: incoming.name ?? old?.name ?? "",

                // Mã cũ luôn được ưu tiên
                // Variant mới không nhận mã từ FE
                ...(old
                  ? {
                      variantCode: old.variantCode,
                      sku: old.sku,
                    }
                  : {}),

                price: incoming.price ?? old?.price ?? "0",

                defaultPrice: incoming.defaultPrice ?? old?.defaultPrice ?? "0",

                unitCost: normalizeVariantNumber(
                  incoming.unitCost,
                  old?.unitCost ?? 0,
                ),

                qty,

                // Chỉ hệ thống đơn hàng được quản lý reservedQty
                reservedQty,

                weight: normalizeVariantNumber(
                  incoming.weight,
                  old?.weight ?? 0,
                ),

                packageQuantity: normalizeVariantPackageQuantity(
                  incoming.packageQuantity ?? old?.packageQuantity,
                ),

                thumbnail: incoming.thumbnail ?? old?.thumbnail ?? "",

                image: incoming.image ?? old?.image ?? "",
              };
            });

            // =================================================
            // KIỂM TRA VARIANT BỊ XÓA
            // =================================================

            for (let i = 0; i < oldVariants.length; i++) {
              if (usedOldIndexes.has(i)) continue;

              const old = oldVariants[i];
              const reservedQty = Number(old.reservedQty || 0);

              if (reservedQty > 0) {
                throw new Error(
                  `Không thể xóa variant "${old.name}" vì đang có ${reservedQty} sản phẩm được giữ chỗ.`,
                );
              }
            }

            // =================================================
            // SAVE VARIANTS
            // =================================================

            product.variants = newVariants;

            // Tổng tồn kho theo variants
            product.qty = newVariants.reduce(
              (total, variant) => total + (Number(variant.qty) || 0),
              0,
            );

            product.stock = String(product.qty);
          }

          product.updated_at = new Date();

          await product.save();

          return product;
        }),
      );

      return res.status(200).json({
        success: true,
        message: "Cập nhật sản phẩm thành công",
        products: results,
      });
    } catch (error) {
      console.error("Update product error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Lỗi cập nhật sản phẩm",
      });
    }
  },
  // =====================================================
  // DELETE PRODUCT
  // =====================================================
  async deleteProductAsync(req, res) {
    try {
      const { id } = req.params;

      const product = await Product.findById(id);

      if (!product) {
        return res.status(404).json({
          message: "Không tìm thấy sản phẩm",
        });
      }

      await Product.findByIdAndDelete(id);

      return res.json({
        message: "Xóa sản phẩm thành công",
        productId: id,
      });
    } catch (error) {
      console.error("Delete product error:", error);

      return res.status(500).json({
        message: "Không thể xóa sản phẩm",
        error: error.message,
      });
    }
  },

  // =====================================================
  // TOP SELLING PRODUCTS
  // =====================================================
  async getTopSellingProductsAsync(req, res) {
    try {
      let limit = Number(req.query.limit || 30);

      if (!Number.isFinite(limit) || limit <= 0) {
        limit = 30;
      }

      limit = Math.min(limit, 100);

      const products = await Product.find({
        soldQty: { $gt: 0 },
      })
        .sort({
          soldQty: -1,
          updated_at: -1,
        })
        .limit(limit)
        .lean();

      const result = products.map((product) => {
        const soldQty = Number(product.soldQty || 0);

        const price = Number(product.price || 0);

        return {
          ...product,

          soldQty,

          soldCount: soldQty,

          revenue: soldQty * price,
        };
      });

      return res.status(200).json({
        success: true,
        total: result.length,
        products: result,
      });
    } catch (error) {
      console.error("❌ getTopSellingProductsAsync:", error);

      return res.status(500).json({
        success: false,
        message: "Không thể lấy danh sách sản phẩm bán chạy",
        error: error.message,
      });
    }
  },

  // =====================================================
  // UPDATE ALL RATING
  // =====================================================
  async updateAllProductsRatingAsync(req, res) {
    try {
      const result = await Product.updateMany(
        {},
        {
          $set: {
            rating: 5,
          },
        },
      );

      return res.status(200).json({
        success: true,
        message: "Đã cập nhật rating = 5 cho toàn bộ sản phẩm",
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
    } catch (error) {
      console.error("❌ updateAllProductsRatingAsync:", error);

      return res.status(500).json({
        success: false,
        message: "Không thể cập nhật rating",
        error: error.message,
      });
    }
  },
};

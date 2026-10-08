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
  async createProduct(req, res) {
    try {
      const data = req.body;

      // =====================================================
      // COMPATIBLE VEHICLES
      // Luôn lưu dạng array
      // =====================================================
      const compatibleVehicles = normalizeCompatibleVehicles(
        data.compatibleVehicles,
      );

      // =====================================================
      // VARIANTS
      // =====================================================
      const variants = Array.isArray(data.variants)
        ? data.variants.map((variant) => ({
            name: variant.name || "",

            price: String(variant.price || "0"),

            defaultPrice: String(variant.defaultPrice || "0"),

            qty: Number(variant.qty || 0),

            // =====================================
            // CÂN NẶNG VARIANT - KG
            // =====================================
            weight: Number(variant.weight || 0),
          }))
        : [];

      // =====================================================
      // TÍNH QTY TỪ VARIANTS
      // =====================================================
      const totalQty = variants.reduce((total, variant) => {
        return total + (Number(variant.qty) || 0);
      }, 0);

      // =====================================================
      // CREATE
      // =====================================================
      const product = new Product({
        title: data.title,

        price: data.price || "0",

        rating: Number(data.rating || 0),

        originalPrice: data.originalPrice || "",

        thumbnail: data.thumbnail || "",

        images: Array.isArray(data.images) ? data.images : [],

        detail: data.detail || "",

        description: data.description || "",

        qty: totalQty,

        stock: data.stock !== undefined ? data.stock : String(totalQty),

        brand: data.brand || "",

        categoryId: data.categoryId || null,

        category: data.category || "",

        type: data.type || "1",

        // =================================================
        // XE TƯƠNG THÍCH
        // =================================================
        compatibleVehicles,

        // =================================================
        // VARIANTS
        // =================================================
        variants,

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
  async updateProductAsync(req, res, next) {
    try {
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

        // =================================================
        // XE TƯƠNG THÍCH
        // =================================================
        "compatibleVehicles",
      ];

      // =====================================================
      // KIỂM TRA ARRAY
      // =====================================================
      if (!Array.isArray(req.body)) {
        return res.status(400).json({
          success: false,
          message: "Dữ liệu cập nhật phải là một mảng sản phẩm",
        });
      }

      await Promise.all(
        req.body.map(async (productData) => {
          // =================================================
          // FIND PRODUCT
          // =================================================
          const product = await Product.findById(productData._id);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm: ${productData._id}`);
          }

          // ================================================
          // KIỂM TRA TYPE
          // ================================================
          if (
            productData.type !== undefined &&
            !["1", "2", "3"].includes(String(productData.type))
          ) {
            throw new Error(
              `Type không hợp lệ cho sản phẩm: ${productData._id}. Type phải là 1, 2 hoặc 3`,
            );
          }

          // ================================================
          // CẬP NHẬT FIELD
          // ================================================
          allowedFields.forEach((field) => {
            if (productData[field] !== undefined) {
              product[field] = productData[field];
            }
          });

          // ================================================
          // CHUẨN HÓA TYPE
          // ================================================
          if (productData.type !== undefined) {
            product.type = String(productData.type);
          }

          // ================================================
          // CHUẨN HÓA XE TƯƠNG THÍCH
          // ================================================
          if (productData.compatibleVehicles !== undefined) {
            product.compatibleVehicles = normalizeCompatibleVehicles(
              productData.compatibleVehicles,
            );
          }

          // ================================================
          // CHUẨN HÓA VARIANTS
          // ================================================
          if (Array.isArray(productData.variants)) {
            product.variants = productData.variants.map((variant) => ({
              name: variant.name || "",

              price: String(variant.price || "0"),

              defaultPrice: String(variant.defaultPrice || "0"),

              qty: Number(variant.qty || 0),

              // ==========================================
              // CÂN NẶNG VARIANT - KG
              // ==========================================
              weight: Number(variant.weight || 0),
            }));
          }

          // ================================================
          // TỰ ĐỘNG TÍNH TỔNG QTY
          // ================================================
          if (Array.isArray(product.variants)) {
            product.qty = product.variants.reduce((total, variant) => {
              return total + (Number(variant.qty) || 0);
            }, 0);
          }

          // ================================================
          // UPDATED AT
          // ================================================
          product.updated_at = new Date();
          await product.save();
        }),
      );

      return res.status(200).json({
        success: true,
        message: "Successfully updated products",
        total: req.body.length,
      });
    } catch (error) {
      console.error("updateProductAsync:", error);

      return res.status(500).json({
        success: false,
        message: error.message,
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

const mongoose = require("mongoose");

const { Product } = require("../models/products");
const InventoryReceipt = require("../models/inventoryReceipt");
const InventoryHistory = require("../models/inventoryHistory");

// =====================================================
// HELPER
// =====================================================

const toNumber = (value) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
};

const getProductCode = (product) => {
  return (
    product?.code ||
    product?.productCode ||
    product?.sku ||
    product?.product_code ||
    ""
  );
};

// =====================================================
// TẠO MÃ PHIẾU NHẬP
// NK + YYMMDD + 3 SỐ
// Ví dụ: NK260926001
// =====================================================

const generateReceiptCode = async (session) => {
  const now = new Date();

  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  const prefix = `NK${yy}${mm}${dd}`;

  const lastReceipt = await InventoryReceipt.findOne({
    code: {
      $regex: `^${prefix}`,
    },
  })
    .sort({
      code: -1,
    })
    .session(session)
    .lean();

  let number = 1;

  if (lastReceipt?.code) {
    const lastNumber = Number(lastReceipt.code.slice(-3));

    if (Number.isFinite(lastNumber)) {
      number = lastNumber + 1;
    }
  }

  return `${prefix}${String(number).padStart(3, "0")}`;
};

// =====================================================
// POST /api/inventory
// NHẬP KHO
// =====================================================

const createInventoryReceiptAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { supplier = "", note = "", items = [] } = req.body || {};

    // =================================================
    // VALIDATE REQUEST
    // =================================================

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Danh sách sản phẩm nhập kho không được để trống",
      });
    }

    // =================================================
    // START TRANSACTION
    // =================================================

    let receipt = null;

    await session.withTransaction(async () => {
      // ===============================================
      // TẠO MÃ PHIẾU
      // ===============================================

      const receiptCode = await generateReceiptCode(session);

      // ===============================================
      // CACHE PRODUCT
      // ===============================================

      const productCache = new Map();

      // ===============================================
      // PASS 1
      // KIỂM TRA TẤT CẢ SẢN PHẨM
      // ===============================================

      for (const item of items) {
        if (!item?.productId) {
          throw new Error("Sản phẩm không hợp lệ");
        }

        if (!mongoose.Types.ObjectId.isValid(item.productId)) {
          throw new Error(`productId không hợp lệ: ${item.productId}`);
        }

        const qty = toNumber(item.qty);

        const unitCost = toNumber(item.unitCost);

        if (qty <= 0) {
          throw new Error(`Số lượng nhập phải lớn hơn 0`);
        }

        if (unitCost < 0) {
          throw new Error(`Giá nhập không hợp lệ`);
        }

        const productId = String(item.productId);

        let product = productCache.get(productId);

        if (!product) {
          product = await Product.findById(item.productId).session(session);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
          }

          productCache.set(productId, product);
        }

        // =============================================
        // KIỂM TRA VARIANT
        // =============================================

        const variantName = String(item.variantName || "").trim();

        if (variantName) {
          const variant = product.variants?.find(
            (v) => String(v?.name || "").trim() === variantName,
          );

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${variantName}" của sản phẩm "${product.title}"`,
            );
          }
        }
      }

      // ===============================================
      // PASS 2
      // TĂNG TỒN KHO + TẠO HISTORY
      // ===============================================

      const receiptItems = [];

      let totalQty = 0;
      let totalAmount = 0;

      for (const item of items) {
        const product = productCache.get(String(item.productId));

        if (!product) {
          throw new Error("Không tìm thấy sản phẩm");
        }

        const qty = toNumber(item.qty);

        const unitCost = toNumber(item.unitCost);

        const variantName = String(item.variantName || "").trim();

        const productCode = getProductCode(product);

        const itemTotal = qty * unitCost;

        totalQty += qty;
        totalAmount += itemTotal;

        // =============================================
        // CÓ VARIANT
        // =============================================

        if (variantName) {
          const variant = product.variants?.find(
            (v) => String(v?.name || "").trim() === variantName,
          );

          if (!variant) {
            throw new Error(`Không tìm thấy variant "${variantName}"`);
          }

          // -------------------------------------------
          // TỒN VARIANT
          // -------------------------------------------

          const beforeVariantQty = toNumber(variant.qty);

          const afterVariantQty = beforeVariantQty + qty;

          variant.qty = afterVariantQty;

          // -------------------------------------------
          // TỔNG TỒN PRODUCT
          // -------------------------------------------

          const beforeProductQty = toNumber(product.qty);

          const afterProductQty = beforeProductQty + qty;

          product.qty = afterProductQty;

          product.updated_at = new Date();

          await product.save({
            session,
          });

          // -------------------------------------------
          // ITEM PHIẾU NHẬP
          // -------------------------------------------

          receiptItems.push({
            productId: product._id,

            productTitle: product.title || "",

            variantName,

            qty,

            unitCost,

            total: itemTotal,
          });

          // -------------------------------------------
          // INVENTORY HISTORY
          // -------------------------------------------

          await InventoryHistory.create(
            [
              {
                type: "import",

                referenceType: "InventoryReceipt",

                referenceId: null,

                referenceCode: receiptCode,

                productId: product._id,

                productTitle: product.title || "",

                productCode,

                variantName,

                qty,

                beforeQty: beforeVariantQty,

                afterQty: afterVariantQty,

                note: note || `Nhập kho theo phiếu ${receiptCode}`,

                createdBy: req.user?._id || null,

                created_at: new Date(),
              },
            ],
            {
              session,
            },
          );
        }

        // =============================================
        // KHÔNG CÓ VARIANT
        // =============================================
        else {
          const beforeQty = toNumber(product.qty);

          const afterQty = beforeQty + qty;

          product.qty = afterQty;

          product.updated_at = new Date();

          await product.save({
            session,
          });

          // -------------------------------------------
          // ITEM PHIẾU NHẬP
          // -------------------------------------------

          receiptItems.push({
            productId: product._id,

            productTitle: product.title || "",

            variantName: "",

            qty,

            unitCost,

            total: itemTotal,
          });

          // -------------------------------------------
          // INVENTORY HISTORY
          // -------------------------------------------

          await InventoryHistory.create(
            [
              {
                type: "import",

                referenceType: "InventoryReceipt",

                referenceId: null,

                referenceCode: receiptCode,

                productId: product._id,

                productTitle: product.title || "",

                productCode,

                variantName: "",

                qty,

                beforeQty,

                afterQty,

                note: note || `Nhập kho theo phiếu ${receiptCode}`,

                createdBy: req.user?._id || null,

                created_at: new Date(),
              },
            ],
            {
              session,
            },
          );
        }
      }

      // ===============================================
      // TẠO INVENTORY RECEIPT
      // ===============================================

      const created = await InventoryReceipt.create(
        [
          {
            code: receiptCode,

            supplier: String(supplier || "").trim(),

            note: String(note || "").trim(),

            items: receiptItems,

            totalQty,

            totalAmount,

            status: "completed",

            createdBy: req.user?._id || null,

            created_at: new Date(),

            updated_at: new Date(),
          },
        ],
        {
          session,
        },
      );

      receipt = created[0];

      // ===============================================
      // UPDATE HISTORY REFERENCE ID
      // ===============================================

      await InventoryHistory.updateMany(
        {
          referenceType: "InventoryReceipt",

          referenceCode: receiptCode,

          referenceId: null,
        },
        {
          $set: {
            referenceId: receipt._id,
          },
        },
        {
          session,
        },
      );
    });

    // =================================================
    // RESPONSE
    // =================================================

    return res.status(201).json({
      success: true,

      message: "Nhập kho thành công",

      receipt,
    });
  } catch (error) {
    console.error("createInventoryReceiptAsync:", error);

    return res.status(400).json({
      success: false,

      message: error?.message || "Không thể nhập kho",
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// GET /api/inventory
// DANH SÁCH PHIẾU NHẬP
// =====================================================

const listInventoryReceiptsAsync = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "" } = req.query;

    const currentPage = Math.max(Number(page) || 1, 1);

    const currentLimit = Math.min(Number(limit) || 20, 100);

    const skip = (currentPage - 1) * currentLimit;

    const filter = {};

    const keyword = String(search || "").trim();

    // ===============================================
    // SEARCH
    // ===============================================

    if (keyword) {
      filter.$or = [
        {
          code: {
            $regex: keyword,
            $options: "i",
          },
        },

        {
          supplier: {
            $regex: keyword,
            $options: "i",
          },
        },

        {
          note: {
            $regex: keyword,
            $options: "i",
          },
        },

        {
          "items.productTitle": {
            $regex: keyword,
            $options: "i",
          },
        },

        {
          "items.variantName": {
            $regex: keyword,
            $options: "i",
          },
        },
      ];
    }

    const [receipts, total] = await Promise.all([
      InventoryReceipt.find(filter)
        .sort({
          created_at: -1,
        })
        .skip(skip)
        .limit(currentLimit)
        .lean(),

      InventoryReceipt.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil(total / currentLimit), 1);

    return res.status(200).json({
      success: true,

      receipts,

      total,

      page: currentPage,

      limit: currentLimit,

      totalPages,

      hasMore: currentPage < totalPages,
    });
  } catch (error) {
    console.error("listInventoryReceiptsAsync:", error);

    return res.status(500).json({
      success: false,

      message: error?.message || "Không thể lấy danh sách phiếu nhập",
    });
  }
};

// =====================================================
// GET /api/inventory/:id
// CHI TIẾT PHIẾU NHẬP
// =====================================================

const getInventoryReceiptDetailAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,

        message: "ID phiếu nhập không hợp lệ",
      });
    }

    const receipt = await InventoryReceipt.findById(id)
      .populate("createdBy", "username name")
      .lean();

    if (!receipt) {
      return res.status(404).json({
        success: false,

        message: "Không tìm thấy phiếu nhập",
      });
    }

    return res.status(200).json({
      success: true,

      receipt,
    });
  } catch (error) {
    console.error("getInventoryReceiptDetailAsync:", error);

    return res.status(500).json({
      success: false,

      message: error?.message || "Không thể lấy chi tiết phiếu nhập",
    });
  }
};

module.exports = {
  createInventoryReceiptAsync,
  listInventoryReceiptsAsync,
  getInventoryReceiptDetailAsync,
};

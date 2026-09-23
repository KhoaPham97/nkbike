const mongoose = require("mongoose");

const { Product } = require("../models/products");
const InventoryReceipt = require("../models/InventoryReceipt");

// ============================================================
// TẠO MÃ PHIẾU NHẬP
// VD: NK260923001
// ============================================================
const generateReceiptCode = async () => {
  const now = new Date();

  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  const prefix = `NK${year}${month}${day}`;

  const count = await InventoryReceipt.countDocuments({
    code: {
      $regex: `^${prefix}`,
    },
  });

  const number = String(count + 1).padStart(3, "0");

  return `${prefix}${number}`;
};

// ============================================================
// NHẬP KHO
// POST /api/products/inventory/import
// ============================================================
const importInventoryAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { supplier = "", note = "", items = [] } = req.body;

    // --------------------------------------------------------
    // VALIDATE
    // --------------------------------------------------------
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Phiếu nhập chưa có sản phẩm",
      });
    }

    // --------------------------------------------------------
    // KIỂM TRA TẤT CẢ ITEM
    // --------------------------------------------------------
    const receiptItems = [];

    let totalQty = 0;
    let totalAmount = 0;

    for (const item of items) {
      const { productId, variantName = "", qty, unitCost = 0 } = item;

      // ------------------------------------------------------
      // CHECK PRODUCT ID
      // ------------------------------------------------------
      if (!productId) {
        return res.status(400).json({
          success: false,
          message: "Thiếu productId",
        });
      }

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        return res.status(400).json({
          success: false,
          message: `productId không hợp lệ: ${productId}`,
        });
      }

      // ------------------------------------------------------
      // CHECK QTY
      // ------------------------------------------------------
      const quantity = Number(qty);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: "Số lượng nhập phải lớn hơn 0",
        });
      }

      // ------------------------------------------------------
      // CHECK PRICE
      // ------------------------------------------------------
      const cost = Number(unitCost || 0);

      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(400).json({
          success: false,
          message: "Giá nhập không hợp lệ",
        });
      }

      // ------------------------------------------------------
      // FIND PRODUCT
      // ------------------------------------------------------
      const product = await Product.findById(productId).session(session);

      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Không tìm thấy sản phẩm ${productId}`,
        });
      }

      // ------------------------------------------------------
      // CHECK VARIANT
      // ------------------------------------------------------
      let variant = null;

      if (variantName) {
        variant = product.variants?.find((item) => item.name === variantName);

        if (!variant) {
          return res.status(400).json({
            success: false,
            message: `Sản phẩm "${product.title}" không có phân loại "${variantName}"`,
          });
        }
      }

      const total = quantity * cost;

      receiptItems.push({
        productId: product._id,
        productTitle: product.title || "",
        variantName: variantName || "",
        qty: quantity,
        unitCost: cost,
        total,
      });

      totalQty += quantity;
      totalAmount += total;
    }

    // --------------------------------------------------------
    // START TRANSACTION
    // --------------------------------------------------------
    session.startTransaction();

    // --------------------------------------------------------
    // CỘNG TỒN KHO
    // --------------------------------------------------------
    for (const item of receiptItems) {
      const product = await Product.findById(item.productId).session(session);

      if (!product) {
        throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
      }

      // ------------------------------------------------------
      // CÓ VARIANT
      // ------------------------------------------------------
      if (item.variantName) {
        const variantIndex = product.variants.findIndex(
          (variant) => variant.name === item.variantName,
        );

        if (variantIndex === -1) {
          throw new Error(
            `Không tìm thấy variant "${item.variantName}" của ${product.title}`,
          );
        }

        const currentQty = Number(product.variants[variantIndex].qty || 0);

        product.variants[variantIndex].qty = currentQty + item.qty;

        // Cập nhật tổng qty sản phẩm
        product.qty = product.variants.reduce(
          (sum, variant) => sum + Number(variant.qty || 0),
          0,
        );
      }

      // ------------------------------------------------------
      // KHÔNG CÓ VARIANT
      // ------------------------------------------------------
      else {
        product.qty = Number(product.qty || 0) + item.qty;
      }

      product.updated_at = new Date();

      await product.save({
        session,
      });
    }

    // --------------------------------------------------------
    // TẠO MÃ PHIẾU
    // --------------------------------------------------------
    const code = await generateReceiptCode();

    // --------------------------------------------------------
    // TẠO PHIẾU NHẬP
    // --------------------------------------------------------
    const receipt = await InventoryReceipt.create(
      [
        {
          code,

          supplier: String(supplier || "").trim(),

          note: String(note || "").trim(),

          items: receiptItems,

          totalQty,

          totalAmount,

          status: "completed",

          createdBy: req.user?.id || req.user?._id || null,

          created_at: new Date(),

          updated_at: new Date(),
        },
      ],
      {
        session,
      },
    );

    // --------------------------------------------------------
    // COMMIT
    // --------------------------------------------------------
    await session.commitTransaction();

    return res.status(201).json({
      success: true,

      message: "Nhập kho thành công",

      receipt: receipt[0],
    });
  } catch (error) {
    // --------------------------------------------------------
    // ROLLBACK
    // --------------------------------------------------------
    try {
      await session.abortTransaction();
    } catch (e) {}

    console.error("importInventoryAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Không thể nhập kho",
    });
  } finally {
    await session.endSession();
  }
};

// ============================================================
// DANH SÁCH PHIẾU NHẬP
// GET /api/products/inventory/import
// ============================================================
const listInventoryImportsAsync = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const skip = (page - 1) * limit;

    const search = String(req.query.search || "").trim();

    const filter = {};

    if (search) {
      filter.$or = [
        {
          code: {
            $regex: search,
            $options: "i",
          },
        },
        {
          supplier: {
            $regex: search,
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
        .limit(limit)
        .lean(),

      InventoryReceipt.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,

      receipts,

      total,

      page,

      limit,

      totalPages: Math.ceil(total / limit),

      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error("listInventoryImportsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách phiếu nhập",
    });
  }
};

// ============================================================
// CHI TIẾT PHIẾU NHẬP
// GET /api/products/inventory/import/:id
// ============================================================
const getInventoryImportAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID phiếu nhập không hợp lệ",
      });
    }

    const receipt = await InventoryReceipt.findById(id)
      .populate("createdBy", "username")
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
    console.error("getInventoryImportAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy phiếu nhập",
    });
  }
};

module.exports = {
  importInventoryAsync,
  listInventoryImportsAsync,
  getInventoryImportAsync,
};

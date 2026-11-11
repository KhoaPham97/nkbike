const mongoose = require("mongoose");

const { Product } = require("../models/products");
const InventoryReceipt = require("../models/InventoryReceipt");
const InventoryHistory = require("../models/inventoryHistory");
const ImportDraft = require("../models/ImportDraft");
const InventoryBatch = require("../models/InventoryBatch");
const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getProductCode = (product) =>
  product?.code ||
  product?.productCode ||
  product?.sku ||
  product?.product_code ||
  "";

const getProductTitle = (product) =>
  product?.title || product?.name || product?.productTitle || "";

const getProductImage = (product) =>
  product?.thumbnail || product?.image || product?.images?.[0] || "";

const getUserId = (req) => req.user?._id || req.user?.id || null;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const generateReceiptCode = async (session) => {
  const now = new Date();
  const date = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");

  const prefix = `NK${date}`;

  const latest = await InventoryReceipt.findOne({
    code: { $regex: `^${prefix}` },
  })
    .sort({ code: -1 })
    .session(session)
    .lean();

  const lastNumber = latest
    ? Number(String(latest.code).slice(prefix.length)) || 0
    : 0;

  return `${prefix}${String(lastNumber + 1).padStart(3, "0")}`;
};

const generateDraftCode = () => {
  const now = new Date();
  const date = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");

  return `NKD${date}${new mongoose.Types.ObjectId()
    .toString()
    .slice(-5)
    .toUpperCase()}`;
};

const normalizeDraftItems = (items = []) => {
  if (!Array.isArray(items)) {
    throw new Error("Danh sách sản phẩm không hợp lệ");
  }

  return items.map((item) => {
    const qty = toNumber(item.qty);
    const unitCost = toNumber(item.unitCost);

    if (!item.productId || !isValidObjectId(item.productId)) {
      throw new Error("Sản phẩm có ID không hợp lệ");
    }

    if (qty < 0 || unitCost < 0) {
      throw new Error("Số lượng và giá vốn không được âm");
    }

    return {
      productId: item.productId,
      productTitle: item.productTitle || "",
      productCode: item.productCode || "",
      thumbnail: item.thumbnail || "",
      variantName: item.variantName || "",
      qty,
      unitCost,
      total: qty * unitCost,
      currentQty: toNumber(item.currentQty),
    };
  });
};

const calculateDraftTotals = (items = []) => ({
  totalQty: items.reduce((sum, item) => sum + toNumber(item.qty), 0),
  totalAmount: items.reduce(
    (sum, item) => sum + toNumber(item.qty) * toNumber(item.unitCost),
    0,
  ),
});

/* =========================================================
   TẠO PHIẾU NHẬP NHÁP
   POST /api/inventory/import-drafts
========================================================= */
const createImportDraftAsync = async (req, res) => {
  try {
    const { supplier = "", note = "", items = [] } = req.body;

    const normalizedItems = normalizeDraftItems(items);
    const totals = calculateDraftTotals(normalizedItems);

    const draft = await ImportDraft.create({
      code: generateDraftCode(),
      supplier,
      note,
      items: normalizedItems,
      ...totals,
      status: "draft",
      createdBy: getUserId(req),
      updatedBy: getUserId(req),
    });

    return res.status(201).json({
      success: true,
      message: "Đã lưu phiếu nhập nháp",
      draft,
    });
  } catch (error) {
    console.error("createImportDraftAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể lưu phiếu nháp",
    });
  }
};

/* =========================================================
   DANH SÁCH PHIẾU NHẬP NHÁP
   GET /api/inventory/import-drafts
========================================================= */
const listImportDraftsAsync = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search || "").trim();
    const status = req.query.status || "draft";

    const filter = {};

    if (status !== "all") {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { code: { $regex: search, $options: "i" } },
        { supplier: { $regex: search, $options: "i" } },
        { note: { $regex: search, $options: "i" } },
        { "items.productTitle": { $regex: search, $options: "i" } },
        { "items.productCode": { $regex: search, $options: "i" } },
      ];
    }

    const [drafts, total] = await Promise.all([
      ImportDraft.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ImportDraft.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      drafts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("listImportDraftsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách phiếu nháp",
    });
  }
};

/* =========================================================
   CHI TIẾT PHIẾU NHẬP NHÁP
   GET /api/inventory/import-drafts/:id
========================================================= */
const getImportDraftDetailAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "ID phiếu nháp không hợp lệ",
      });
    }

    const draft = await ImportDraft.findById(id).lean();

    if (!draft) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy phiếu nháp",
      });
    }

    return res.json({
      success: true,
      draft,
    });
  } catch (error) {
    console.error("getImportDraftDetailAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết phiếu nháp",
    });
  }
};

/* =========================================================
   CẬP NHẬT PHIẾU NHẬP NHÁP
   PUT /api/inventory/import-drafts/:id
========================================================= */
const updateImportDraftAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "ID phiếu nháp không hợp lệ",
      });
    }

    const { supplier = "", note = "", items = [] } = req.body;

    const normalizedItems = normalizeDraftItems(items);
    const totals = calculateDraftTotals(normalizedItems);

    const draft = await ImportDraft.findOneAndUpdate(
      { _id: id, status: "draft" },
      {
        $set: {
          supplier,
          note,
          items: normalizedItems,
          ...totals,
          updatedBy: getUserId(req),
        },
      },
      { new: true, runValidators: true },
    );

    if (!draft) {
      return res.status(404).json({
        success: false,
        message: "Phiếu nháp không tồn tại hoặc đã nhập kho",
      });
    }

    return res.json({
      success: true,
      message: "Đã cập nhật phiếu nháp",
      draft,
    });
  } catch (error) {
    console.error("updateImportDraftAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể cập nhật phiếu nháp",
    });
  }
};

/* =========================================================
   XÓA PHIẾU NHẬP NHÁP
   DELETE /api/inventory/import-drafts/:id
========================================================= */
const deleteImportDraftAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "ID phiếu nháp không hợp lệ",
      });
    }

    const draft = await ImportDraft.findOneAndDelete({
      _id: id,
      status: "draft",
    });

    if (!draft) {
      return res.status(404).json({
        success: false,
        message: "Phiếu không tồn tại hoặc đã nhập kho, không thể xóa",
      });
    }

    return res.json({
      success: true,
      message: "Đã xóa phiếu nháp",
    });
  } catch (error) {
    console.error("deleteImportDraftAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể xóa phiếu nháp",
    });
  }
};

/* =========================================================
   NHẬP KHO CHÍNH THỨC
   POST /api/inventory/batch-import-multiple

   Nếu body có draftId:
   - Kiểm tra phiếu nháp còn trạng thái draft
   - Thực hiện nhập kho
   - Đánh dấu phiếu nháp completed trong transaction
========================================================= */
const createInventoryReceiptAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { supplier = "", note = "", items = [], draftId = null } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng thêm ít nhất một sản phẩm",
      });
    }

    if (draftId && !isValidObjectId(draftId)) {
      return res.status(400).json({
        success: false,
        message: "ID phiếu nháp không hợp lệ",
      });
    }

    let receiptResult = null;

    await session.withTransaction(async () => {
      let draft = null;

      if (draftId) {
        draft = await ImportDraft.findOne({
          _id: draftId,
          status: "draft",
        }).session(session);

        if (!draft) {
          throw new Error("Phiếu nháp đã được nhập hoặc không tồn tại");
        }
      }

      const code = await generateReceiptCode(session);
      const productCache = new Map();
      const normalized = [];

      // 1. Kiểm tra toàn bộ dữ liệu trước khi thay đổi kho.
      for (const item of items) {
        const productId = item.productId;
        const qty = toNumber(item.qty);
        const unitCost = toNumber(item.unitCost);
        const variantName = String(item.variantName || "").trim();

        if (!productId || !isValidObjectId(productId)) {
          throw new Error("Sản phẩm có ID không hợp lệ");
        }

        if (qty <= 0) {
          throw new Error("Số lượng nhập phải lớn hơn 0");
        }

        if (unitCost < 0) {
          throw new Error("Giá vốn không được âm");
        }

        let product = productCache.get(String(productId));

        if (!product) {
          product = await Product.findById(productId).session(session);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${productId}`);
          }

          productCache.set(String(productId), product);
        }

        let variant = null;

        if (variantName) {
          variant = product.variants?.find(
            (v) =>
              String(v.name || "")
                .trim()
                .toLowerCase() === variantName.toLowerCase(),
          );

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${variantName}" của ${getProductTitle(
                product,
              )}`,
            );
          }
        }

        normalized.push({
          product,
          variant,
          productId,
          productTitle: getProductTitle(product),
          productCode: getProductCode(product),
          variantName,
          qty,
          unitCost,
          total: qty * unitCost,
        });
      }

      // 2. Cập nhật tồn kho và tạo phiếu nhập.
      const receiptItems = [];
      const historyIds = [];

      let totalQty = 0;
      let totalAmount = 0;

      for (const item of normalized) {
        const {
          product,
          variant,
          productId,
          productTitle,
          productCode,
          variantName,
          qty,
          unitCost,
          total,
        } = item;

        const beforeQty = variant
          ? toNumber(variant.qty)
          : toNumber(product.qty);

        const afterQty = beforeQty + qty;

        if (variant) {
          variant.qty = afterQty;
          product.qty = toNumber(product.qty) + qty;
          variant.unitCost = unitCost;
        } else {
          product.qty = afterQty;
          product.unitCost = unitCost;
        }

        product.updated_at = new Date();

        await product.save({ session });

        receiptItems.push({
          productId,
          productTitle,
          productCode,
          variantName,
          qty,
          unitCost,
          total,
        });

        totalQty += qty;
        totalAmount += total;

        // Tạo InventoryHistory.
        const [history] = await InventoryHistory.create(
          [
            {
              type: "import",
              referenceType: "InventoryReceipt",
              referenceId: null,
              referenceCode: code,
              productId,
              productTitle,
              productCode,
              variantName,
              qty,
              beforeQty,
              afterQty,
              note: note || `Nhập kho ${code}`,
              createdBy: getUserId(req),
              created_at: new Date(),
            },
          ],
          { session },
        );

        historyIds.push({
          history,
          item,
        });
      }

      // 3. Tạo InventoryReceipt.
      const [receipt] = await InventoryReceipt.create(
        [
          {
            code,
            supplier,
            note,
            items: receiptItems,
            totalQty,
            totalAmount,
            status: "completed",
            createdBy: getUserId(req),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        { session },
      );

      // 4. Tạo InventoryBatch cho từng dòng nhập.
      for (const { history, item } of historyIds) {
        const {
          productId,
          productTitle,
          productCode,
          variantName,
          qty,
          unitCost,
        } = item;

        const batchCode = `${code}-${String(
          historyIds.indexOf(
            historyIds.find((x) => x.history._id.equals(history._id)),
          ) + 1,
        ).padStart(3, "0")}`;

        const [batch] = await InventoryBatch.create(
          [
            {
              batchCode,
              productId,
              productTitle,
              productCode,
              variantName,

              importDate: new Date(),
              importQty: qty,
              remainingQty: qty,

              // Giá vốn lưu bằng CNY.
              unitCost,

              importReceiptId: receipt._id,
              importHistoryId: history._id,

              source: "IMPORT",
              sourceConfidence: "HIGH",

              note: note || `Nhập kho ${code}`,
              createdBy: getUserId(req),
              isActive: true,
            },
          ],
          { session },
        );

        // Liên kết batch với lịch sử nhập.
        await InventoryHistory.updateOne(
          { _id: history._id },
          {
            $set: {
              referenceId: receipt._id,
              batchId: batch._id,
              batchCode: batch.batchCode,
            },
          },
          { session },
        );
      }

      // 5. Hoàn tất phiếu nháp trong cùng transaction.
      if (draftId) {
        const updateResult = await ImportDraft.updateOne(
          {
            _id: draftId,
            status: "draft",
          },
          {
            $set: {
              status: "completed",
              receiptId: receipt._id,
              completedAt: new Date(),
              updatedBy: getUserId(req),
            },
          },
          { session },
        );

        if (updateResult.modifiedCount !== 1) {
          throw new Error("Phiếu nháp đã được xử lý bởi một yêu cầu khác");
        }
      }

      receiptResult = receipt;
    });

    return res.status(201).json({
      success: true,
      message: "Nhập kho và tạo lô hàng thành công",
      receipt: receiptResult,
    });
  } catch (error) {
    console.error("createInventoryReceiptAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể nhập kho",
    });
  } finally {
    await session.endSession();
  }
};
/* =========================================================
   DANH SÁCH PHIẾU NHẬP KHO
========================================================= */
const listInventoryReceiptsAsync = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search || "").trim();

    const filter = {};

    if (search) {
      filter.$or = [
        { code: { $regex: search, $options: "i" } },
        { supplier: { $regex: search, $options: "i" } },
        { note: { $regex: search, $options: "i" } },
        { "items.productTitle": { $regex: search, $options: "i" } },
        { "items.variantName": { $regex: search, $options: "i" } },
      ];
    }

    const [receipts, total] = await Promise.all([
      InventoryReceipt.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("createdBy", "username name")
        .lean(),

      InventoryReceipt.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      receipts,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error("listInventoryReceiptsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách phiếu nhập kho",
    });
  }
};

/* =========================================================
   CHI TIẾT PHIẾU NHẬP KHO
========================================================= */
const getInventoryReceiptDetailAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
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
        message: "Không tìm thấy phiếu nhập kho",
      });
    }

    return res.json({
      success: true,
      receipt,
    });
  } catch (error) {
    console.error("getInventoryReceiptDetailAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết phiếu nhập",
    });
  }
};

/* =========================================================
   ĐỒNG BỘ GIÁ VỐN CŨ TỪ PRODUCT VARIANTS
========================================================= */
const syncZeroCost = async (req, res) => {
  try {
    const receipts = await InventoryReceipt.find({
      status: { $ne: "cancelled" },
    });

    const productIds = [
      ...new Set(
        receipts.flatMap((receipt) =>
          (receipt.items || []).map((item) => String(item.productId)),
        ),
      ),
    ];

    const products = await Product.find({
      _id: { $in: productIds },
    })
      .select("variants")
      .lean();

    const costMap = new Map();

    products.forEach((product) => {
      (product.variants || []).forEach((variant) => {
        const key = `${product._id}_${String(
          variant.name || "",
        ).toLowerCase()}`;

        costMap.set(key, toNumber(variant.unitCost));
      });
    });

    const operations = [];
    let updatedItems = 0;

    for (const receipt of receipts) {
      let changed = false;

      for (const item of receipt.items || []) {
        if (toNumber(item.unitCost) > 0) continue;

        const key = `${item.productId}_${String(
          item.variantName || "",
        ).toLowerCase()}`;

        const cost = costMap.get(key);

        if (cost > 0) {
          item.unitCost = cost;
          item.total = toNumber(item.qty) * cost;
          changed = true;
          updatedItems += 1;
        }
      }

      if (changed) {
        receipt.totalAmount = (receipt.items || []).reduce(
          (sum, item) => sum + toNumber(item.qty) * toNumber(item.unitCost),
          0,
        );

        operations.push({
          updateOne: {
            filter: { _id: receipt._id },
            update: {
              $set: {
                items: receipt.items,
                totalAmount: receipt.totalAmount,
              },
            },
          },
        });
      }
    }

    if (operations.length) {
      await InventoryReceipt.bulkWrite(operations);
    }

    return res.json({
      success: true,
      message: "Đã đồng bộ giá vốn",
      updatedReceipts: operations.length,
      updatedItems,
      currency: "CNY",
    });
  } catch (error) {
    console.error("syncZeroCost:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đồng bộ giá vốn",
    });
  }
};

module.exports = {
  createImportDraftAsync,
  listImportDraftsAsync,
  getImportDraftDetailAsync,
  updateImportDraftAsync,
  deleteImportDraftAsync,

  createInventoryReceiptAsync,
  listInventoryReceiptsAsync,
  getInventoryReceiptDetailAsync,
  syncZeroCost,
};

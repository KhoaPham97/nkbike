const mongoose = require("mongoose");
const crypto = require("crypto");

const InventoryBatch = require("../models/InventoryBatch");
const InventoryHistory = require("../models/inventoryHistory");
const InventoryReceipt = require("../models/InventoryReceipt");
const Order = require("../models/orders");
const { Product } = require("../models/products");

// =====================================================
// COMMON HELPERS
// =====================================================

const n = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const clean = (value) => String(value ?? "").trim();

const normalizeVariantCode = (value) => clean(value);

const normalizeVariantName = (value) => clean(value);

const getVariants = (product) =>
  Array.isArray(product?.variants) ? product.variants : [];

const getCode = (product) =>
  product?.code ||
  product?.productCode ||
  product?.sku ||
  product?.product_code ||
  "";

const hasVariants = (product) => getVariants(product).length > 0;

const findVariant = (product, variantName = "", variantCode = "") => {
  const variants = getVariants(product);
  const code = normalizeVariantCode(variantCode);
  const name = normalizeVariantName(variantName);

  if (code) {
    return (
      variants.find(
        (item) => normalizeVariantCode(item?.variantCode) === code,
      ) || null
    );
  }

  if (!name) return null;

  const matched = variants.filter(
    (item) => normalizeVariantName(item?.name) === name,
  );

  if (matched.length > 1) {
    throw new Error(
      `Tên phân loại "${name}" bị trùng. Vui lòng sử dụng variantCode.`,
    );
  }

  return matched[0] || null;
};

const resolveVariantIdentity = (
  product,
  variantName = "",
  variantCode = "",
) => {
  const name = normalizeVariantName(variantName);
  const code = normalizeVariantCode(variantCode);

  if (!hasVariants(product)) {
    if (name || code) {
      throw new Error("Sản phẩm không có biến thể");
    }

    return {
      variant: null,
      variantName: "",
      variantCode: "",
    };
  }

  if (!name && !code) {
    throw new Error("Vui lòng chọn biến thể sản phẩm");
  }

  const variant = findVariant(product, name, code);

  if (!variant) {
    throw new Error(
      code
        ? `Không tìm thấy biến thể có mã "${code}"`
        : `Không tìm thấy biến thể "${name}"`,
    );
  }

  return {
    variant,
    variantName: normalizeVariantName(variant.name),
    variantCode: normalizeVariantCode(variant.variantCode),
  };
};

const buildBatchVariantFilter = (product, variant) => {
  if (!variant) {
    return {
      $or: [
        {
          variantCode: { $in: ["", null] },
          variantName: { $in: ["", null] },
        },
      ],
    };
  }

  const variantCode = normalizeVariantCode(variant.variantCode);
  const variantName = normalizeVariantName(variant.name);

  if (!variantCode) {
    return { variantName };
  }

  const filter = [{ variantCode }];

  const sameNameCount = getVariants(product).filter(
    (item) => normalizeVariantName(item.name) === variantName,
  ).length;

  if (sameNameCount === 1) {
    filter.push({
      variantCode: { $in: ["", null] },
      variantName,
    });
  }

  return { $or: filter };
};

const buildBatchFilter = ({
  product,
  productId,
  variant,
  activeOnly = true,
  remainingOnly = false,
}) => {
  const filter = { productId };

  if (activeOnly) filter.isActive = { $ne: false };
  if (remainingOnly) filter.remainingQty = { $gt: 0 };

  return {
    ...filter,
    ...buildBatchVariantFilter(product, variant),
  };
};

const generateReceiptCode = async (session, date = new Date()) => {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const prefix = `NK${yy}${mm}${dd}`;

  const lastReceipt = await InventoryReceipt.findOne({
    code: new RegExp(`^${prefix}`),
  })
    .sort({ code: -1 })
    .session(session)
    .lean();

  let nextNumber = 1;

  if (lastReceipt?.code) {
    const lastNumber = Number(lastReceipt.code.slice(prefix.length));
    if (Number.isFinite(lastNumber)) {
      nextNumber = lastNumber + 1;
    }
  }

  return `${prefix}${String(nextNumber).padStart(3, "0")}`;
};

const makeBatchCode = (date = new Date()) => {
  const ymd =
    `${date.getFullYear()}` +
    `${String(date.getMonth() + 1).padStart(2, "0")}` +
    `${String(date.getDate()).padStart(2, "0")}`;

  return `NK${ymd}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
};

const getLegacyVariantIdentity = (product, history) => {
  const variantCode = normalizeVariantCode(history.variantCode);
  const variantName = normalizeVariantName(history.variantName);

  if (!hasVariants(product)) {
    return {
      variantCode: "",
      variantName: "",
    };
  }

  const identity = resolveVariantIdentity(product, variantName, variantCode);

  return {
    variantCode: identity.variantCode,
    variantName: identity.variantName,
  };
};

// =====================================================
// DANH SÁCH LÔ NHẬP
// =====================================================

const listInventoryBatchesAsync = async (req, res) => {
  try {
    const page = Math.max(1, n(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, n(req.query.limit) || 20));
    const search = clean(req.query.search);

    const filter = { isActive: { $ne: false } };

    if (
      req.query.productId &&
      mongoose.Types.ObjectId.isValid(req.query.productId)
    ) {
      filter.productId = req.query.productId;
    }

    if (req.query.variantCode !== undefined) {
      filter.variantCode = clean(req.query.variantCode);
    } else if (req.query.variantName !== undefined) {
      filter.variantName = clean(req.query.variantName);
    }

    if (req.query.source) {
      filter.source = clean(req.query.source).toUpperCase();
    }

    if (req.query.onlyRemaining === "true") {
      filter.remainingQty = { $gt: 0 };
    }

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      filter.$or = [
        { batchCode: rx },
        { productTitle: rx },
        { productCode: rx },
        { variantCode: rx },
        { variantName: rx },
        { note: rx },
      ];
    }

    const [rows, total, summary] = await Promise.all([
      InventoryBatch.find(filter)
        .sort({ importDate: -1, createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      InventoryBatch.countDocuments(filter),

      InventoryBatch.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            batchCount: { $sum: 1 },
            remainingQty: { $sum: "$remainingQty" },
            inventoryValue: {
              $sum: {
                $multiply: ["$remainingQty", "$unitCost"],
              },
            },
          },
        },
      ]),
    ]);

    return res.json({
      success: true,
      batches: rows,
      summary: summary[0] || {
        batchCount: 0,
        remainingQty: 0,
        inventoryValue: 0,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("listInventoryBatchesAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải lô nhập",
    });
  }
};

// =====================================================
// LÔ CỦA MỘT SẢN PHẨM
// =====================================================

const getProductBatchesAsync = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "productId không hợp lệ",
      });
    }

    const product = await Product.findById(productId).select("variants").lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    let variant = null;

    if (
      req.query.variantCode !== undefined ||
      req.query.variantName !== undefined
    ) {
      try {
        const identity = resolveVariantIdentity(
          product,
          req.query.variantName,
          req.query.variantCode,
        );

        variant = identity.variant;
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }
    } else if (hasVariants(product)) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng truyền variantCode hoặc variantName",
      });
    }

    const filter = buildBatchFilter({
      product,
      productId,
      variant,
      remainingOnly: true,
    });

    const batches = await InventoryBatch.find(filter)
      .sort({ importDate: 1, createdAt: 1, _id: 1 })
      .lean();

    const batchesWithAvailability = batches.map((batch) => ({
      ...batch,
      availableQty: Math.max(0, n(batch.remainingQty) - n(batch.reservedQty)),
    }));

    const totalRemaining = batches.reduce(
      (sum, batch) => sum + n(batch.remainingQty),
      0,
    );

    const totalReserved = batches.reduce(
      (sum, batch) => sum + n(batch.reservedQty),
      0,
    );

    return res.json({
      success: true,
      batches: batchesWithAvailability,
      totalRemaining,
      totalReserved,
      totalAvailable: Math.max(0, totalRemaining - totalReserved),
    });
  } catch (error) {
    console.error("getProductBatchesAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải lô sản phẩm",
    });
  }
};

// =====================================================
// LỊCH SỬ CỦA MỘT LÔ
// =====================================================

const getInventoryBatchHistoryAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "batchId không hợp lệ",
      });
    }

    const batch = await InventoryBatch.findById(id).lean();

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy lô",
      });
    }

    const histories = await InventoryHistory.find({ batchId: id })
      .sort({ created_at: -1 })
      .lean();

    return res.json({
      success: true,
      batch,
      histories,
    });
  } catch (error) {
    console.error("getInventoryBatchHistoryAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải lịch sử lô",
    });
  }
};

// =====================================================
// LƯU PHÂN BỔ LÔ CHO ĐƠN - CHƯA TRỪ KHO
// =====================================================

const updateOrderBatchAllocationsAsync = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { items = [] } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "orderId không hợp lệ",
      });
    }

    if (!Array.isArray(items)) {
      throw new Error("items phải là mảng");
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    if (order.stockDeducted) {
      return res.status(409).json({
        success: false,
        message: "Đơn đã trừ kho, không thể đổi phân bổ lô",
      });
    }

    const productCache = new Map();
    const processedItems = new Set();

    for (const input of items) {
      if (!mongoose.Types.ObjectId.isValid(input.productId)) {
        throw new Error("productId không hợp lệ");
      }

      const productId = String(input.productId);
      let product = productCache.get(productId);

      if (!product) {
        product = await Product.findById(productId).select("variants");

        if (!product) {
          throw new Error(`Không tìm thấy sản phẩm ${productId}`);
        }

        productCache.set(productId, product);
      }

      const identity = resolveVariantIdentity(
        product,
        input.variantName,
        input.variantCode,
      );

      const item = order.items.find((row) => {
        if (String(row.productId) !== productId) return false;

        const rowCode = normalizeVariantCode(row.variantCode);

        if (identity.variantCode && rowCode) {
          return rowCode === identity.variantCode;
        }

        return normalizeVariantName(row.variantName) === identity.variantName;
      });

      if (!item) {
        throw new Error(
          `Không tìm thấy sản phẩm/biến thể trong đơn: ${productId}`,
        );
      }

      const itemKey = `${productId}::${identity.variantCode || identity.variantName}`;

      if (processedItems.has(itemKey)) {
        throw new Error("Một sản phẩm/biến thể không được phân bổ lặp lại");
      }

      processedItems.add(itemKey);

      const allocations = Array.isArray(input.batchAllocations)
        ? input.batchAllocations
        : [];

      const seen = new Set();
      let sum = 0;
      const normalized = [];

      for (const allocation of allocations) {
        if (!mongoose.Types.ObjectId.isValid(allocation.batchId)) {
          throw new Error("batchId không hợp lệ");
        }

        const batchId = String(allocation.batchId);

        if (seen.has(batchId)) {
          throw new Error("Một lô không được chọn lặp lại");
        }

        seen.add(batchId);

        const qty = n(allocation.qty);

        if (!Number.isSafeInteger(qty) || qty <= 0) {
          throw new Error("Số lượng phân bổ phải là số nguyên dương");
        }

        const batchFilter = buildBatchFilter({
          product,
          productId: item.productId,
          variant: identity.variant,
        });

        const batch = await InventoryBatch.findOne({
          _id: allocation.batchId,
          ...batchFilter,
        }).lean();

        if (!batch) {
          throw new Error(
            `Lô ${allocation.batchCode || batchId} không thuộc đúng sản phẩm/biến thể`,
          );
        }

        const ownReservedQty = (item.reservedBatchAllocations || [])
          .filter((row) => String(row.batchId) === batchId)
          .reduce((total, row) => total + n(row.qty), 0);
        const availableBatchQty =
          n(batch.remainingQty) - n(batch.reservedQty) + ownReservedQty;

        if (availableBatchQty < qty) {
          throw new Error(
            `Lô ${batch.batchCode} chỉ còn khả dụng ${Math.max(0, availableBatchQty)}`,
          );
        }

        sum += qty;

        normalized.push({
          batchId: batch._id,
          batchCode: batch.batchCode,
          variantCode: identity.variantCode,
          variantName: identity.variantName,
          qty,
          unitCost: n(batch.unitCost),
        });
      }

      if (sum !== n(item.qty)) {
        throw new Error(
          `Phân bổ lô của ${item.productTitle} phải bằng ${item.qty}, hiện là ${sum}`,
        );
      }

      item.variantCode = identity.variantCode;
      item.variantName = identity.variantName;
      item.batchAllocations = normalized;
    }

    order.updated_at = new Date();
    await order.save();

    return res.json({
      success: true,
      message: "Đã lưu phân bổ lô (chưa trừ kho)",
      order,
    });
  } catch (error) {
    console.error("updateOrderBatchAllocationsAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể lưu phân bổ lô",
    });
  }
};

// =====================================================
// XUẤT KHO THEO PHÂN BỔ LÔ THỦ CÔNG
// =====================================================

const deductOrderStockByBatchesAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      throw new Error("orderId không hợp lệ");
    }

    let resultOrder;

    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);

      if (!order) throw new Error("Không tìm thấy đơn hàng");
      if (order.stockDeducted) throw new Error("Đơn hàng đã trừ kho");

      if (order.status === "cancelled") {
        throw new Error("Không thể xuất kho cho đơn đã hủy");
      }

      const productCache = new Map();

      // Đơn đang giữ hàng: giải phóng phần giữ của chính đơn trước khi xuất.
      if (order.stockReserved === true) {
        for (const item of order.items || []) {
          const qty = n(item.qty);
          const productId = String(item.productId);
          let product = productCache.get(productId);

          if (!product) {
            product = await Product.findById(item.productId).session(session);
            if (!product) throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
            productCache.set(productId, product);
          }

          if (n(product.reservedQty) < qty) {
            throw new Error(`Số lượng giữ của "${product.title}" không khớp.`);
          }
          product.reservedQty = n(product.reservedQty) - qty;

          const identity = resolveVariantIdentity(product, item.variantName, item.variantCode);
          if (identity.variant) {
            if (n(identity.variant.reservedQty) < qty) {
              throw new Error(`Số lượng giữ của biến thể "${identity.variant.name}" không khớp.`);
            }
            identity.variant.reservedQty = n(identity.variant.reservedQty) - qty;
          }

          for (const allocation of item.reservedBatchAllocations || []) {
            const batch = await InventoryBatch.findById(allocation.batchId).session(session);
            if (!batch || n(batch.reservedQty) < n(allocation.qty)) {
              throw new Error(`Không thể giải phóng số lượng giữ ở lô ${allocation.batchCode || allocation.batchId}.`);
            }
            batch.reservedQty = n(batch.reservedQty) - n(allocation.qty);
            await batch.save({ session });
          }
          item.reservedBatchAllocations = [];

          await product.save({ session });
        }

        order.stockReserved = false;
        order.stockReservedAt = null;
      }

      for (const item of order.items) {
        const qty = n(item.qty);

        if (!Number.isSafeInteger(qty) || qty <= 0) {
          throw new Error("Số lượng đơn không hợp lệ");
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

        const identity = resolveVariantIdentity(
          product,
          item.variantName,
          item.variantCode,
        );

        const allocations = Array.isArray(item.batchAllocations)
          ? item.batchAllocations
          : [];

        const sum = allocations.reduce((total, row) => total + n(row.qty), 0);

        if (sum !== qty) {
          throw new Error(
            `Đơn ${order.code}: ${item.productTitle} chưa phân bổ đủ lô (${sum}/${qty})`,
          );
        }

        const variant = identity.variant;
        const currentQty = variant ? n(variant.qty) : n(product.qty);
        const reservedQty = variant ? n(variant.reservedQty) : n(product.reservedQty);
        const availableQty = Math.max(0, currentQty - reservedQty);
        const availableProductQty = Math.max(0, n(product.qty) - n(product.reservedQty));

        if (availableProductQty < qty || availableQty < qty) {
          throw new Error(
            `${item.productTitle} chỉ còn khả dụng ${availableQty} (tồn ${currentQty}, đã giữ ${reservedQty}), cần ${qty}`,
          );
        }

        let runningQty = currentQty;

        for (const allocation of allocations) {
          const allocationQty = n(allocation.qty);

          if (!Number.isSafeInteger(allocationQty) || allocationQty <= 0) {
            throw new Error("Số lượng phân bổ lô không hợp lệ");
          }

          const batchFilter = buildBatchFilter({
            product,
            productId: item.productId,
            variant,
          });

          const batch = await InventoryBatch.findOne({
            _id: allocation.batchId,
            ...batchFilter,
          }).session(session);

          if (!batch) {
            throw new Error(
              `Không tìm thấy lô ${allocation.batchCode || allocation.batchId}`,
            );
          }

          const batchAvailableQty = Math.max(
            0,
            n(batch.remainingQty) - n(batch.reservedQty),
          );
          if (batchAvailableQty < allocationQty) {
            throw new Error(
              `Lô ${batch.batchCode} chỉ còn khả dụng ${batchAvailableQty}, cần ${allocationQty}`,
            );
          }

          batch.remainingQty = n(batch.remainingQty) - allocationQty;

          await batch.save({ session });

          await InventoryHistory.create(
            [
              {
                type: "order",
                referenceType: "Order",
                referenceId: order._id,
                referenceCode: order.code || "",
                productId: product._id,
                productTitle: product.title || "",
                productCode: getCode(product),
                variantCode: identity.variantCode,
                variantName: identity.variantName,
                qty: -allocationQty,
                beforeQty: runningQty,
                afterQty: runningQty - allocationQty,
                batchId: batch._id,
                batchCode: batch.batchCode,
                unitCost: n(batch.unitCost),
                note: `Xuất ${allocationQty} từ lô ${batch.batchCode} theo đơn ${order.code}`,
                createdBy: req.user?._id || null,
                rollback: false,
                created_at: new Date(),
              },
            ],
            { session },
          );

          runningQty -= allocationQty;
        }

        if (variant) {
          variant.qty = currentQty - qty;
        }

        product.qty = Math.max(0, n(product.qty) - qty);
        product.soldQty = n(product.soldQty) + qty;
        product.updated_at = new Date();

        item.variantCode = identity.variantCode;
        item.variantName = identity.variantName;

        await product.save({ session });
      }

      order.stockReserved = false;
      order.stockReservedAt = null;
      order.stockDeducted = true;
      order.updated_at = new Date();

      await order.save({ session });

      resultOrder = order;
    });

    return res.json({
      success: true,
      message: "Xuất kho theo lô thành công",
      order: resultOrder,
    });
  } catch (error) {
    console.error("deductOrderStockByBatchesAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể xuất kho theo lô",
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// DỰNG LẠI LÔ TỪ LỊCH SỬ NHẬP/XUẤT CŨ
// =====================================================

const rebuildHistoricalBatchesAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        success: false,
        message: "Gửi confirm:true để xác nhận chạy migration",
      });
    }

    let report;

    await session.withTransaction(async () => {
      const existing = await InventoryBatch.countDocuments({}).session(session);

      if (existing > 0 && req.body?.replace !== true) {
        throw new Error(
          "Đã có dữ liệu lô. Gửi replace:true chỉ khi đã sao lưu và muốn dựng lại toàn bộ.",
        );
      }

      if (existing > 0) {
        await InventoryBatch.deleteMany({}, { session });
      }

      const histories = await InventoryHistory.find({
        $or: [
          { type: "import", qty: { $gt: 0 } },
          {
            type: { $in: ["order", "export", "adjustment", "cancel"] },
            qty: { $ne: 0 },
          },
        ],
        rollback: { $ne: true },
      })
        .sort({ created_at: 1, _id: 1 })
        .session(session)
        .lean();

      const productCache = new Map();

      const getProduct = async (productId) => {
        const key = String(productId);

        if (!productCache.has(key)) {
          productCache.set(
            key,
            await Product.findById(productId).session(session),
          );
        }

        return productCache.get(key);
      };

      const imports = histories.filter(
        (history) => history.type === "import" && n(history.qty) > 0,
      );

      const outbound = histories.filter(
        (history) =>
          ["order", "export", "adjustment"].includes(history.type) &&
          n(history.qty) < 0,
      );

      const normalizedImports = [];
      const normalizedOutbound = [];

      for (const history of imports) {
        const product = await getProduct(history.productId);

        if (!product) continue;

        const identity = getLegacyVariantIdentity(product, history);

        normalizedImports.push({
          ...history,
          variantCode: identity.variantCode,
          variantName: identity.variantName,
        });
      }

      for (const history of outbound) {
        const product = await getProduct(history.productId);

        if (!product) continue;

        const identity = getLegacyVariantIdentity(product, history);

        normalizedOutbound.push({
          ...history,
          variantCode: identity.variantCode,
          variantName: identity.variantName,
        });
      }

      const keyOf = (history) =>
        `${String(history.productId)}::${normalizeVariantCode(history.variantCode) || `NAME:${normalizeVariantName(history.variantName)}`}`;

      const groups = new Map();

      for (const history of normalizedImports) {
        const key = keyOf(history);

        if (!groups.has(key)) groups.set(key, []);

        groups.get(key).push(history);
      }

      const batches = [];

      for (const importRows of groups.values()) {
        for (const history of importRows) {
          const product = await getProduct(history.productId);

          const receiptSuffix =
            clean(history.referenceCode) || String(history._id).slice(-6);

          batches.push({
            batchCode: `H-${receiptSuffix}-${String(history._id).slice(-8)}`,
            productId: history.productId,
            productTitle: history.productTitle || product?.title || "",
            productCode: history.productCode || getCode(product),
            variantCode: normalizeVariantCode(history.variantCode),
            variantName: normalizeVariantName(history.variantName),
            importDate: history.created_at || new Date(),
            importQty: n(history.qty),
            remainingQty: n(history.qty),
            unitCost: n(history.unitCost || history.costPrice || 0),
            importReceiptId:
              history.referenceType === "InventoryReceipt"
                ? history.referenceId
                : null,
            importHistoryId: history._id,
            source: "OTHER",
            sourceConfidence: "high",
            note: `Dựng từ lịch sử nhập ${history.referenceCode || ""}`,
          });
        }
      }

      batches.sort((a, b) => new Date(a.importDate) - new Date(b.importDate));

      const getCurrentGroup = (history) =>
        batches.filter(
          (batch) =>
            String(batch.productId) === String(history.productId) &&
            normalizeVariantCode(batch.variantCode) ===
              normalizeVariantCode(history.variantCode) &&
            normalizeVariantName(batch.variantName) ===
              normalizeVariantName(history.variantName) &&
            new Date(batch.importDate) <= new Date(history.created_at || 0),
        );

      let inferredOutbound = 0;

      for (const history of normalizedOutbound) {
        let remaining = Math.abs(n(history.qty));
        const candidates = getCurrentGroup(history);

        for (const batch of candidates) {
          if (remaining <= 0) break;

          const take = Math.min(n(batch.remainingQty), remaining);

          batch.remainingQty -= take;
          remaining -= take;
        }

        if (remaining > 0) {
          inferredOutbound += remaining;
        }
      }

      const products = await Product.find({}).session(session).lean();

      let openingBatches = 0;
      let discrepancy = 0;

      for (const product of products) {
        const rows = getVariants(product).length
          ? getVariants(product).map((variant) => ({
              variantName: normalizeVariantName(variant.name),
              variantCode: normalizeVariantCode(variant.variantCode),
              qty: n(variant.qty),
            }))
          : [
              {
                variantName: "",
                variantCode: "",
                qty: n(product.qty),
              },
            ];

        for (const row of rows) {
          const related = batches.filter(
            (batch) =>
              String(batch.productId) === String(product._id) &&
              normalizeVariantCode(batch.variantCode) === row.variantCode &&
              normalizeVariantName(batch.variantName) === row.variantName,
          );

          const calculated = related.reduce(
            (sum, batch) => sum + n(batch.remainingQty),
            0,
          );

          const delta = row.qty - calculated;

          discrepancy += Math.abs(delta);

          if (delta > 0) {
            const variantKey =
              row.variantCode ||
              Buffer.from(row.variantName || "BASE")
                .toString("hex")
                .slice(0, 16) ||
              "BASE";

            batches.push({
              batchCode: `OPEN-${String(product._id).slice(-6)}-${variantKey}`,
              productId: product._id,
              productTitle: product.title || "",
              productCode: getCode(product),
              variantCode: row.variantCode,
              variantName: row.variantName,
              importDate: product.created_at || new Date(),
              importQty: delta,
              remainingQty: delta,
              unitCost: 0,
              source: "OPENING",
              sourceConfidence: "low",
              note: "Tồn đầu kỳ chưa xác định được phiếu/lô nhập gốc",
            });

            openingBatches++;
          } else if (delta < 0) {
            let need = Math.abs(delta);

            for (const batch of related) {
              if (need <= 0) break;

              const take = Math.min(n(batch.remainingQty), need);

              batch.remainingQty -= take;
              need -= take;
            }
          }
        }
      }

      const validBatches = batches.filter((batch) => n(batch.importQty) > 0);

      if (validBatches.length) {
        await InventoryBatch.insertMany(validBatches, {
          session,
          ordered: true,
        });
      }

      report = {
        importedHistoryRows: normalizedImports.length,
        outboundHistoryRows: normalizedOutbound.length,
        createdBatches: validBatches.length,
        openingBatches,
        unlinkedHistoricalOutboundQty: inferredOutbound,
        absoluteReconciliationDifferenceBeforeOpening: discrepancy,
        note: "Lịch sử cũ được phân bổ FIFO theo variantCode. Dữ liệu không có mã biến thể chỉ được đối chiếu theo tên nếu tên duy nhất trong Product.",
      };
    });

    return res.json({
      success: true,
      message: "Dựng dữ liệu lô lịch sử hoàn tất",
      report,
    });
  } catch (error) {
    console.error("rebuildHistoricalBatchesAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể dựng lô lịch sử",
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// PHÂN BỔ TỒN KHO HIỆN TẠI VÀO LÔ OPENING
// =====================================================

const backfillCurrentStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        success: false,
        message: "Gửi confirm:true để xác nhận phân bổ tồn kho hiện tại",
      });
    }

    let report;

    await session.withTransaction(async () => {
      const products = await Product.find({}).session(session).lean();

      let createdBatches = 0;
      let updatedBatches = 0;
      let allocatedQty = 0;
      let alreadyMatched = 0;

      const mismatches = [];

      for (const product of products) {
        const stockRows = getVariants(product).length
          ? getVariants(product).map((variant) => ({
              variantName: normalizeVariantName(variant.name),
              variantCode: normalizeVariantCode(variant.variantCode),
              productQty: Math.max(0, n(variant.qty)),
            }))
          : [
              {
                variantName: "",
                variantCode: "",
                productQty: Math.max(0, n(product.qty)),
              },
            ];

        for (const row of stockRows) {
          const variant =
            row.variantCode || row.variantName
              ? findVariant(product, row.variantName, row.variantCode)
              : null;

          const batchFilter = buildBatchFilter({
            product,
            productId: product._id,
            variant,
            activeOnly: true,
          });

          const existingRows = await InventoryBatch.aggregate([
            { $match: batchFilter },
            {
              $group: {
                _id: null,
                batchQty: { $sum: "$remainingQty" },
              },
            },
          ]).session(session);

          const batchQty = n(existingRows[0]?.batchQty);
          const difference = row.productQty - batchQty;

          if (difference === 0) {
            alreadyMatched++;
            continue;
          }

          if (difference < 0) {
            mismatches.push({
              productId: product._id,
              productTitle: product.title || "",
              variantCode: row.variantCode,
              variantName: row.variantName,
              productQty: row.productQty,
              batchQty,
              difference,
              reason:
                "Tổng tồn các lô lớn hơn tồn Product; cần kiểm tra trước khi xử lý.",
            });

            continue;
          }

          const variantKey =
            row.variantCode ||
            Buffer.from(row.variantName || "BASE")
              .toString("hex")
              .slice(0, 16) ||
            "BASE";

          const batchCode = `OPEN-${String(product._id).slice(-8)}-${variantKey}`;

          const openingBatch = await InventoryBatch.findOne({
            productId: product._id,
            variantCode: row.variantCode,
            variantName: row.variantName,
            source: "OPENING",
            batchCode,
          }).session(session);

          if (openingBatch) {
            openingBatch.importQty = n(openingBatch.importQty) + difference;

            openingBatch.remainingQty =
              n(openingBatch.remainingQty) + difference;

            openingBatch.note =
              "Tồn hiện tại chưa được liên kết với phiếu/lô nhập gốc; được bổ sung bởi chức năng phân bổ tồn hàng loạt.";

            await openingBatch.save({ session });

            updatedBatches++;
          } else {
            await InventoryBatch.create(
              [
                {
                  batchCode,
                  productId: product._id,
                  productTitle: product.title || "",
                  productCode: getCode(product),
                  variantCode: row.variantCode,
                  variantName: row.variantName,
                  importDate: product.created_at || new Date(),
                  importQty: difference,
                  remainingQty: difference,
                  unitCost: 0,
                  source: "OPENING",
                  sourceConfidence: "low",
                  note: "Tồn hiện tại chưa được liên kết với phiếu/lô nhập gốc; tạo tự động khi phân bổ tồn hàng loạt.",
                  createdBy: req.user?._id || null,
                },
              ],
              { session },
            );

            createdBatches++;
          }

          allocatedQty += difference;
        }
      }

      report = {
        productsScanned: products.length,
        createdBatches,
        updatedBatches,
        allocatedQty,
        alreadyMatched,
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 100),
        note: "Không thay đổi Product.qty/Variant.qty. Tồn chưa rõ nguồn được ghi vào lô OPENING với giá vốn 0 và sourceConfidence=low.",
      };
    });

    return res.json({
      success: true,
      message: "Đã phân bổ phần tồn kho hiện tại chưa có lô",
      report,
    });
  } catch (error) {
    console.error("backfillCurrentStockAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể phân bổ tồn kho hiện tại",
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// ĐỐI CHIẾU TỒN PRODUCT VÀ TỔNG TỒN CÁC LÔ
// =====================================================

const getBatchReconciliationAsync = async (_req, res) => {
  try {
    const products = await Product.find({})
      .select("title code productCode sku qty variants")
      .lean();

    const rows = [];

    for (const product of products) {
      const productVariants = getVariants(product);

      const variants = productVariants.length
        ? productVariants.map((variant) => ({
            variantName: normalizeVariantName(variant.name),
            variantCode: normalizeVariantCode(variant.variantCode),
            productQty: n(variant.qty),
          }))
        : [
            {
              variantName: "",
              variantCode: "",
              productQty: n(product.qty),
            },
          ];

      for (const row of variants) {
        const variant =
          row.variantCode || row.variantName
            ? findVariant(product, row.variantName, row.variantCode)
            : null;

        const batchFilter = buildBatchFilter({
          product,
          productId: product._id,
          variant,
          activeOnly: true,
        });

        const batchRows = await InventoryBatch.aggregate([
          { $match: batchFilter },
          {
            $group: {
              _id: null,
              batchQty: { $sum: "$remainingQty" },
              batchCount: { $sum: 1 },
            },
          },
        ]);

        const batchQty = n(batchRows[0]?.batchQty);
        const difference = row.productQty - batchQty;

        if (difference !== 0) {
          rows.push({
            productId: product._id,
            productTitle: product.title,
            productCode: getCode(product),

            variantCode: row.variantCode,
            variantName: row.variantName,

            // Tồn sản phẩm / Variant
            productQty: row.productQty,

            // Tổng tồn các lô
            batchQty,
            batchCount: n(batchRows[0]?.batchCount),

            // Product - Batch
            difference,

            differenceType: difference > 0 ? "product_higher" : "batch_higher",

            // Hỗ trợ frontend điều chỉnh tồn thực tế
            canAdjustProduct: true,
            canAdjustBatch: true,
          });
        }
      }
    }

    return res.json({
      success: true,
      totalMismatches: rows.length,
      summary: {
        productHigher: rows.filter((row) => row.difference > 0).length,
        batchHigher: rows.filter((row) => row.difference < 0).length,
      },
      rows,
    });
  } catch (error) {
    console.error("getBatchReconciliationAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể đối chiếu tồn kho",
    });
  }
};

// =====================================================
// NHẬP MỘT LÔ
// =====================================================

const importNewBatchAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      productId,
      variantName = "",
      variantCode = "",
      qty,
      unitCost = 0,
      importDate,
      note = "",
      supplier = "",
    } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      throw new Error("productId không hợp lệ");
    }

    const importQty = Number(qty);
    const cost = Number(unitCost);

    if (!Number.isSafeInteger(importQty) || importQty <= 0) {
      throw new Error("Số lượng nhập phải là số nguyên dương");
    }

    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error("Giá vốn không hợp lệ");
    }

    const date = importDate ? new Date(importDate) : new Date();

    if (Number.isNaN(date.getTime())) {
      throw new Error("Ngày nhập không hợp lệ");
    }

    let result;

    await session.withTransaction(async () => {
      const product = await Product.findById(productId).session(session);

      if (!product) {
        throw new Error("Không tìm thấy sản phẩm");
      }

      const identity = resolveVariantIdentity(
        product,
        variantName,
        variantCode,
      );

      const variant = identity.variant;
      const normalizedVariantName = identity.variantName;
      const normalizedVariantCode = identity.variantCode;

      const beforeQty = n(product.qty);

      let beforeVariantQty = null;
      let afterVariantQty = null;

      if (variant) {
        beforeVariantQty = n(variant.qty);
        afterVariantQty = beforeVariantQty + importQty;
        variant.qty = afterVariantQty;
      }

      product.qty = beforeQty + importQty;
      product.updated_at = new Date();

      await product.save({ session });

      const receiptCode = await generateReceiptCode(session, date);

      const receiptRows = await InventoryReceipt.create(
        [
          {
            code: receiptCode,
            supplier: clean(supplier),
            note: clean(note),
            items: [
              {
                productId: product._id,
                productTitle: product.title || "",
                variantCode: normalizedVariantCode,
                variantName: normalizedVariantName,
                qty: importQty,
                unitCost: cost,
                total: importQty * cost,
              },
            ],
            totalQty: importQty,
            totalAmount: importQty * cost,
            status: "completed",
            createdBy: req.user?._id || null,
            created_at: date,
            updated_at: new Date(),
          },
        ],
        { session },
      );

      const receipt = receiptRows[0];
      const batchCode = makeBatchCode(date);

      const batch = new InventoryBatch({
        batchCode,
        productId: product._id,
        productTitle: product.title || "",
        productCode: getCode(product),
        variantCode: normalizedVariantCode,
        variantName: normalizedVariantName,
        importDate: date,
        importQty,
        remainingQty: importQty,
        unitCost: cost,
        importReceiptId: receipt._id,
        source: "IMPORT",
        sourceConfidence: "high",
        note: clean(note),
        createdBy: req.user?._id || null,
        isActive: true,
      });

      await batch.save({ session });

      const history = new InventoryHistory({
        type: "import",
        referenceType: "InventoryReceipt",
        referenceId: receipt._id,
        referenceCode: receipt.code,
        productId: product._id,
        productTitle: product.title || "",
        productCode: getCode(product),
        variantCode: normalizedVariantCode,
        variantName: normalizedVariantName,
        batchId: batch._id,
        batchCode: batch.batchCode,
        unitCost: cost,
        qty: importQty,
        beforeQty,
        afterQty: product.qty,
        note: [
          `Nhập phiếu ${receipt.code}`,
          `Nhập lô ${batch.batchCode}`,
          variant
            ? `Tồn biến thể: ${beforeVariantQty} → ${afterVariantQty}`
            : "",
          clean(note),
        ]
          .filter(Boolean)
          .join(" | "),
        createdBy: req.user?._id || null,
        rollback: false,
        created_at: new Date(),
      });

      await history.save({ session });

      batch.importHistoryId = history._id;
      await batch.save({ session });

      result = {
        receipt,
        batch,
        history,
        product: {
          _id: product._id,
          title: product.title,
          qty: product.qty,
          variantCode: normalizedVariantCode,
          variantName: normalizedVariantName,
          variantQty: afterVariantQty,
        },
      };
    });

    return res.status(201).json({
      success: true,
      message: "Nhập lô hàng thành công",
      data: result,
    });
  } catch (error) {
    console.error("importNewBatchAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể nhập lô hàng",
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// NHẬP NHIỀU LÔ TRONG MỘT PHIẾU
// =====================================================

const importMultipleBatchesAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const supplier = clean(req.body?.supplier);
    const note = clean(req.body?.note);
    const items = req.body?.items;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Phiếu nhập chưa có sản phẩm",
      });
    }

    if (items.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Mỗi phiếu chỉ được nhập tối đa 200 dòng",
      });
    }

    const normalizedItems = items.map((item, index) => {
      if (!mongoose.Types.ObjectId.isValid(item.productId)) {
        throw new Error(`Dòng ${index + 1}: productId không hợp lệ`);
      }

      const qty = Number(item.qty);
      const unitCost = Number(item.unitCost ?? 0);

      if (!Number.isSafeInteger(qty) || qty <= 0) {
        throw new Error(
          `Dòng ${index + 1}: số lượng phải là số nguyên lớn hơn 0`,
        );
      }

      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error(`Dòng ${index + 1}: giá nhập không hợp lệ`);
      }

      return {
        productId: item.productId,
        variantName: normalizeVariantName(item.variantName),
        variantCode: normalizeVariantCode(item.variantCode),
        qty,
        unitCost,
      };
    });

    const importDate = req.body?.importDate
      ? new Date(req.body.importDate)
      : new Date();

    if (Number.isNaN(importDate.getTime())) {
      throw new Error("Ngày nhập không hợp lệ");
    }

    let result;

    await session.withTransaction(async () => {
      const createdBatches = [];
      const receiptItems = [];

      const totalQty = normalizedItems.reduce((sum, item) => sum + item.qty, 0);

      const totalAmount = normalizedItems.reduce(
        (sum, item) => sum + item.qty * item.unitCost,
        0,
      );

      const receiptCode = await generateReceiptCode(session, importDate);

      const receiptRows = await InventoryReceipt.create(
        [
          {
            code: receiptCode,
            supplier,
            note,
            items: [],
            totalQty,
            totalAmount,
            status: "completed",
            createdBy: req.user?._id || null,
            created_at: importDate,
            updated_at: new Date(),
          },
        ],
        { session },
      );

      const receipt = receiptRows[0];
      const productCache = new Map();

      for (let i = 0; i < normalizedItems.length; i++) {
        const item = normalizedItems[i];
        const cacheKey = String(item.productId);

        let product = productCache.get(cacheKey);

        if (!product) {
          product = await Product.findById(item.productId).session(session);

          if (!product) {
            throw new Error(`Dòng ${i + 1}: không tìm thấy sản phẩm`);
          }

          productCache.set(cacheKey, product);
        }

        let identity;

        try {
          identity = resolveVariantIdentity(
            product,
            item.variantName,
            item.variantCode,
          );
        } catch (error) {
          throw new Error(`Dòng ${i + 1}: ${error.message}`);
        }

        const variant = identity.variant;
        const variantName = identity.variantName;
        const variantCode = identity.variantCode;

        const beforeQty = n(product.qty);
        const beforeVariantQty = variant ? n(variant.qty) : beforeQty;

        product.qty = beforeQty + item.qty;

        if (variant) {
          variant.qty = beforeVariantQty + item.qty;
        }

        product.updated_at = new Date();

        await product.save({ session });

        const batchCode = makeBatchCode(importDate);

        const batch = new InventoryBatch({
          batchCode,
          productId: product._id,
          productTitle: product.title || "",
          productCode: getCode(product),
          variantCode,
          variantName,
          importDate,
          importQty: item.qty,
          remainingQty: item.qty,
          unitCost: item.unitCost,
          importReceiptId: receipt._id,
          source: "IMPORT",
          sourceConfidence: "high",
          note: [supplier ? `Nhà cung cấp: ${supplier}` : "", note]
            .filter(Boolean)
            .join(" | "),
          createdBy: req.user?._id || null,
          isActive: true,
        });

        await batch.save({ session });

        const history = new InventoryHistory({
          type: "import",
          referenceType: "InventoryReceipt",
          referenceId: receipt._id,
          referenceCode: receipt.code,
          productId: product._id,
          productTitle: product.title || "",
          productCode: getCode(product),
          variantCode,
          variantName,
          batchId: batch._id,
          batchCode,
          unitCost: item.unitCost,
          qty: item.qty,
          beforeQty,
          afterQty: product.qty,
          note: [
            `Phiếu nhập ${receipt.code}`,
            supplier ? `Nhà cung cấp: ${supplier}` : "",
            note,
            `Nhập lô ${batchCode}`,
          ]
            .filter(Boolean)
            .join(" | "),
          createdBy: req.user?._id || null,
          rollback: false,
          created_at: new Date(),
        });

        await history.save({ session });

        batch.importHistoryId = history._id;
        await batch.save({ session });

        receiptItems.push({
          productId: product._id,
          productTitle: product.title || "",
          variantCode,
          variantName,
          qty: item.qty,
          unitCost: item.unitCost,
          total: item.qty * item.unitCost,
        });

        createdBatches.push({
          batchId: batch._id,
          batchCode,
          productId: product._id,
          productTitle: product.title || "",
          variantCode,
          variantName,
          qty: item.qty,
          unitCost: item.unitCost,
          remainingQty: batch.remainingQty,
          beforeQty,
          afterQty: product.qty,
        });
      }

      receipt.items = receiptItems;
      receipt.totalQty = totalQty;
      receipt.totalAmount = totalAmount;
      receipt.updated_at = new Date();

      await receipt.save({ session });

      result = {
        receipt: {
          _id: receipt._id,
          code: receipt.code,
          supplier: receipt.supplier,
          totalQty: receipt.totalQty,
          totalAmount: receipt.totalAmount,
          status: receipt.status,
        },
        totalItems: createdBatches.length,
        totalQty,
        totalAmount,
        batches: createdBatches,
      };
    });

    return res.status(201).json({
      success: true,
      message: `Nhập thành công ${result.totalItems} dòng hàng`,
      data: result,
    });
  } catch (error) {
    console.error("importMultipleBatchesAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể nhập nhiều lô hàng",
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// ĐỒNG BỘ GIÁ VỐN LÔ NHẬP
// =====================================================

const syncBatchUnitCosts = async (req, res) => {
  try {
    const batches = await InventoryBatch.find({
      $or: [
        { unitCost: { $exists: false } },
        { unitCost: null },
        { unitCost: 0 },
      ],
    }).lean();

    const productIds = [
      ...new Set(
        batches
          .filter((batch) => mongoose.Types.ObjectId.isValid(batch.productId))
          .map((batch) => String(batch.productId)),
      ),
    ];

    const products = await Product.find({
      _id: { $in: productIds },
    })
      .select("_id title price defaultPrice variants")
      .lean();

    const productMap = new Map(
      products.map((product) => [String(product._id), product]),
    );

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    const details = [];

    for (const batch of batches) {
      try {
        const product = productMap.get(String(batch.productId));

        if (!product) {
          skipped++;

          details.push({
            batchCode: batch.batchCode,
            status: "skipped",
            reason: "Không tìm thấy sản phẩm",
          });

          continue;
        }

        let sourceVariant = null;

        if (hasVariants(product)) {
          const variantCode = normalizeVariantCode(batch.variantCode);
          const variantName = normalizeVariantName(batch.variantName);

          if (variantCode) {
            sourceVariant = getVariants(product).find(
              (item) => normalizeVariantCode(item.variantCode) === variantCode,
            );
          } else if (variantName) {
            const matched = getVariants(product).filter(
              (item) => normalizeVariantName(item.name) === variantName,
            );

            if (matched.length > 1) {
              skipped++;

              details.push({
                batchCode: batch.batchCode,
                productTitle: product.title,
                variantName,
                status: "skipped",
                reason: "Tên biến thể bị trùng và lô chưa có variantCode",
              });

              continue;
            }

            sourceVariant = matched[0] || null;
          }
        }

        if (hasVariants(product) && !sourceVariant) {
          skipped++;

          details.push({
            batchCode: batch.batchCode,
            productTitle: product.title,
            variantCode: batch.variantCode || "",
            variantName: batch.variantName || "",
            status: "skipped",
            reason: "Không tìm thấy biến thể tương ứng",
          });

          continue;
        }

        const unitCost = Number(
          sourceVariant
            ? sourceVariant.defaultPrice
            : (product.defaultPrice ?? product.price),
        );

        if (!Number.isFinite(unitCost) || unitCost <= 0) {
          skipped++;

          details.push({
            batchCode: batch.batchCode,
            productTitle: product.title,
            variantCode: batch.variantCode || "",
            variantName: batch.variantName || "",
            status: "skipped",
            reason: "Không có giá vốn hợp lệ",
          });

          continue;
        }

        const updateResult = await InventoryBatch.updateOne(
          {
            _id: batch._id,
            $or: [
              { unitCost: { $exists: false } },
              { unitCost: null },
              { unitCost: 0 },
            ],
          },
          {
            $set: {
              unitCost,
              sourceConfidence: "medium",
              note: [batch.note, "Đồng bộ giá vốn từ Product.defaultPrice"]
                .filter(Boolean)
                .join(" | "),
            },
          },
        );

        if (updateResult.modifiedCount > 0) {
          updated++;

          details.push({
            batchCode: batch.batchCode,
            productTitle: product.title,
            variantCode: batch.variantCode || "",
            variantName: batch.variantName || "",
            unitCost,
            currency: "CNY",
            status: "updated",
          });
        } else {
          skipped++;

          details.push({
            batchCode: batch.batchCode,
            status: "skipped",
            reason: "Lô đã được cập nhật hoặc không còn đủ điều kiện",
          });
        }
      } catch (error) {
        failed++;

        details.push({
          batchCode: batch.batchCode,
          status: "failed",
          reason: error.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Đồng bộ giá vốn hoàn tất",
      summary: {
        total: batches.length,
        updated,
        skipped,
        failed,
      },
      details,
    });
  } catch (error) {
    console.error("syncBatchUnitCosts:", error);

    return res.status(500).json({
      success: false,
      message: "Lỗi đồng bộ giá vốn",
      error: error.message,
    });
  }
};

/**
 * CHỈNH SỬA TỒN KHO CỦA MỘT LÔ
 *
 * Body:
 * {
 *   remainingQty: 10,
 *   note: "Kiểm kho thực tế"
 * }
 */
const updateInventoryBatchRemainingAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id } = req.params;
    const { remainingQty, note } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("Mã lô không hợp lệ");
    }

    const newRemainingQty = Number(remainingQty);
    const adjustmentNote = clean(note);

    if (!Number.isSafeInteger(newRemainingQty) || newRemainingQty < 0) {
      throw new Error("Tồn kho mới phải là số nguyên không âm");
    }

    if (!adjustmentNote) {
      throw new Error("Vui lòng nhập lý do điều chỉnh tồn kho");
    }

    let result;

    await session.withTransaction(async () => {
      const batch = await InventoryBatch.findById(id).session(session);

      if (!batch) {
        throw new Error("Không tìm thấy lô nhập");
      }

      if (batch.isActive === false) {
        throw new Error("Lô đã ngừng hoạt động, không thể chỉnh tồn");
      }

      const product = await Product.findById(batch.productId).session(session);

      if (!product) {
        throw new Error("Không tìm thấy sản phẩm của lô");
      }

      // Xác định đúng Variant bằng variantCode / variantName
      let identity;

      try {
        identity = resolveVariantIdentity(
          product,
          batch.variantName,
          batch.variantCode,
        );
      } catch (error) {
        throw new Error(`Không xác định được biến thể: ${error.message}`);
      }

      const variant = identity.variant;

      const oldBatchQty = n(batch.remainingQty);
      const delta = newRemainingQty - oldBatchQty;

      const oldProductQty = n(product.qty);
      const oldVariantQty = variant ? n(variant.qty) : null;

      const newProductQty = oldProductQty + delta;
      const newVariantQty = variant ? oldVariantQty + delta : null;

      if (newProductQty < 0) {
        throw new Error("Điều chỉnh khiến tồn sản phẩm bị âm");
      }

      if (variant) {
        if (newVariantQty < 0) {
          throw new Error("Điều chỉnh khiến tồn Variant bị âm");
        }

        const reservedQty = Math.max(0, n(variant.reservedQty));

        if (newVariantQty < reservedQty) {
          throw new Error(
            `Không thể giảm tồn xuống ${newVariantQty}. ` +
              `Variant đang giữ ${reservedQty} sản phẩm.`,
          );
        }

        variant.qty = newVariantQty;
      }

      // Không thay đổi importQty
      batch.remainingQty = newRemainingQty;
      batch.note = [
        clean(batch.note),
        `Điều chỉnh tồn: ${oldBatchQty} → ${newRemainingQty}. ${adjustmentNote}`,
      ]
        .filter(Boolean)
        .join(" | ");

      // Đồng bộ tồn Product
      product.qty = newProductQty;
      product.updated_at = new Date();

      await batch.save({ session });
      await product.save({ session });

      // Ghi lịch sử điều chỉnh
      let history = null;

      if (delta !== 0) {
        const historyRows = await InventoryHistory.create(
          [
            {
              type: "adjustment",
              referenceType: "InventoryBatch",
              referenceId: batch._id,
              referenceCode: batch.batchCode,

              productId: product._id,
              productTitle: product.title || "",
              productCode: getCode(product),

              variantCode: identity.variantCode,
              variantName: identity.variantName,

              batchId: batch._id,
              batchCode: batch.batchCode,

              qty: delta,
              beforeQty: oldProductQty,
              afterQty: newProductQty,

              unitCost: n(batch.unitCost),

              note: [
                "Điều chỉnh tồn kho thủ công",
                `Lô: ${batch.batchCode}`,
                `Tồn lô: ${oldBatchQty} → ${newRemainingQty}`,
                adjustmentNote,
              ].join(" | "),

              createdBy: req.user?._id || null,
              rollback: false,
              created_at: new Date(),
            },
          ],
          { session },
        );

        history = historyRows[0];
      }

      result = {
        batch,
        history,
        adjustment: {
          delta,
          oldBatchQty,
          newBatchQty: newRemainingQty,
          oldProductQty,
          newProductQty,
          oldVariantQty,
          newVariantQty,
        },
      };
    });

    return res.json({
      success: true,
      message: "Điều chỉnh tồn kho thành công",
      data: result,
    });
  } catch (error) {
    console.error("updateInventoryBatchRemainingAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể điều chỉnh tồn kho",
    });
  } finally {
    await session.endSession();
  }
};

const adjustProductActualStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { productId } = req.params;
    const { variantCode, actualQty, note } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      throw new Error("Mã sản phẩm không hợp lệ");
    }

    const newQty = Number(actualQty);
    const adjustmentNote = clean(note);

    if (!Number.isSafeInteger(newQty) || newQty < 0) {
      throw new Error("Tồn thực tế phải là số nguyên không âm");
    }

    if (!adjustmentNote) {
      throw new Error("Vui lòng nhập lý do điều chỉnh");
    }

    let result;

    await session.withTransaction(async () => {
      const product = await Product.findById(productId).session(session);

      if (!product) {
        throw new Error("Không tìm thấy sản phẩm");
      }

      const variants = Array.isArray(product.variants) ? product.variants : [];

      const hasVariants = variants.length > 0;

      let variant = null;
      let oldQty = 0;
      let newProductQty = 0;
      let historyVariantCode = "";
      let historyVariantName = "";

      if (hasVariants) {
        const code = normalizeVariantCode(variantCode);

        if (!code) {
          throw new Error("Vui lòng chọn Variant cần điều chỉnh");
        }

        variant = variants.find(
          (item) => normalizeVariantCode(item.variantCode) === code,
        );

        if (!variant) {
          throw new Error("Không tìm thấy Variant");
        }

        oldQty = n(variant.qty);

        const reservedQty = Math.max(0, n(variant.reservedQty));

        if (newQty < reservedQty) {
          throw new Error(
            `Tồn thực tế không được thấp hơn số lượng đang giữ (${reservedQty})`,
          );
        }

        variant.qty = newQty;

        newProductQty = variants.reduce(
          (total, item) => total + n(item.qty),
          0,
        );

        historyVariantCode = variant.variantCode || "";
        historyVariantName = variant.name || "";
      } else {
        oldQty = n(product.qty);

        newProductQty = newQty;
      }

      const delta = newQty - oldQty;

      product.qty = newProductQty;
      product.updated_at = new Date();

      await product.save({ session });

      let history = null;

      if (delta !== 0) {
        const historyRows = await InventoryHistory.create(
          [
            {
              type: "adjustment",

              referenceType: "Product",
              referenceId: product._id,
              referenceCode: historyVariantCode || getCode(product),

              productId: product._id,
              productTitle: product.title || "",
              productCode: getCode(product),

              variantCode: historyVariantCode,
              variantName: historyVariantName,

              batchId: null,
              batchCode: "",

              qty: delta,
              beforeQty: oldQty,
              afterQty: newQty,

              note: [
                "Điều chỉnh tồn kho thực tế",
                `Tồn cũ: ${oldQty}`,
                `Tồn mới: ${newQty}`,
                adjustmentNote,
              ].join(" | "),

              createdBy: req.user?._id || null,
              rollback: false,
              created_at: new Date(),
            },
          ],
          { session },
        );

        history = historyRows[0];
      }

      result = {
        productId: product._id,
        productTitle: product.title,
        variantCode: historyVariantCode,
        variantName: historyVariantName,

        oldQty,
        actualQty: newQty,
        difference: delta,

        productQty: newProductQty,
        history,
      };
    });

    return res.json({
      success: true,
      message: "Điều chỉnh tồn thực tế thành công",
      data: result,
    });
  } catch (error) {
    console.error("adjustProductActualStockAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể điều chỉnh tồn thực tế",
    });
  } finally {
    await session.endSession();
  }
};
// =====================================================
// TRỪ TỔNG TỒN LÔ THEO FIFO
// Chỉ cập nhật InventoryBatch.remainingQty
// Không cập nhật Product.qty / Variant.qty / importQty
// =====================================================

const subtractTotalBatchQtyAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { productId } = req.params;
    const { variantCode, variantName, qtyToSubtract, note } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "Product ID không hợp lệ",
      });
    }

    const subtractQty = Number(qtyToSubtract);
    const adjustmentNote = clean(note);

    if (!Number.isSafeInteger(subtractQty) || subtractQty <= 0) {
      return res.status(400).json({
        success: false,
        message: "Số lượng cần trừ phải là số nguyên lớn hơn 0",
      });
    }

    if (!adjustmentNote) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập lý do điều chỉnh",
      });
    }

    let result = null;

    await session.withTransaction(async () => {
      const product = await Product.findById(productId).session(session);

      if (!product) {
        throw new Error("Không tìm thấy sản phẩm");
      }

      const variants = getVariants(product);
      let variant = null;

      if (variants.length > 0) {
        const code = normalizeVariantCode(variantCode);
        const name = normalizeVariantName(variantName);

        if (!code && !name) {
          throw new Error("Sản phẩm có phân loại, cần xác định phân loại");
        }

        variant = findVariant(product, name, code);

        if (!variant) {
          throw new Error("Không tìm thấy phân loại cần điều chỉnh");
        }
      }

      const batchFilter = buildBatchFilter({
        product,
        productId: product._id,
        variant,
        activeOnly: true,
      });

      // FIFO: lô nhập cũ nhất được trừ trước
      const batches = await InventoryBatch.find(batchFilter)
        .sort({ importDate: 1, createdAt: 1, _id: 1 })
        .session(session);

      const totalBefore = batches.reduce(
        (sum, batch) => sum + Math.max(0, n(batch.remainingQty)),
        0,
      );

      if (subtractQty > totalBefore) {
        throw new Error(
          `Số lượng cần trừ (${subtractQty}) vượt tổng tồn lô (${totalBefore})`,
        );
      }

      let remainingToSubtract = subtractQty;
      const historyRows = [];
      const affectedBatches = [];

      for (const batch of batches) {
        if (remainingToSubtract <= 0) break;

        const beforeQty = Math.max(0, n(batch.remainingQty));
        if (beforeQty <= 0) continue;

        const takeQty = Math.min(beforeQty, remainingToSubtract);
        const afterQty = beforeQty - takeQty;

        batch.remainingQty = afterQty;
        await batch.save({ session });

        historyRows.push({
          type: "adjustment",
          referenceType: "InventoryBatch",
          referenceId: batch._id,
          referenceCode: batch.batchCode || "",
          productId: product._id,
          productTitle: product.title || "",
          productCode: getCode(product) || "",
          variantCode: variant?.variantCode || "",
          variantName: variant?.name || "",
          batchId: batch._id,
          batchCode: batch.batchCode || "",
          unitCost: n(batch.unitCost),
          qty: -takeQty,
          beforeQty,
          afterQty,
          note: adjustmentNote,
          createdBy: req.user?._id || null,
          rollback: false,
        });

        affectedBatches.push({
          batchId: batch._id,
          batchCode: batch.batchCode || "",
          beforeQty,
          deductedQty: takeQty,
          afterQty,
        });

        remainingToSubtract -= takeQty;
      }

      if (remainingToSubtract > 0) {
        throw new Error("Không thể phân bổ đủ số lượng cần trừ vào các lô");
      }

      if (historyRows.length > 0) {
        await InventoryHistory.create(historyRows, { session });
      }

      result = {
        productId: product._id,
        productTitle: product.title,
        variantCode: variant?.variantCode || "",
        variantName: variant?.name || "",
        totalBefore,
        deductedQty: subtractQty,
        totalAfter: totalBefore - subtractQty,
        affectedBatches,
      };
    });

    return res.json({
      success: true,
      message: "Đã trừ tổng tồn lô theo FIFO",
      data: result,
    });
  } catch (error) {
    console.error("subtractTotalBatchQtyAsync:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Không thể trừ tổng tồn lô",
    });
  } finally {
    await session.endSession();
  }
};
// =====================================================
// EXPORT
// =====================================================

module.exports = {
  listInventoryBatchesAsync,
  getProductBatchesAsync,
  getInventoryBatchHistoryAsync,
  updateOrderBatchAllocationsAsync,
  deductOrderStockByBatchesAsync,
  rebuildHistoricalBatchesAsync,
  backfillCurrentStockAsync,
  getBatchReconciliationAsync,
  importNewBatchAsync,
  importMultipleBatchesAsync,
  syncBatchUnitCosts,
  adjustProductActualStockAsync,
  // Thêm dòng này
  updateInventoryBatchRemainingAsync,
  subtractTotalBatchQtyAsync,
};

const mongoose = require("mongoose");
const crypto = require("crypto");

const InventoryBatch = require("../models/InventoryBatch");
const InventoryHistory = require("../models/inventoryHistory");
const InventoryReceipt = require("../models/InventoryReceipt");
const Order = require("../models/orders");
const { Product } = require("../models/products");

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const clean = (v) => String(v || "").trim();

const getCode = (p) =>
  p?.code || p?.productCode || p?.sku || p?.product_code || "";

const findVariant = (p, name) =>
  (p?.variants || []).find((v) => clean(v?.name) === clean(name));

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
    if (Number.isFinite(lastNumber)) nextNumber = lastNumber + 1;
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

const listInventoryBatchesAsync = async (req, res) => {
  try {
    const page = Math.max(1, n(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, n(req.query.limit) || 20));
    const search = clean(req.query.search);
    const filter = { isActive: true };

    if (
      req.query.productId &&
      mongoose.Types.ObjectId.isValid(req.query.productId)
    ) {
      filter.productId = req.query.productId;
    }

    if (req.query.variantName !== undefined) {
      filter.variantName = clean(req.query.variantName);
    }

    if (req.query.source) filter.source = clean(req.query.source);
    if (req.query.onlyRemaining === "true") filter.remainingQty = { $gt: 0 };

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      filter.$or = [
        { batchCode: rx },
        { productTitle: rx },
        { productCode: rx },
        { variantName: rx },
        { note: rx },
      ];
    }

    const [rows, total, summary] = await Promise.all([
      InventoryBatch.find(filter)
        .sort({ importDate: -1, createdAt: -1 })
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
              $sum: { $multiply: ["$remainingQty", "$unitCost"] },
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

const getProductBatchesAsync = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res
        .status(400)
        .json({ success: false, message: "productId không hợp lệ" });
    }

    const variantName = clean(req.query.variantName);
    const filter = {
      productId,
      isActive: true,
      remainingQty: { $gt: 0 },
    };

    if (req.query.variantName !== undefined) {
      filter.variantName = variantName;
    }

    const batches = await InventoryBatch.find(filter)
      .sort({ importDate: 1, createdAt: 1 })
      .lean();

    const totalRemaining = batches.reduce(
      (sum, batch) => sum + n(batch.remainingQty),
      0,
    );

    return res.json({ success: true, batches, totalRemaining });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải lô sản phẩm",
    });
  }
};

const getInventoryBatchHistoryAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "batchId không hợp lệ" });
    }

    const batch = await InventoryBatch.findById(id).lean();

    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy lô" });
    }

    const histories = await InventoryHistory.find({ batchId: id })
      .sort({ created_at: -1 })
      .lean();

    return res.json({ success: true, batch, histories });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải lịch sử lô",
    });
  }
};

/*
 * Lưu phân bổ lô cho đơn nhưng CHƯA trừ kho.
 */
const updateOrderBatchAllocationsAsync = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { items = [] } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "orderId không hợp lệ" });
    }

    if (!Array.isArray(items)) throw new Error("items phải là mảng");

    const order = await Order.findById(orderId);

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy đơn hàng" });
    }

    if (order.stockDeducted) {
      return res.status(409).json({
        success: false,
        message: "Đơn đã trừ kho, không thể đổi phân bổ lô",
      });
    }

    for (const input of items) {
      const item = order.items.find(
        (x) =>
          String(x.productId) === String(input.productId) &&
          clean(x.variantName) === clean(input.variantName),
      );

      if (!item) {
        throw new Error(
          `Không tìm thấy sản phẩm/Variant trong đơn: ${input.productId}`,
        );
      }

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

        if (seen.has(String(allocation.batchId))) {
          throw new Error("Một lô không được chọn lặp lại");
        }

        seen.add(String(allocation.batchId));

        const qty = n(allocation.qty);

        if (!Number.isInteger(qty) || qty <= 0) {
          throw new Error("Số lượng phân bổ phải là số nguyên dương");
        }

        const batch = await InventoryBatch.findOne({
          _id: allocation.batchId,
          productId: item.productId,
          variantName: clean(item.variantName),
          isActive: true,
        }).lean();

        if (!batch) throw new Error("Lô không thuộc đúng sản phẩm/Variant");

        if (n(batch.remainingQty) < qty) {
          throw new Error(
            `Lô ${batch.batchCode} chỉ còn ${batch.remainingQty}`,
          );
        }

        sum += qty;

        normalized.push({
          batchId: batch._id,
          batchCode: batch.batchCode,
          qty,
          unitCost: n(batch.unitCost),
        });
      }

      if (sum !== n(item.qty)) {
        throw new Error(
          `Phân bổ lô của ${item.productTitle} phải bằng ${item.qty}, hiện là ${sum}`,
        );
      }

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
    return res.status(400).json({
      success: false,
      message: error.message || "Không thể lưu phân bổ lô",
    });
  }
};

/*
 * Xuất kho theo phân bổ thủ công.
 * Transaction đảm bảo Product, Batch, Order và InventoryHistory
 * cùng thành công hoặc cùng rollback.
 */
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

      const cache = new Map();

      for (const item of order.items) {
        const qty = n(item.qty);

        if (!Number.isInteger(qty) || qty <= 0) {
          throw new Error("Số lượng đơn không hợp lệ");
        }

        const allocations = item.batchAllocations || [];
        const sum = allocations.reduce((total, row) => total + n(row.qty), 0);

        if (sum !== qty) {
          throw new Error(
            `Đơn ${order.code}: ${item.productTitle} chưa phân bổ đủ lô (${sum}/${qty})`,
          );
        }

        let product = cache.get(String(item.productId));

        if (!product) {
          product = await Product.findById(item.productId).session(session);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
          }

          cache.set(String(item.productId), product);
        }

        const variantName = clean(item.variantName);
        const variant = variantName ? findVariant(product, variantName) : null;

        if (variantName && !variant) {
          throw new Error(`Không tìm thấy Variant ${variantName}`);
        }

        const currentQty = variant ? n(variant.qty) : n(product.qty);

        if (currentQty < qty) {
          throw new Error(
            `${item.productTitle} chỉ còn ${currentQty}, cần ${qty}`,
          );
        }

        if (variant && n(product.qty) < qty) {
          throw new Error(
            `${item.productTitle}: tồn tổng sản phẩm không đủ để xuất ${qty}`,
          );
        }

        let runningVariantQty = currentQty;

        for (const allocation of allocations) {
          const batch = await InventoryBatch.findOne({
            _id: allocation.batchId,
            productId: item.productId,
            variantName,
            isActive: true,
          }).session(session);

          if (!batch) {
            throw new Error(
              `Không tìm thấy lô ${allocation.batchCode || allocation.batchId}`,
            );
          }

          if (n(batch.remainingQty) < n(allocation.qty)) {
            throw new Error(
              `Lô ${batch.batchCode} chỉ còn ${batch.remainingQty}, cần ${allocation.qty}`,
            );
          }

          batch.remainingQty = n(batch.remainingQty) - n(allocation.qty);

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
                variantName,
                qty: -n(allocation.qty),
                beforeQty: runningVariantQty,
                afterQty: runningVariantQty - n(allocation.qty),
                batchId: batch._id,
                batchCode: batch.batchCode,
                unitCost: n(batch.unitCost),
                note: `Xuất ${allocation.qty} từ lô ${batch.batchCode} theo đơn ${order.code}`,
                createdBy: req.user?._id || null,
                rollback: false,
                created_at: new Date(),
              },
            ],
            { session },
          );

          runningVariantQty -= n(allocation.qty);
        }

        if (variant) variant.qty = currentQty - qty;

        product.qty = Math.max(0, n(product.qty) - qty);
        product.soldQty = n(product.soldQty) + qty;
        product.updated_at = new Date();

        await product.save({ session });
      }

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

      const imports = histories.filter(
        (history) => history.type === "import" && n(history.qty) > 0,
      );

      const outbound = histories.filter(
        (history) =>
          ["order", "export", "adjustment"].includes(history.type) &&
          n(history.qty) < 0,
      );

      const groups = new Map();
      const keyOf = (history) =>
        `${String(history.productId)}::${clean(history.variantName)}`;

      for (const history of imports) {
        const key = keyOf(history);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(history);
      }

      const batches = [];

      for (const [key, importRows] of groups.entries()) {
        const [productId] = key.split("::");
        const product = await Product.findById(productId).session(session);

        for (const history of importRows) {
          const receiptSuffix =
            clean(history.referenceCode) || String(history._id).slice(-6);

          batches.push({
            batchCode: `H-${receiptSuffix}-${String(history._id).slice(-8)}`,
            productId: history.productId,
            productTitle: history.productTitle || product?.title || "",
            productCode: history.productCode || getCode(product),
            variantName: clean(history.variantName),
            importDate: history.created_at || new Date(),
            importQty: n(history.qty),
            remainingQty: n(history.qty),
            unitCost: n(history.unitCost || history.costPrice || 0),
            importReceiptId:
              history.referenceType === "InventoryReceipt"
                ? history.referenceId
                : null,
            importHistoryId: history._id,
            source: "historical",
            sourceConfidence: "recorded",
            note: `Dựng từ lịch sử nhập ${history.referenceCode || ""}`,
          });
        }
      }

      const sortedBatches = batches.sort(
        (a, b) => new Date(a.importDate) - new Date(b.importDate),
      );

      const getCurrentGroup = (history) =>
        sortedBatches.filter(
          (batch) =>
            String(batch.productId) === String(history.productId) &&
            clean(batch.variantName) === clean(history.variantName) &&
            new Date(batch.importDate) <= new Date(history.created_at || 0),
        );

      let inferredOutbound = 0;

      for (const history of outbound) {
        let remaining = Math.abs(n(history.qty));
        const candidates = getCurrentGroup(history);

        for (const batch of candidates) {
          if (remaining <= 0) break;

          const take = Math.min(n(batch.remainingQty), remaining);
          batch.remainingQty -= take;
          remaining -= take;
        }

        if (remaining > 0) inferredOutbound += remaining;
      }

      const products = await Product.find({}).session(session).lean();
      let openingBatches = 0;
      let discrepancy = 0;

      for (const product of products) {
        const rows = product.variants?.length
          ? product.variants.map((variant) => ({
              variantName: clean(variant.name),
              qty: n(variant.qty),
            }))
          : [{ variantName: "", qty: n(product.qty) }];

        for (const row of rows) {
          const related = batches.filter(
            (batch) =>
              String(batch.productId) === String(product._id) &&
              clean(batch.variantName) === row.variantName,
          );

          const calculated = related.reduce(
            (sum, batch) => sum + n(batch.remainingQty),
            0,
          );

          const delta = row.qty - calculated;
          discrepancy += Math.abs(delta);

          if (delta > 0) {
            batches.push({
              batchCode:
                `OPEN-${String(product._id).slice(-6)}-` +
                (Buffer.from(row.variantName).toString("hex").slice(0, 16) ||
                  "BASE"),
              productId: product._id,
              productTitle: product.title || "",
              productCode: getCode(product),
              variantName: row.variantName,
              importDate: product.created_at || new Date(),
              importQty: delta,
              remainingQty: delta,
              unitCost: 0,
              source: "opening",
              sourceConfidence: "unknown",
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
        importedHistoryRows: imports.length,
        outboundHistoryRows: outbound.length,
        createdBatches: validBatches.length,
        openingBatches,
        unlinkedHistoricalOutboundQty: inferredOutbound,
        absoluteReconciliationDifferenceBeforeOpening: discrepancy,
        note: "Xuất lịch sử được phân bổ FIFO để tái dựng báo cáo; không thể xác nhận vật lý từng món thuộc lô nào nếu dữ liệu cũ không lưu batchId.",
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
        const stockRows = product.variants?.length
          ? product.variants.map((variant) => ({
              variantName: clean(variant.name),
              productQty: Math.max(0, n(variant.qty)),
            }))
          : [{ variantName: "", productQty: Math.max(0, n(product.qty)) }];

        for (const row of stockRows) {
          const existingRows = await InventoryBatch.aggregate([
            {
              $match: {
                productId: product._id,
                variantName: row.variantName,
                isActive: true,
              },
            },
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
            Buffer.from(row.variantName || "BASE")
              .toString("hex")
              .slice(0, 16) || "BASE";

          const batchCode = `OPEN-${String(product._id).slice(-8)}-${variantKey}`;

          let openingBatch = await InventoryBatch.findOne({
            productId: product._id,
            variantName: row.variantName,
            source: "opening",
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
                  variantName: row.variantName,
                  importDate: product.created_at || new Date(),
                  importQty: difference,
                  remainingQty: difference,
                  unitCost: 0,
                  source: "opening",
                  sourceConfidence: "unknown",
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
        note: "Không thay đổi Product.qty/Variant.qty. Tồn chưa rõ nguồn được ghi vào lô OPENING với giá vốn 0 và sourceConfidence=unknown; không khẳng định đó là một lô nhập lịch sử cụ thể.",
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

const getBatchReconciliationAsync = async (_req, res) => {
  try {
    const products = await Product.find({})
      .select("title code productCode sku qty variants")
      .lean();

    const rows = [];

    for (const product of products) {
      const variants = product.variants?.length
        ? product.variants.map((variant) => ({
            variantName: clean(variant.name),
            productQty: n(variant.qty),
          }))
        : [{ variantName: "", productQty: n(product.qty) }];

      for (const variant of variants) {
        const batchRows = await InventoryBatch.aggregate([
          {
            $match: {
              productId: product._id,
              variantName: variant.variantName,
              isActive: true,
            },
          },
          {
            $group: {
              _id: null,
              batchQty: { $sum: "$remainingQty" },
              batchCount: { $sum: 1 },
            },
          },
        ]);

        const batchQty = n(batchRows[0]?.batchQty);

        if (batchQty !== variant.productQty) {
          rows.push({
            productId: product._id,
            productTitle: product.title,
            productCode: getCode(product),
            variantName: variant.variantName,
            productQty: variant.productQty,
            batchQty,
            difference: variant.productQty - batchQty,
          });
        }
      }
    }

    return res.json({
      success: true,
      totalMismatches: rows.length,
      rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Không thể đối chiếu tồn kho",
    });
  }
};
/*
 * Nhập một lô:
 * - Tạo một InventoryReceipt.
 * - Tạo một InventoryBatch.
 * - Tạo InventoryHistory liên kết đến InventoryReceipt và InventoryBatch.
 * - Tất cả cùng transaction.
 */
const importNewBatchAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      productId,
      variantName = "",
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

    if (!Number.isInteger(importQty) || importQty <= 0) {
      throw new Error("Số lượng nhập phải là số nguyên dương");
    }

    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error("Giá vốn không hợp lệ");
    }

    const date = importDate ? new Date(importDate) : new Date();

    if (Number.isNaN(date.getTime())) {
      throw new Error("Ngày nhập không hợp lệ");
    }

    const normalizedVariant = clean(variantName);
    let result;

    await session.withTransaction(async () => {
      const product = await Product.findById(productId).session(session);

      if (!product) throw new Error("Không tìm thấy sản phẩm");

      const variant = findVariant(product, normalizedVariant);
      const hasVariants =
        Array.isArray(product.variants) && product.variants.length > 0;

      if (hasVariants && !normalizedVariant) {
        throw new Error("Vui lòng chọn biến thể cần nhập");
      }

      if (hasVariants && !variant) {
        throw new Error("Biến thể không tồn tại");
      }

      if (!hasVariants && normalizedVariant) {
        throw new Error("Sản phẩm không có biến thể");
      }

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
                variantName: normalizedVariant,
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
        variantName: normalizedVariant,
        importDate: date,
        importQty,
        remainingQty: importQty,
        unitCost: cost,
        importReceiptId: receipt._id,
        source: "manual",
        sourceConfidence: "recorded",
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
        variantName: normalizedVariant,
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
          variantName: normalizedVariant,
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

/*
 * Nhập nhiều lô:
 * - Một request tạo một InventoryReceipt.
 * - Mỗi dòng tạo một InventoryBatch và một InventoryHistory.
 * - Các lịch sử cùng referenceId/referenceCode của phiếu nhập.
 */
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
        variantName: clean(item.variantName),
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

        const hasVariants =
          Array.isArray(product.variants) && product.variants.length > 0;

        let variant = null;
        let variantName = "";

        if (hasVariants) {
          variantName = clean(item.variantName);

          if (!variantName) {
            throw new Error(
              `Dòng ${i + 1}: vui lòng chọn phân loại cho ${product.title}`,
            );
          }

          variant = findVariant(product, variantName);

          if (!variant) {
            throw new Error(
              `Dòng ${i + 1}: không tìm thấy phân loại "${variantName}" của ${product.title}`,
            );
          }
        } else if (item.variantName) {
          throw new Error(
            `Dòng ${i + 1}: sản phẩm ${product.title} không có phân loại`,
          );
        }

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
          variantName,
          importDate,
          importQty: item.qty,
          remainingQty: item.qty,
          unitCost: item.unitCost,
          importReceiptId: receipt._id,
          source: "manual",
          sourceConfidence: "recorded",
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
};

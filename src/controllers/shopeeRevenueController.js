const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeStockTransaction = require("../models/ShopeeStockTransaction");
const ShopeeRevenueSnapshot = require("../models/ShopeeRevenueSnapshot");

const {
  getShopeeIncomeOverview,
  getShopeeIncomeDetail,
  getShopeeEscrowDetailBatch,
} = require("../services/shopeeService");

// =====================================================
// CONFIG
// =====================================================

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const ESCROW_BATCH_SIZE = 50;

const number = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const text = (value) =>
  value === undefined || value === null ? "" : String(value).trim();

const hasNumber = (value) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  Number.isFinite(Number(value));

function parseDate(value, fieldName) {
  const input = text(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`${fieldName} phải có định dạng YYYY-MM-DD.`);
  }

  const date = new Date(`${input}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input
  ) {
    throw new Error(`${fieldName} không hợp lệ.`);
  }

  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getDateChunks(from, to) {
  const chunks = [];
  let cursor = new Date(from);

  while (cursor <= to) {
    const end = new Date(
      Math.min(cursor.getTime() + 13 * DAY_MS, to.getTime()),
    );

    chunks.push({
      from: formatDate(cursor),
      to: formatDate(end),
    });

    cursor = new Date(end.getTime() + DAY_MS);
  }

  return chunks;
}

function getIncomeStatus(income, fallbackStatus) {
  if (hasNumber(income?.income_status)) {
    return number(income.income_status);
  }

  if (hasNumber(fallbackStatus)) {
    return number(fallbackStatus);
  }

  return income?.released_amount != null ? 1 : 2;
}

function getPayoutAmount(income, orderIncome = {}) {
  if (hasNumber(income?.released_amount)) {
    return number(income.released_amount);
  }

  if (hasNumber(income?.estimated_escrow_amount)) {
    return number(income.estimated_escrow_amount);
  }

  if (hasNumber(orderIncome?.escrow_amount_after_adjustment)) {
    return number(orderIncome.escrow_amount_after_adjustment);
  }

  if (hasNumber(orderIncome?.escrow_amount)) {
    return number(orderIncome.escrow_amount);
  }

  return 0;
}

function getFeeBreakdown(orderIncome = {}) {
  const result = {};

  for (const [key, value] of Object.entries(orderIncome)) {
    const normalizedKey = key.toLowerCase();

    if (
      !normalizedKey.includes("fee") &&
      !normalizedKey.includes("commission")
    ) {
      continue;
    }

    if (hasNumber(value)) {
      result[key] = number(value);
    }
  }

  return result;
}

function getActualPayoutTime(income) {
  const timestamp = number(income?.actual_payout_time);

  if (timestamp <= 0) return null;

  const date = new Date(timestamp * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
}

function unwrapEscrow(result) {
  const data = result?.data || result || {};

  return data.response || data;
}

function getOrderIncome(escrow) {
  return escrow?.order_income || {};
}

// =====================================================
// GET ALL INCOME PAGES
// =====================================================

async function getAllIncomePages(shopId, options) {
  const all = [];
  const seen = new Set();

  let cursor = "";
  let page = 0;

  while (true) {
    page += 1;

    if (page > MAX_PAGES) {
      throw new Error(`Shopee vượt quá giới hạn ${MAX_PAGES} trang doanh thu.`);
    }

    const response = await getShopeeIncomeDetail(shopId, {
      ...options,
      pageSize: PAGE_SIZE,
      cursor,
    });

    const list = Array.isArray(response?.list) ? response.list : [];

    for (const item of list) {
      const orderSn = text(item.order_sn);

      if (!orderSn) continue;

      // Giữ đúng trạng thái từ truy vấn Released/Pending.
      const normalized = {
        ...item,
        income_status: getIncomeStatus(item, options.incomeStatus),
      };

      // Cùng đơn có thể xuất hiện ở nhiều trạng thái.
      // Để bước merge bên ngoài xử lý ưu tiên Released.
      const key = `${orderSn}:${normalized.income_status}`;

      if (seen.has(key)) continue;

      seen.add(key);
      all.push(normalized);
    }

    const nextCursor = text(response?.next_page?.cursor);

    if (!nextCursor || nextCursor === cursor) {
      break;
    }

    cursor = nextCursor;
  }

  return all;
}

// =====================================================
// FIFO COST MAP
// =====================================================

async function getOrderCostMap(shopId, orderSns) {
  const map = new Map();

  if (!orderSns.length) return map;

  const transactions = await ShopeeStockTransaction.find({
    shopId: String(shopId),
    orderSn: { $in: orderSns },
    kind: {
      $in: ["order_export", "return_import"],
    },
    status: "completed",
  }).lean();

  for (const transaction of transactions) {
    const orderSn = text(transaction.orderSn);

    if (!orderSn) continue;

    if (!map.has(orderSn)) {
      map.set(orderSn, {
        exportedCostCny: 0,
        returnedCostCny: 0,
        exportedQty: 0,
        returnedQty: 0,
        hasExport: false,
        hasReturn: false,
      });
    }

    const current = map.get(orderSn);

    for (const allocation of transaction.allocations || []) {
      const qty = Math.max(0, number(allocation.qty));
      const unitCost = Math.max(0, number(allocation.unitCost));
      const cost = qty * unitCost;

      if (transaction.kind === "order_export") {
        current.exportedCostCny += cost;
        current.exportedQty += qty;
        current.hasExport = true;
      }

      if (transaction.kind === "return_import") {
        current.returnedCostCny += cost;
        current.returnedQty += qty;
        current.hasReturn = true;
      }
    }
  }

  return map;
}

// =====================================================
// ESCROW DETAIL
// =====================================================

async function getEscrowMap(shopId, orderSns) {
  const map = new Map();
  const errors = [];

  for (let i = 0; i < orderSns.length; i += ESCROW_BATCH_SIZE) {
    const chunk = orderSns.slice(i, i + ESCROW_BATCH_SIZE);

    const results = await getShopeeEscrowDetailBatch(shopId, chunk);

    for (const result of results || []) {
      const orderSn = text(result.orderSn);

      if (!orderSn) continue;

      if (result.success) {
        map.set(orderSn, unwrapEscrow(result.data));
      } else {
        errors.push({
          orderSn,
          message: result.error || "Không lấy được escrow.",
        });
      }
    }
  }

  return { map, errors };
}

// =====================================================
// BUILD REVENUE ROWS
// =====================================================

async function buildRevenueRows(shopId, incomeList) {
  const orderSns = [
    ...new Set(incomeList.map((item) => text(item.order_sn)).filter(Boolean)),
  ];

  if (!orderSns.length) {
    return {
      rows: [],
      escrowErrors: [],
    };
  }

  const [orders, costMap, escrowResult] = await Promise.all([
    ShopeeOrder.find({
      shopId: String(shopId),
      orderSn: { $in: orderSns },
    }).lean(),

    getOrderCostMap(shopId, orderSns),

    getEscrowMap(shopId, orderSns),
  ]);

  const orderMap = new Map(orders.map((order) => [text(order.orderSn), order]));

  const escrowMap = escrowResult.map;

  const exchangeRate = Math.max(0, number(process.env.CNY_VND_RATE, 3650));

  const rows = [];

  for (const income of incomeList) {
    const orderSn = text(income.order_sn);

    if (!orderSn) continue;

    const order = orderMap.get(orderSn) || null;
    const cost = costMap.get(orderSn);

    const escrow = escrowMap.get(orderSn) || {};
    const orderIncome = getOrderIncome(escrow);

    const incomeStatus = getIncomeStatus(income);

    const payoutAmount = getPayoutAmount(income, orderIncome);

    const exportedCostCny = number(cost?.exportedCostCny);

    const returnedCostCny = number(cost?.returnedCostCny);

    const netCostCny = Math.max(0, exportedCostCny - returnedCostCny);

    const costVnd = netCostCny * exchangeRate;

    const hasReturnedStock = Boolean(cost?.hasReturn);

    const returnOrderList = Array.isArray(escrow?.return_order_sn_list)
      ? escrow.return_order_sn_list
      : [];

    const hasShopeeReturn = returnOrderList.length > 0;

    let profitStatus = "missing_stock_cost";
    let profitVnd = null;

    if (cost?.hasExport) {
      if (hasReturnedStock || hasShopeeReturn) {
        profitStatus = "needs_return_reconciliation";
      } else if (incomeStatus === 2) {
        profitStatus = "pending_estimate";

        // Chỉ là lợi nhuận ước tính, không cộng vào lợi nhuận đã chốt.
        profitVnd = payoutAmount - costVnd;
      } else if (incomeStatus === 1 && hasNumber(income?.released_amount)) {
        profitStatus = "calculated";
        profitVnd = payoutAmount - costVnd;
      }
    }

    const feeBreakdown = getFeeBreakdown(orderIncome);

    rows.push({
      shopId: String(shopId),
      orderSn,

      orderStatus: order?.orderStatus || "",
      orderDate: order?.createTime || null,

      incomeStatus,

      incomeLabel:
        income.status ||
        (incomeStatus === 1 ? "Đã quyết toán" : "Đang chờ quyết toán"),

      currency: text(income.currency || "VND"),

      payoutAmount,
      actualPayoutTime: getActualPayoutTime(income),

      exportedCostCny,
      returnedCostCny,
      netCostCny,

      exchangeRate,
      costVnd,

      profitVnd,
      profitStatus,

      exportedQty: number(cost?.exportedQty),
      returnedQty: number(cost?.returnedQty),

      feeBreakdown,

      buyerUsername: order?.buyerUsername || "",
      totalOrderAmount: number(order?.totalAmount),

      escrowAvailable: Boolean(escrow?.order_income),

      rawIncome: income,
      rawEscrow: escrow,
    });
  }

  return {
    rows,
    escrowErrors: escrowResult.errors,
  };
}

// =====================================================
// SAVE SNAPSHOTS
// =====================================================

async function saveRevenueRows(rows) {
  if (!rows.length) return;

  const operations = rows.map((row) => ({
    updateOne: {
      filter: {
        shopId: row.shopId,
        orderSn: row.orderSn,
      },
      update: {
        $set: {
          shopId: row.shopId,
          orderSn: row.orderSn,

          incomeStatus: row.incomeStatus,
          currency: row.currency,
          payoutAmount: row.payoutAmount,
          actualPayoutTime: row.actualPayoutTime,

          exportedCostCny: row.exportedCostCny,
          returnedCostCny: row.returnedCostCny,
          netCostCny: row.netCostCny,

          exchangeRate: row.exchangeRate,
          costVnd: row.costVnd,
          profitVnd: row.profitVnd,
          profitStatus: row.profitStatus,

          feeBreakdown: row.feeBreakdown,

          rawIncome: row.rawIncome,
          rawEscrow: row.rawEscrow,

          syncedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await ShopeeRevenueSnapshot.bulkWrite(operations, {
    ordered: false,
  });
}

// =====================================================
// SUMMARY
// =====================================================

function sumRows(rows, field) {
  return rows.reduce((total, row) => total + number(row[field]), 0);
}

function buildSummary(rows) {
  const releasedRows = rows.filter((row) => row.incomeStatus === 1);

  const pendingRows = rows.filter((row) => row.incomeStatus === 2);

  const calculatedRows = releasedRows.filter(
    (row) => row.profitStatus === "calculated",
  );

  const pendingEstimateRows = pendingRows.filter(
    (row) => row.profitStatus === "pending_estimate",
  );

  const missingCostRows = rows.filter(
    (row) => row.profitStatus === "missing_stock_cost",
  );

  const returnRows = rows.filter(
    (row) => row.profitStatus === "needs_return_reconciliation",
  );

  return {
    totalOrders: rows.length,

    releasedOrders: releasedRows.length,
    pendingOrders: pendingRows.length,

    releasedAmount: sumRows(releasedRows, "payoutAmount"),

    pendingAmount: sumRows(pendingRows, "payoutAmount"),

    totalExportedCostCny: sumRows(rows, "exportedCostCny"),

    totalReturnedCostCny: sumRows(rows, "returnedCostCny"),

    totalCostVnd: sumRows(calculatedRows, "costVnd"),

    calculatedProfitVnd: sumRows(calculatedRows, "profitVnd"),

    estimatedProfitVnd: sumRows(pendingEstimateRows, "profitVnd"),

    calculatedOrders: calculatedRows.length,
    pendingEstimateOrders: pendingEstimateRows.length,
    missingCostOrders: missingCostRows.length,
    returnReconciliationOrders: returnRows.length,
  };
}

// =====================================================
// GET OVERVIEW
// GET /revenue/overview?shop_id=...
// =====================================================

exports.getRevenueOverviewAsync = async (req, res) => {
  try {
    const shopId = text(req.query.shop_id || req.query.shopId);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const overview = await getShopeeIncomeOverview(shopId);

    return res.json({
      success: true,
      shopId,
      data: overview,
      syncedAt: new Date(),
    });
  } catch (error) {
    console.error("[Shopee Revenue Overview]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải tổng quan doanh thu Shopee.",
    });
  }
};

// =====================================================
// GET REPORT
// GET /revenue/report?shop_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// =====================================================

exports.getRevenueReportAsync = async (req, res) => {
  try {
    const shopId = text(req.query.shop_id || req.query.shopId);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const fromValue = text(req.query.from);
    const toValue = text(req.query.to);

    const from = parseDate(fromValue, "from");
    const to = parseDate(toValue, "to");

    if (from > to) {
      return res.status(400).json({
        success: false,
        message: "Ngày bắt đầu không được lớn hơn ngày kết thúc.",
      });
    }

    const dayCount = Math.floor((to - from) / DAY_MS) + 1;

    if (dayCount > 366) {
      return res.status(400).json({
        success: false,
        message: "Mỗi báo cáo chỉ được truy vấn tối đa 366 ngày.",
      });
    }

    // -----------------------------------------
    // RELEASED: chia từng đoạn tối đa 14 ngày
    // -----------------------------------------

    const chunks = getDateChunks(from, to);
    const releasedLists = [];

    for (const chunk of chunks) {
      const list = await getAllIncomePages(shopId, {
        incomeStatus: 1,
        dateFrom: chunk.from,
        dateTo: chunk.to,
      });

      releasedLists.push(...list);
    }

    // -----------------------------------------
    // PENDING: danh sách hiện tại của Shopee
    // Không phải dữ liệu Pending lịch sử theo ngày.
    // -----------------------------------------

    const pendingList = await getAllIncomePages(shopId, {
      incomeStatus: 2,
    });

    // -----------------------------------------
    // MERGE: ưu tiên Released
    // -----------------------------------------

    const merged = new Map();

    for (const item of [...pendingList, ...releasedLists]) {
      const orderSn = text(item.order_sn);

      if (!orderSn) continue;

      const previous = merged.get(orderSn);

      if (!previous || getIncomeStatus(item) === 1) {
        merged.set(orderSn, item);
      }
    }

    const incomeList = Array.from(merged.values());

    // -----------------------------------------
    // BUILD + SAVE
    // -----------------------------------------

    const { rows, escrowErrors } = await buildRevenueRows(shopId, incomeList);

    await saveRevenueRows(rows);

    const summary = buildSummary(rows);

    return res.json({
      success: true,
      shopId,

      period: {
        from: fromValue,
        to: toValue,
      },

      summary,

      exchangeRate: number(process.env.CNY_VND_RATE, 3650),

      pendingScope: "current",
      pendingNote:
        "Danh sách Pending là các khoản đang chờ hiện tại từ Shopee, không phải lịch sử Pending riêng trong khoảng ngày đã chọn.",

      escrowErrorCount: escrowErrors.length,
      escrowErrors,

      syncedAt: new Date(),

      items: rows,
    });
  } catch (error) {
    console.error("[Shopee Revenue Report]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tạo báo cáo doanh thu Shopee.",
    });
  }
};

// =====================================================
// GET SAVED ORDERS
// GET /revenue/orders?shop_id=...&page=1&limit=50
// =====================================================

exports.getRevenueOrdersAsync = async (req, res) => {
  try {
    const shopId = text(req.query.shop_id || req.query.shopId);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const page = Math.max(1, Math.floor(number(req.query.page, 1)));

    const limit = Math.min(
      100,
      Math.max(1, Math.floor(number(req.query.limit, 50))),
    );

    const filter = {
      shopId,
    };

    if (req.query.status !== undefined && req.query.status !== "") {
      const status = Number(req.query.status);

      if (![0, 1, 2].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Trạng thái đối soát không hợp lệ.",
        });
      }

      filter.incomeStatus = status;
    }

    if (req.query.profitStatus) {
      const allowed = [
        "calculated",
        "pending_estimate",
        "missing_stock_cost",
        "needs_return_reconciliation",
      ];

      if (!allowed.includes(req.query.profitStatus)) {
        return res.status(400).json({
          success: false,
          message: "Trạng thái lợi nhuận không hợp lệ.",
        });
      }

      filter.profitStatus = req.query.profitStatus;
    }

    if (req.query.from || req.query.to) {
      filter.actualPayoutTime = {};

      if (req.query.from) {
        filter.actualPayoutTime.$gte = parseDate(req.query.from, "from");
      }

      if (req.query.to) {
        const end = parseDate(req.query.to, "to");
        end.setUTCHours(23, 59, 59, 999);

        filter.actualPayoutTime.$lte = end;
      }
    }

    const [items, total] = await Promise.all([
      ShopeeRevenueSnapshot.find(filter)
        .sort({
          actualPayoutTime: -1,
          updatedAt: -1,
        })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeRevenueSnapshot.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("[Shopee Revenue Orders]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tải danh sách đối soát.",
    });
  }
};

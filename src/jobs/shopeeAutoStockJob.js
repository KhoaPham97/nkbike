const crypto = require("crypto");
const cron = require("node-cron");

const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeAutoStockSettings = require("../models/ShopeeAutoStockSettings");
const ShopeeAutoStockJobLog = require("../models/ShopeeAutoStockJobLog");
const ShopeeAutoStockJobLock = require("../models/ShopeeAutoStockJobLock");

const {
  deductShopeeOrder,
  refreshShopeeOrderMappings,
} = require("../services/shopeeAutoSyncService");

let scheduledTask = null;
let currentInterval = null;
let isRunning = false;

const LOCK_ID = "SHOPEE_AUTO_STOCK";
const LOCK_DURATION_MS = 30 * 60 * 1000;

function getIntervalExpression(minutes) {
  const allowed = [1, 5, 10, 15, 30, 60];
  const value = allowed.includes(Number(minutes)) ? Number(minutes) : 5;

  return value === 60 ? "0 * * * *" : `*/${value} * * * *`;
}

// =====================================================
// LOCK
// =====================================================

async function acquireLock(ownerToken) {
  const now = new Date();

  try {
    await ShopeeAutoStockJobLock.updateOne(
      { _id: LOCK_ID },
      {
        $setOnInsert: {
          ownerToken: "",
          lockedUntil: null,
          acquiredAt: null,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }

  const lock = await ShopeeAutoStockJobLock.findOneAndUpdate(
    {
      _id: LOCK_ID,
      $or: [
        { lockedUntil: null },
        { lockedUntil: { $exists: false } },
        { lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        ownerToken,
        acquiredAt: now,
        lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
      },
    },
    { new: true },
  );

  return Boolean(lock);
}

async function renewLock(ownerToken) {
  await ShopeeAutoStockJobLock.updateOne(
    {
      _id: LOCK_ID,
      ownerToken,
    },
    {
      $set: {
        lockedUntil: new Date(Date.now() + LOCK_DURATION_MS),
      },
    },
  );
}

async function releaseLock(ownerToken) {
  await ShopeeAutoStockJobLock.updateOne(
    {
      _id: LOCK_ID,
      ownerToken,
    },
    {
      $set: {
        ownerToken: "",
        lockedUntil: null,
        acquiredAt: null,
      },
    },
  );
}

// =====================================================
// PROCESS ONE ORDER
// =====================================================

async function processOneOrder(order) {
  const beforeQty = (order.items || []).reduce(
    (sum, item) => sum + Number(item.deductedQty || 0),
    0,
  );

  try {
    if (String(order.orderStatus).toUpperCase() !== "COMPLETED") {
      return {
        shopId: order.shopId,
        orderSn: order.orderSn,
        status: "skipped",
        message: "Đơn chưa ở trạng thái COMPLETED.",
        stockStatus: order.stockStatus,
        deductedQty: 0,
      };
    }

    if (order.stockDeducted) {
      return {
        shopId: order.shopId,
        orderSn: order.orderSn,
        status: "skipped",
        message: "Đơn đã trừ kho hoàn toàn.",
        stockStatus: "deducted",
        deductedQty: 0,
      };
    }

    // Lấy mapping mới nhất trước khi xuất kho.
    await refreshShopeeOrderMappings(order);

    // Đọc lại dữ liệu mới nhất sau khi cập nhật mapping.
    const freshOrder = await ShopeeOrder.findById(order._id);

    if (!freshOrder) {
      throw new Error("Không tìm thấy đơn Shopee.");
    }

    if (freshOrder.stockDeducted) {
      return {
        shopId: freshOrder.shopId,
        orderSn: freshOrder.orderSn,
        status: "skipped",
        message: "Đơn đã được tiến trình khác xử lý.",
        stockStatus: "deducted",
        deductedQty: 0,
      };
    }

    const eligibleItems = (freshOrder.items || []).filter(
      (item) =>
        item.mappingStatus === "mapped" &&
        item.allowStockDeduction === true &&
        item.productId &&
        item.variantCode,
    );

    if (!eligibleItems.length) {
      return {
        shopId: freshOrder.shopId,
        orderSn: freshOrder.orderSn,
        status: "skipped",
        message: "Đơn chưa có SKU mapping đủ điều kiện trừ kho.",
        stockStatus: freshOrder.stockStatus || "unmapped",
        deductedQty: 0,
      };
    }

    const beforeFreshQty = eligibleItems.reduce(
      (sum, item) => sum + Number(item.deductedQty || 0),
      0,
    );

    // Tái sử dụng logic FIFO + transaction + idempotency hiện có.
    const processed = await deductShopeeOrder(freshOrder);

    const afterQty = (processed.items || []).reduce(
      (sum, item) => sum + Number(item.deductedQty || 0),
      0,
    );

    const deductedQty = Math.max(0, afterQty - beforeFreshQty);

    const stockStatus = processed.stockStatus || "pending";

    if (processed.stockDeducted || stockStatus === "deducted") {
      return {
        shopId: processed.shopId,
        orderSn: processed.orderSn,
        status: "success",
        message: "Đã xử lý trừ kho hoàn tất.",
        stockStatus,
        deductedQty,
      };
    }

    if (stockStatus === "partially_deducted") {
      return {
        shopId: processed.shopId,
        orderSn: processed.orderSn,
        status: "partial",
        message: "Đã trừ một phần. Cần kiểm tra số lượng còn thiếu.",
        stockStatus,
        deductedQty,
      };
    }

    return {
      shopId: processed.shopId,
      orderSn: processed.orderSn,
      status: "skipped",
      message: "Không phát sinh số lượng trừ kho.",
      stockStatus,
      deductedQty,
    };
  } catch (error) {
    console.error(`[Shopee Auto Stock] ${order.orderSn}:`, error);

    return {
      shopId: order.shopId,
      orderSn: order.orderSn,
      status: "failed",
      message: error.message || "Lỗi xử lý trừ kho.",
      stockStatus: order.stockStatus || "failed",
      deductedQty: 0,
    };
  }
}

// =====================================================
// PROCESS ORDERS
// =====================================================

async function processOrders({
  trigger = "cron",
  orderSns = null,
  batchSize = 100,
} = {}) {
  if (isRunning) {
    return {
      skipped: true,
      message: "Auto Stock đang chạy trong tiến trình này.",
    };
  }

  const ownerToken = crypto.randomUUID();
  const locked = await acquireLock(ownerToken);

  if (!locked) {
    return {
      skipped: true,
      message: "Auto Stock đang chạy ở một tiến trình khác.",
    };
  }

  isRunning = true;

  const startedAt = new Date();

  const log = await ShopeeAutoStockJobLog.create({
    trigger,
    status: "running",
    startedAt,
  });

  const results = [];

  try {
    const query = {
      orderStatus: "COMPLETED",
      stockDeducted: { $ne: true },
    };

    if (Array.isArray(orderSns)) {
      query.orderSn = { $in: orderSns };
    }

    const orders = await ShopeeOrder.find(query)
      .sort({ createTime: 1, _id: 1 })
      .limit(Math.max(1, Math.min(Number(batchSize) || 100, 500)));

    for (const order of orders) {
      await renewLock(ownerToken);

      const result = await processOneOrder(order);
      results.push(result);
    }

    const successCount = results.filter(
      (item) => item.status === "success",
    ).length;

    const failedCount = results.filter(
      (item) => item.status === "failed",
    ).length;

    const skippedCount = results.filter(
      (item) => item.status === "skipped",
    ).length;

    const partialCount = results.filter(
      (item) => item.status === "partial",
    ).length;

    const finishedAt = new Date();

    let status = "completed";

    if (failedCount > 0 || partialCount > 0) {
      status = successCount > 0 || skippedCount > 0 ? "partial" : "failed";
    }

    log.status = status;
    log.finishedAt = finishedAt;
    log.durationMs = finishedAt.getTime() - startedAt.getTime();

    log.scannedOrders = orders.length;
    log.successCount = successCount;
    log.failedCount = failedCount;
    log.skippedCount = skippedCount;
    log.partialCount = partialCount;
    log.results = results;

    await log.save();

    await ShopeeAutoStockSettings.findOneAndUpdate(
      { _id: "SHOPEE_AUTO_STOCK_SETTINGS" },
      { $set: { lastRunAt: finishedAt } },
      { upsert: true, setDefaultsOnInsert: true },
    );

    return {
      success: failedCount === 0 && partialCount === 0,
      logId: log._id,
      status,
      scannedOrders: orders.length,
      successCount,
      failedCount,
      skippedCount,
      partialCount,
      results,
    };
  } catch (error) {
    log.status = "failed";
    log.error = error.message || "Auto Stock Job failed.";
    log.finishedAt = new Date();
    log.durationMs = log.finishedAt.getTime() - startedAt.getTime();
    log.results = results;

    await log.save().catch(console.error);

    throw error;
  } finally {
    isRunning = false;
    await releaseLock(ownerToken).catch(console.error);
  }
}

// =====================================================
// RUN SCHEDULE
// =====================================================

async function configureShopeeAutoStockJob() {
  const settings = await ShopeeAutoStockSettings.findById(
    "SHOPEE_AUTO_STOCK_SETTINGS",
  );

  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  currentInterval = null;

  if (!settings || !settings.enabled) {
    console.log("[Shopee Auto Stock] Job đang tắt.");
    return;
  }

  const interval = [1, 5, 10, 15, 30, 60].includes(
    Number(settings.intervalMinutes),
  )
    ? Number(settings.intervalMinutes)
    : 5;

  const expression = getIntervalExpression(interval);

  scheduledTask = cron.schedule(
    expression,
    async () => {
      try {
        const latestSettings = await ShopeeAutoStockSettings.findById(
          "SHOPEE_AUTO_STOCK_SETTINGS",
        );

        if (!latestSettings?.enabled) return;

        await processOrders({
          trigger: "cron",
          batchSize: latestSettings.batchSize || 100,
        });
      } catch (error) {
        console.error("[Shopee Auto Stock Cron]", error);
      }
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  currentInterval = interval;

  console.log(`[Shopee Auto Stock] Đã bật Job, chu kỳ ${interval} phút.`);
}

async function startShopeeAutoStockJob() {
  await configureShopeeAutoStockJob();
}

module.exports = {
  processOrders,
  processOneOrder,
  configureShopeeAutoStockJob,
  startShopeeAutoStockJob,
};

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

// =====================================================
// GLOBAL STATE
// =====================================================

let scheduledTask = null;
let isRunning = false;
let configuringJob = false;

const LOCK_ID = "SHOPEE_AUTO_STOCK";

const LOCK_DURATION_MS = 30 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000;

const ALLOWED_INTERVALS = [1, 5, 10, 15, 30, 60];

// =====================================================
// COMMON HELPERS
// =====================================================

function getIntervalExpression(minutes) {
  const interval = Number(minutes);

  if (interval === 60) {
    return "0 * * * *";
  }

  if (ALLOWED_INTERVALS.includes(interval)) {
    return `*/${interval} * * * *`;
  }

  return "*/5 * * * *";
}

function normalizeBatchSize(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return 100;
  }

  return Math.max(1, Math.min(Math.floor(number), 500));
}

function normalizeEnabled(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (value === true || value === 1 || value === "1" || value === "true") {
    return true;
  }

  if (value === false || value === 0 || value === "0" || value === "false") {
    return false;
  }

  return fallback;
}

function normalizeInterval(value, fallback = 5) {
  const interval = Number(value);

  return ALLOWED_INTERVALS.includes(interval) ? interval : fallback;
}

// =====================================================
// GET SETTINGS - SINGLETON
// =====================================================

async function getAutoStockSettings() {
  try {
    return await ShopeeAutoStockSettings.findOneAndUpdate(
      { _id: LOCK_ID },
      {
        $setOnInsert: {
          enabled: false,
          intervalMinutes: 5,
          batchSize: 100,
          lastRunAt: null,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    if (error.code === 11000) {
      const existing = await ShopeeAutoStockSettings.findById(LOCK_ID);

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
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
    if (error.code !== 11000) {
      throw error;
    }
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
  const result = await ShopeeAutoStockJobLock.updateOne(
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

  return result.modifiedCount > 0;
}

async function releaseLock(ownerToken) {
  return ShopeeAutoStockJobLock.updateOne(
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

    // Cập nhật mapping mới nhất trước khi trừ kho.
    await refreshShopeeOrderMappings(order);

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

    const beforeQty = eligibleItems.reduce(
      (sum, item) => sum + Number(item.deductedQty || 0),
      0,
    );

    // Sử dụng logic FIFO + transaction + idempotency hiện tại.
    const processed = await deductShopeeOrder(freshOrder);

    if (!processed) {
      throw new Error("Không nhận được kết quả xử lý trừ kho.");
    }

    const afterQty = (processed.items || []).reduce(
      (sum, item) => sum + Number(item.deductedQty || 0),
      0,
    );

    const deductedQty = Math.max(0, afterQty - beforeQty);
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
  // Chặn chạy trùng trong cùng Node.js process.
  if (isRunning) {
    return {
      success: false,
      skipped: true,
      message: "Auto Stock đang chạy trong tiến trình này.",
    };
  }

  const ownerToken = crypto.randomUUID();

  // Khóa toàn hệ thống, kể cả nhiều Render instance.
  const locked = await acquireLock(ownerToken);

  if (!locked) {
    return {
      success: false,
      skipped: true,
      message: "Auto Stock đang chạy ở một tiến trình khác.",
    };
  }

  isRunning = true;

  const startedAt = new Date();

  let log = null;
  let heartbeat = null;
  let lockLost = false;

  const results = [];

  try {
    log = await ShopeeAutoStockJobLog.create({
      trigger,
      status: "running",
      startedAt,
    });

    // Gia hạn lock định kỳ.
    heartbeat = setInterval(async () => {
      try {
        const renewed = await renewLock(ownerToken);

        if (!renewed) {
          lockLost = true;

          console.error("[Shopee Auto Stock] Không thể gia hạn lock.");
        }
      } catch (error) {
        console.error("[Shopee Auto Stock] Lỗi gia hạn lock:", error);
      }
    }, LOCK_RENEW_INTERVAL_MS);

    const query = {
      orderStatus: "COMPLETED",
      stockDeducted: { $ne: true },
    };

    if (Array.isArray(orderSns)) {
      query.orderSn = { $in: orderSns };
    }

    const orders = await ShopeeOrder.find(query)
      .sort({ createTime: 1, _id: 1 })
      .limit(normalizeBatchSize(batchSize));

    for (const order of orders) {
      if (lockLost) {
        throw new Error(
          "Auto Stock mất quyền giữ lock. Đã dừng xử lý để tránh chạy trùng.",
        );
      }

      const renewed = await renewLock(ownerToken);

      if (!renewed) {
        lockLost = true;

        throw new Error("Không thể gia hạn lock Auto Stock.");
      }

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
      status =
        successCount > 0 || skippedCount > 0 || partialCount > 0
          ? "partial"
          : "failed";
    }

    // Lưu log kết quả.
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

    // Cập nhật thời điểm chạy gần nhất.
    await ShopeeAutoStockSettings.updateOne(
      { _id: LOCK_ID },
      {
        $set: {
          lastRunAt: finishedAt,
        },
      },
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
    console.error("[Shopee Auto Stock] Job error:", error);

    if (log) {
      log.status = "failed";
      log.error = error.message || "Auto Stock Job failed.";
      log.finishedAt = new Date();
      log.durationMs = log.finishedAt.getTime() - startedAt.getTime();
      log.results = results;

      await log.save().catch((saveError) => {
        console.error("[Shopee Auto Stock] Không thể lưu log lỗi:", saveError);
      });
    }

    throw error;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }

    isRunning = false;

    // Chỉ giải phóng lock của chính tiến trình này.
    await releaseLock(ownerToken).catch((error) => {
      console.error("[Shopee Auto Stock] Không thể giải phóng lock:", error);
    });
  }
}

// =====================================================
// CONFIGURE CRON JOB
// =====================================================

async function configureShopeeAutoStockJob() {
  if (configuringJob) {
    console.log(
      "[Shopee Auto Stock] Đang cấu hình lịch, bỏ qua yêu cầu trùng.",
    );

    return {
      success: false,
      message: "Đang cấu hình lịch.",
    };
  }

  configuringJob = true;

  try {
    const settings = await getAutoStockSettings();

    console.log("[Shopee Auto Stock] Settings:", {
      enabled: settings?.enabled,
      intervalMinutes: settings?.intervalMinutes,
      batchSize: settings?.batchSize,
    });

    // Dừng lịch cũ trước khi tạo lịch mới.
    if (scheduledTask) {
      scheduledTask.stop();
      scheduledTask = null;

      console.log("[Shopee Auto Stock] Đã dừng lịch cũ.");
    }

    if (!settings || !normalizeEnabled(settings.enabled)) {
      console.log("[Shopee Auto Stock] Job đang tắt.");

      return {
        success: true,
        enabled: false,
        message: "Auto Stock đang tắt.",
      };
    }

    const interval = normalizeInterval(settings.intervalMinutes, 5);
    const batchSize = normalizeBatchSize(settings.batchSize);
    const expression = getIntervalExpression(interval);

    scheduledTask = cron.schedule(
      expression,
      async () => {
        const now = new Date().toLocaleString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh",
        });

        console.log(`[Shopee Auto Stock] Cron được kích hoạt lúc ${now}`);

        try {
          // Luôn đọc cấu hình mới nhất trước khi xử lý.
          const latestSettings = await getAutoStockSettings();

          if (!normalizeEnabled(latestSettings?.enabled)) {
            console.log("[Shopee Auto Stock] Đã tắt, bỏ qua lần chạy.");

            return;
          }

          // processOrders tự kiểm tra isRunning và distributed lock.
          const result = await processOrders({
            trigger: "cron",
            batchSize: normalizeBatchSize(latestSettings.batchSize),
          });

          console.log("[Shopee Auto Stock] Kết quả:", JSON.stringify(result));
        } catch (error) {
          console.error("[Shopee Auto Stock] Cron execution error:", error);
        }
      },
      {
        timezone: "Asia/Ho_Chi_Minh",
      },
    );

    console.log(
      `[Shopee Auto Stock] Đã bật lịch thành công.
Chu kỳ: ${interval} phút
Cron: ${expression}
Batch: ${batchSize}`,
    );

    return {
      success: true,
      enabled: true,
      intervalMinutes: interval,
      batchSize,
      cronExpression: expression,
    };
  } catch (error) {
    console.error("[Shopee Auto Stock] Configure error:", error);

    return {
      success: false,
      enabled: false,
      message: error.message,
    };
  } finally {
    configuringJob = false;
  }
}

// =====================================================
// UPDATE AUTO STOCK SETTINGS
// =====================================================

async function updateAutoStockSettings(data = {}) {
  try {
    // Lấy cấu hình hiện tại để hỗ trợ cập nhật từng phần.
    const current = await getAutoStockSettings();

    const enabled = normalizeEnabled(
      data.enabled,
      normalizeEnabled(current?.enabled, false),
    );

    const interval = normalizeInterval(
      data.intervalMinutes,
      normalizeInterval(current?.intervalMinutes, 5),
    );

    const batchSize =
      data.batchSize !== undefined
        ? normalizeBatchSize(data.batchSize)
        : normalizeBatchSize(current?.batchSize);

    const settings = await ShopeeAutoStockSettings.findOneAndUpdate(
      { _id: LOCK_ID },
      {
        $set: {
          enabled,
          intervalMinutes: interval,
          batchSize,
        },
        $setOnInsert: {
          lastRunAt: null,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    );

    // Cấu hình lại cron ngay sau khi lưu.
    const job = await configureShopeeAutoStockJob();

    return {
      success: true,
      message: enabled ? "Đã bật Auto Stock." : "Đã tắt Auto Stock.",
      settings,
      job,
    };
  } catch (error) {
    console.error("[Shopee Auto Stock] Update settings error:", error);

    throw error;
  }
}

// =====================================================
// START JOB
// =====================================================

async function startShopeeAutoStockJob() {
  return configureShopeeAutoStockJob();
}

// =====================================================
// STOP JOB
// =====================================================

function stopShopeeAutoStockJob() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  console.log("[Shopee Auto Stock] Đã dừng cron job.");

  return {
    success: true,
    message: "Đã dừng Auto Stock.",
  };
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  processOrders,
  processOneOrder,

  getAutoStockSettings,
  updateAutoStockSettings,

  configureShopeeAutoStockJob,
  startShopeeAutoStockJob,
  stopShopeeAutoStockJob,
};

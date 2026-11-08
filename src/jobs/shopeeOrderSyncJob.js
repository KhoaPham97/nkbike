const crypto = require("crypto");
const cron = require("node-cron");

const ShopeeAutoStockJobLock = require("../models/ShopeeAutoStockJobLock");
const { syncAllShopeeOrders } = require("../services/shopeeAutoSyncService");

const LOCK_ID = "SHOPEE_ORDER_SYNC";
const LOCK_DURATION_MS = 30 * 60 * 1000;
const RENEW_INTERVAL_MS = 60 * 1000;

let scheduledTask = null;
let isRunning = false;
let currentIo = null;

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
  const result = await ShopeeAutoStockJobLock.updateOne(
    { _id: LOCK_ID, ownerToken },
    {
      $set: {
        lockedUntil: new Date(Date.now() + LOCK_DURATION_MS),
      },
    },
  );

  return result.modifiedCount > 0;
}

async function releaseLock(ownerToken) {
  await ShopeeAutoStockJobLock.updateOne(
    { _id: LOCK_ID, ownerToken },
    {
      $set: {
        ownerToken: "",
        lockedUntil: null,
        acquiredAt: null,
      },
    },
  );
}

function emitSyncEvent(result) {
  if (!currentIo) return;

  const namespace = currentIo.of("/shopee-orders");

  namespace.to("shopee:admins").emit("shopee:orders:synced", {
    shopId: String(result.shopId),
    fetched: Number(result.fetched || 0),
    saved: Number(result.saved || 0),
    reserved: Number(result.reserved || 0),
    deducted: Number(result.deducted || 0),
    released: Number(result.released || 0),
    errorCount: Array.isArray(result.errors)
      ? result.errors.length
      : result.error
        ? 1
        : 0,
    syncedAt: new Date().toISOString(),
  });
}

async function runShopeeOrderSync() {
  if (isRunning) {
    return {
      success: false,
      skipped: true,
      message: "Shopee Order Sync đang chạy trong tiến trình này.",
    };
  }

  const ownerToken = crypto.randomUUID();
  const locked = await acquireLock(ownerToken);

  if (!locked) {
    return {
      success: false,
      skipped: true,
      message: "Shopee Order Sync đang chạy ở tiến trình khác.",
    };
  }

  isRunning = true;

  let heartbeat = null;
  let lockLost = false;

  try {
    heartbeat = setInterval(async () => {
      try {
        const renewed = await renewLock(ownerToken);

        if (!renewed) {
          lockLost = true;
          console.error("[Shopee Order Sync] Mất quyền giữ lock.");
        }
      } catch (error) {
        console.error("[Shopee Order Sync] Lỗi gia hạn lock:", error);
      }
    }, RENEW_INTERVAL_MS);

    const results = await syncAllShopeeOrders();

    if (lockLost) {
      throw new Error("Shopee Order Sync đã mất quyền giữ lock.");
    }

    for (const result of results) {
      emitSyncEvent(result);
    }

    console.log(
      "[Shopee Order Sync] Hoàn tất:",
      JSON.stringify(
        results.map((item) => ({
          shopId: item.shopId,
          fetched: item.fetched || 0,
          saved: item.saved || 0,
          errors: item.errors?.length || (item.error ? 1 : 0),
        })),
      ),
    );

    return {
      success: true,
      results,
    };
  } catch (error) {
    console.error("[Shopee Order Sync] Lỗi:", error);

    return {
      success: false,
      error: error.message || String(error),
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);

    isRunning = false;

    await releaseLock(ownerToken).catch((error) => {
      console.error("[Shopee Order Sync] Không thể giải phóng lock:", error);
    });
  }
}

function startShopeeOrderSyncJob(io) {
  if (io) currentIo = io;

  if (scheduledTask) {
    console.log("[Shopee Order Sync] Lịch đã được khởi tạo.");
    return {
      success: true,
      message: "Lịch đồng bộ đã tồn tại.",
    };
  }

  scheduledTask = cron.schedule(
    "*/5 * * * *",
    async () => {
      console.log("[Shopee Order Sync] Bắt đầu đồng bộ đơn hàng.");

      const result = await runShopeeOrderSync();

      console.log("[Shopee Order Sync] Kết quả:", result);
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  console.log("[Shopee Order Sync] Đã bật lịch 5 phút/lần.");

  return {
    success: true,
    intervalMinutes: 5,
  };
}

function stopShopeeOrderSyncJob() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  console.log("[Shopee Order Sync] Đã dừng lịch.");

  return {
    success: true,
  };
}

module.exports = {
  startShopeeOrderSyncJob,
  stopShopeeOrderSyncJob,
  runShopeeOrderSync,
};

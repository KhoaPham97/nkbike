const { syncAllShopeeOrders } = require("./shopeeAutoSyncService");
const { isBackgroundJobsEnabled } = require("../utils/backgroundJobs");

let timer = null;
let isRunning = false;

async function runShopeeSync() {
  if (isRunning) {
    console.log("[Shopee Scheduler] Lượt đồng bộ trước chưa hoàn tất.");
    return;
  }

  isRunning = true;

  try {
    const results = await syncAllShopeeOrders();

    console.log(
      "[Shopee Scheduler] Kết quả đồng bộ:",
      JSON.stringify(results, null, 2),
    );

    return results;
  } catch (error) {
    console.error("[Shopee Scheduler] Lỗi:", error.message || error);

    throw error;
  } finally {
    isRunning = false;
  }
}

function startShopeeAutoSync({
  intervalMs = 60_000,
  runImmediately = true,
} = {}) {
  if (!isBackgroundJobsEnabled()) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    console.log("[Shopee Scheduler] Bỏ qua: background jobs đang tắt trên deployment này.");
    return false;
  }

  if (timer) {
    console.log("[Shopee Scheduler] Scheduler đã được khởi động.");
    return;
  }

  const interval = Math.max(15_000, Number(intervalMs) || 60_000);

  if (runImmediately) {
    runShopeeSync().catch(() => {});
  }

  timer = setInterval(() => {
    runShopeeSync().catch(() => {});
  }, interval);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  console.log(`[Shopee Scheduler] Đang chạy mỗi ${interval / 1000} giây.`);
}

function stopShopeeAutoSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  console.log("[Shopee Scheduler] Đã dừng.");
}

module.exports = {
  startShopeeAutoSync,
  stopShopeeAutoSync,
  runShopeeSync,
};

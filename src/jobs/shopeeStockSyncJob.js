const cron = require("node-cron");
const { isBackgroundJobsEnabled } = require("../utils/backgroundJobs");

const {
  getStockSyncSettings,
  runShopeeStockSync,
} = require("../services/shopeeStockSyncService");

let scheduledTask = null;
let configuringJob = false;

async function configureShopeeStockSyncJob() {
  if (!isBackgroundJobsEnabled()) {
    if (scheduledTask) {
      scheduledTask.stop();
      scheduledTask = null;
    }
    console.log("[Shopee Stock Sync] Bỏ qua: background jobs đang tắt trên deployment này.");
    return { success: true, enabled: false, skipped: true, reason: "background_jobs_disabled" };
  }

  if (configuringJob) {
    return {
      success: false,
      message: "Đang cấu hình lịch đồng bộ.",
    };
  }

  configuringJob = true;

  try {
    const settings = await getStockSyncSettings();

    if (scheduledTask) {
      scheduledTask.stop();
      scheduledTask = null;
    }

    if (!settings.enabled) {
      console.log("[Shopee Stock Sync] Cron đang tắt.");

      return {
        success: true,
        enabled: false,
      };
    }

    scheduledTask = cron.schedule(
      "*/5 * * * *",
      async () => {
        console.log("[Shopee Stock Sync] Cron bắt đầu.");

        try {
          const latestSettings = await getStockSyncSettings();

          if (!latestSettings.enabled) {
            console.log("[Shopee Stock Sync] Đã tắt, bỏ qua.");
            return;
          }

          const result = await runShopeeStockSync({
            trigger: "cron",
          });

          console.log("[Shopee Stock Sync] Kết quả:", JSON.stringify(result));
        } catch (error) {
          console.error("[Shopee Stock Sync] Cron execution error:", error);
        }
      },
      {
        timezone: "Asia/Ho_Chi_Minh",
      },
    );

    console.log("[Shopee Stock Sync] Đã bật cron mỗi 5 phút.");

    return {
      success: true,
      enabled: true,
      intervalMinutes: 5,
      cronExpression: "*/5 * * * *",
    };
  } catch (error) {
    console.error("[Shopee Stock Sync] Configure error:", error);

    throw error;
  } finally {
    configuringJob = false;
  }
}

async function startShopeeStockSyncJob() {
  return configureShopeeStockSyncJob();
}

function stopShopeeStockSyncJob() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  console.log("[Shopee Stock Sync] Đã dừng cron.");

  return {
    success: true,
    message: "Đã dừng cron đồng bộ tồn kho.",
  };
}

module.exports = {
  configureShopeeStockSyncJob,
  startShopeeStockSyncJob,
  stopShopeeStockSyncJob,
};

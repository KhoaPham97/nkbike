const cron = require("node-cron");
const { isBackgroundJobsEnabled } = require("../utils/backgroundJobs");
const ShopeeShop = require("../models/ShopeeShop");
const { getShopeeItemIds } = require("../services/shopeeService");
const { getAllShopeeReviews } = require("../services/shopeeReviewService");
const { persistShopeeReviews } = require("../services/shopeeReviewSyncService");

let runningPromise = null;
let task = null;

function extractItemIds(result) {
  let items = [];
  if (Array.isArray(result)) items = result;
  else if (Array.isArray(result?.itemIds)) items = result.itemIds;
  else if (Array.isArray(result?.items)) items = result.items;

  return [...new Set(items.map((item) => {
    const value = typeof item === "object" && item
      ? (item.itemId ?? item.item_id ?? item.itemID)
      : item;
    const id = String(value ?? "").trim();
    return /^\d+$/.test(id) ? id : "";
  }).filter(Boolean))];
}

async function executeShopeeReviewSync() {
  if (runningPromise) return runningPromise;
  runningPromise = (async () => {
    const shops = await ShopeeShop.find({ shopId: { $exists: true, $ne: "" } }).lean();
    const results = [];

    for (const shop of shops) {
      const shopId = String(shop.shopId);
      try {
        const itemResult = await getShopeeItemIds({
          shopId,
          itemStatuses: ["NORMAL", "UNLIST", "BANNED", "REVIEWING", "SELLER_DELETE", "SHOPEE_DELETE"],
          pageSize: 100,
        });
        const itemIds = extractItemIds(itemResult);
        if (!itemIds.length) {
          results.push({ shopId, itemCount: 0, saved: 0 });
          continue;
        }

        const scan = await getAllShopeeReviews({
          shopId,
          itemIds,
          pageSize: 100,
          requestDelay: 300,
          maxPagesPerItem: 1000,
        });
        const persisted = await persistShopeeReviews({ shopId, reviews: scan.reviews || [] });
        const result = {
          shopId,
          itemCount: itemIds.length,
          pages: scan.totalPages || 0,
          scanErrors: scan.errors || [],
          ...persisted,
        };
        results.push(result);
        console.log("[SHOPEE REVIEW SYNC]", result);
      } catch (error) {
        console.error("[SHOPEE REVIEW SYNC] Shop failed:", shopId, error.message);
        results.push({ shopId, error: error.message });
      }
    }
    return { success: true, shops: results };
  })().finally(() => { runningPromise = null; });
  return runningPromise;
}

function startShopeeReviewSyncJob() {
  if (!isBackgroundJobsEnabled()) {
    if (task) {
      task.stop();
      task = null;
    }
    console.log("[SHOPEE REVIEW SYNC] Bỏ qua: background jobs đang tắt trên deployment này.");
    return false;
  }

  if (task) task.stop();
  task = cron.schedule("0 */6 * * *", () => {
    executeShopeeReviewSync().catch((error) =>
      console.error("[SHOPEE REVIEW SYNC] Scheduled run failed:", error),
    );
  }, { timezone: "Asia/Ho_Chi_Minh" });

  executeShopeeReviewSync().catch((error) =>
    console.error("[SHOPEE REVIEW SYNC] Initial run failed:", error),
  );
  console.log("[SHOPEE REVIEW SYNC] Scheduled every 6 hours.");
  return true;
}

module.exports = { startShopeeReviewSyncJob, executeShopeeReviewSync };

const cron = require("node-cron");
const { isBackgroundJobsEnabled } = require("../utils/backgroundJobs");
const controller = require("../controllers/shopeeDocumentController");
function startShopeeDocumentJob() {
  if (!isBackgroundJobsEnabled()) { console.log("[Shopee Documents] Background job disabled on this deployment."); return null; }
  const pollTask = cron.schedule("*/2 * * * *", async () => {
    try { await controller.pollPendingDocuments(); } catch (e) { console.error("[Shopee Documents] polling cron failed:", e); }
  }, { timezone: "Asia/Ho_Chi_Minh" });
  const monthlyTask = cron.schedule("20 3 2 * *", async () => {
    try { await controller.createPreviousMonthForAllShops(); } catch (e) { console.error("[Shopee Documents] monthly cron failed:", e); }
  }, { timezone: "Asia/Ho_Chi_Minh" });
  console.log("[Shopee Documents] Polling every 2 minutes; monthly generation on day 2 at 03:20.");
  return { pollTask, monthlyTask };
}
module.exports = { startShopeeDocumentJob };

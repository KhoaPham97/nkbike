const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");
const {
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
} = require("../controllers/inventoryBatchController");

router.get("/", auth, adminAuth, listInventoryBatchesAsync);
router.get("/reconciliation", auth, adminAuth, getBatchReconciliationAsync);
router.post(
  "/rebuild-historical",
  auth,
  adminAuth,
  rebuildHistoricalBatchesAsync,
);
router.post(
  "/backfill-current-stock",
  auth,
  adminAuth,
  backfillCurrentStockAsync,
);
router.get("/product/:productId", auth, adminAuth, getProductBatchesAsync);
router.get("/:id/history", auth, adminAuth, getInventoryBatchHistoryAsync);
router.put(
  "/orders/:orderId/allocations",
  auth,
  adminAuth,
  updateOrderBatchAllocationsAsync,
);
router.post(
  "/orders/:orderId/deduct",
  auth,
  adminAuth,
  deductOrderStockByBatchesAsync,
);
router.post("/import", importNewBatchAsync);
router.post("/import-multiple", auth, adminAuth, importMultipleBatchesAsync);
module.exports = router;

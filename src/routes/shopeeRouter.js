const express = require("express");
const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const shopeeController = require("../controllers/shopeeController");
const shopeeOrderController = require("../controllers/shopeeOrderController");
const shopeeStockController = require("../controllers/shopeeStockController");
const shopeeAutoStockController = require("../controllers/shopeeAutoStockController");
const shopeeRevenueController = require("../controllers/shopeeRevenueController");
const shopeeProductManagementController = require("../controllers/shopeeProductManagementController");
const shopeeStockSyncController = require("../controllers/shopeeStockSyncController");

const adminAuth = [auth, adminOnly];

// =====================================================
// AUTHENTICATION & SHOP MANAGEMENT
// =====================================================

router.post("/auth", ...adminAuth, shopeeController.connectShopee);

router.get("/callback", shopeeController.shopeeCallback);

router.get("/shops", ...adminAuth, shopeeController.getShopeeShops);

router.post(
  "/refresh-token",
  ...adminAuth,
  shopeeController.refreshShopeeToken,
);

router.delete(
  "/shops/:shopId",
  ...adminAuth,
  shopeeController.disconnectShopeeShop,
);

// =====================================================
// ORDER SYNC
// =====================================================

router.post(
  "/orders/sync",
  ...adminAuth,
  shopeeOrderController.syncOrdersAsync,
);

router.get("/orders", ...adminAuth, shopeeOrderController.getOrdersAsync);

router.get(
  "/orders/:orderSn",
  ...adminAuth,
  shopeeOrderController.getOrderDetailAsync,
);

router.get(
  "/sync/status",
  ...adminAuth,
  shopeeOrderController.getSyncStatusAsync,
);

// =====================================================
// SKU MAPPING
// =====================================================

router.get(
  "/management/sku-mappings",
  ...adminAuth,
  shopeeController.getSkuMappingsAsync,
);

router.post(
  "/management/sku-mappings",
  ...adminAuth,
  shopeeController.createSkuMappingAsync,
);

router.put(
  "/management/sku-mappings/:id",
  ...adminAuth,
  shopeeController.updateSkuMappingAsync,
);

router.delete(
  "/management/sku-mappings/:id",
  ...adminAuth,
  shopeeController.deleteSkuMappingAsync,
);

router.post(
  "/management/sku-mappings/auto-match",
  ...adminAuth,
  shopeeController.autoMatchSkuMappingsAsync,
);

// =====================================================
// STOCK MANAGEMENT
// =====================================================

// Tổng quan tồn kho Shopee
router.get(
  "/stock/summary",
  ...adminAuth,
  shopeeStockController.getStockSummaryAsync,
);

// Danh sách giao dịch tồn kho
router.get(
  "/stock/transactions",
  ...adminAuth,
  shopeeStockController.getStockTransactionsAsync,
);

// Danh sách đơn cần xử lý kho
router.get(
  "/stock/pending-orders",
  ...adminAuth,
  shopeeStockController.getPendingStockOrdersAsync,
);

// Chi tiết trạng thái kho của đơn
router.get(
  "/stock/orders/:orderSn",
  ...adminAuth,
  shopeeStockController.getOrderStockDetailAsync,
);

// Giữ tồn kho cho đơn
router.post(
  "/stock/orders/:orderSn/reserve",
  ...adminAuth,
  shopeeStockController.reserveOrderStockAsync,
);

// Xác nhận trừ kho FIFO
router.post(
  "/stock/orders/:orderSn/deduct",
  ...adminAuth,
  shopeeStockController.deductOrderStockAsync,
);

// Giải phóng tồn kho khi đơn bị hủy
router.post(
  "/stock/orders/:orderSn/release",
  ...adminAuth,
  shopeeStockController.releaseOrderStockAsync,
);

// =====================================================
// ORDER STOCK OPERATIONS
// =====================================================

// Xem trước phân bổ FIFO
router.post(
  "/orders/:orderSn/stock/preview",
  ...adminAuth,
  shopeeStockController.previewStockDeductionAsync,
);

// Xuất kho theo đơn
router.post(
  "/orders/:orderSn/stock/deduct",
  ...adminAuth,
  shopeeStockController.deductStockAsync,
);

// Lịch sử giao dịch kho theo đơn
router.get(
  "/orders/:orderSn/stock/history",
  ...adminAuth,
  shopeeStockController.getStockHistoryAsync,
);

// Tiếp nhận hàng hoàn
router.post(
  "/orders/:orderSn/returns/receive",
  ...adminAuth,
  shopeeStockController.receiveReturnAsync,
);

// =====================================================
// AUTO STOCK MANAGEMENT
// =====================================================

router.get(
  "/auto-stock/orders",
  ...adminAuth,
  shopeeAutoStockController.getAutoStockOrdersAsync,
);

router.get(
  "/auto-stock/history",
  ...adminAuth,
  shopeeAutoStockController.getAutoStockHistoryAsync,
);

router.get(
  "/auto-stock/settings",
  ...adminAuth,
  shopeeAutoStockController.getAutoStockSettingsAsync,
);

router.put(
  "/auto-stock/settings",
  ...adminAuth,
  shopeeAutoStockController.updateAutoStockSettingsAsync,
);

router.post(
  "/auto-stock/run",
  ...adminAuth,
  shopeeAutoStockController.runAutoStockNowAsync,
);

router.post(
  "/auto-stock/process-selected",
  ...adminAuth,
  shopeeAutoStockController.processSelectedOrdersAsync,
);
// =====================================================
// REVENUE / FINANCE
// =====================================================

router.get(
  "/revenue/overview",
  ...adminAuth,
  shopeeRevenueController.getRevenueOverviewAsync,
);

router.get(
  "/revenue/report",
  ...adminAuth,
  shopeeRevenueController.getRevenueReportAsync,
);

router.get(
  "/revenue/orders",
  ...adminAuth,
  shopeeRevenueController.getRevenueOrdersAsync,
);

// =====================================================
// SHOPEE LIVE PRODUCT MANAGEMENT
// =====================================================

// Danh sách sản phẩm trực tiếp từ Shopee
router.get(
  "/management/products",
  ...adminAuth,
  shopeeProductManagementController.getProducts,
);

// Chi tiết sản phẩm và phân loại
router.get(
  "/management/products/:itemId",
  ...adminAuth,
  shopeeProductManagementController.getProductDetail,
);

// Cập nhật tên, mô tả, cân nặng, kích thước
router.put(
  "/management/products/:itemId",
  ...adminAuth,
  shopeeProductManagementController.updateProductInfo,
);

// Cập nhật giá từng phân loại
router.put(
  "/management/products/:itemId/prices",
  ...adminAuth,
  shopeeProductManagementController.updateProductPrices,
);

// Cập nhật tồn kho từng phân loại
router.put(
  "/management/products/:itemId/stock",
  ...adminAuth,
  shopeeProductManagementController.updateProductStock,
);
// =====================================================
// SHOPEE AUTO STOCK SYNC
// =====================================================

// Trạng thái đồng bộ
router.get(
  "/stock-sync/status",
  ...adminAuth,
  shopeeStockSyncController.getStatusAsync,
);

// Cấu hình đồng bộ
router.get(
  "/stock-sync/settings",
  ...adminAuth,
  shopeeStockSyncController.getSettingsAsync,
);

// Cập nhật cấu hình bật/tắt
router.put(
  "/stock-sync/settings",
  ...adminAuth,
  shopeeStockSyncController.updateSettingsAsync,
);

// Chạy đồng bộ thủ công
router.post(
  "/stock-sync/run",
  ...adminAuth,
  shopeeStockSyncController.runNowAsync,
);

// Lịch sử đồng bộ
router.get(
  "/stock-sync/history",
  ...adminAuth,
  shopeeStockSyncController.getHistoryAsync,
);
module.exports = router;

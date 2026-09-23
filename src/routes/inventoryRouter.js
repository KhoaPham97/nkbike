const express = require("express");

const router = express.Router();

const inventoryController = require("../controllers/inventoryController");

// ============================================================
// NHẬP KHO
// ============================================================

// Tạo phiếu nhập
router.post("/import", inventoryController.importInventoryAsync);

// Danh sách phiếu nhập
router.get("/import", inventoryController.listInventoryImportsAsync);

// Chi tiết phiếu nhập
router.get("/import/:id", inventoryController.getInventoryImportAsync);

module.exports = router;

const express = require("express");

const router = express.Router();

const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");

const {
  createInventoryReceiptAsync,
  listInventoryReceiptsAsync,
  getInventoryReceiptDetailAsync,
} = require("../controllers/inventoryController");

// =====================================================
// TẠO PHIẾU NHẬP
// POST /api/inventory
// =====================================================
router.post("/", auth, adminAuth, createInventoryReceiptAsync);

// =====================================================
// DANH SÁCH PHIẾU NHẬP
// GET /api/inventory
// =====================================================
router.get("/", auth, adminAuth, listInventoryReceiptsAsync);

// =====================================================
// CHI TIẾT PHIẾU NHẬP
// GET /api/inventory/:id
// =====================================================
router.get("/:id", auth, adminAuth, getInventoryReceiptDetailAsync);

module.exports = router;

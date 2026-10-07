const express = require("express");

const {
  getAllVehicles,
  getVehicleById,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  getVehicleBrands,
  getVehiclesByBrand,
  getVehicleProducts,
} = require("../controllers/vehicleController");

const router = express.Router();

// ============================================================
// VEHICLE
// ============================================================

// GET /api/vehicles
// Danh sách xe
router.get("/", getAllVehicles);

// GET /api/vehicles/brands
// Danh sách hãng xe
//
// Ví dụ:
// /api/vehicles/brands?type=2
router.get("/brands", getVehicleBrands);

// GET /api/vehicles/by-brand
// Danh sách xe theo hãng
//
// Ví dụ:
// /api/vehicles/by-brand?brand=YADEA&type=2
router.get("/by-brand", getVehiclesByBrand);

// GET /api/vehicles/:id/products
// Danh sách sản phẩm/phụ tùng tương thích với xe
//
// Ví dụ:
// /api/vehicles/68abc123/products
//
// LƯU Ý:
// Route này phải nằm TRƯỚC /:id
router.get("/:id/products", getVehicleProducts);

// GET /api/vehicles/:id
// Chi tiết xe
router.get("/:id", getVehicleById);

// POST /api/vehicles
// Tạo xe
router.post("/", createVehicle);

// PUT /api/vehicles/:id
// Cập nhật xe
router.put("/:id", updateVehicle);

// DELETE /api/vehicles/:id
// Xóa xe
router.delete("/:id", deleteVehicle);

module.exports = router;

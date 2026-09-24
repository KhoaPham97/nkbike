const express = require("express");

const router = express.Router();

const categoryController = require("../controllers/categoryController");

// =====================================================
// CATEGORY ROUTES
// =====================================================

// GET tất cả category
router.get("/categorys", categoryController.getCategories);

// GET category theo ID
router.get("/categorys/:id", categoryController.getCategoryById);

// POST tạo category
router.post("/categorys", categoryController.createCategory);

// PATCH cập nhật category
router.patch("/categorys/:id", categoryController.updateCategory);

// DELETE category
router.delete("/categorys/:id", categoryController.deleteCategory);

module.exports = router;

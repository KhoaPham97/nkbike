const express = require("express");

// category Controller
const categoryController = require("../controllers/categoryController");

// Auth Middleware
const auth = require("../middlewares/auth");

// Admin Access Middleware
const adminAuth = require("../middlewares/adminAuth");

// Upload image middleware
const {
  uploadImageMiddleware,
  uploadImageBase64,
  editMiddleware,
} = require("../middlewares/uploadImage");

// Search category Query Middleware

const router = express.Router();

// Public access
router.get("/api/categorys", categoryController.listAllCategorysAsync);
// router.get("/api/category/:id", categoryController.getcategoryAsync);

// Admin access only
router.post(
  "/api/category",
  //   uploadImageBase64,
  categoryController.createcategoryAsync
);
router.patch("/api/category/", categoryController.updateCategoryAsync);

router.delete("/api/category/all", categoryController.deleteAll);

module.exports = router;

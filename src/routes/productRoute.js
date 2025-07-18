const express = require("express");

// Product Controller
const productController = require("../controllers/productController");

// Auth Middleware
const auth = require("../middlewares/auth");

// Admin Access Middleware
const adminAuth = require("../middlewares/adminAuth");

// Upload image middleware
const {
  uploadImageMiddleware,
  editMiddleware,
} = require("../middlewares/uploadImage");

// Search Product Query Middleware
const {
  productQuery,
  productsYouMayLike,
} = require("../middlewares/productQuery");

const router = express.Router();
router.delete("/api/product/all", productController.deleteAll);

// Public access
router.get("/api/products", productController.listAllProductsAsync);
router.get("/api/product/:id", productController.getProductAsync);

// Get Products by category
router.get("/api/products/men", productQuery, productController.getMenProduct);
router.get(
  "/api/products/women",
  productQuery,
  productController.getWomenProduct
);
router.get(
  "/api/products/discount",
  productQuery,
  productController.getDiscountedProduct
);
router.get(
  "/api/products/kids",
  productQuery,
  productController.getKidsProduct
);
router.get(
  "/api/products/new-arrivals",
  productController.getNewArrivalsProduct
);

router.get(
  "/api/products-you-may-like",
  productsYouMayLike,
  productController.getProductsYouMayLike
);

// Admin access only
router.post("/api/product", productController.createProductAsync);
router.patch("/api/product", productController.updateProductAsync);

router.delete(
  "/api/product/:id",
  auth,
  adminAuth,
  productController.deleteProductAsync
);

module.exports = router;

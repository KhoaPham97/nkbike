const express = require("express");

// Import auth middleware

// Import Cart Controller
const cartController = require("../controllers/cartController");

// Cart Manipulation
const cart = require("../middlewares/cartManipulations");

const router = express.Router();

// Add locally stored items into cart once the user logs in
router.post(
  "/api/user/:id/move-cart-to-db",
  cart.moveToCartDatabase,
  cartController.moveCartToDB,
);

router.post(
  "/api/user/:id/cart",
  cart.addToCartMiddleware,
  cartController.addToCart,
);

router.patch("/api/user/:id/update-cart", cartController.updateCart);
router.patch("/api/user/:id/remove", cartController.deleteItemInCart);
router.patch("/api/user/:id/removeAll", cartController.removeCartItems);

module.exports = router;

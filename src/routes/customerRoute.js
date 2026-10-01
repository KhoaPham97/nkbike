const express = require("express");

const router = express.Router();

const customerController = require("../controllers/customerController");
router.get("/:id/orders", customerController.getCustomerOrdersAsync);
router.get("/", customerController.listCustomersAsync);

router.get("/:id", customerController.getCustomerByIdAsync);

router.post("/", customerController.createCustomerAsync);

router.put("/:id", customerController.updateCustomerAsync);

router.patch("/:id/debt", customerController.updateCustomerDebtAsync);
router.post(
  "/update-multiple",
  customerController.updateMultipleCustomersAsync,
);
router.delete("/:id", customerController.deleteCustomerAsync);
router.put("/:id/password", customerController.changeCustomerPasswordAsync);
router.post("/login", customerController.loginCustomerAsync);
module.exports = router;

const express = require("express");

const router = express.Router();

const customerController = require("../controllers/customerController");
router.get("/:id/orders", customerController.getCustomerOrdersAsync);
router.get("/", customerController.listCustomersAsync);

router.get("/:id", customerController.getCustomerByIdAsync);

router.post("/", customerController.createCustomerAsync);

router.put("/:id", customerController.updateCustomerAsync);

router.patch("/:id/debt", customerController.updateCustomerDebtAsync);

router.delete("/:id", customerController.deleteCustomerAsync);

module.exports = router;

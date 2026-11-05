const express = require("express");
const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const controller = require("../controllers/shopeeInventoryController");

router.use(auth, adminOnly);

router.post("/orders/:orderSn/export", controller.exportOrderItem);

router.post("/returns/:returnSn/receive", controller.receiveReturnItem);

router.get("/transactions", controller.getTransactions);

module.exports = router;

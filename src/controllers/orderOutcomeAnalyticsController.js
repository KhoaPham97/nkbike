const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");

const isCancelled = (status = "") =>
  /CANCEL/i.test(String(status)) || /HỦY|HUY/i.test(String(status));

const isActiveCustomerReturn = (record = {}) => {
  const status = String(record.status || record.shopeeReturnStatus || record.shopeeStatus || "").toUpperCase();
  return record.returnType === "CUSTOMER_RETURN" &&
    !["CANCELLED", "CANCEL", "REJECTED", "REQUEST_CANCELLED"].includes(status);
};

const rate = (numerator, denominator) =>
  denominator ? Number((numerator / denominator * 100).toFixed(2)) : 0;

const clean = (value) => String(value || "").trim();

const getBuyer = (order = {}) => {
  const raw = order.rawData || {};
  const buyerUserId = clean(order.buyerUserId || raw.buyer_user_id || raw.buyerUserId);
  const buyerUsername = clean(order.buyerUsername || raw.buyer_username || raw.buyerUsername);
  const key = buyerUserId || buyerUsername || "unknown";
  return {
    key,
    buyerUserId,
    buyerUsername: buyerUsername || (buyerUserId ? `User ${buyerUserId}` : "Không xác định"),
  };
};

const getProductKey = (item = {}) =>
  clean(item.productId || item.itemId || item.variationSku || item.itemSku || item.itemName || "unknown");

const getReturnedQty = (returnItem = {}) =>
  Math.max(0, Number(returnItem.receivedQty || 0));

exports.getOrderOutcomeByProvince = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const start = fromDate ? new Date(fromDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = toDate ? new Date(new Date(toDate).setHours(23, 59, 59, 999)) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return res.status(400).json({ success: false, message: "Khoảng ngày không hợp lệ" });
    }

    // Chỉ truy vấn ShopeeOrder; tuyệt đối không gộp đơn nội bộ.
    const shopeeOrders = await ShopeeOrder.find({ createTime: { $gte: start, $lte: end } })
      .select("orderSn orderStatus buyerUserId buyerUsername items createTime rawData")
      .lean();

    const orderSns = shopeeOrders.map((order) => order.orderSn).filter(Boolean);
    const returnRecords = orderSns.length
      ? await ShopeeReturn.find({ orderSn: { $in: orderSns }, returnType: "CUSTOMER_RETURN" })
          .select("orderSn buyerUsername status shopeeReturnStatus shopeeStatus items returnSn returnReason reason")
          .lean()
      : [];

    const activeReturns = returnRecords.filter(isActiveCustomerReturn);
    const returnsByOrder = new Map();
    activeReturns.forEach((record) => {
      const key = String(record.orderSn);
      if (!returnsByOrder.has(key)) returnsByOrder.set(key, []);
      returnsByOrder.get(key).push(record);
    });

    const byBuyer = new Map();
    const byProduct = new Map();
    let cancelledOrders = 0;
    let returnedOrders = 0;
    let soldQty = 0;
    let returnedQty = 0;

    for (const order of shopeeOrders) {
      const orderSn = String(order.orderSn || "");
      const cancelled = isCancelled(order.orderStatus);
      const orderReturns = returnsByOrder.get(orderSn) || [];
      const returned = orderReturns.length > 0;
      if (cancelled) cancelledOrders += 1;
      if (returned) returnedOrders += 1;

      const buyer = getBuyer(order);
      const buyerRow = byBuyer.get(buyer.key) || {
        ...buyer, totalOrders: 0, cancelledOrders: 0, returnedOrders: 0, orderSns: [],
      };
      buyerRow.totalOrders += 1;
      if (cancelled) buyerRow.cancelledOrders += 1;
      if (returned) buyerRow.returnedOrders += 1;
      buyerRow.orderSns.push(orderSn);
      if (!buyerRow.buyerUsername || buyerRow.buyerUsername === "Không xác định") {
        const returnBuyer = orderReturns.find((item) => clean(item.buyerUsername));
        if (returnBuyer) buyerRow.buyerUsername = clean(returnBuyer.buyerUsername);
      }
      byBuyer.set(buyer.key, buyerRow);

      const returnItems = orderReturns.flatMap((record) => record.items || []);
      for (const item of order.items || []) {
        const quantity = Math.max(0, Number(item.quantity || 0));
        soldQty += quantity;
        const productKey = getProductKey(item);
        const productRow = byProduct.get(productKey) || {
          key: productKey,
          productId: item.productId || null,
          itemId: clean(item.itemId),
          itemSku: clean(item.variationSku || item.itemSku),
          productName: clean(item.itemName) || "Sản phẩm chưa có tên",
          modelName: clean(item.modelName),
          soldQty: 0,
          returnedQty: 0,
          returnedOrderCount: 0,
          orderSns: [],
        };
        productRow.soldQty += quantity;
        productRow.orderSns.push(orderSn);

        const matchingReturns = returnItems.filter((returnedItem) => {
          const sameItem = clean(returnedItem.itemId) && clean(returnedItem.itemId) === clean(item.itemId);
          const sameModel = clean(returnedItem.modelId) && clean(returnedItem.modelId) === clean(item.modelId);
          const sameSku = clean(returnedItem.variationSku || returnedItem.itemSku) &&
            clean(returnedItem.variationSku || returnedItem.itemSku) === clean(item.variationSku || item.itemSku);
          return (sameItem && (!clean(item.modelId) || sameModel)) || sameSku;
        });
        const qtyFromReturnRecords = matchingReturns.reduce((sum, returnedItem) => sum + getReturnedQty(returnedItem), 0);
        // Fallback cho dữ liệu kho cũ đã ghi nhận số lượng nhận hoàn trên đơn.
        const qtyFromOrder = Number(item.returnedQty || 0);
        const qty = Math.min(quantity, Math.max(qtyFromReturnRecords, qtyFromOrder));
        if (qty > 0) {
          productRow.returnedQty += qty;
          productRow.returnedOrderCount += 1;
          returnedQty += qty;
        }
        byProduct.set(productKey, productRow);
      }
    }

    const buyers = [...byBuyer.values()].map((row) => ({
      ...row,
      cancellationRate: rate(row.cancelledOrders, row.totalOrders),
      returnRate: rate(row.returnedOrders, row.totalOrders),
    })).sort((a, b) => (b.returnRate + b.cancellationRate) - (a.returnRate + a.cancellationRate));

    const products = [...byProduct.values()].map((row) => ({
      ...row,
      returnRate: rate(row.returnedQty, row.soldQty),
    })).sort((a, b) => b.returnRate - a.returnRate || b.returnedQty - a.returnedQty);

    const totals = {
      totalOrders: shopeeOrders.length,
      cancelledOrders,
      returnedOrders,
      soldQty,
      returnedQty,
    };

    return res.json({
      success: true,
      data: {
        totals,
        cancellationRate: rate(cancelledOrders, shopeeOrders.length),
        returnRate: rate(returnedOrders, shopeeOrders.length),
        buyerStats: buyers,
        productStats: products,
        period: { fromDate: start, toDate: end },
      },
    });
  } catch (error) {
    console.error("ORDER OUTCOME ANALYTICS:", error);
    return res.status(500).json({ success: false, message: "Không thể tải thống kê hủy/trả hàng" });
  }
};

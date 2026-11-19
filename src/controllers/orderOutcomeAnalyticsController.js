const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");

const getProvince = (address = "") => {
  const parts = String(address)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(việt nam|viet nam|vietnam)$/i.test(part));
  if (!parts.length) return "Không xác định";
  // Địa chỉ giao hàng thường kết thúc bằng tỉnh/thành; bỏ hậu tố quốc gia nếu có.
  return parts[parts.length - 1];
};

const isCancelled = (status = "") =>
  /CANCEL/i.test(String(status)) || /HỦY|HUY/i.test(String(status));

const isReturned = (record) => {
  const status = String(record.status || record.shopeeReturnStatus || record.shopeeStatus || "").toUpperCase();
  return record.returnType === "CUSTOMER_RETURN" &&
    !["CANCELLED", "CANCEL", "REJECTED", "REQUEST_CANCELLED"].includes(status);
};

exports.getOrderOutcomeByProvince = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const start = fromDate ? new Date(fromDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = toDate ? new Date(new Date(toDate).setHours(23, 59, 59, 999)) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return res.status(400).json({ success: false, message: "Khoảng ngày không hợp lệ" });
    }
    const dateFilter = { $gte: start, $lte: end };
    const shopeeOrders = await ShopeeOrder.find({ createTime: dateFilter })
      .select("orderSn orderStatus recipientAddress createTime")
      .lean();
    const shopeeSns = shopeeOrders.map((order) => order.orderSn).filter(Boolean);
    const returns = shopeeSns.length
      ? await ShopeeReturn.find({ orderSn: { $in: shopeeSns }, returnType: "CUSTOMER_RETURN" })
          .select("orderSn returnType status shopeeReturnStatus shopeeStatus").lean()
      : [];
    const returnedSns = new Set(returns.filter(isReturned).map((item) => String(item.orderSn)));
    const byProvince = new Map();
    const add = (address, outcome) => {
      const province = getProvince(address);
      const row = byProvince.get(province) || { province, totalOrders: 0, cancelledOrders: 0, returnedOrders: 0 };
      row.totalOrders += 1;
      if (outcome.cancelled) row.cancelledOrders += 1;
      if (outcome.returned) row.returnedOrders += 1;
      byProvince.set(province, row);
    };
    shopeeOrders.forEach((order) => add(order.recipientAddress, {
      cancelled: isCancelled(order.orderStatus),
      returned: returnedSns.has(String(order.orderSn)),
    }));
    const rows = [...byProvince.values()].map((row) => ({
      ...row,
      cancellationRate: row.totalOrders ? Number((row.cancelledOrders / row.totalOrders * 100).toFixed(2)) : 0,
      returnRate: row.totalOrders ? Number((row.returnedOrders / row.totalOrders * 100).toFixed(2)) : 0,
    })).sort((a, b) => b.totalOrders - a.totalOrders);
    const totals = rows.reduce((sum, row) => ({
      totalOrders: sum.totalOrders + row.totalOrders,
      cancelledOrders: sum.cancelledOrders + row.cancelledOrders,
      returnedOrders: sum.returnedOrders + row.returnedOrders,
    }), { totalOrders: 0, cancelledOrders: 0, returnedOrders: 0 });
    res.json({
      success: true,
      data: {
        totals,
        cancellationRate: totals.totalOrders ? Number((totals.cancelledOrders / totals.totalOrders * 100).toFixed(2)) : 0,
        returnRate: totals.totalOrders ? Number((totals.returnedOrders / totals.totalOrders * 100).toFixed(2)) : 0,
        provinces: rows,
        period: { fromDate: start, toDate: end },
      },
    });
  } catch (error) {
    console.error("ORDER OUTCOME ANALYTICS:", error);
    res.status(500).json({ success: false, message: "Không thể tải thống kê hủy/trả hàng" });
  }
};

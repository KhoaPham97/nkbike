const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");

const cleanProvince = (value) => {
  const text = String(value || "").trim();
  if (!text || /\*{2,}|x{3,}/i.test(text) || /^(việt nam|viet nam|vietnam)$/i.test(text)) return "";
  return text;
};

const getProvince = (order = {}) => {
  const rawAddress = order.rawData?.recipient_address || order.rawData?.recipientAddress || {};
  // Shopee trả về các thành phần địa chỉ riêng; state thường là tỉnh/thành tại Việt Nam.
  const structured = [
    order.recipientProvince,
    rawAddress.state,
    rawAddress.province,
    rawAddress.province_name,
    rawAddress.city,
  ];
  for (const candidate of structured) {
    const province = cleanProvince(candidate);
    if (province) return province;
  }

  // Chỉ dùng full_address làm phương án dự phòng nếu phần cuối không bị Shopee che.
  const parts = String(order.recipientAddress || rawAddress.full_address || "")
    .split(",")
    .map((part) => cleanProvince(part))
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Chưa xác định";
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
      .select("orderSn orderStatus recipientAddress recipientProvince rawData createTime")
      .lean();
    const shopeeSns = shopeeOrders.map((order) => order.orderSn).filter(Boolean);
    const returns = shopeeSns.length
      ? await ShopeeReturn.find({ orderSn: { $in: shopeeSns }, returnType: "CUSTOMER_RETURN" })
          .select("orderSn returnType status shopeeReturnStatus shopeeStatus").lean()
      : [];
    const returnedSns = new Set(returns.filter(isReturned).map((item) => String(item.orderSn)));
    const byProvince = new Map();
    const add = (order, outcome) => {
      const province = getProvince(order);
      const row = byProvince.get(province) || { province, totalOrders: 0, cancelledOrders: 0, returnedOrders: 0 };
      row.totalOrders += 1;
      if (outcome.cancelled) row.cancelledOrders += 1;
      if (outcome.returned) row.returnedOrders += 1;
      byProvince.set(province, row);
    };
    shopeeOrders.forEach((order) => add(order, {
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

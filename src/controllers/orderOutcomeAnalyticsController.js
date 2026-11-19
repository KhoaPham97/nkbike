const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");

// Tên tỉnh/thành hiện hành và tên địa giới cũ để xử lý cả đơn cũ.
const VIETNAM_PROVINCES = [
  "An Giang", "Bà Rịa - Vũng Tàu", "Bắc Giang", "Bắc Kạn", "Bạc Liêu",
  "Bắc Ninh", "Bến Tre", "Bình Định", "Bình Dương", "Bình Phước",
  "Bình Thuận", "Cà Mau", "Cần Thơ", "Cao Bằng", "Đà Nẵng", "Đắk Lắk",
  "Đắk Nông", "Điện Biên", "Đồng Nai", "Đồng Tháp", "Gia Lai", "Hà Giang",
  "Hà Nam", "Hà Nội", "Hà Tĩnh", "Hải Dương", "Hải Phòng", "Hậu Giang",
  "Hòa Bình", "Hồ Chí Minh", "Hưng Yên", "Khánh Hòa", "Kiên Giang",
  "Kon Tum", "Lai Châu", "Lâm Đồng", "Lạng Sơn", "Lào Cai", "Long An",
  "Nam Định", "Nghệ An", "Ninh Bình", "Ninh Thuận", "Phú Thọ", "Phú Yên",
  "Quảng Bình", "Quảng Nam", "Quảng Ngãi", "Quảng Ninh", "Quảng Trị",
  "Sóc Trăng", "Sơn La", "Tây Ninh", "Thái Bình", "Thái Nguyên",
  "Thanh Hóa", "Thừa Thiên Huế", "Tiền Giang", "Trà Vinh", "Tuyên Quang",
  "Vĩnh Long", "Vĩnh Phúc", "Yên Bái",
  // Tên tỉnh/thành sau sắp xếp địa giới năm 2025.
  "Đắk Lắk", "Lâm Đồng", "Gia Lai", "Đồng Nai", "Tây Ninh", "Cần Thơ",
  "Đồng Tháp", "Vĩnh Long", "An Giang", "Cà Mau", "Bắc Ninh", "Hưng Yên",
  "Ninh Bình", "Phú Thọ", "Thái Nguyên", "Quảng Ngãi", "Khánh Hòa",
  "Lào Cai", "Tuyên Quang", "Hải Phòng", "Đà Nẵng", "Quảng Trị",
  "Hồ Chí Minh", "Huế"
];

const normalizeAddressText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const cleanProvince = (value) => {
  const text = String(value || "").trim();
  if (!text || /\*{2,}|x{3,}/i.test(text) || /^(việt nam|viet nam|vietnam)$/i.test(text)) return "";
  return text;
};

const findKnownProvince = (values = []) => {
  const combined = normalizeAddressText(values.filter(Boolean).join(" "));
  if (!combined) return "";
  const candidates = [...new Set(VIETNAM_PROVINCES)]
    .sort((a, b) => normalizeAddressText(b).length - normalizeAddressText(a).length);
  for (const province of candidates) {
    const normalized = normalizeAddressText(province);
    if ((` ${combined} `).includes(` ${normalized} `)) {
      return province;
    }
  }
  // Các cách viết tắt phổ biến của TP.HCM và TP.Hà Nội.
  if (/(^| )(tp hcm|tphcm|hcm|sai gon)( |$)/.test(combined)) return "Hồ Chí Minh";
  if (/(^| )(tp ha noi|tphn)( |$)/.test(combined)) return "Hà Nội";
  return "";
};

const getProvince = (order = {}) => {
  const rawAddress = order.rawData?.recipient_address || order.rawData?.recipientAddress || {};
  const candidates = [
    order.recipientProvince,
    rawAddress.state,
    rawAddress.province,
    rawAddress.province_name,
    rawAddress.city,
    rawAddress.full_address,
    rawAddress.address,
    order.recipientAddress,
  ];

  // Tìm theo danh sách địa danh trên toàn bộ chuỗi, không mặc định tỉnh luôn nằm cuối.
  const knownProvince = findKnownProvince(candidates);
  if (knownProvince) return knownProvince;

  // Nếu Shopee có trả riêng state nhưng không thuộc danh sách địa danh VN.
  for (const candidate of [order.recipientProvince, rawAddress.state, rawAddress.province, rawAddress.province_name]) {
    const province = cleanProvince(candidate);
    if (province) return province;
  }
  return "Chưa xác định";
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

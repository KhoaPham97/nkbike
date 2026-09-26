const InventoryHistory = require("../models/inventoryHistory");

const listInventoryHistoryAsync = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "", type = "all" } = req.query;

    const currentPage = Math.max(Number(page) || 1, 1);

    const currentLimit = Math.min(Number(limit) || 20, 100);

    const skip = (currentPage - 1) * currentLimit;

    const filter = {};

    // ============================================
    // TYPE
    // ============================================

    if (type && type !== "all") {
      filter.type = type;
    }

    // ============================================
    // SEARCH
    // ============================================

    const keyword = String(search || "").trim();

    if (keyword) {
      filter.$or = [
        {
          productTitle: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          productCode: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          referenceCode: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          variantName: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          note: {
            $regex: keyword,
            $options: "i",
          },
        },
      ];
    }

    // ============================================
    // QUERY
    // ============================================

    const [histories, total] = await Promise.all([
      InventoryHistory.find(filter)
        .sort({
          created_at: -1,
        })
        .skip(skip)
        .limit(currentLimit)
        .lean(),

      InventoryHistory.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil(total / currentLimit), 1);

    return res.status(200).json({
      success: true,

      histories,

      total,

      page: currentPage,

      limit: currentLimit,

      totalPages,

      hasMore: currentPage < totalPages,
    });
  } catch (error) {
    console.error("listInventoryHistoryAsync:", error);

    return res.status(500).json({
      success: false,

      message: error?.message || "Không thể lấy lịch sử kho",
    });
  }
};

module.exports = {
  listInventoryHistoryAsync,
};

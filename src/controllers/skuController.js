const { Product } = require("../models/products");

// =====================================================
// GET SKU MANAGEMENT
// GET /api/admin/sku
// =====================================================

exports.getSkuManagement = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();
    const type = String(req.query.type || "all");
    const status = String(req.query.status || "all");

    // Chỉ đọc dữ liệu, tuyệt đối không cập nhật Product
    const products = await Product.find({
      variants: { $exists: true, $ne: [] },
    })
      .select("_id title name code type categoryId variants")
      .lean();

    const rows = [];

    for (const product of products) {
      const variants = product.variants || [];

      variants.forEach((variant, index) => {
        rows.push({
          id: `${product._id}_${variant._id || index}`,
          productId: String(product._id),

          productName: product.title || product.name || "Chưa có tên",

          productCode: product.code || "",
          type: String(product.type || ""),

          variantName:
            variant.name ||
            variant.variantName ||
            variant.title ||
            variant.value ||
            `Biến thể ${index + 1}`,

          variantCode: String(variant.variantCode || "").trim(),
          sku: String(variant.sku || "").trim(),
        });
      });
    }

    // =================================================
    // DETECT DUPLICATE
    // =================================================

    const skuCounts = new Map();
    const variantCodeCounts = new Map();

    rows.forEach((row) => {
      if (row.sku) {
        skuCounts.set(row.sku, (skuCounts.get(row.sku) || 0) + 1);
      }

      if (row.variantCode) {
        variantCodeCounts.set(
          row.variantCode,
          (variantCodeCounts.get(row.variantCode) || 0) + 1,
        );
      }
    });

    rows.forEach((row) => {
      const duplicateSku = row.sku && skuCounts.get(row.sku) > 1;

      const duplicateVariantCode =
        row.variantCode && variantCodeCounts.get(row.variantCode) > 1;

      row.missing = !row.sku || !row.variantCode;

      row.duplicate = Boolean(duplicateSku || duplicateVariantCode);

      row.status = row.duplicate
        ? "duplicate"
        : row.missing
          ? "missing"
          : "complete";
    });

    // =================================================
    // STATISTICS
    // =================================================

    const stats = {
      total: rows.length,

      withSku: rows.filter((row) => row.sku).length,

      missing: rows.filter((row) => row.missing).length,

      duplicate: rows.filter((row) => row.duplicate).length,
    };

    // =================================================
    // FILTER
    // =================================================

    let filtered = rows;

    if (type !== "all") {
      filtered = filtered.filter((row) => row.type === type);
    }

    if (status !== "all") {
      filtered = filtered.filter((row) => row.status === status);
    }

    if (search) {
      filtered = filtered.filter((row) => {
        const values = [
          row.productName,
          row.productCode,
          row.variantName,
          row.variantCode,
          row.sku,
        ];

        return values.some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(search),
        );
      });
    }

    // =================================================
    // SORT
    // =================================================

    filtered.sort((a, b) => {
      return (
        a.productName.localeCompare(b.productName, "vi") ||
        a.variantName.localeCompare(b.variantName, "vi")
      );
    });

    // =================================================
    // PAGINATION
    // =================================================

    const total = filtered.length;

    const totalPages = Math.max(1, Math.ceil(total / limit));

    const data = filtered.slice((page - 1) * limit, page * limit);

    return res.json({
      success: true,

      data,

      stats,

      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("[SKU MANAGEMENT]", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách SKU.",
      error: error.message,
    });
  }
};

// =====================================================
// EXPORT CSV
// GET /api/admin/sku/export.csv
// =====================================================

exports.exportSkuManagement = async (req, res) => {
  try {
    const products = await Product.find({
      variants: { $exists: true, $ne: [] },
    })
      .select("title name code type variants")
      .lean();

    const rows = [];

    for (const product of products) {
      (product.variants || []).forEach((variant, index) => {
        rows.push([
          product.title || product.name || "",
          product.code || "",
          product.type || "",
          variant.name ||
            variant.variantName ||
            variant.title ||
            variant.value ||
            `Biến thể ${index + 1}`,
          variant.variantCode || "",
          variant.sku || "",
        ]);
      });
    }

    const escapeCsv = (value) => {
      return `"${String(value ?? "").replace(/"/g, '""')}"`;
    };

    const header = [
      "Tên sản phẩm",
      "Mã sản phẩm",
      "Loại sản phẩm",
      "Biến thể",
      "Variant Code",
      "SKU",
    ];

    const csv =
      "\uFEFF" +
      [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="nhat-khang-bike-sku.csv"',
    );

    return res.send(csv);
  } catch (error) {
    console.error("[SKU EXPORT]", error);

    return res.status(500).json({
      success: false,
      message: "Xuất danh sách SKU thất bại.",
    });
  }
};

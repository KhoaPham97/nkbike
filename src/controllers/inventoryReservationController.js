const mongoose = require("mongoose");

const Order = require("../models/orders");
const ShopeeOrder = require("../models/ShopeeOrder"); // Sửa đúng tên file model nếu khác
const { Product } = require("../models/products");

const ACTIVE_WEBSITE_STATUSES = ["pending", "confirmed", "shipping"];

const n = (value) => {
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : 0;
};

const clean = (value) => String(value || "").trim();

const getVariantKey = (variantCode, variantName = "") => {
  const code = clean(variantCode);
  if (code) return `CODE:${code}`;

  const name = clean(variantName);
  return name ? `NAME:${name}` : "DEFAULT";
};

const getProductTypeName = (type) => {
  const map = {
    1: "Phụ tùng xe đạp",
    2: "Phụ tùng xe điện",
    3: "Phụ tùng xe ba gác",
  };

  return map[String(type)] || "Khác";
};

const getProductVariant = (product, variantCode, variantName) => {
  const variants = Array.isArray(product.variants) ? product.variants : [];

  if (variantCode) {
    return (
      variants.find(
        (variant) =>
          clean(variant.variantCode).toUpperCase() ===
          clean(variantCode).toUpperCase(),
      ) || null
    );
  }

  if (variantName) {
    return (
      variants.find((variant) => clean(variant.name) === clean(variantName)) ||
      null
    );
  }

  return null;
};

const makeOrderLine = ({ source, order, item, qty, product }) => {
  const isShopee = source === "shopee";

  return {
    source,
    sourceLabel: isShopee ? "Shopee" : "Website",

    orderId: String(order._id),
    orderCode: isShopee ? clean(order.orderSn) : clean(order.code),

    orderStatus: isShopee ? clean(order.orderStatus) : clean(order.status),

    stockStatus: isShopee
      ? clean(order.stockStatus)
      : order.stockReserved
        ? "reserved"
        : order.stockDeducted
          ? "deducted"
          : "not_reserved",

    customerName: isShopee
      ? clean(order.recipientName || order.buyerUsername)
      : clean(order.customerName),

    customerPhone: isShopee
      ? clean(order.recipientPhone)
      : clean(order.customerPhone),

    productId: String(item.productId),
    productTitle: product.title || item.productTitle || item.itemName || "",

    variantName: clean(item.variantName || item.modelName || ""),

    variantCode: clean(item.variantCode || item.variationSku || ""),

    sku: clean(item.itemSku || ""),
    qty: n(qty),

    createdAt: isShopee
      ? order.createTime || order.createdAt
      : order.created_at,

    updatedAt: isShopee
      ? order.updateTime || order.updatedAt
      : order.updated_at,
  };
};

/**
 * GET /api/inventory/reservations
 *
 * Query:
 *  search
 *  source = all | website | shopee
 *  type = all | 1 | 2 | 3
 *  page
 *  limit
 */
const getReservations = async (req, res) => {
  try {
    const search = clean(req.query.search).toLowerCase();
    const sourceFilter = clean(req.query.source || "all").toLowerCase();
    const typeFilter = clean(req.query.type || "all");

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 30),
    );

    const [products, websiteOrders, shopeeOrders] = await Promise.all([
      Product.find({})
        .select("_id title code brand type qty thumbnail variants isVisible")
        .lean(),

      Order.find({
        status: { $in: ACTIVE_WEBSITE_STATUSES },
        $or: [{ stockReserved: true }, { stockDeducted: true }],
      })
        .select(
          "_id code status customerName customerPhone items created_at updated_at stockDeducted stockReserved",
        )
        .lean(),

      // Không lọc orderStatus ở đây:
      // Nếu một đơn bị hủy nhưng dữ liệu reservedQty chưa được giải phóng,
      // vẫn phải hiển thị để phát hiện tồn giữ bất thường.
      ShopeeOrder.find({
        "items.reservedQty": { $gt: 0 },
      })
        .select(
          "_id shopId orderSn orderStatus recipientName recipientPhone buyerUsername items createTime updateTime stockStatus stockDeducted",
        )
        .lean(),
    ]);

    const productMap = new Map(
      products.map((product) => [String(product._id), product]),
    );

    const reservationMap = new Map();

    const ensureProduct = (product) => {
      const productId = String(product._id);

      if (!reservationMap.has(productId)) {
        reservationMap.set(productId, {
          productId,
          title: product.title || "",
          code: product.code || "",
          brand: product.brand || "",
          type: String(product.type || ""),
          typeName: getProductTypeName(product.type),
          thumbnail: product.thumbnail || "",
          physicalQty: n(product.qty),
          websiteQty: 0,
          websiteReservedQty: 0,
          shopeeReservedQty: 0,
          totalOrders: 0,
          variants: new Map(),
        });
      }

      return reservationMap.get(productId);
    };

    const ensureVariant = (row, product, variantCode, variantName) => {
      const key = getVariantKey(variantCode, variantName);

      if (!row.variants.has(key)) {
        const productVariant = getProductVariant(
          product,
          variantCode,
          variantName,
        );

        row.variants.set(key, {
          key,
          variantName:
            clean(variantName) || clean(productVariant?.name) || "Mặc định",

          variantCode: clean(variantCode) || clean(productVariant?.variantCode),

          sku: clean(productVariant?.sku),

          physicalQty: productVariant ? n(productVariant.qty) : n(product.qty),

          productReservedQty: productVariant
            ? n(productVariant.reservedQty)
            : 0,

          websiteQty: 0,
          websiteReservedQty: 0,
          shopeeReservedQty: 0,
          orders: [],
        });
      }

      return row.variants.get(key);
    };

    // =====================================================
    // WEBSITE
    // Website đã trừ tồn kho khi tạo đơn.
    // Chỉ thống kê cam kết đơn hàng, KHÔNG trừ tồn lần nữa.
    // =====================================================

    if (sourceFilter === "all" || sourceFilter === "website") {
      for (const order of websiteOrders) {
        for (const item of order.items || []) {
          if (!item.productId) continue;

          const product = productMap.get(String(item.productId));
          if (!product) continue;

          const qty = n(item.qty);
          if (qty <= 0) continue;

          const row = ensureProduct(product);

          const variant = ensureVariant(
            row,
            product,
            item.variantCode,
            item.variantName,
          );

          row.websiteQty += qty;
          variant.websiteQty += qty;
          if (order.stockReserved === true) {
            row.websiteReservedQty += qty;
            variant.websiteReservedQty += qty;
          }

          variant.orders.push(
            makeOrderLine({
              source: "website",
              order,
              item,
              qty,
              product,
            }),
          );
        }
      }
    }

    // =====================================================
    // SHOPEE
    // item.reservedQty hiện tại là lượng còn giữ.
    // Khi xuất kho hoặc giải phóng, service đã giảm trường này.
    // =====================================================

    if (sourceFilter === "all" || sourceFilter === "shopee") {
      for (const order of shopeeOrders) {
        for (const item of order.items || []) {
          const qty = n(item.reservedQty);

          if (qty <= 0 || !item.productId) continue;

          // Chỉ nhận mapping đã xác nhận.
          if (
            item.mappingStatus !== "mapped" ||
            item.allowStockDeduction !== true
          ) {
            continue;
          }

          const product = productMap.get(String(item.productId));
          if (!product) continue;

          const variantCode = clean(item.variantCode);

          // Với sản phẩm có biến thể, yêu cầu variantCode để tránh
          // ghép nhầm hai biến thể trùng tên.
          if (
            Array.isArray(product.variants) &&
            product.variants.length > 0 &&
            !variantCode
          ) {
            continue;
          }

          const row = ensureProduct(product);

          const variant = ensureVariant(
            row,
            product,
            variantCode,
            item.variantName,
          );

          row.shopeeReservedQty += qty;
          variant.shopeeReservedQty += qty;

          variant.orders.push(
            makeOrderLine({
              source: "shopee",
              order,
              item,
              qty,
              product,
            }),
          );
        }
      }
    }

    // =====================================================
    // FORMAT
    // =====================================================

    let rows = Array.from(reservationMap.values()).map((row) => {
      const variants = Array.from(row.variants.values()).map((variant) => {
        const orders = variant.orders.sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
        );

        return {
          ...variant,
          availableQty: Math.max(
            0,
            variant.physicalQty -
              variant.websiteReservedQty -
              variant.shopeeReservedQty,
          ),
          totalOrders: orders.length,
          orders,
        };
      });

      const totalOrders = variants.reduce(
        (sum, variant) => sum + variant.totalOrders,
        0,
      );

      return {
        ...row,
        variants,
        totalOrders,

        // Website đã trừ kho khi tạo đơn.
        // Chỉ Shopee reservedQty mới tiếp tục chiếm tồn vật lý.
        availableQty: Math.max(
          0,
          row.physicalQty - row.websiteReservedQty - row.shopeeReservedQty,
        ),

        hasReservation: row.websiteQty > 0 || row.shopeeReservedQty > 0,
      };
    });

    rows = rows.filter((row) => row.hasReservation);

    if (typeFilter !== "all") {
      rows = rows.filter((row) => row.type === typeFilter);
    }

    if (search) {
      rows = rows.filter((row) => {
        const productMatch = [row.title, row.code, row.brand, row.productId]
          .join(" ")
          .toLowerCase()
          .includes(search);

        const variantMatch = row.variants.some((variant) =>
          [variant.variantName, variant.variantCode, variant.sku]
            .join(" ")
            .toLowerCase()
            .includes(search),
        );

        const orderMatch = row.variants.some((variant) =>
          variant.orders.some((order) =>
            [order.orderCode, order.customerName, order.customerPhone]
              .join(" ")
              .toLowerCase()
              .includes(search),
          ),
        );

        return productMatch || variantMatch || orderMatch;
      });
    }

    rows.sort(
      (a, b) =>
        b.shopeeReservedQty +
        b.websiteQty -
        (a.shopeeReservedQty + a.websiteQty),
    );

    const summary = rows.reduce(
      (result, row) => {
        result.totalProducts += 1;
        result.websiteQty += row.websiteQty;
        result.websiteReservedQty += row.websiteReservedQty;
        result.shopeeReservedQty += row.shopeeReservedQty;
        result.totalOrders += row.totalOrders;
        return result;
      },
      {
        totalProducts: 0,
        websiteQty: 0,
        websiteReservedQty: 0,
        shopeeReservedQty: 0,
        totalOrders: 0,
      },
    );

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const paginatedRows = rows.slice((page - 1) * limit, page * limit);

    return res.json({
      success: true,
      data: paginatedRows,
      summary,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("[getReservations]", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải dữ liệu theo dõi hàng giữ",
      error: error.message,
    });
  }
};

// =====================================================
// CHI TIẾT MỘT SẢN PHẨM
// GET /api/inventory/reservations/:productId
// =====================================================

const getReservationDetail = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "productId không hợp lệ",
      });
    }

    const result = await getReservationsInternal(productId);

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[getReservationDetail]", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết hàng giữ",
      error: error.message,
    });
  }
};

// Dùng lại logic đọc dữ liệu cho trang chi tiết.
async function getReservationsInternal(productId) {
  const product = await Product.findById(productId)
    .select("_id title code brand type qty thumbnail variants")
    .lean();

  if (!product) return null;

  const [websiteOrders, shopeeOrders] = await Promise.all([
    Order.find({
      status: { $in: ACTIVE_WEBSITE_STATUSES },
      $or: [{ stockReserved: true }, { stockDeducted: true }],
      "items.productId": product._id,
    }).lean(),

    ShopeeOrder.find({
      "items.productId": product._id,
      "items.reservedQty": { $gt: 0 },
    }).lean(),
  ]);

  const variants = new Map();

  const getOrCreate = (code, name) => {
    const key = getVariantKey(code, name);

    if (!variants.has(key)) {
      const productVariant = getProductVariant(product, code, name);

      variants.set(key, {
        variantName: clean(name) || productVariant?.name || "Mặc định",
        variantCode: clean(code) || clean(productVariant?.variantCode),
        sku: clean(productVariant?.sku),
        physicalQty: productVariant ? n(productVariant.qty) : n(product.qty),
        productReservedQty: productVariant ? n(productVariant.reservedQty) : 0,
        websiteQty: 0,
        websiteReservedQty: 0,
        shopeeReservedQty: 0,
        orders: [],
      });
    }

    return variants.get(key);
  };

  for (const order of websiteOrders) {
    for (const item of order.items || []) {
      if (String(item.productId) !== String(product._id)) continue;

      const qty = n(item.qty);
      if (qty <= 0) continue;

      const variant = getOrCreate(item.variantCode, item.variantName);
      variant.websiteQty += qty;
      if (order.stockReserved === true) {
        variant.websiteReservedQty += qty;
      }

      variant.orders.push(
        makeOrderLine({
          source: "website",
          order,
          item,
          qty,
          product,
        }),
      );
    }
  }

  for (const order of shopeeOrders) {
    for (const item of order.items || []) {
      if (
        String(item.productId) !== String(product._id) ||
        item.mappingStatus !== "mapped" ||
        item.allowStockDeduction !== true
      ) {
        continue;
      }

      const qty = n(item.reservedQty);
      if (qty <= 0) continue;

      const variantCode = clean(item.variantCode);

      if (product.variants?.length && !variantCode) continue;

      const variant = getOrCreate(variantCode, item.variantName);
      variant.shopeeReservedQty += qty;

      variant.orders.push(
        makeOrderLine({
          source: "shopee",
          order,
          item,
          qty,
          product,
        }),
      );
    }
  }

  const formattedVariants = Array.from(variants.values()).map((variant) => ({
    ...variant,
    availableQty: Math.max(
      0,
      variant.physicalQty -
        variant.websiteReservedQty -
        variant.shopeeReservedQty,
    ),
    orders: variant.orders.sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    ),
  }));

  return {
    productId: String(product._id),
    title: product.title,
    code: product.code || "",
    brand: product.brand || "",
    type: String(product.type || ""),
    typeName: getProductTypeName(product.type),
    thumbnail: product.thumbnail || "",
    physicalQty: n(product.qty),
    websiteQty: formattedVariants.reduce(
      (sum, variant) => sum + variant.websiteQty,
      0,
    ),
    websiteReservedQty: formattedVariants.reduce(
      (sum, variant) => sum + variant.websiteReservedQty,
      0,
    ),
    shopeeReservedQty: formattedVariants.reduce(
      (sum, variant) => sum + variant.shopeeReservedQty,
      0,
    ),
    availableQty: Math.max(
      0,
      n(product.qty) -
        formattedVariants.reduce(
          (sum, variant) =>
            sum + variant.websiteReservedQty + variant.shopeeReservedQty,
          0,
        ),
    ),
    variants: formattedVariants,
  };
}
// =====================================================
// CHI TIẾT ĐƠN HÀNG WEBSITE / SHOPEE
// GET /api/inventory/reservations/order/:source/:orderId
// =====================================================

const getReservationOrderDetail = async (req, res) => {
  try {
    const { source, orderId } = req.params;

    if (!["website", "shopee"].includes(source)) {
      return res.status(400).json({
        success: false,
        message: "Nguồn đơn hàng không hợp lệ",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "orderId không hợp lệ",
      });
    }

    let order = null;

    if (source === "website") {
      order = await Order.findById(orderId).lean();
    } else {
      order = await ShopeeOrder.findById(orderId).lean();
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    return res.json({
      success: true,
      data: {
        source,
        sourceLabel: source === "shopee" ? "Shopee" : "Website",
        order,
      },
    });
  } catch (error) {
    console.error("[getReservationOrderDetail]", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết đơn hàng",
      error: error.message,
    });
  }
};
module.exports = {
  getReservations,
  getReservationDetail,
  getReservationOrderDetail,
};

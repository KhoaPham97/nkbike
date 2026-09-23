const mongoose = require("mongoose");

const Order = require("../models/orders");
const Customer = require("../models/Customer");
const { Product } = require("../models/products");

/* =========================================================
   HELPER
========================================================= */

const toNumber = (value) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
};

const getProductCode = (product) => {
  return (
    product?.code ||
    product?.productCode ||
    product?.sku ||
    product?.product_code ||
    ""
  );
};

/* =========================================================
   GENERATE ORDER CODE
   DH20260923-0001
========================================================= */

const generateOrderCode = async () => {
  const now = new Date();

  const yyyy = now.getFullYear();

  const mm = String(now.getMonth() + 1).padStart(2, "0");

  const dd = String(now.getDate()).padStart(2, "0");

  const prefix = `DH${yyyy}${mm}${dd}`;

  const lastOrder = await Order.findOne({
    code: {
      $regex: `^${prefix}-`,
    },
  })
    .sort({
      code: -1,
    })
    .lean();

  let sequence = 1;

  if (lastOrder?.code) {
    const lastNumber = Number(lastOrder.code.split("-")[1]) || 0;

    sequence = lastNumber + 1;
  }

  return `${prefix}-${String(sequence).padStart(4, "0")}`;
};

/* =========================================================
   CREATE ORDER
========================================================= */

const createOrderAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      customerId,
      items = [],
      discount = 0,
      shippingFee = 0,
      paidAmount = 0,
      paymentMethod = "cash",
      note = "",
    } = req.body;

    /* =====================================================
       VALIDATE ITEMS
    ===================================================== */

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Đơn hàng chưa có sản phẩm",
      });
    }

    /* =====================================================
       VALIDATE CUSTOMER ID
    ===================================================== */

    if (customerId && !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "customerId không hợp lệ",
      });
    }

    /* =====================================================
       NORMALIZE MONEY
    ===================================================== */

    const discountNumber = Math.max(0, toNumber(discount));

    const shippingNumber = Math.max(0, toNumber(shippingFee));

    const paidNumber = Math.max(0, toNumber(paidAmount));

    /* =====================================================
       PAYMENT METHOD
    ===================================================== */

    const allowedPaymentMethods = ["cash", "transfer", "cod", "debt"];

    if (!allowedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Phương thức thanh toán không hợp lệ",
      });
    }

    /* =====================================================
       START TRANSACTION
    ===================================================== */

    let createdOrder = null;

    await session.withTransaction(async () => {
      /* ================================================
           CUSTOMER
        ================================================ */

      let customer = null;

      if (customerId) {
        customer = await Customer.findById(customerId).session(session);

        if (!customer) {
          throw new Error("Không tìm thấy khách hàng");
        }
      }

      /* ================================================
           MERGE SAME PRODUCT + VARIANT
        ================================================ */

      const mergedItems = {};

      for (const item of items) {
        if (
          !item.productId ||
          !mongoose.Types.ObjectId.isValid(item.productId)
        ) {
          throw new Error("productId không hợp lệ");
        }

        const qty = toNumber(item.qty);

        if (qty <= 0) {
          throw new Error("Số lượng sản phẩm phải lớn hơn 0");
        }

        const variantName = String(item.variantName || "").trim();

        const key = `${item.productId}_${variantName}`;

        if (!mergedItems[key]) {
          mergedItems[key] = {
            productId: item.productId,

            variantName,

            qty: 0,
          };
        }

        mergedItems[key].qty += qty;
      }

      /* ================================================
           PROCESS PRODUCTS
        ================================================ */

      const orderItems = [];

      let subtotal = 0;

      for (const item of Object.values(mergedItems)) {
        const product = await Product.findById(item.productId).session(session);

        if (!product) {
          throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
        }

        let price = toNumber(product.price);

        let stock = toNumber(product.qty);

        let variant = null;

        /* ==============================================
             VARIANT
          ============================================== */

        if (item.variantName) {
          variant = product.variants?.find(
            (v) => String(v.name).trim() === item.variantName,
          );

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${item.variantName}" của sản phẩm "${product.title}"`,
            );
          }

          price = toNumber(variant.price);

          stock = toNumber(variant.qty);
        }

        /* ==============================================
             CHECK STOCK
          ============================================== */

        if (stock < item.qty) {
          throw new Error(
            `Sản phẩm "${product.title}" ${
              item.variantName ? `- ${item.variantName} ` : ""
            }chỉ còn ${stock}`,
          );
        }

        /* ==============================================
             TOTAL
          ============================================== */

        const itemTotal = price * item.qty;

        subtotal += itemTotal;

        /* ==============================================
             TRỪ VARIANT STOCK
          ============================================== */

        if (variant) {
          variant.qty = toNumber(variant.qty) - item.qty;

          /*
           * Product.qty được xem là
           * tổng tồn kho của toàn bộ variant.
           */
          product.qty = Math.max(0, toNumber(product.qty) - item.qty);
        } else {
          /* ============================================
               PRODUCT KHÔNG CÓ VARIANT
            ============================================ */

          product.qty = Math.max(0, toNumber(product.qty) - item.qty);
        }

        product.updated_at = new Date();

        await product.save({
          session,
        });

        /* ==============================================
             SNAPSHOT ORDER ITEM
          ============================================== */

        orderItems.push({
          productId: product._id,

          productTitle: product.title || "",

          productCode: getProductCode(product),

          variantName: item.variantName,

          price,

          qty: item.qty,

          total: itemTotal,

          thumbnail: product.thumbnail || "",
        });
      }

      /* ================================================
           TOTAL
        ================================================ */

      const totalAmount = Math.max(
        0,
        subtotal - discountNumber + shippingNumber,
      );

      if (paidNumber > totalAmount) {
        throw new Error("Số tiền khách trả không được lớn hơn tổng tiền");
      }

      const debt = Math.max(0, totalAmount - paidNumber);

      /* ================================================
           ORDER CODE
        ================================================ */

      const code = await generateOrderCode();

      /* ================================================
           CREATE ORDER
        ================================================ */

      const order = new Order({
        code,

        customerId: customer?._id || null,

        customerName: customer?.name || "Khách lẻ",

        customerPhone: customer?.phone || "",

        customerAddress: customer?.address || "",

        items: orderItems,

        subtotal,

        discount: discountNumber,

        shippingFee: shippingNumber,

        totalAmount,

        paidAmount: paidNumber,

        debt,

        paymentMethod,

        status: "pending",

        note: String(note || "").trim(),

        created_at: new Date(),

        updated_at: new Date(),
      });

      await order.save({
        session,
      });

      /* ================================================
           UPDATE CUSTOMER
        ================================================ */

      if (customer) {
        customer.totalOrders = toNumber(customer.totalOrders) + 1;

        customer.totalSpent = toNumber(customer.totalSpent) + paidNumber;

        customer.debt = toNumber(customer.debt) + debt;

        customer.updated_at = new Date();

        await customer.save({
          session,
        });
      }

      createdOrder = order;
    });

    /* =====================================================
       RESPONSE
    ===================================================== */

    return res.status(201).json({
      success: true,

      message: "Tạo đơn hàng thành công",

      order: createdOrder,
    });
  } catch (error) {
    console.error("createOrderAsync:", error);

    return res.status(400).json({
      success: false,

      message: error?.message || "Không thể tạo đơn hàng",
    });
  } finally {
    await session.endSession();
  }
};

/* =========================================================
   GET ORDER
========================================================= */

const getOrderByIdAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID đơn hàng không hợp lệ",
      });
    }

    const order = await Order.findById(id).populate("customerId").lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    return res.status(200).json({
      success: true,
      order,
    });
  } catch (error) {
    console.error("getOrderByIdAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy đơn hàng",
    });
  }
};

/* =========================================================
   LIST ORDERS
========================================================= */

const listOrdersAsync = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const skip = (page - 1) * limit;

    const search = String(req.query.search || "").trim();

    const status = String(req.query.status || "").trim();

    const filter = {};

    if (status) {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        {
          code: {
            $regex: search,
            $options: "i",
          },
        },
        {
          customerName: {
            $regex: search,
            $options: "i",
          },
        },
        {
          customerPhone: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({
          created_at: -1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      Order.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,

      orders,

      total,

      page,

      limit,

      totalPages: Math.ceil(total / limit),

      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error("listOrdersAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách đơn hàng",
    });
  }
};

/* =========================================================
   UPDATE STATUS
========================================================= */

const updateOrderStatusAsync = async (req, res) => {
  try {
    const { id } = req.params;

    const { status } = req.body;

    const allowedStatus = [
      "pending",
      "confirmed",
      "shipping",
      "completed",
      "cancelled",
    ];

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Trạng thái không hợp lệ",
      });
    }

    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    order.status = status;
    order.updated_at = new Date();

    await order.save();

    return res.status(200).json({
      success: true,
      message: "Cập nhật trạng thái thành công",
      order,
    });
  } catch (error) {
    console.error("updateOrderStatusAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật trạng thái",
    });
  }
};

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  createOrderAsync,
  getOrderByIdAsync,
  listOrdersAsync,
  updateOrderStatusAsync,
};

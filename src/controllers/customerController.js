const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const Customer = require("../models/customer");
const Order = require("../models/orders");

// =====================================================
// CONSTANT
// =====================================================

const DEFAULT_CUSTOMER_PASSWORD = "nhatkhangbike";
const PASSWORD_MIN_LENGTH = 6;

const CUSTOMER_SELECT_FIELDS =
  "_id name phone address email username status totalOrders totalSpent totalPurchased totalPaid debt note lastLoginAt created_at updated_at";

// =====================================================
// HELPER - TẠO USERNAME
// =====================================================

const generateUniqueUsername = async (name = "") => {
  let prefix = String(name || "customer")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "");

  if (!prefix) {
    prefix = "customer";
  }

  prefix = prefix.substring(0, 12);

  let username;
  let exists = true;

  while (exists) {
    const random = Math.random().toString(36).substring(2, 8);

    username = `${prefix}${random}`;

    exists = await Customer.exists({
      username,
    });
  }

  return username;
};

// =====================================================
// HELPER - VALIDATE PASSWORD
// =====================================================

const validatePassword = (password) => {
  if (!password || !String(password).trim()) {
    return "Mật khẩu không được để trống";
  }

  if (String(password).length < PASSWORD_MIN_LENGTH) {
    return `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự`;
  }

  return null;
};

// =====================================================
// DANH SÁCH KHÁCH HÀNG
// GET /api/customers
// =====================================================

const listCustomersAsync = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const skip = (page - 1) * limit;

    const filter = {};

    // =====================================================
    // SEARCH
    // =====================================================

    if (search) {
      filter.$or = [
        {
          name: {
            $regex: search,
            $options: "i",
          },
        },
        {
          phone: {
            $regex: search,
            $options: "i",
          },
        },
        {
          email: {
            $regex: search,
            $options: "i",
          },
        },
        {
          username: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .select(CUSTOMER_SELECT_FIELDS)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Customer.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      customers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error("listCustomersAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// THÊM KHÁCH HÀNG
// POST /api/customers
//
// PASSWORD MẶC ĐỊNH:
// nhatkhangbike
// =====================================================

const createCustomerAsync = async (req, res) => {
  try {
    const { name, phone, address, email, username, status, note, password } =
      req.body;

    // =====================================================
    // CHECK NAME
    // =====================================================

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Tên khách hàng là bắt buộc",
      });
    }

    // =====================================================
    // USERNAME
    // =====================================================

    let finalUsername = String(username || "")
      .trim()
      .toLowerCase();

    if (finalUsername) {
      const duplicateUsername = await Customer.findOne({
        username: finalUsername,
      }).lean();

      if (duplicateUsername) {
        return res.status(400).json({
          success: false,
          message: "Username đã được sử dụng",
        });
      }
    } else {
      finalUsername = await generateUniqueUsername(name);
    }

    // =====================================================
    // PASSWORD
    //
    // Nếu không gửi password:
    // => nhatkhangbike
    //
    // Nếu frontend gửi password:
    // => dùng password đó
    // =====================================================

    const rawPassword =
      password !== undefined && password !== null && String(password).trim()
        ? String(password).trim()
        : DEFAULT_CUSTOMER_PASSWORD;

    const passwordError = validatePassword(rawPassword);

    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError,
      });
    }

    // =====================================================
    // HASH PASSWORD
    // =====================================================

    const hashedPassword = await bcrypt.hash(rawPassword, 12);

    // =====================================================
    // CREATE CUSTOMER
    // =====================================================

    const customer = await Customer.create({
      name: String(name).trim(),

      phone: phone !== undefined && phone !== null ? String(phone).trim() : "",

      address:
        address !== undefined && address !== null ? String(address).trim() : "",

      email:
        email !== undefined && email !== null
          ? String(email).trim().toLowerCase()
          : "",

      username: finalUsername,

      password: hashedPassword,

      status: status || "pending",

      note: note !== undefined && note !== null ? String(note).trim() : "",

      totalOrders: 0,
      totalSpent: 0,
      totalPurchased: 0,
      totalPaid: 0,
      debt: 0,

      created_at: new Date(),
      updated_at: new Date(),
    });

    // =====================================================
    // KHÔNG TRẢ PASSWORD
    // =====================================================

    const customerResponse = await Customer.findById(customer._id)
      .select(CUSTOMER_SELECT_FIELDS)
      .lean();

    return res.status(201).json({
      success: true,
      message: "Thêm khách hàng thành công",
      customer: customerResponse,

      // Chỉ thông báo cho frontend biết đây là password mặc định.
      // Không trả password hash.
      passwordDefault: !password,
    });
  } catch (error) {
    console.error("createCustomerAsync:", error);

    // MongoDB duplicate key
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Username đã tồn tại, vui lòng thử lại",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Không thể thêm khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// CẬP NHẬT NHIỀU KHÁCH HÀNG
// POST /api/customers/update-multiple
// =====================================================

const updateMultipleCustomersAsync = async (req, res) => {
  try {
    const { customers } = req.body;

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "customers phải là một mảng và không được rỗng",
      });
    }

    if (customers.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Mỗi lần chỉ được cập nhật tối đa 100 khách hàng",
      });
    }

    const updatedCustomers = [];
    const errors = [];

    for (const item of customers) {
      try {
        const id = item._id || item.id;

        if (!id) {
          errors.push({
            id: null,
            message: "Thiếu _id khách hàng",
          });

          continue;
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
          errors.push({
            id,
            message: "ID khách hàng không hợp lệ",
          });

          continue;
        }

        const currentCustomer =
          await Customer.findById(id).select("_id name username");

        if (!currentCustomer) {
          errors.push({
            id,
            message: "Không tìm thấy khách hàng",
          });

          continue;
        }

        const updateData = {
          updated_at: new Date(),
        };

        // =====================================================
        // NAME
        // =====================================================

        if (item.name !== undefined) {
          const value = String(item.name).trim();

          if (!value) {
            errors.push({
              id,
              message: "Tên khách hàng không được để trống",
            });

            continue;
          }

          updateData.name = value;
        }

        // =====================================================
        // PHONE
        // =====================================================

        if (item.phone !== undefined) {
          updateData.phone = String(item.phone || "").trim();
        }

        // =====================================================
        // ADDRESS
        // =====================================================

        if (item.address !== undefined) {
          updateData.address = String(item.address || "").trim();
        }

        // =====================================================
        // EMAIL
        // =====================================================

        if (item.email !== undefined) {
          updateData.email = String(item.email || "")
            .trim()
            .toLowerCase();
        }

        // =====================================================
        // USERNAME
        // =====================================================

        if (item.username !== undefined) {
          const username = String(item.username || "")
            .trim()
            .toLowerCase();

          if (username) {
            const duplicate = await Customer.findOne({
              username,
              _id: { $ne: id },
            });

            if (duplicate) {
              errors.push({
                id,
                message: `Username "${username}" đã được sử dụng`,
              });

              continue;
            }

            updateData.username = username;
          } else {
            updateData.username = await generateUniqueUsername(
              item.name || currentCustomer.name,
            );
          }
        }

        // =====================================================
        // CUSTOMER CHƯA CÓ USERNAME
        // =====================================================

        if (!currentCustomer.username && !updateData.username) {
          updateData.username = await generateUniqueUsername(
            item.name || currentCustomer.name,
          );
        }

        // =====================================================
        // STATUS
        // =====================================================

        if (item.status !== undefined) {
          const allowedStatus = ["pending", "active", "blocked"];

          if (!allowedStatus.includes(item.status)) {
            errors.push({
              id,
              message: "Status không hợp lệ",
            });

            continue;
          }

          updateData.status = item.status;
        }

        // =====================================================
        // NOTE
        // =====================================================

        if (item.note !== undefined) {
          updateData.note = String(item.note || "").trim();
        }

        // =====================================================
        // UPDATE
        // =====================================================

        const customer = await Customer.findByIdAndUpdate(
          id,
          {
            $set: updateData,
          },
          {
            new: true,
            runValidators: true,
          },
        ).select(CUSTOMER_SELECT_FIELDS);

        if (!customer) {
          errors.push({
            id,
            message: "Không thể cập nhật khách hàng",
          });

          continue;
        }

        updatedCustomers.push(customer);
      } catch (error) {
        console.error(`Update customer ${item?.id}:`, error);

        errors.push({
          id: item?.id,
          message: error.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Đã cập nhật ${updatedCustomers.length}/${customers.length} khách hàng`,
      total: customers.length,
      updated: updatedCustomers.length,
      failed: errors.length,
      customers: updatedCustomers,
      errors,
    });
  } catch (error) {
    console.error("updateMultipleCustomersAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật nhiều khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// CHI TIẾT KHÁCH HÀNG
// GET /api/customers/:id
// =====================================================

const getCustomerByIdAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const customer = await Customer.findById(id)
      .select(CUSTOMER_SELECT_FIELDS)
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    return res.status(200).json({
      success: true,
      customer,
    });
  } catch (error) {
    console.error("getCustomerByIdAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy thông tin khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// CẬP NHẬT KHÁCH HÀNG
// PUT /api/customers/:id
// =====================================================

const updateCustomerAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const { name, phone, address, email, username, status, note, lastLoginAt } =
      req.body;

    const currentCustomer =
      await Customer.findById(id).select("_id name username");

    if (!currentCustomer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    const updateData = {
      updated_at: new Date(),
    };

    // =====================================================
    // NAME
    // =====================================================

    if (name !== undefined) {
      const value = String(name).trim();

      if (!value) {
        return res.status(400).json({
          success: false,
          message: "Tên khách hàng không được để trống",
        });
      }

      updateData.name = value;
    }

    // =====================================================
    // PHONE
    // =====================================================

    if (phone !== undefined) {
      updateData.phone = String(phone || "").trim();
    }

    // =====================================================
    // ADDRESS
    // =====================================================

    if (address !== undefined) {
      updateData.address = String(address || "").trim();
    }

    // =====================================================
    // EMAIL
    // =====================================================

    if (email !== undefined) {
      updateData.email = String(email || "")
        .trim()
        .toLowerCase();
    }

    // =====================================================
    // USERNAME
    // =====================================================

    if (username !== undefined) {
      const value = String(username || "")
        .trim()
        .toLowerCase();

      if (value) {
        const existingCustomer = await Customer.findOne({
          username: value,
          _id: { $ne: id },
        });

        if (existingCustomer) {
          return res.status(400).json({
            success: false,
            message: "Username đã được sử dụng",
          });
        }

        updateData.username = value;
      } else {
        updateData.username = await generateUniqueUsername(
          name !== undefined ? name : currentCustomer.name,
        );
      }
    }

    // =====================================================
    // CUSTOMER CHƯA CÓ USERNAME
    // =====================================================

    if (!currentCustomer.username && !updateData.username) {
      updateData.username = await generateUniqueUsername(
        name !== undefined ? name : currentCustomer.name,
      );
    }

    // =====================================================
    // STATUS
    // =====================================================

    if (status !== undefined) {
      const allowedStatus = ["pending", "active", "blocked"];

      if (!allowedStatus.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Trạng thái khách hàng không hợp lệ",
          allowedStatus,
        });
      }

      updateData.status = status;
    }

    // =====================================================
    // NOTE
    // =====================================================

    if (note !== undefined) {
      updateData.note = String(note || "").trim();
    }

    // =====================================================
    // LAST LOGIN
    // =====================================================

    if (lastLoginAt !== undefined) {
      if (lastLoginAt === null || lastLoginAt === "") {
        updateData.lastLoginAt = null;
      } else {
        const date = new Date(lastLoginAt);

        if (Number.isNaN(date.getTime())) {
          return res.status(400).json({
            success: false,
            message: "lastLoginAt không hợp lệ",
          });
        }

        updateData.lastLoginAt = date;
      }
    }

    // =====================================================
    // UPDATE
    // =====================================================

    const customer = await Customer.findByIdAndUpdate(
      id,
      {
        $set: updateData,
      },
      {
        new: true,
        runValidators: true,
      },
    ).select(CUSTOMER_SELECT_FIELDS);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Cập nhật khách hàng thành công",
      customer,
    });
  } catch (error) {
    console.error("updateCustomerAsync:", error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Username đã tồn tại, vui lòng thử lại",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// ĐỔI MẬT KHẨU KHÁCH HÀNG
// PUT /api/customers/:id/password
//
// Body:
// {
//   "password": "matkhau-moi"
// }
// =====================================================

const changeCustomerPasswordAsync = async (req, res) => {
  try {
    const { id } = req.params;

    // =====================================================
    // CHECK ID
    // =====================================================

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const { password } = req.body;

    // =====================================================
    // CHECK PASSWORD
    // =====================================================

    const passwordError = validatePassword(password);

    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError,
      });
    }

    // =====================================================
    // FIND CUSTOMER
    // =====================================================

    const customer = await Customer.findById(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // =====================================================
    // HASH PASSWORD
    // =====================================================

    const hashedPassword = await bcrypt.hash(String(password).trim(), 12);

    // =====================================================
    // UPDATE PASSWORD
    // =====================================================

    customer.password = hashedPassword;
    customer.updated_at = new Date();

    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Đổi mật khẩu thành công",
    });
  } catch (error) {
    console.error("changeCustomerPasswordAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đổi mật khẩu",
      error: error.message,
    });
  }
};

// =====================================================
// CẬP NHẬT CÔNG NỢ
// PATCH /api/customers/:id/debt
// =====================================================

const updateCustomerDebtAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const customer = await Customer.findById(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // =====================================================
    // LẤY ĐƠN HÀNG
    // =====================================================

    const orders = await Order.find({
      $or: [{ customer: id }, { customerId: id }],
      status: {
        $ne: "cancelled",
      },
    }).lean();

    // =====================================================
    // TÍNH THỐNG KÊ
    // =====================================================

    let totalSpent = 0;
    let totalPaid = 0;
    let totalDebt = 0;

    for (const order of orders) {
      const totalAmount = Math.max(
        Number(order.totalAmount || order.total || 0),
        0,
      );

      const paidAmount = Math.max(Number(order.paidAmount || 0), 0);

      const debt = Math.max(Number(order.debt ?? totalAmount - paidAmount), 0);

      totalSpent += totalAmount;
      totalPaid += paidAmount;
      totalDebt += debt;
    }

    // =====================================================
    // UPDATE CUSTOMER
    // =====================================================

    customer.debt = totalDebt;
    customer.totalSpent = totalSpent;
    customer.totalPurchased = totalSpent;
    customer.totalPaid = totalPaid;
    customer.totalOrders = orders.length;
    customer.updated_at = new Date();

    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Cập nhật công nợ và số tiền đã mua thành công",
      customer: {
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        totalOrders: orders.length,
        totalSpent,
        totalPurchased: totalSpent,
        totalPaid,
        debt: totalDebt,
      },
    });
  } catch (error) {
    console.error("updateCustomerDebtAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật công nợ khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// XÓA KHÁCH HÀNG
// DELETE /api/customers/:id
// =====================================================

const deleteCustomerAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const customer = await Customer.findByIdAndDelete(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Xóa khách hàng thành công",
    });
  } catch (error) {
    console.error("deleteCustomerAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể xóa khách hàng",
      error: error.message,
    });
  }
};

// =====================================================
// LỊCH SỬ MUA HÀNG
// GET /api/customers/:id/orders
// =====================================================

const getCustomerOrdersAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const customer = await Customer.findById(id).lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    const orders = await Order.find({
      customerId: new mongoose.Types.ObjectId(id),
      status: {
        $ne: "cancelled",
      },
    })
      .sort({
        created_at: -1,
      })
      .lean();

    // =====================================================
    // FORMAT ORDERS
    // =====================================================

    const formattedOrders = orders.map((order) => {
      const items = Array.isArray(order.items)
        ? order.items.map((item) => ({
            productId: item.productId,
            productTitle: item.productTitle || "",
            productCode: item.productCode || "",
            variantName: item.variantName || "",
            price: Number(item.price) || 0,
            qty: Number(item.qty) || 0,
            total: Number(item.total) || 0,
            thumbnail: item.thumbnail || "",
          }))
        : [];

      return {
        _id: order._id,
        code: order.code,

        customerId: order.customerId,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerAddress: order.customerAddress,

        items,

        subtotal: Number(order.subtotal) || 0,

        discount: Number(order.discount) || 0,

        shippingFee: Number(order.shippingFee) || 0,

        totalAmount: Number(order.totalAmount) || 0,

        paidAmount: Number(order.paidAmount) || 0,

        debt: Number(order.debt) || 0,

        paymentMethod: order.paymentMethod || "cash",

        status: order.status || "pending",

        note: order.note || "",

        created_at: order.created_at,

        updated_at: order.updated_at,

        stockDeducted: Boolean(order.stockDeducted),
      };
    });

    // =====================================================
    // THỐNG KÊ
    // =====================================================

    const totalOrders = formattedOrders.length;

    const totalPurchased = formattedOrders.reduce(
      (sum, order) => sum + Number(order.totalAmount || 0),
      0,
    );

    const totalPaid = formattedOrders.reduce(
      (sum, order) => sum + Number(order.paidAmount || 0),
      0,
    );

    const totalDebt = formattedOrders.reduce(
      (sum, order) => sum + Number(order.debt || 0),
      0,
    );

    return res.status(200).json({
      success: true,

      customer: {
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        email: customer.email,
      },

      orders: formattedOrders,

      total: totalOrders,

      statistics: {
        totalOrders,
        totalPurchased,
        totalPaid,
        totalDebt,
      },
    });
  } catch (error) {
    console.error("getCustomerOrdersAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy lịch sử mua hàng",
      error: error.message,
    });
  }
};
// =====================================================
// ĐĂNG NHẬP KHÁCH HÀNG
// POST /api/customers/login
//
// Body:
// {
//   "username": "khoapham",
//   "password": "123456"
// }
// =====================================================

const loginCustomerAsync = async (req, res) => {
  try {
    const { username, password } = req.body;

    // =====================================================
    // VALIDATE
    // =====================================================

    const loginUsername = String(username || "")
      .trim()
      .toLowerCase();

    const loginPassword = String(password || "");

    if (!loginUsername) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập username",
      });
    }

    if (!loginPassword) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập mật khẩu",
      });
    }

    // =====================================================
    // TÌM CUSTOMER
    //
    // password đang select: false
    // nên phải .select("+password")
    // =====================================================

    const customer = await Customer.findOne({
      username: loginUsername,
    }).select("+password");

    if (!customer) {
      return res.status(401).json({
        success: false,
        message: "Username hoặc mật khẩu không đúng",
      });
    }

    // =====================================================
    // CHECK PASSWORD
    // =====================================================

    const passwordMatched = await bcrypt.compare(
      loginPassword,
      customer.password,
    );

    if (!passwordMatched) {
      return res.status(401).json({
        success: false,
        message: "Username hoặc mật khẩu không đúng",
      });
    }

    // =====================================================
    // CHECK STATUS
    // =====================================================

    if (customer.status === "blocked") {
      return res.status(403).json({
        success: false,
        message: "Tài khoản đã bị khóa",
      });
    }

    // =====================================================
    // JWT SECRET
    // =====================================================

    const JWT_SECRET = process.env.JWT_SECRET;

    if (!JWT_SECRET) {
      console.error("JWT_SECRET chưa được cấu hình trong environment");

      return res.status(500).json({
        success: false,
        message: "Server chưa cấu hình JWT_SECRET",
      });
    }

    // =====================================================
    // JWT PAYLOAD
    // =====================================================

    const token = jwt.sign(
      {
        id: customer._id.toString(),
        customerId: customer._id.toString(),
        username: customer.username,
        role: "customer",
      },
      JWT_SECRET,
      {
        expiresIn: "30d",
      },
    );

    // =====================================================
    // UPDATE LAST LOGIN
    // =====================================================

    customer.lastLoginAt = new Date();

    if (customer.status === "pending") {
      customer.status = "active";
    }

    customer.updated_at = new Date();

    await customer.save();

    // =====================================================
    // RESPONSE CUSTOMER
    //
    // KHÔNG TRẢ PASSWORD
    // =====================================================

    const customerResponse = {
      _id: customer._id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      email: customer.email,
      username: customer.username,
      status: customer.status,

      totalOrders: Number(customer.totalOrders || 0),
      totalSpent: Number(customer.totalSpent || 0),
      totalPurchased: Number(
        customer.totalPurchased || customer.totalSpent || 0,
      ),
      totalPaid: Number(customer.totalPaid || 0),
      debt: Number(customer.debt || 0),

      note: customer.note || "",

      lastLoginAt: customer.lastLoginAt,
      created_at: customer.created_at,
      updated_at: customer.updated_at,
    };

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,
      message: "Đăng nhập thành công",

      token,

      accessToken: token,

      customer: customerResponse,
    });
  } catch (error) {
    console.error("loginCustomerAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đăng nhập",
      error: error.message,
    });
  }
};
// =====================================================
// EXPORT
// =====================================================

module.exports = {
  listCustomersAsync,
  createCustomerAsync,
  getCustomerByIdAsync,
  updateCustomerAsync,
  changeCustomerPasswordAsync,
  updateCustomerDebtAsync,
  deleteCustomerAsync,
  getCustomerOrdersAsync,
  updateMultipleCustomersAsync,
  loginCustomerAsync,
};

const mongoose = require("mongoose");
const Customer = require("../models/Customer");

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

    // Tìm theo tên, số điện thoại, email
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
      ];
    }

    const [customers, total] = await Promise.all([
      Customer.find(filter)
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
// Chỉ name là bắt buộc
// =====================================================
const createCustomerAsync = async (req, res) => {
  try {
    const { name, phone, address, email, note } = req.body;

    // Chỉ kiểm tra name
    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Tên khách hàng là bắt buộc",
      });
    }

    const customer = await Customer.create({
      name: String(name).trim(),

      phone: phone !== undefined && phone !== null ? String(phone).trim() : "",

      address:
        address !== undefined && address !== null ? String(address).trim() : "",

      email: email !== undefined && email !== null ? String(email).trim() : "",

      note: note !== undefined && note !== null ? String(note) : "",

      totalOrders: 0,
      totalSpent: 0,
      debt: 0,

      created_at: new Date(),
      updated_at: new Date(),
    });

    return res.status(201).json({
      success: true,
      message: "Thêm khách hàng thành công",
      customer,
    });
  } catch (error) {
    console.error("createCustomerAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể thêm khách hàng",
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

    const customer = await Customer.findById(id).lean();

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
//
// Chỉ name bắt buộc nếu gửi name lên
// Các trường khác tùy chọn
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

    const { name, phone, address, email, note } = req.body;

    const updateData = {
      updated_at: new Date(),
    };

    // Nếu có gửi name thì kiểm tra name
    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({
          success: false,
          message: "Tên khách hàng không được để trống",
        });
      }

      updateData.name = String(name).trim();
    }

    if (phone !== undefined) {
      updateData.phone = String(phone || "").trim();
    }

    if (address !== undefined) {
      updateData.address = String(address || "").trim();
    }

    if (email !== undefined) {
      updateData.email = String(email || "").trim();
    }

    if (note !== undefined) {
      updateData.note = String(note || "");
    }

    const customer = await Customer.findByIdAndUpdate(
      id,
      {
        $set: updateData,
      },
      {
        new: true,
        runValidators: true,
      },
    );

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

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật khách hàng",
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
    const { debt } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID khách hàng không hợp lệ",
      });
    }

    const newDebt = Number(debt);

    if (!Number.isFinite(newDebt)) {
      return res.status(400).json({
        success: false,
        message: "Công nợ không hợp lệ",
      });
    }

    const customer = await Customer.findByIdAndUpdate(
      id,
      {
        $set: {
          debt: newDebt,
          updated_at: new Date(),
        },
      },
      {
        new: true,
      },
    );

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Cập nhật công nợ thành công",
      customer,
    });
  } catch (error) {
    console.error("updateCustomerDebtAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật công nợ",
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
// EXPORT
// =====================================================
module.exports = {
  listCustomersAsync,
  createCustomerAsync,
  getCustomerByIdAsync,
  updateCustomerAsync,
  updateCustomerDebtAsync,
  deleteCustomerAsync,
};

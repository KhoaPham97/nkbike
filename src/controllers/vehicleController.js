const mongoose = require("mongoose");
const { Vehicle } = require("../models/vehicle");
const { Product } = require("../models/products");

// ============================================================
// GET ALL VEHICLES
// ============================================================
// GET /api/vehicles
//
// Query:
// ?page=1
// ?limit=30
// ?type=2
// ?brand=YADEA
// ?search=M133
// ?isVisible=true
// ============================================================

const getAllVehicles = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    const skip = (page - 1) * limit;

    const filter = {};

    // ----------------------------------------------------------
    // TYPE
    // ----------------------------------------------------------

    if (req.query.type) {
      const type = String(req.query.type);

      if (["1", "2", "3"].includes(type)) {
        filter.type = type;
      }
    }

    // ----------------------------------------------------------
    // BRAND
    // ----------------------------------------------------------

    if (req.query.brand) {
      filter.brand = String(req.query.brand).trim();
    }

    // ----------------------------------------------------------
    // SEARCH
    // ----------------------------------------------------------

    if (req.query.search) {
      const search = String(req.query.search).trim();

      if (search) {
        filter.$or = [
          {
            name: {
              $regex: search,
              $options: "i",
            },
          },
          {
            brand: {
              $regex: search,
              $options: "i",
            },
          },
        ];
      }
    }

    // ----------------------------------------------------------
    // VISIBILITY
    // ----------------------------------------------------------

    // Nếu truyền isVisible thì filter theo giá trị.
    //
    // Ví dụ:
    // ?isVisible=true
    // ?isVisible=false
    //
    // Nếu không truyền:
    // admin có thể lấy cả ẩn + hiện.
    // ----------------------------------------------------------

    if (req.query.isVisible !== undefined) {
      filter.isVisible = req.query.isVisible === "true";
    }

    const [vehicles, total] = await Promise.all([
      Vehicle.find(filter)
        .sort({
          brand: 1,
          name: 1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      Vehicle.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      vehicles,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("getAllVehicles error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách xe",
      error: error.message,
    });
  }
};

// ============================================================
// GET VEHICLE BY ID
// ============================================================
// GET /api/vehicles/:id
// ============================================================

const getVehicleById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID xe không hợp lệ",
      });
    }

    const vehicle = await Vehicle.findById(id).lean();

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy xe",
      });
    }

    return res.status(200).json({
      success: true,
      vehicle,
    });
  } catch (error) {
    console.error("getVehicleById error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy thông tin xe",
      error: error.message,
    });
  }
};

// ============================================================
// CREATE VEHICLE
// ============================================================
// POST /api/vehicles
//
// Body:
// {
//   name: "M133",
//   brand: "YADEA",
//   type: "2",
//   image: "...",
//   description: "...",
//   isVisible: true
// }
// ============================================================

const createVehicle = async (req, res) => {
  try {
    const {
      name,
      brand = "",
      type,
      image = "",
      description = "",
      isVisible = true,
    } = req.body;

    // ----------------------------------------------------------
    // VALIDATE NAME
    // ----------------------------------------------------------

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Tên xe là bắt buộc",
      });
    }

    // ----------------------------------------------------------
    // VALIDATE TYPE
    // ----------------------------------------------------------

    if (!["1", "2", "3"].includes(String(type))) {
      return res.status(400).json({
        success: false,
        message: "Loại xe không hợp lệ",
      });
    }

    const cleanName = String(name).trim();
    const cleanBrand = String(brand || "").trim();

    // ----------------------------------------------------------
    // CHECK DUPLICATE
    // ----------------------------------------------------------
    // Không cho trùng:
    //
    // YADEA + M133
    //
    // nhưng:
    //
    // YADEA + M133
    // VC + M133
    //
    // vẫn được phép.
    // ----------------------------------------------------------

    const duplicateFilter = {
      name: {
        $regex: `^${escapeRegex(cleanName)}$`,
        $options: "i",
      },
      type: String(type),
    };

    if (cleanBrand) {
      duplicateFilter.brand = {
        $regex: `^${escapeRegex(cleanBrand)}$`,
        $options: "i",
      };
    } else {
      duplicateFilter.brand = "";
    }

    const existingVehicle = await Vehicle.findOne(duplicateFilter);

    if (existingVehicle) {
      return res.status(409).json({
        success: false,
        message: "Xe này đã tồn tại",
        vehicle: existingVehicle,
      });
    }

    // ----------------------------------------------------------
    // CREATE
    // ----------------------------------------------------------

    const vehicle = await Vehicle.create({
      name: cleanName,
      brand: cleanBrand,
      type: String(type),
      image: String(image || "").trim(),
      description: String(description || ""),
      isVisible: Boolean(isVisible),
      created_at: new Date(),
      updated_at: new Date(),
    });

    return res.status(201).json({
      success: true,
      message: "Tạo xe thành công",
      vehicle,
    });
  } catch (error) {
    console.error("createVehicle error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tạo xe",
      error: error.message,
    });
  }
};

// ============================================================
// UPDATE VEHICLE
// ============================================================
// PUT /api/vehicles/:id
// ============================================================

const updateVehicle = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID xe không hợp lệ",
      });
    }

    const vehicle = await Vehicle.findById(id);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy xe",
      });
    }

    const { name, brand, type, image, description, isVisible } = req.body;

    // ----------------------------------------------------------
    // BUILD UPDATE
    // ----------------------------------------------------------

    const updateData = {};

    if (name !== undefined) {
      const cleanName = String(name).trim();

      if (!cleanName) {
        return res.status(400).json({
          success: false,
          message: "Tên xe không được để trống",
        });
      }

      updateData.name = cleanName;
    }

    if (brand !== undefined) {
      updateData.brand = String(brand || "").trim();
    }

    if (type !== undefined) {
      if (!["1", "2", "3"].includes(String(type))) {
        return res.status(400).json({
          success: false,
          message: "Loại xe không hợp lệ",
        });
      }

      updateData.type = String(type);
    }

    if (image !== undefined) {
      updateData.image = String(image || "").trim();
    }

    if (description !== undefined) {
      updateData.description = String(description || "");
    }

    if (isVisible !== undefined) {
      updateData.isVisible = Boolean(isVisible);
    }

    // ----------------------------------------------------------
    // CHECK DUPLICATE
    // ----------------------------------------------------------

    const nextName =
      updateData.name !== undefined ? updateData.name : vehicle.name;

    const nextBrand =
      updateData.brand !== undefined ? updateData.brand : vehicle.brand;

    const nextType =
      updateData.type !== undefined ? updateData.type : vehicle.type;

    const duplicateFilter = {
      _id: {
        $ne: vehicle._id,
      },
      name: {
        $regex: `^${escapeRegex(nextName)}$`,
        $options: "i",
      },
      type: nextType,
    };

    if (nextBrand) {
      duplicateFilter.brand = {
        $regex: `^${escapeRegex(nextBrand)}$`,
        $options: "i",
      };
    } else {
      duplicateFilter.brand = "";
    }

    const duplicate = await Vehicle.findOne(duplicateFilter);

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "Xe này đã tồn tại",
        vehicle: duplicate,
      });
    }

    // ----------------------------------------------------------
    // UPDATE
    // ----------------------------------------------------------

    updateData.updated_at = new Date();

    const updatedVehicle = await Vehicle.findByIdAndUpdate(
      id,
      {
        $set: updateData,
      },
      {
        new: true,
        runValidators: true,
      },
    ).lean();

    return res.status(200).json({
      success: true,
      message: "Cập nhật xe thành công",
      vehicle: updatedVehicle,
    });
  } catch (error) {
    console.error("updateVehicle error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật xe",
      error: error.message,
    });
  }
};

// ============================================================
// DELETE VEHICLE
// ============================================================
// DELETE /api/vehicles/:id
//
// Không xóa Product.
// Chỉ xóa Vehicle.
// Các Product đang reference Vehicle sẽ được kiểm tra trước.
// ============================================================

const deleteVehicle = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID xe không hợp lệ",
      });
    }

    const vehicle = await Vehicle.findById(id);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy xe",
      });
    }

    // ----------------------------------------------------------
    // CHECK PRODUCT
    // ----------------------------------------------------------

    const productCount = await Product.countDocuments({
      compatibleVehicles: id,
    });

    if (productCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Không thể xóa xe vì đang có sản phẩm liên kết",
        productCount,
      });
    }

    await Vehicle.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Xóa xe thành công",
    });
  } catch (error) {
    console.error("deleteVehicle error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể xóa xe",
      error: error.message,
    });
  }
};

// ============================================================
// GET VEHICLE BRANDS
// ============================================================
// GET /api/vehicles/brands?type=2
//
// Trả về danh sách hãng để FE làm autocomplete/select.
// ============================================================

const getVehicleBrands = async (req, res) => {
  try {
    const filter = {};

    if (req.query.type) {
      const type = String(req.query.type);

      if (["1", "2", "3"].includes(type)) {
        filter.type = type;
      }
    }

    filter.isVisible = true;

    const brands = await Vehicle.distinct("brand", filter);

    const result = brands
      .map((brand) => String(brand || "").trim())
      .filter(Boolean)
      .sort((a, b) =>
        a.localeCompare(b, "vi", {
          sensitivity: "base",
        }),
      );

    return res.status(200).json({
      success: true,
      brands: result,
    });
  } catch (error) {
    console.error("getVehicleBrands error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách hãng xe",
      error: error.message,
    });
  }
};

// ============================================================
// GET VEHICLES BY BRAND
// ============================================================
// GET /api/vehicles/by-brand?brand=YADEA&type=2
// ============================================================

const getVehiclesByBrand = async (req, res) => {
  try {
    const brand = String(req.query.brand || "").trim();

    if (!brand) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng cung cấp hãng xe",
      });
    }

    const filter = {
      brand: {
        $regex: `^${escapeRegex(brand)}$`,
        $options: "i",
      },
      isVisible: true,
    };

    if (req.query.type) {
      const type = String(req.query.type);

      if (["1", "2", "3"].includes(type)) {
        filter.type = type;
      }
    }

    const vehicles = await Vehicle.find(filter)
      .sort({
        name: 1,
      })
      .lean();

    return res.status(200).json({
      success: true,
      vehicles,
    });
  } catch (error) {
    console.error("getVehiclesByBrand error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách xe",
      error: error.message,
    });
  }
};

// ============================================================
// GET PRODUCTS COMPATIBLE WITH VEHICLE
// ============================================================
// GET /api/vehicles/:id/products
//
// Query:
// ?page=1
// ?limit=40
// ?categoryId=...
// ?search=...
//
// Đây là API chính cho trang:
// /vehicles/m133
// ============================================================

const getVehicleProducts = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID xe không hợp lệ",
      });
    }

    // ----------------------------------------------------------
    // CHECK VEHICLE
    // ----------------------------------------------------------

    const vehicle = await Vehicle.findOne({
      _id: id,
      isVisible: true,
    }).lean();

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy xe",
      });
    }

    // ----------------------------------------------------------
    // PAGINATION
    // ----------------------------------------------------------

    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);

    const skip = (page - 1) * limit;

    // ----------------------------------------------------------
    // FILTER
    // ----------------------------------------------------------

    const filter = {
      compatibleVehicles: id,
      isVisible: {
        $ne: false,
      },
    };

    // Category
    if (
      req.query.categoryId &&
      mongoose.Types.ObjectId.isValid(req.query.categoryId)
    ) {
      filter.categoryId = req.query.categoryId;
    }

    // Search
    if (req.query.search) {
      const search = String(req.query.search).trim();

      if (search) {
        filter.$or = [
          {
            title: {
              $regex: search,
              $options: "i",
            },
          },
          {
            brand: {
              $regex: search,
              $options: "i",
            },
          },
          {
            category: {
              $regex: search,
              $options: "i",
            },
          },
        ];
      }
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate("categoryId")
        .sort({
          title: 1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      Product.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,

      vehicle,

      products,

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("getVehicleProducts error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy phụ tùng phù hợp với xe",
      error: error.message,
    });
  }
};

// ============================================================
// ESCAPE REGEX
// ============================================================

const escapeRegex = (value = "") => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  getAllVehicles,
  getVehicleById,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  getVehicleBrands,
  getVehiclesByBrand,
  getVehicleProducts,
};

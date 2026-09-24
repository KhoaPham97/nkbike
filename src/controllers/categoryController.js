const { Category } = require("../models/category");

module.exports = {
  // =====================================================
  // GET ALL CATEGORIES
  // GET /api/categorys
  // =====================================================
  async getCategories(req, res) {
    try {
      const categories = await Category.find({}).sort({ name: 1 }).lean();

      return res.status(200).json({
        success: true,
        categorys: categories,
        total: categories.length,
      });
    } catch (error) {
      console.error("getCategories error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Không thể lấy danh mục",
      });
    }
  },

  // =====================================================
  // GET CATEGORY BY ID
  // GET /api/categorys/:id
  // =====================================================
  async getCategoryById(req, res) {
    try {
      const { id } = req.params;

      const category = await Category.findById(id).lean();

      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy danh mục",
        });
      }

      return res.status(200).json({
        success: true,
        category,
      });
    } catch (error) {
      console.error("getCategoryById error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Không thể lấy danh mục",
      });
    }
  },

  // =====================================================
  // CREATE CATEGORY
  // POST /api/categorys
  // =====================================================
  async createCategory(req, res) {
    try {
      const { name, type, description, image } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({
          success: false,
          message: "Tên danh mục không được để trống",
        });
      }

      const category = new Category({
        name: String(name).trim(),

        type: type !== undefined && type !== null ? String(type) : "",

        description: description || "",

        image: image || "",

        created_at: new Date(),

        updated_at: new Date(),
      });

      await category.save();

      return res.status(201).json({
        success: true,
        message: "Thêm danh mục thành công",
        category,
      });
    } catch (error) {
      console.error("createCategory error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Không thể thêm danh mục",
      });
    }
  },

  // =====================================================
  // UPDATE CATEGORY
  // PATCH /api/categorys/:id
  // =====================================================
  async updateCategory(req, res) {
    try {
      const { id } = req.params;

      const category = await Category.findById(id);

      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy danh mục",
        });
      }

      if (req.body.name !== undefined) {
        category.name = String(req.body.name).trim();
      }

      if (req.body.type !== undefined) {
        category.type = String(req.body.type);
      }

      if (req.body.description !== undefined) {
        category.description = req.body.description;
      }

      if (req.body.image !== undefined) {
        category.image = req.body.image;
      }

      category.updated_at = new Date();

      await category.save();

      return res.status(200).json({
        success: true,
        message: "Cập nhật danh mục thành công",
        category,
      });
    } catch (error) {
      console.error("updateCategory error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Không thể cập nhật danh mục",
      });
    }
  },

  // =====================================================
  // DELETE CATEGORY
  // DELETE /api/categorys/:id
  // =====================================================
  async deleteCategory(req, res) {
    try {
      const { id } = req.params;

      const category = await Category.findByIdAndDelete(id);

      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy danh mục",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Xóa danh mục thành công",
      });
    } catch (error) {
      console.error("deleteCategory error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Không thể xóa danh mục",
      });
    }
  },
};

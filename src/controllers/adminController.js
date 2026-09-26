const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const { User } = require("../models/user");

// ============================================================
// CHANGE ADMIN PASSWORD
// ============================================================

const changeAdminPasswordAsync = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    // ========================================================
    // VALIDATION
    // ========================================================

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập mật khẩu hiện tại và mật khẩu mới",
      });
    }

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu không hợp lệ",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu mới phải có ít nhất 6 ký tự",
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu mới phải khác mật khẩu hiện tại",
      });
    }

    // ========================================================
    // CHECK LOGIN
    // ========================================================

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Vui lòng đăng nhập",
      });
    }

    // ========================================================
    // CHECK USER ID
    // ========================================================

    if (!mongoose.Types.ObjectId.isValid(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: "Tài khoản không hợp lệ",
      });
    }

    // ========================================================
    // FIND USER
    // ========================================================

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy tài khoản",
      });
    }

    // ========================================================
    // CHECK ADMIN
    // ========================================================

    if (user.role && !["admin", "ADMIN"].includes(String(user.role))) {
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền đổi mật khẩu quản trị",
      });
    }

    // ========================================================
    // CHECK CURRENT PASSWORD
    // ========================================================

    if (!user.password) {
      return res.status(500).json({
        success: false,
        message: "Tài khoản chưa có mật khẩu",
      });
    }

    const passwordMatched = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!passwordMatched) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu hiện tại không đúng",
      });
    }

    // ========================================================
    // HASH NEW PASSWORD
    // ========================================================

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // ========================================================
    // SAVE NEW PASSWORD
    // ========================================================

    user.password = hashedPassword;

    await user.save();

    // ========================================================
    // RESPONSE
    // ========================================================

    return res.status(200).json({
      success: true,
      message: "Đổi mật khẩu thành công",
    });
  } catch (error) {
    console.error("changeAdminPasswordAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đổi mật khẩu",
    });
  }
};

module.exports = {
  changeAdminPasswordAsync,
};

const { User } = require("../models/user");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

module.exports = {
  // =========================================================
  // SIGN IN
  // =========================================================
  async signIn(req, res) {
    try {
      const { username, password } = req.body;

      console.log("=================================");
      console.log("ADMIN LOGIN");
      console.log("Username:", username);
      console.log("Password:", password ? "******" : "EMPTY");
      console.log("JWT_SECRET:", process.env.JWT_SECRET ? "OK" : "UNDEFINED");
      console.log("=================================");

      // -------------------------------------------------------
      // Validate
      // -------------------------------------------------------
      if (!username || !password) {
        return res.status(400).json({
          success: false,
          auth: false,
          message: "Vui lòng nhập tài khoản và mật khẩu",
        });
      }

      // -------------------------------------------------------
      // Tìm user
      // -------------------------------------------------------
      const foundUser = await User.findOne({
        username: username.trim(),
      });

      if (!foundUser) {
        console.log("LOGIN RESULT: USER NOT FOUND");

        return res.status(401).json({
          success: false,
          auth: false,
          message: "Tài khoản hoặc mật khẩu không đúng",
        });
      }

      console.log("User found:", foundUser.username);
      console.log("Role:", foundUser.role);
      console.log("MemberShip:", foundUser.memberShip);

      // -------------------------------------------------------
      // Kiểm tra password
      // -------------------------------------------------------
      const isPasswordValid = await bcrypt.compare(
        password,
        foundUser.password,
      );

      console.log("Password valid:", isPasswordValid);

      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          auth: false,
          message: "Tài khoản hoặc mật khẩu không đúng",
        });
      }

      // -------------------------------------------------------
      // Kiểm tra quyền admin
      // -------------------------------------------------------
      const isAdmin =
        foundUser.role === "admin" || foundUser.memberShip === "admin";

      console.log("Is admin:", isAdmin);

      if (!isAdmin) {
        return res.status(403).json({
          success: false,
          auth: false,
          message: "Tài khoản không có quyền quản trị",
        });
      }

      // -------------------------------------------------------
      // Kiểm tra JWT_SECRET
      // -------------------------------------------------------
      if (!process.env.JWT_SECRET) {
        console.error("ERROR: JWT_SECRET chưa được cấu hình");

        return res.status(500).json({
          success: false,
          auth: false,
          message: "Server chưa cấu hình JWT_SECRET",
        });
      }

      // -------------------------------------------------------
      // Tạo JWT
      // -------------------------------------------------------
      const token = jwt.sign(
        {
          id: foundUser._id.toString(),
          username: foundUser.username,
          role: foundUser.role,
          memberShip: foundUser.memberShip,
        },
        process.env.JWT_SECRET,
        {
          expiresIn: "7d",
        },
      );

      console.log("JWT created: OK");

      // -------------------------------------------------------
      // Lưu token vào database
      // -------------------------------------------------------
      foundUser.tokens = Array.isArray(foundUser.tokens)
        ? foundUser.tokens
        : [];

      // Xóa token null / không hợp lệ
      foundUser.tokens = foundUser.tokens.filter((item) => item && item.token);

      foundUser.tokens.push({
        token: token,
      });

      await foundUser.save();

      // -------------------------------------------------------
      // Tạo user response
      // Không trả password và tokens
      // -------------------------------------------------------
      const user = foundUser.toObject();

      delete user.password;
      delete user.tokens;

      // -------------------------------------------------------
      // Response
      // -------------------------------------------------------
      return res.status(200).json({
        success: true,
        auth: true,
        message: "Đăng nhập thành công",
        token: token,
        user: user,
      });
    } catch (error) {
      console.error("signIn error:", error);

      return res.status(500).json({
        success: false,
        auth: false,
        message: error?.message || "Đăng nhập thất bại",
      });
    }
  },

  // =========================================================
  // SIGN UP
  // =========================================================
  async signUp(req, res) {
    try {
      const { username, password } = req.body;

      // -------------------------------------------------------
      // Validate
      // -------------------------------------------------------
      if (!username || !username.trim()) {
        return res.status(400).json({
          success: false,
          message: "Vui lòng nhập username",
        });
      }

      if (!password) {
        return res.status(400).json({
          success: false,
          message: "Vui lòng nhập password",
        });
      }

      // -------------------------------------------------------
      // Kiểm tra username đã tồn tại
      // -------------------------------------------------------
      const existingUser = await User.findOne({
        username: username.trim(),
      });

      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: `Username ${username} đã tồn tại`,
        });
      }

      // -------------------------------------------------------
      // Hash password
      // -------------------------------------------------------
      const hashedPassword = await bcrypt.hash(password, 8);

      // -------------------------------------------------------
      // Create user
      // -------------------------------------------------------
      const user = await User.create({
        username: username.trim(),
        password: hashedPassword,
      });

      // -------------------------------------------------------
      // Response
      // -------------------------------------------------------
      return res.status(201).json({
        success: true,
        message: "Tạo tài khoản thành công",
        user: {
          _id: user._id,
          username: user.username,
        },
      });
    } catch (error) {
      console.error("signUp error:", error);

      return res.status(500).json({
        success: false,
        message: error?.message || "Problem creating a new user",
      });
    }
  },

  // =========================================================
  // SIGN OUT
  // =========================================================
  async signOut(req, res) {
    try {
      const { token, userId } = req.body;

      if (!token || !userId) {
        return res.status(400).json({
          success: false,
          message: "Thiếu token hoặc userId",
        });
      }

      const user = await User.findById(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy user",
        });
      }

      user.tokens = Array.isArray(user.tokens) ? user.tokens : [];

      user.tokens = user.tokens.filter((item) => item && item.token !== token);

      await user.save();

      return res.status(200).json({
        success: true,
        message: "Đăng xuất thành công",
        logout: true,
      });
    } catch (error) {
      console.error("signOut error:", error);

      return res.status(500).json({
        success: false,
        message: "Không thể đăng xuất",
      });
    }
  },
};

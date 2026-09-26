const { verifyToken } = require("../services/authServices");
const { User } = require("../models/user");

const auth = async (req, res, next) => {
  try {
    const header = req.header("Authorization");

    console.log("========== AUTH ==========");
    console.log("Authorization:", header);

    if (!header || !header.startsWith("Bearer ")) {
      console.log("❌ Missing Bearer token");

      return res.status(401).json({
        success: false,
        message: "Missing Authorization Bearer token",
      });
    }

    const token = header.replace("Bearer ", "").trim();

    console.log("Token:", token ? "FOUND" : "EMPTY");

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access token is empty",
      });
    }

    // ============================
    // VERIFY JWT
    // ============================

    const tokenPayload = await verifyToken(token, process.env.JWT_SECRET);

    console.log("Token payload:", tokenPayload);

    if (!tokenPayload?.id) {
      console.log("❌ Token không có id");

      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    // ============================
    // FIND USER
    // ============================

    const user = await User.findOne({
      _id: tokenPayload.id,
      "tokens.token": token,
    });

    console.log("User found:", !!user);

    if (!user) {
      console.log("❌ User không tồn tại hoặc token không nằm trong tokens");

      return res.status(401).json({
        success: false,
        message: "User not logged in or unauthorized",
      });
    }

    // ============================
    // SUCCESS
    // ============================

    req.token = token;
    req.user = user;
    req.tokenPayload = tokenPayload;

    console.log("✅ AUTH SUCCESS");
    console.log("User:", user._id);
    console.log("Role:", user.role);

    next();
  } catch (err) {
    console.error("========== AUTH ERROR ==========");
    console.error(err);

    return res.status(401).json({
      success: false,
      message: "User not logged in or unauthorized",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

module.exports = auth;

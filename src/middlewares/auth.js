const { verifyToken } = require("../services/authServices");
const { User } = require("../models/user");

const auth = async (req, res, next) => {
  try {
    const header = req.header("Authorization");

    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Missing Authorization Bearer token",
      });
    }

    const token = header.replace("Bearer ", "").trim();

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

    if (!tokenPayload?.id) {
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

    if (!user) {
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

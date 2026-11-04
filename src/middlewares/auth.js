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

    const token = header.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access token is empty",
      });
    }

    const tokenPayload = await verifyToken(token, process.env.JWT_SECRET);

    if (!tokenPayload?.id) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    const user = await User.findOne({
      _id: tokenPayload.id,
      "tokens.token": token,
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not logged in",
      });
    }

    req.token = token;
    req.user = user;
    req.tokenPayload = tokenPayload;

    next();
  } catch (err) {
    console.error("AUTH ERROR:", err.message);

    return res.status(401).json({
      success: false,
      message: "Unauthorized",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

const adminOnly = (req, res, next) => {
  const role = String(
    req.user?.role || req.tokenPayload?.role || "",
  ).toLowerCase();

  if (role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Admin permission required",
    });
  }

  next();
};

module.exports = {
  auth,
  adminOnly,
};

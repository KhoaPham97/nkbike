const jwt = require("jsonwebtoken");

const optionalAuth = (req, res, next) => {
  try {
    req.user = null;

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      req.user = decoded;
    } catch (error) {
      // Token hết hạn / không hợp lệ
      // Coi như khách chưa đăng nhập
      req.user = null;
    }

    next();
  } catch (error) {
    req.user = null;
    next();
  }
};

module.exports = optionalAuth;

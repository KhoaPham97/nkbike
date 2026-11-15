const jwt = require("jsonwebtoken");
const { User } = require("../models/user");

const setupOrderNotificationSocket = (io) => {
  const namespace = io.of("/order-notifications");

  // Keep this aligned with the REST admin check: this project supports
  // administrators identified by either role or memberShip. Older tokens
  // created by editUserAsync may contain only the user id, so resolve those
  // against MongoDB instead of rejecting a valid admin session.
  namespace.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Thiếu token"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      let isAdmin =
        decoded.role === "admin" || decoded.memberShip === "admin";

      if (!isAdmin && decoded.id) {
        const user = await User.findById(decoded.id)
          .select("role memberShip")
          .lean();

        isAdmin =
          user?.role === "admin" || user?.memberShip === "admin";

        if (isAdmin) {
          socket.user = {
            ...decoded,
            role: user.role,
            memberShip: user.memberShip,
          };
        }
      } else {
        socket.user = decoded;
      }

      if (!isAdmin) {
        return next(new Error("Không có quyền Admin"));
      }

      socket.user = socket.user || decoded;
      return next();
    } catch (error) {
      console.warn("[Order Notification Socket] Authentication failed:", error.message);
      return next(new Error("Token không hợp lệ hoặc phiên đăng nhập hết hạn"));
    }
  });

  namespace.on("connection", (socket) => {
    socket.join("admins");
    console.log("Admin connected to order notifications:", socket.id);
  });

  console.log("Order notification socket initialized");
};

module.exports = setupOrderNotificationSocket;

const jwt = require("jsonwebtoken");

const setupOrderNotificationSocket = (io) => {
  const namespace = io.of("/order-notifications");

  namespace.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Thiếu token"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role !== "admin") return next(new Error("Không có quyền Admin"));
      socket.user = decoded;
      next();
    } catch (error) {
      next(new Error("Token không hợp lệ"));
    }
  });

  namespace.on("connection", (socket) => {
    socket.join("admins");
    console.log("Admin connected to order notifications:", socket.id);
  });

  console.log("Order notification socket initialized");
};

module.exports = setupOrderNotificationSocket;

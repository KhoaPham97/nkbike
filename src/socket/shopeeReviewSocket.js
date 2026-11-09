const jwt = require("jsonwebtoken");

const setupShopeeReviewSocket = (io) => {
  const namespace = io.of("/shopee-reviews");

  // ==============================
  // AUTHENTICATION
  // ==============================

  namespace.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Thiếu token"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.role !== "admin") {
        return next(new Error("Không có quyền Admin"));
      }

      socket.user = decoded;

      next();
    } catch (error) {
      next(new Error("Token không hợp lệ"));
    }
  });

  // ==============================
  // CONNECTION
  // ==============================

  namespace.on("connection", (socket) => {
    console.log("[Shopee Review] Admin connected:", socket.id);

    socket.join("admins");

    socket.on("disconnect", (reason) => {
      console.log("[Shopee Review] Admin disconnected:", socket.id, reason);
    });
  });

  console.log("[Shopee Review] Socket initialized");
};

module.exports = setupShopeeReviewSocket;

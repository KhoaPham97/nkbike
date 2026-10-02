const setupChatSocket = (io) => {
  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    // Join conversation
    socket.on("chat:join", ({ conversationId }) => {
      if (!conversationId) return;

      const room = `conversation:${conversationId}`;

      socket.join(room);

      console.log(`Socket ${socket.id} joined ${room}`);
    });

    // Leave conversation
    socket.on("chat:leave", ({ conversationId }) => {
      if (!conversationId) return;

      const room = `conversation:${conversationId}`;

      socket.leave(room);
    });

    // Typing
    socket.on("chat:typing", ({ conversationId, senderType }) => {
      if (!conversationId) return;

      socket.to(`conversation:${conversationId}`).emit("chat:typing", {
        conversationId,
        senderType,
      });
    });

    // Stop typing
    socket.on("chat:stop-typing", ({ conversationId, senderType }) => {
      if (!conversationId) return;

      socket.to(`conversation:${conversationId}`).emit("chat:stop-typing", {
        conversationId,
        senderType,
      });
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", socket.id);
    });
  });
};

module.exports = setupChatSocket;

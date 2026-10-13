const setupChatSocket = (io) => {
  io.on("connection", (socket) => {
    // Join conversation
    socket.on("chat:join", ({ conversationId }) => {
      if (!conversationId) return;

      const room = `conversation:${conversationId}`;

      socket.join(room);
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

    socket.on("disconnect", () => {});
  });
};

module.exports = setupChatSocket;

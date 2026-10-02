const express = require("express");

const router = express.Router();

const {
  getOrCreateConversation,
  getMessages,
  getAdminConversations,
  sendMessage,
  markAsRead,
  closeConversation,
} = require("../controllers/chatController");

// CUSTOMER
router.post("/conversation", getOrCreateConversation);

router.get("/conversation/:conversationId/messages", getMessages);

router.post("/conversation/:conversationId/message", sendMessage);

router.put("/conversation/:conversationId/read", markAsRead);

// ADMIN
router.get("/admin/conversations", getAdminConversations);

router.put("/conversation/:conversationId/close", closeConversation);

module.exports = router;

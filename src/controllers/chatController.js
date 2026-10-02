const mongoose = require("mongoose");

const ChatConversation = require("../models/chatConversation");
const ChatMessage = require("../models/chatMessage");
const Customer = require("../models/customer");
// ===============================
// TẠO / LẤY CUỘC CHAT CỦA CUSTOMER
// ===============================
const getOrCreateConversation = async (req, res) => {
  try {
    const { customerId, product } = req.body;

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "customerId là bắt buộc",
      });
    }

    let conversation = await ChatConversation.findOne({
      customerId,
      status: "open",
    });

    if (!conversation) {
      conversation = await ChatConversation.create({
        customerId,
        status: "open",
        productContext: product || {},
        lastMessageAt: new Date(),
      });
    } else if (product?.productId) {
      conversation.productContext = product;
      await conversation.save();
    }

    return res.json({
      success: true,
      conversation,
    });
  } catch (error) {
    console.error("getOrCreateConversation:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể tạo cuộc trò chuyện",
      error: error.message,
    });
  }
};

// ===============================
// CUSTOMER LẤY MESSAGE
// ===============================
const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "conversationId không hợp lệ",
      });
    }

    const messages = await ChatMessage.find({
      conversationId,
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error("getMessages:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy tin nhắn",
      error: error.message,
    });
  }
};

// ===============================
// LẤY DANH SÁCH CHAT CHO ADMIN
// ===============================
const getAdminConversations = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.status === "open" || req.query.status === "closed") {
      filter.status = req.query.status;
    }
    console.log("GET ADMIN CONVERSATIONS:", { filter, page, limit });
    // ========================================== // LẤY CONVERSATIONS // ==========================================
    const [conversations, total] = await Promise.all([
      ChatConversation.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ChatConversation.countDocuments(filter),
    ]);
    // ========================================== // LẤY CUSTOMER IDS // ==========================================
    const customerIds = conversations
      .map((item) => item.customerId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id)); // ========================================== // LẤY CUSTOMERS // ==========================================
    let customers = [];
    if (customerIds.length > 0) {
      customers = await Customer.find({ _id: { $in: customerIds } })
        .select("_id name phone email avatar")
        .lean();
    }
    // ========================================== // TẠO MAP CUSTOMER // ==========================================
    const customerMap = new Map();
    customers.forEach((customer) => {
      customerMap.set(String(customer._id), customer);
    });
    // ========================================== // GHÉP CUSTOMER VÀO CONVERSATION // ==========================================
    const result = conversations.map((conversation) => {
      const customer = customerMap.get(String(conversation.customerId));
      return {
        ...conversation,
        customerId: customer || {
          _id: conversation.customerId,
          name: "Khách hàng",
          phone: "",
          email: "",
        },
      };
    });
    // ========================================== // RESPONSE // ==========================================
    return res.json({
      success: true,
      conversations: result,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("❌ getAdminConversations:", error);
    return res
      .status(500)
      .json({
        success: false,
        message: "Không thể lấy danh sách chat",
        error: error.message,
      });
  }
};
// ===============================
// GỬI MESSAGE
// ===============================
const sendMessage = async (req, res) => {
  try {
    // conversationId lấy từ URL
    const { conversationId } = req.params;

    // Các dữ liệu khác lấy từ body
    const { senderType, senderId, message, images = [], product } = req.body;

    // ==============================
    // CHECK CONVERSATION ID
    // ==============================

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "conversationId là bắt buộc",
      });
    }

    // ==============================
    // CHECK SENDER TYPE
    // ==============================

    if (!["customer", "admin"].includes(senderType)) {
      return res.status(400).json({
        success: false,
        message: 'senderType phải là "customer" hoặc "admin"',
      });
    }

    // ==============================
    // CHECK MESSAGE
    // ==============================

    const textMessage = typeof message === "string" ? message.trim() : "";

    const validImages = Array.isArray(images) ? images : [];

    const validProduct = product && typeof product === "object" ? product : {};

    if (!textMessage && validImages.length === 0 && !validProduct.productId) {
      return res.status(400).json({
        success: false,
        message: "Tin nhắn không được để trống",
      });
    }

    // ==============================
    // FIND CONVERSATION
    // ==============================

    const conversation = await ChatConversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy cuộc trò chuyện",
      });
    }

    // ==============================
    // CHECK CLOSED
    // ==============================

    if (conversation.status === "closed") {
      return res.status(400).json({
        success: false,
        message: "Cuộc trò chuyện đã đóng",
      });
    }

    // ==============================
    // CREATE MESSAGE
    // ==============================

    const newMessage = await ChatMessage.create({
      conversationId,

      senderType,

      senderId: senderId || null,

      message: textMessage,

      images: validImages,

      product: validProduct,

      isRead: false,
    });

    // ==============================
    // UPDATE CONVERSATION
    // ==============================

    let lastMessage = textMessage;

    if (!lastMessage) {
      if (validImages.length > 0) {
        lastMessage = "Đã gửi hình ảnh";
      } else if (validProduct.productId) {
        lastMessage = "Đã gửi sản phẩm";
      }
    }

    conversation.lastMessage = lastMessage;

    conversation.lastMessageAt = new Date();

    // Tin từ customer
    if (senderType === "customer") {
      conversation.unreadAdmin = Number(conversation.unreadAdmin || 0) + 1;
    }

    // Tin từ admin
    if (senderType === "admin") {
      conversation.unreadCustomer =
        Number(conversation.unreadCustomer || 0) + 1;
    }

    await conversation.save();

    // ==============================
    // GET MESSAGE
    // ==============================

    const populatedMessage = await ChatMessage.findById(newMessage._id).lean();

    // ==============================
    // SOCKET.IO
    // ==============================

    const io = req.app.get("io");

    if (io) {
      // Gửi cho những người đang ở conversation
      io.to(`conversation:${conversationId}`).emit(
        "chat:new-message",
        populatedMessage,
      );

      // Cập nhật danh sách conversation
      io.emit("chat:conversation-updated", {
        conversationId,

        lastMessage: conversation.lastMessage,

        lastMessageAt: conversation.lastMessageAt,

        unreadCustomer: conversation.unreadCustomer,

        unreadAdmin: conversation.unreadAdmin,
      });
    }

    // ==============================
    // RESPONSE
    // ==============================

    return res.status(201).json({
      success: true,
      message: populatedMessage,
    });
  } catch (error) {
    console.error("❌ sendMessage:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể gửi tin nhắn",
      error: error.message,
    });
  }
};

// ===============================
// ĐÁNH DẤU ĐÃ ĐỌC
// ===============================
const markAsRead = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { readerType } = req.body;

    if (!["customer", "admin"].includes(readerType)) {
      return res.status(400).json({
        success: false,
        message: "readerType không hợp lệ",
      });
    }

    await ChatMessage.updateMany(
      {
        conversationId,
        senderType: readerType === "customer" ? "admin" : "customer",
        isRead: false,
      },
      {
        $set: {
          isRead: true,
        },
      },
    );

    const update =
      readerType === "customer" ? { unreadCustomer: 0 } : { unreadAdmin: 0 };

    const conversation = await ChatConversation.findByIdAndUpdate(
      conversationId,
      {
        $set: update,
      },
      {
        new: true,
      },
    );

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy cuộc trò chuyện",
      });
    }

    if (req.app.get("io")) {
      req.app.get("io").to(`conversation:${conversationId}`).emit("chat:read", {
        conversationId,
        readerType,
      });

      req.app.get("io").emit("chat:conversation-updated", {
        conversationId,
        unreadCustomer: conversation.unreadCustomer,
        unreadAdmin: conversation.unreadAdmin,
      });
    }

    return res.json({
      success: true,
      conversation,
    });
  } catch (error) {
    console.error("markAsRead:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật trạng thái đọc",
      error: error.message,
    });
  }
};

// ===============================
// ĐÓNG CHAT
// ===============================
const closeConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await ChatConversation.findByIdAndUpdate(
      conversationId,
      {
        $set: {
          status: "closed",
        },
      },
      {
        new: true,
      },
    );

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy cuộc trò chuyện",
      });
    }

    if (req.app.get("io")) {
      req.app
        .get("io")
        .to(`conversation:${conversationId}`)
        .emit("chat:closed", {
          conversationId,
        });
    }

    return res.json({
      success: true,
      conversation,
    });
  } catch (error) {
    console.error("closeConversation:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đóng cuộc trò chuyện",
      error: error.message,
    });
  }
};

module.exports = {
  getOrCreateConversation,
  getMessages,
  getAdminConversations,
  sendMessage,
  markAsRead,
  closeConversation,
};

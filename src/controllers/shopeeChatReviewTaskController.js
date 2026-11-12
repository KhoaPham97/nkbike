const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReview = require("../models/ShopeeReview");
const ShopeeChatConversation = require("../models/ShopeeChatConversation");
const ShopeeChatReviewTask = require("../models/ShopeeChatReviewTask");

const clean = (value) => String(value ?? "").trim();
const SHOP_DISPLAY_NAME = "xediennhatkhang Wavlink VN Local";
const maskAddress = (value) => {
  const address = clean(value);
  if (!address) return "địa chỉ đã đăng ký trên Shopee";
  if (address.startsWith("*")) return address;
  const firstSpace = address.indexOf(" ");
  return firstSpace > 0 ? `******${address.slice(firstSpace)}` : `****** ${address}`;
};
const getTrackingNumber = (order) => clean(
  order?.rawData?.tracking_number ||
  order?.rawData?.trackingNo ||
  order?.rawData?.tracking_number_list?.[0] ||
  order?.rawData?.package_list?.[0]?.tracking_number
);
const makeKey = (shopId, type, ref) => `${shopId}:${type}:${ref}`;

async function upsertTask(data) {
  if (!data.messageText || !data.referenceId) return;
  await ShopeeChatReviewTask.updateOne(
    { eventKey: data.eventKey },
    { $setOnInsert: data },
    { upsert: true }
  );
}

exports.getReviewTasks = async (req, res) => {
  try {
    const shopId = clean(req.query.shopId || req.query.shop_id);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn gian hàng Shopee." });

    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const [orders, reviews, conversations] = await Promise.all([
      ShopeeOrder.find({ shopId, createTime: { $gte: since } }).sort({ createTime: -1 }).limit(100).lean(),
      ShopeeReview.find({ shopId, reviewCreatedAt: { $gte: since } }).sort({ reviewCreatedAt: -1 }).limit(100).lean(),
      ShopeeChatConversation.find({ shopId }).select("conversationId buyerId buyerName").lean(),
    ]);

    const byBuyerId = new Map(conversations.filter(x => x.buyerId).map(x => [String(x.buyerId), x]));
    const byBuyerName = new Map(conversations.filter(x => x.buyerName).map(x => [clean(x.buyerName).toLowerCase(), x]));

    for (const order of orders) {
      const buyerName = clean(order.buyerUsername || "Khách Shopee");
      const buyerId = clean(order.buyerUserId || order.rawData?.buyer_user_id);
      const conversation = byBuyerId.get(buyerId) || byBuyerName.get(buyerName.toLowerCase());
      const eventKey = makeKey(shopId, "new_order", order.orderSn);
      await upsertTask({
        shopId, eventKey, eventType: "new_order", referenceId: order.orderSn,
        buyerName, buyerId, conversationId: conversation?.conversationId || "",
        messageText: `Xin chào, ${SHOP_DISPLAY_NAME} đã nhận được đơn hàng của bạn ${order.orderSn}, vui lòng xác nhận lại thông tin đơn hàng của bạn ${maskAddress(order.recipientAddress)} nhé, chúng tôi sẽ sắp xếp gửi hàng cho bạn sớm nhất có thể.`,
      });

      if (clean(order.orderStatus).toUpperCase() === "SHIPPED") {
        const trackingNumber = getTrackingNumber(order);
        if (trackingNumber) {
          await upsertTask({
            shopId, eventKey: makeKey(shopId, "shipped", order.orderSn), eventType: "shipped",
            referenceId: order.orderSn, buyerName, buyerId,
            conversationId: conversation?.conversationId || "",
            messageText: `👋👋Hi ${SHOP_DISPLAY_NAME}, gói hàng của bạn đã được gửi đi ${trackingNumber}. Nếu bạn có thể kiểm tra và quay video mở hộp ngay khi nhận được hàng, chúng tôi sẽ rất biết ơn.😊`,
          });
        }
      }
    }

    for (const review of reviews) {
      const buyerName = clean(review.customerUsername || review.customerName || "Quý khách hàng");
      const conversation = byBuyerName.get(buyerName.toLowerCase());
      await upsertTask({
        shopId, eventKey: makeKey(shopId, "review", review.commentId),
        eventType: "review", referenceId: review.commentId, buyerName,
        buyerId: conversation?.buyerId || "", conversationId: conversation?.conversationId || "",
        messageText: "Quý khách hàng thân mến, rất cảm ơn vì đánh giá của bạn, chúng tôi sẽ tiếp tục nỗ lực để cung cấp cho bạn những sản phẩm tốt hơn và dịch vụ chất lượng cao, đồng thời chúng tôi cũng hy vọng rằng bạn có thể theo dõi shop chúng tôi, chúng tôi có nhiều sản phẩm chất lượng cao hơn đang chờ bạn ghé thăm.",
      });
    }

    const tasks = await ShopeeChatReviewTask.find({ shopId, status: "pending" })
      .sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, tasks, total: tasks.length, note: "Các nhiệm vụ chỉ được tạo để nhân viên kiểm tra; không tự gửi tin nhắn." });
  } catch (error) {
    console.error("[Shopee Chat review tasks]", error);
    return res.status(500).json({ success: false, message: error.message || "Không thể tải danh sách cần kiểm tra." });
  }
};

exports.updateReviewTask = async (req, res) => {
  try {
    const task = await ShopeeChatReviewTask.findOne({ _id: req.params.taskId, shopId: clean(req.body.shopId || req.query.shopId) });
    if (!task) return res.status(404).json({ success: false, message: "Không tìm thấy nhiệm vụ." });
    const status = clean(req.body.status);
    if (!["sent", "dismissed"].includes(status)) return res.status(400).json({ success: false, message: "Trạng thái không hợp lệ." });
    if (task.status === "sent") return res.status(409).json({ success: false, message: "Nhiệm vụ này đã được đánh dấu đã gửi." });
    task.status = status;
    if (status === "sent") {
      task.sentAt = new Date();
      task.sentBy = req.user?._id || req.admin?._id || null;
    }
    await task.save();
    return res.json({ success: true, task });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || "Không thể cập nhật nhiệm vụ." });
  }
};

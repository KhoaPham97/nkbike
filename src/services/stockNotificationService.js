const emitStockNotification = (io, notification) => {
  if (!io || !notification) return;

  io.of("/stock-notifications").to("admins").emit("stock:notification", {
    _id: notification._id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    productId: notification.productId,
    variantName: notification.variantName,
    qty: notification.qty,
    created_at: notification.created_at,
  });
};

module.exports = {
  emitStockNotification,
};

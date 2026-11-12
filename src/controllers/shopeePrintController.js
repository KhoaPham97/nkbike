const ShopeeOrder = require("../models/ShopeeOrder");
const { callShopeeShopApi } = require("../services/shopeeService");

const normalize = (value) => String(value ?? "").trim();

exports.getSelfDesignWaybillDataAsync = async (req, res) => {
  try {
    const shopId = normalize(req.body?.shopId || req.query?.shopId);
    const orderSn = normalize(req.params?.orderSn);
    const packageNumber = normalize(req.body?.packageNumber);

    if (!shopId || !orderSn) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId hoặc mã đơn Shopee.",
      });
    }

    const order = await ShopeeOrder.findOne({ shopId, orderSn }).lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng trong shop đã chọn.",
      });
    }

    if (!["PROCESSED", "SHIPPED", "COMPLETED"].includes(String(order.orderStatus || "").toUpperCase())) {
      return res.status(400).json({
        success: false,
        code: "ORDER_NOT_READY_FOR_WAYBILL",
        message: "Đơn chưa ở trạng thái cho phép lấy dữ liệu vận đơn. Hãy xác nhận gửi hàng trên Shopee trước.",
      });
    }

    const body = { order_sn: orderSn };
    if (packageNumber) body.package_number = packageNumber;

    const apiResult = await callShopeeShopApi({
      shopId,
      path: "/api/v2/logistics/get_shipping_document_data_info",
      method: "POST",
      body,
    });

    const response = apiResult?.response || apiResult;
    const shippingInfo = response?.shipping_document_info || response?.shipping_document_info_list?.[0];

    if (!shippingInfo) {
      const apiMessage = apiResult?.message || response?.message;
      throw new Error(apiMessage || "Shopee không trả về dữ liệu vận đơn để tự thiết kế.");
    }

    const trackingNumber = normalize(shippingInfo.tracking_number);
    if (!trackingNumber) {
      throw new Error("Shopee chưa cấp mã vận đơn cho đơn này. Vui lòng thử lại sau.");
    }

    return res.status(200).json({
      success: true,
      data: {
        orderSn,
        shopId,
        packageNumber,
        trackingNumber,
        shopeeTrackingNumber: normalize(shippingInfo.shopee_tracking_number),
        shippingCarrier: normalize(shippingInfo.shipping_carrier || order.shippingCarrier),
        cod: Boolean(shippingInfo.cod),
        codAmount: Number(shippingInfo.cod_amount || 0),
        orderWeight: Number(shippingInfo.order_weight || 0),
        deliverArea: normalize(shippingInfo.deliver_area),
        createDate: normalize(shippingInfo.create_date_ymd_sl),
        recipientSortCode: shippingInfo.recipient_sort_code || {},
        senderSortCode: shippingInfo.sender_sort_code || {},
        returnSortCode: shippingInfo.return_sort_code || {},
        mutualCheck: shippingInfo.mutual_check,
        preferredDeliveryOption: shippingInfo.preferred_delivery_option,
        order: {
          orderSn: order.orderSn,
          recipientName: order.recipientName,
          recipientPhone: order.recipientPhone,
          recipientAddress: order.recipientAddress,
          buyerUsername: order.buyerUsername,
          totalAmount: Number(order.totalAmount || 0),
          paymentMethod: order.paymentMethod,
          shippingCarrier: order.shippingCarrier,
          items: (order.items || []).map((item) => ({
            itemName: item.itemName,
            variantName: item.variantName || item.modelName,
            sku: item.variationSku || item.itemSku,
            quantity: Number(item.quantity || 0),
            unitPrice: Number(item.unitPrice || 0),
          })),
        },
        recipientAddressInfo: response?.recipient_address_info || null,
      },
      requestId: apiResult?.request_id || null,
    });
  } catch (error) {
    console.error("[Shopee Waybill] getSelfDesignWaybillDataAsync:", error);
    return res.status(400).json({
      success: false,
      message: error?.response?.data?.message || error.message || "Không lấy được dữ liệu vận đơn.",
      code: error?.response?.data?.error || error.shopeeError || null,
      requestId: error?.response?.data?.request_id || error.shopeeRequestId || null,
    });
  }
};

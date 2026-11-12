const ShopeeOrder = require("../models/ShopeeOrder");
const { callShopeeShopApi } = require("../services/shopeeService");

const clean = (v) => String(v ?? "").trim();
const unwrap = (v) => v?.response || v || {};
const statuses = new Set(["PROCESSED", "SHIPPED"]);

function parseList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error("Chọn từ 1 đến 50 kiện hàng mỗi lần.");
  }
  const seen = new Set();
  return value.map((v) => ({
    orderSn: clean(v?.orderSn || v?.order_sn),
    packageNumber: clean(v?.packageNumber || v?.package_number),
    shippingDocumentType: clean(v?.shippingDocumentType || v?.shipping_document_type),
  })).filter((v) => {
    if (!v.orderSn) throw new Error("Thiếu mã đơn Shopee.");
    const key = v.orderSn + "::" + v.packageNumber;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolvePackages(shopId, items) {
  const result = [];
  for (const item of items) {
    const local = await ShopeeOrder.findOne({ shopId, orderSn: item.orderSn }).lean();
    if (!local) throw new Error(`Không tìm thấy đơn ${item.orderSn} trong shop.`);
    if (!statuses.has(clean(local.orderStatus).toUpperCase())) {
      throw new Error(`Đơn ${item.orderSn} chưa ở trạng thái PROCESSED/SHIPPED để in.`);
    }
    const detail = await callShopeeShopApi({
      shopId, path: "/api/v2/order/get_order_detail", method: "GET",
      params: { order_sn_list: item.orderSn, response_optional_fields: "package_list" },
    });
    const remote = (unwrap(detail).order_list || []).find((x) => clean(x.order_sn) === item.orderSn);
    const packages = Array.isArray(remote?.package_list) ? remote.package_list : [];
    if (!packages.length) throw new Error(`Shopee chưa tạo kiện hàng cho đơn ${item.orderSn}.`);
    const selectedPackages = item.packageNumber
      ? packages.filter((x) => clean(x.package_number) === item.packageNumber)
      : packages;
    if (!selectedPackages.length) throw new Error(`Không tìm thấy kiện của đơn ${item.orderSn}.`);
    for (const selected of selectedPackages) {
      const packageNumber = clean(selected.package_number);
      const detailPackage = await callShopeeShopApi({
        shopId, path: "/api/v2/order/get_package_detail", method: "GET",
        params: { package_number_list: packageNumber },
      });
      const packageInfo = (unwrap(detailPackage).package_list || []).find(
        (x) => clean(x.package_number) === packageNumber,
      );
      const trackingNumber = clean(packageInfo?.tracking_number || selected.tracking_number);
      if (!trackingNumber) throw new Error(`Kiện ${packageNumber} chưa có mã vận đơn.`);
      result.push({
        order_sn: item.orderSn, package_number: packageNumber,
        tracking_number: trackingNumber, shippingDocumentType: item.shippingDocumentType,
      });
    }
  }
  if (result.length > 50) throw new Error("Shopee chỉ cho phép tối đa 50 kiện hàng mỗi lần in.");
  return result;
}

function fail(res, error) {
  const data = error?.response?.data;
  return res.status(400).json({
    success: false,
    message: data?.message || data?.msg || error?.message || "Không xử lý được vận đơn.",
    code: data?.error || error?.shopeeError || null,
    requestId: data?.request_id || error?.shopeeRequestId || null,
  });
}

exports.getParameters = async (req, res) => {
  try {
    const shopId = clean(req.body?.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const packages = await resolvePackages(shopId, parseList(req.body?.orderList));
    const raw = await callShopeeShopApi({
      shopId, path: "/api/v2/logistics/get_shipping_document_parameter", method: "POST",
      body: { order_list: packages.map(({ order_sn, package_number }) => ({ order_sn, package_number })) },
    });
    const list = unwrap(raw).result_list || [];
    return res.json({
      success: true,
      requestId: raw.request_id || null,
      data: list.map((entry) => {
        const pkg = packages.find((p) => p.order_sn === clean(entry.order_sn) &&
          (!entry.package_number || p.package_number === clean(entry.package_number)));
        return pkg ? { ...entry, tracking_number: pkg.tracking_number } : entry;
      }),
    });
  } catch (error) { console.error("[Shopee AWB] parameters", error); return fail(res, error); }
};

exports.createDocuments = async (req, res) => {
  try {
    const shopId = clean(req.body?.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const requested = parseList(req.body?.orderList);
    const packages = await resolvePackages(shopId, requested);
    const paramsRaw = await callShopeeShopApi({
      shopId, path: "/api/v2/logistics/get_shipping_document_parameter", method: "POST",
      body: { order_list: packages.map(({ order_sn, package_number }) => ({ order_sn, package_number })) },
    });
    const parameterList = unwrap(paramsRaw).result_list || [];
    const payload = packages.map((pkg) => {
      const param = parameterList.find((p) => clean(p.order_sn) === pkg.order_sn &&
        (!p.package_number || clean(p.package_number) === pkg.package_number));
      if (param?.fail_error) throw new Error(param.fail_message || param.fail_error);
      const type = pkg.shippingDocumentType || param?.suggest_shipping_document_type;
      const choices = param?.selectable_shipping_document_type || [];
      if (!type || (choices.length && !choices.includes(type))) {
        throw new Error(`Loại vận đơn không được hỗ trợ cho đơn ${pkg.order_sn}.`);
      }
      return { order_sn: pkg.order_sn, package_number: pkg.package_number,
        tracking_number: pkg.tracking_number, shipping_document_type: type };
    });
    const raw = await callShopeeShopApi({
      shopId, path: "/api/v2/logistics/create_shipping_document", method: "POST",
      body: { order_list: payload },
    });
    return res.json({ success: true, requestId: raw.request_id || null, data: unwrap(raw).result_list || [] });
  } catch (error) { console.error("[Shopee AWB] create", error); return fail(res, error); }
};

exports.getResult = async (req, res) => {
  try {
    const shopId = clean(req.body?.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const packages = await resolvePackages(shopId, parseList(req.body?.orderList));
    const raw = await callShopeeShopApi({
      shopId, path: "/api/v2/logistics/get_shipping_document_result", method: "POST",
      body: { order_list: packages.map(({ order_sn, package_number }) => ({ order_sn, package_number })) },
    });
    return res.json({ success: true, requestId: raw.request_id || null, data: unwrap(raw).result_list || [] });
  } catch (error) { console.error("[Shopee AWB] result", error); return fail(res, error); }
};

exports.downloadDocuments = async (req, res) => {
  try {
    const shopId = clean(req.body?.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const requested = parseList(req.body?.orderList);
    const packages = await resolvePackages(shopId, requested);
    const types = [...new Set(requested.map((x) => x.shippingDocumentType).filter(Boolean))];
    if (types.length > 1) throw new Error("Hãy tải riêng các nhóm có loại vận đơn khác nhau.");
    const raw = await callShopeeShopApi({
      shopId, path: "/api/v2/logistics/download_shipping_document", method: "POST",
      body: {
        order_list: packages.map(({ order_sn, package_number }) => ({ order_sn, package_number })),
        ...(types[0] ? { shipping_document_type: types[0] } : {}),
      },
      responseType: "arraybuffer",
    });
    const contentType = String(raw.headers?.["content-type"] || "application/pdf");
    if (contentType.includes("application/json")) {
      const payload = JSON.parse(Buffer.from(raw.data).toString("utf8"));
      throw new Error(payload?.message || payload?.msg || payload?.error || "Shopee chưa trả về file vận đơn.");
    }
    const buffer = Buffer.from(raw.data);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", 'inline; filename="shopee-waybills.pdf"');
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (error) { console.error("[Shopee AWB] download", error); return fail(res, error); }
};

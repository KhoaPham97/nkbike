const { callShopeeShopApi } = require("./shopeeService");

const PATH = {
  ITEM_LIST: "/api/v2/product/get_item_list",
  ITEM_INFO: "/api/v2/product/get_item_base_info",
  MODEL_LIST: "/api/v2/product/get_model_list",
  UPDATE_ITEM: "/api/v2/product/update_item",
  UPDATE_PRICE: "/api/v2/product/update_price",
  UPDATE_STOCK: "/api/v2/product/update_stock",
};

const ITEM_STATUSES = [
  "NORMAL",
  "UNLIST",
  "BANNED",
  "REVIEWING",
  "SELLER_DELETE",
  "SHOPEE_DELETE",
];

function unwrap(data) {
  return data?.response || data || {};
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function validateShopId(shopId) {
  const value = String(shopId || "").trim();

  if (!/^\d+$/.test(value)) {
    throw new Error("shopId không hợp lệ.");
  }

  return value;
}

function validateId(value, field = "ID") {
  const normalized = String(value ?? "").trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${field} không hợp lệ.`);
  }

  return Number(normalized);
}

function validatePositive(value, field) {
  const result = Number(value);

  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`${field} phải lớn hơn 0.`);
  }

  return result;
}

function validateNonNegativeInteger(value, field) {
  const result = Number(value);

  if (!Number.isFinite(result) || result < 0 || !Number.isInteger(result)) {
    throw new Error(`${field} phải là số nguyên không âm.`);
  }

  return result;
}

function validateText(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${field} không hợp lệ.`);
  }

  const result = value.trim();

  if (!result) {
    throw new Error(`${field} không được để trống.`);
  }

  if (result.length > maxLength) {
    throw new Error(`${field} tối đa ${maxLength} ký tự.`);
  }

  return result;
}

function getPriceInfo(item) {
  if (Array.isArray(item?.price_info)) {
    return item.price_info[0] || {};
  }

  return item?.price_info || {};
}

function getStockInfo(item) {
  return item?.stock_info_v2 || {};
}

function normalizeModel(model) {
  const price = getPriceInfo(model);
  const stock = getStockInfo(model);
  const summary = stock.summary_info || {};

  return {
    modelId: String(model.model_id ?? ""),
    modelName: model.model_name || "",
    modelSku: model.model_sku || "",
    modelStatus: model.model_status || "",
    tierIndex: model.tier_index || [],

    originalPrice: number(price.original_price ?? price.current_price),

    currentPrice: number(price.current_price),

    stock: number(summary.total_available_stock),
    reservedStock: number(summary.total_reserved_stock),

    sellerStock: (stock.seller_stock || []).map((entry) => ({
      locationId: entry.location_id || "",
      stock: number(entry.stock),
    })),

    shopeeStock: stock.shopee_stock || [],
  };
}

function normalizeItem(item, statusFallback = "") {
  const price = getPriceInfo(item);
  const stock = getStockInfo(item);
  const summary = stock.summary_info || {};

  return {
    itemId: String(item.item_id || ""),
    itemName: item.item_name || "",
    itemSku: item.item_sku || "",
    itemStatus: item.item_status || statusFallback,

    categoryId: String(item.category_id || ""),
    hasModel: Boolean(item.has_model),

    image: item.image?.image_url_list?.[0] || "",
    images: item.image?.image_url_list || [],
    imageIds: item.image?.image_id_list || [],

    originalPrice: number(price.original_price ?? price.current_price),
    currentPrice: number(price.current_price),

    stock: number(summary.total_available_stock),
    reservedStock: number(summary.total_reserved_stock),

    description: item.description || "",
    descriptionType: item.description_type || "normal",

    weight: number(item.weight),
    dimension: item.dimension || {},

    brand: item.brand || {},
    attributes: item.attribute_list || [],
    logistics: item.logistic_info || [],

    createTime: item.create_time || null,
    updateTime: item.update_time || null,
  };
}

// =====================================================
// 1. DANH SÁCH SẢN PHẨM
// GET /api/v2/product/get_item_list
// =====================================================

async function getShopeeProductList({
  shopId,
  page = 1,
  pageSize = 20,
  itemStatus = "NORMAL",
}) {
  const normalizedShopId = validateShopId(shopId);

  const currentPage = Math.max(Math.floor(number(page, 1)), 1);

  const limit = Math.min(Math.max(Math.floor(number(pageSize, 20)), 1), 100);

  const status = String(itemStatus || "NORMAL").toUpperCase();

  if (!ITEM_STATUSES.includes(status)) {
    throw new Error("Trạng thái sản phẩm không hợp lệ.");
  }

  const offset = (currentPage - 1) * limit;

  const data = await callShopeeShopApi({
    shopId: normalizedShopId,
    path: PATH.ITEM_LIST,
    method: "GET",
    params: {
      offset,
      page_size: limit,
      item_status: status,
    },
  });

  const response = unwrap(data);
  const items = response.item || response.item_list || [];

  return {
    shopId: normalizedShopId,
    items: items.map((item) => ({
      itemId: String(item.item_id || ""),
      itemStatus: item.item_status || status,
      updateTime: item.update_time || null,
      createTime: item.create_time || null,
    })),
    total: number(response.total_count),
    hasMore: Boolean(response.has_next_page),
    nextOffset: number(response.next_offset, offset + items.length),
    page: currentPage,
    pageSize: limit,
    requestId: data.request_id || null,
  };
}

// =====================================================
// 2. THÔNG TIN CƠ BẢN NHIỀU SẢN PHẨM
// Shopee giới hạn 50 item_id mỗi request
// =====================================================

async function getShopeeProductBaseInfo(shopId, itemIds) {
  const normalizedShopId = validateShopId(shopId);

  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return [];
  }

  const ids = [...new Set(itemIds.map((id) => validateId(id, "itemId")))];

  const result = [];

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);

    const data = await callShopeeShopApi({
      shopId: normalizedShopId,
      path: PATH.ITEM_INFO,
      method: "GET",
      params: {
        item_id_list: chunk.join(","),
        response_optional_fields: [
          "item_sku",
          "description",
          "weight",
          "dimension",
          "image",
          "brand",
          "attribute_list",
          "logistic_info",
          "price_info",
          "stock_info_v2",
          "item_status",
          "has_model",
          "category_id",
          "description_type",
          "description_info",
          "create_time",
          "update_time",
        ].join(","),
      },
    });

    const response = unwrap(data);
    result.push(...(response.item_list || []));
  }

  return result;
}

// =====================================================
// 3. DANH SÁCH PHÂN LOẠI
// =====================================================

async function getShopeeProductModels(shopId, itemId) {
  const normalizedShopId = validateShopId(shopId);
  const normalizedItemId = validateId(itemId, "itemId");

  const data = await callShopeeShopApi({
    shopId: normalizedShopId,
    path: PATH.MODEL_LIST,
    method: "GET",
    params: {
      item_id: normalizedItemId,
    },
  });

  const response = unwrap(data);

  return {
    tierVariation: response.tier_variation || [],
    models: (response.model || []).map(normalizeModel),
  };
}

// =====================================================
// 4. CHI TIẾT SẢN PHẨM
// =====================================================

async function getShopeeProductDetail(shopId, itemId) {
  const normalizedShopId = validateShopId(shopId);
  const normalizedItemId = validateId(itemId, "itemId");

  const items = await getShopeeProductBaseInfo(normalizedShopId, [
    normalizedItemId,
  ]);

  if (!items.length) {
    throw new Error("Không tìm thấy sản phẩm trên Shopee.");
  }

  const item = items[0];
  const product = normalizeItem(item);

  let variants = {
    tierVariation: [],
    models: [],
  };

  if (product.hasModel) {
    variants = await getShopeeProductModels(normalizedShopId, normalizedItemId);
  }

  return {
    shopId: normalizedShopId,
    ...product,
    tierVariation: variants.tierVariation,
    models: variants.models,

    // Chỉ dùng để đọc, không gửi ngược nguyên object này lên Shopee.
    descriptionInfo: item.description_info || null,
  };
}

// =====================================================
// 5. KIỂM TRA MÔ TẢ TRƯỚC KHI GHI
// Không làm mất mô tả mở rộng có ảnh.
// =====================================================

async function assertNormalDescription(shopId, itemId) {
  const items = await getShopeeProductBaseInfo(shopId, [itemId]);

  if (!items.length) {
    throw new Error("Không tìm thấy sản phẩm trên Shopee.");
  }

  const item = items[0];
  const type = String(item.description_type || "normal").toLowerCase();

  if (type === "extended") {
    throw new Error(
      "Sản phẩm dùng mô tả mở rộng. Chưa hỗ trợ ghi đè mô tả này để tránh mất hình ảnh và bố cục.",
    );
  }
}

// =====================================================
// 6. CẬP NHẬT THÔNG TIN CƠ BẢN
// =====================================================

async function updateShopeeProductInfo(shopId, itemId, changes = {}) {
  const normalizedShopId = validateShopId(shopId);
  const normalizedItemId = validateId(itemId, "itemId");

  const body = {
    item_id: normalizedItemId,
  };

  if (changes.itemName !== undefined) {
    body.item_name = validateText(changes.itemName, "Tên sản phẩm", 255);
  }

  if (changes.description !== undefined) {
    await assertNormalDescription(normalizedShopId, normalizedItemId);

    if (typeof changes.description !== "string") {
      throw new Error("Mô tả không hợp lệ.");
    }

    if (changes.description.length > 50000) {
      throw new Error("Mô tả vượt quá giới hạn 50.000 ký tự.");
    }

    body.description = changes.description;
  }

  if (changes.weight !== undefined) {
    body.weight = validatePositive(changes.weight, "Cân nặng");
  }

  if (changes.dimension !== undefined) {
    const dimension = changes.dimension || {};

    body.dimension = {
      package_length: Math.round(
        validatePositive(dimension.package_length, "Chiều dài"),
      ),
      package_width: Math.round(
        validatePositive(dimension.package_width, "Chiều rộng"),
      ),
      package_height: Math.round(
        validatePositive(dimension.package_height, "Chiều cao"),
      ),
    };
  }

  if (Object.keys(body).length === 1) {
    throw new Error("Không có thông tin cần cập nhật.");
  }

  const data = await callShopeeShopApi({
    shopId: normalizedShopId,
    path: PATH.UPDATE_ITEM,
    method: "POST",
    body,
  });

  return {
    success: true,
    requestId: data.request_id || null,
    response: unwrap(data),
  };
}

// =====================================================
// 7. CẬP NHẬT GIÁ
// =====================================================

async function updateShopeeProductPrices(shopId, itemId, priceList) {
  const normalizedShopId = validateShopId(shopId);
  const normalizedItemId = validateId(itemId, "itemId");

  if (!Array.isArray(priceList) || !priceList.length) {
    throw new Error("Vui lòng nhập giá cần cập nhật.");
  }

  if (priceList.length > 50) {
    throw new Error("Mỗi lần chỉ cập nhật tối đa 50 phân loại.");
  }

  const normalizedList = priceList.map((item) => ({
    model_id: validateId(item.modelId ?? 0, "modelId"),
    original_price: validatePositive(item.originalPrice, "Giá bán"),
  }));

  const ids = normalizedList.map((item) => item.model_id);

  if (new Set(ids).size !== ids.length) {
    throw new Error("Danh sách giá có modelId bị trùng.");
  }

  const data = await callShopeeShopApi({
    shopId: normalizedShopId,
    path: PATH.UPDATE_PRICE,
    method: "POST",
    body: {
      item_id: normalizedItemId,
      price_list: normalizedList,
    },
  });

  const response = unwrap(data);
  const failures = response.failure_list || [];

  return {
    success: failures.length === 0,
    requestId: data.request_id || null,
    successList: response.success_list || [],
    failureList: failures,
    response,
  };
}

// =====================================================
// 8. CẬP NHẬT TỒN KHO
// =====================================================

async function updateShopeeProductStock(shopId, itemId, stockList) {
  const normalizedShopId = validateShopId(shopId);
  const normalizedItemId = validateId(itemId, "itemId");

  if (!Array.isArray(stockList) || !stockList.length) {
    throw new Error("Vui lòng nhập tồn kho cần cập nhật.");
  }

  if (stockList.length > 50) {
    throw new Error("Mỗi lần chỉ cập nhật tối đa 50 phân loại.");
  }

  const normalizedList = stockList.map((item) => {
    const modelId = validateId(item.modelId ?? 0, "modelId");

    const entry = {
      model_id: modelId,
    };

    const warehouses = Array.isArray(item.sellerStock) ? item.sellerStock : [];

    if (warehouses.length) {
      entry.seller_stock = warehouses.map((warehouse) => {
        const stock = validateNonNegativeInteger(warehouse.stock, "Tồn kho");

        const result = { stock };

        if (warehouse.locationId) {
          result.location_id = String(warehouse.locationId);
        }

        return result;
      });
    } else {
      entry.seller_stock = [
        {
          stock: validateNonNegativeInteger(item.stock, "Tồn kho"),
        },
      ];
    }

    return entry;
  });

  const ids = normalizedList.map((item) => item.model_id);

  if (new Set(ids).size !== ids.length) {
    throw new Error("Danh sách tồn kho có modelId bị trùng.");
  }

  const data = await callShopeeShopApi({
    shopId: normalizedShopId,
    path: PATH.UPDATE_STOCK,
    method: "POST",
    body: {
      item_id: normalizedItemId,
      stock_list: normalizedList,
    },
  });

  const response = unwrap(data);
  const failures = response.failure_list || [];

  return {
    success: failures.length === 0,
    requestId: data.request_id || null,
    successList: response.success_list || [],
    failureList: failures,
    response,
  };
}

module.exports = {
  ITEM_STATUSES,

  getShopeeProductList,
  getShopeeProductBaseInfo,
  getShopeeProductModels,
  getShopeeProductDetail,

  updateShopeeProductInfo,
  updateShopeeProductPrices,
  updateShopeeProductStock,
};

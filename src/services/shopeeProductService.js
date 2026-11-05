const ShopeeProduct = require("../models/ShopeeProduct");
const { callShopeeShopApi } = require("./shopeeService");

const ITEM_LIST_PATH = "/api/v2/product/get_item_list";
const ITEM_INFO_PATH = "/api/v2/product/get_item_base_info";
const MODEL_LIST_PATH = "/api/v2/product/get_model_list";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getResponse(data) {
  return data?.response || data || {};
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getImageList(item) {
  const images =
    item?.image?.image_url_list || item?.image_url_list || item?.images || [];

  return Array.isArray(images) ? images.filter(Boolean) : [];
}

function getPriceInfo(item) {
  const price = Array.isArray(item?.price_info)
    ? item.price_info[0]
    : item?.price_info;

  return {
    price: toNumber(price?.current_price ?? price?.original_price),
    originalPrice: toNumber(price?.original_price ?? price?.current_price),
  };
}

function getStockInfo(item) {
  const stock = item?.stock_info_v2 || {};
  const summary = stock.summary_info || {};

  const available = toNumber(
    summary.total_available_stock ??
      item?.stock_info?.[0]?.normal_stock ??
      item?.stock_info?.[0]?.current_stock,
  );

  const reserved = toNumber(summary.total_reserved_stock);

  return {
    stock: available,
    normalStock: available,
    reservedStock: reserved,
  };
}

function normalizeModel(model) {
  const priceInfo = Array.isArray(model?.price_info)
    ? model.price_info[0]
    : model?.price_info;

  const stockInfo = model?.stock_info_v2 || {};
  const summary = stockInfo.summary_info || {};

  const available = toNumber(
    summary.total_available_stock ??
      model?.stock_info?.[0]?.normal_stock ??
      model?.stock_info?.[0]?.current_stock,
  );

  const reserved = toNumber(summary.total_reserved_stock);

  return {
    modelId: String(model?.model_id ?? "0"),
    modelName: Array.isArray(model?.tier_index)
      ? model.tier_index.join(" / ")
      : String(model?.model_name || ""),
    modelSku: String(model?.model_sku || ""),
    price: toNumber(priceInfo?.current_price ?? priceInfo?.original_price),
    originalPrice: toNumber(
      priceInfo?.original_price ?? priceInfo?.current_price,
    ),
    stock: available,
    normalStock: available,
    reservedStock: reserved,
    status: String(model?.model_status || ""),
  };
}

async function getShopeeItemList({
  shopId,
  offset = 0,
  pageSize = 100,
  itemStatus = "NORMAL",
}) {
  const data = await callShopeeShopApi({
    shopId,
    path: ITEM_LIST_PATH,
    method: "GET",
    params: {
      offset,
      page_size: pageSize,
      item_status: itemStatus,
    },
  });

  const response = getResponse(data);

  return {
    items: response.item || response.item_list || [],
    totalCount: toNumber(response.total_count),
    hasNextPage: Boolean(response.has_next_page),
    raw: data,
  };
}

async function getShopeeItemBaseInfo(shopId, itemIds) {
  if (!itemIds.length) return [];

  const data = await callShopeeShopApi({
    shopId,
    path: ITEM_INFO_PATH,
    method: "GET",
    params: {
      item_id_list: itemIds.join(","),
    },
  });

  const response = getResponse(data);

  return response.item_list || [];
}

async function getShopeeItemModels(shopId, itemId) {
  const data = await callShopeeShopApi({
    shopId,
    path: MODEL_LIST_PATH,
    method: "GET",
    params: {
      item_id: Number(itemId),
    },
  });

  const response = getResponse(data);
  return response.model || [];
}

async function buildShopeeProduct(shopId, item) {
  const itemId = String(item.item_id);

  let models = [];

  if (item.has_model) {
    const remoteModels = await getShopeeItemModels(shopId, itemId);
    models = remoteModels.map(normalizeModel);
  }

  const images = getImageList(item);
  const priceInfo = getPriceInfo(item);
  const stockInfo = getStockInfo(item);

  const totalModelStock = models.reduce(
    (total, model) => total + model.stock,
    0,
  );

  const minModelPrice = models.length
    ? Math.min(...models.map((model) => model.price))
    : priceInfo.price;

  const maxModelPrice = models.length
    ? Math.max(...models.map((model) => model.price))
    : priceInfo.price;

  return {
    shopId: String(shopId),
    itemId,
    itemName: String(item.item_name || ""),
    itemSku: String(item.item_sku || ""),
    image: images[0] || "",
    images,
    description: String(item.description || ""),
    categoryId: String(item.category_id || ""),
    price: minModelPrice,
    maxPrice: maxModelPrice,
    stock: models.length ? totalModelStock : stockInfo.stock,
    status: String(item.item_status || ""),
    itemStatus: String(item.item_status || ""),
    models,
    isDeletedOnShopee: false,
    lastSyncedAt: new Date(),
    rawData: item,
  };
}

/**
 * Đồng bộ sản phẩm theo từng trang.
 *
 * Mặc định đồng bộ tối đa 10 trang x 100 sản phẩm/lần
 * để tránh request kéo dài gây timeout trên server.
 * Gọi lại với nextOffset để tiếp tục phần còn lại.
 */
async function syncShopeeProducts({
  shopId,
  offset = 0,
  pageSize = 100,
  maxPages = 10,
  itemStatus = "NORMAL",
}) {
  if (!shopId) throw new Error("Thiếu shopId");

  const normalizedShopId = String(shopId);
  const limit = Math.min(Math.max(toNumber(pageSize, 100), 1), 100);
  const pages = Math.min(Math.max(toNumber(maxPages, 10), 1), 50);

  let currentOffset = Math.max(toNumber(offset), 0);
  let syncedCount = 0;
  let failedCount = 0;
  let totalCount = 0;
  let hasMore = false;
  const errors = [];

  for (let page = 0; page < pages; page += 1) {
    const listResult = await getShopeeItemList({
      shopId: normalizedShopId,
      offset: currentOffset,
      pageSize: limit,
      itemStatus,
    });

    totalCount = listResult.totalCount || totalCount;

    const itemIds = listResult.items
      .map((item) => item.item_id)
      .filter(Boolean);

    if (!itemIds.length) {
      hasMore = false;
      break;
    }

    // Shopee giới hạn số item_id trong một lần lấy base info.
    // Chia thành nhóm 50 sản phẩm.
    for (let i = 0; i < itemIds.length; i += 50) {
      const chunk = itemIds.slice(i, i + 50);

      const baseItems = await getShopeeItemBaseInfo(normalizedShopId, chunk);

      for (const item of baseItems) {
        try {
          const product = await buildShopeeProduct(normalizedShopId, item);

          await ShopeeProduct.findOneAndUpdate(
            {
              shopId: normalizedShopId,
              itemId: product.itemId,
            },
            { $set: product },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
            },
          );

          syncedCount += 1;

          // Giảm tốc độ gọi API model để hạn chế request dồn dập.
          if (item.has_model) await sleep(100);
        } catch (error) {
          failedCount += 1;
          errors.push({
            itemId: String(item.item_id || ""),
            itemName: item.item_name || "",
            message: error.message,
          });
        }
      }
    }

    currentOffset += itemIds.length;

    hasMore =
      listResult.hasNextPage || (totalCount > 0 && currentOffset < totalCount);

    if (!hasMore || itemIds.length < limit) break;
  }

  return {
    shopId: normalizedShopId,
    syncedCount,
    failedCount,
    totalCount,
    nextOffset: currentOffset,
    hasMore,
    itemStatus,
    errors: errors.slice(0, 30),
  };
}

async function getShopeeProducts({
  shopId,
  page = 1,
  limit = 20,
  keyword = "",
  status = "",
}) {
  const filter = {};

  if (shopId) filter.shopId = String(shopId);

  if (status) filter.itemStatus = String(status);

  if (keyword) {
    const regex = new RegExp(
      String(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );

    filter.$or = [{ itemName: regex }, { itemSku: regex }, { itemId: regex }];
  }

  const currentPage = Math.max(toNumber(page, 1), 1);
  const pageLimit = Math.min(Math.max(toNumber(limit, 20), 1), 100);

  const [products, total] = await Promise.all([
    ShopeeProduct.find(filter)
      .sort({ lastSyncedAt: -1, itemName: 1 })
      .skip((currentPage - 1) * pageLimit)
      .limit(pageLimit)
      .lean(),
    ShopeeProduct.countDocuments(filter),
  ]);

  return {
    products,
    pagination: {
      page: currentPage,
      limit: pageLimit,
      total,
      totalPages: Math.ceil(total / pageLimit),
    },
  };
}

module.exports = {
  syncShopeeProducts,
  getShopeeProducts,
};

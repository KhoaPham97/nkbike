const orderedStockQty =
  Number(orderItem.quantity || 0) * Number(orderItem.quantityMultiplier || 1);

const alreadyDeducted = Number(orderItem.deductedQty || 0);

const remainingOrderQty = orderedStockQty - alreadyDeducted;

if (qty > remainingOrderQty) {
  throw new Error(
    `Số lượng xuất vượt số lượng còn lại. Còn được xuất: ${remainingOrderQty}`,
  );
}

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const chatGPT = async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        message: "Vui lòng nhập nội dung cần hỏi",
      });
    }

    const input = [
      {
        role: "developer",
        content: `
Bạn là trợ lý AI của NHẬT KHANG BIKE.

Cửa hàng chuyên bán:
- Phụ tùng xe đạp
- Phụ tùng xe điện
- Phụ tùng xe ba gác
- Các loại vòng bi, bạc đạn, vỏ xe, phụ tùng và linh kiện liên quan.

Quy tắc:
- Trả lời bằng tiếng Việt.
- Trả lời ngắn gọn, dễ hiểu.
- Hỗ trợ khách hàng tìm hiểu sản phẩm.
- Nếu khách hỏi về sản phẩm nhưng chưa đủ thông tin thì hỏi thêm kích thước, mã sản phẩm hoặc loại xe.
- Không tự bịa giá, tồn kho hoặc thông số sản phẩm nếu hệ thống chưa cung cấp.
- Khi không chắc chắn, nói rõ là cần kiểm tra lại.
- Có thể hướng dẫn khách liên hệ NHẬT KHANG BIKE để được tư vấn.
        `,
      },

      ...history,

      {
        role: "user",
        content: message.trim(),
      },
    ];

    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input,
    });

    return res.status(200).json({
      success: true,
      reply: response.output_text,
    });
  } catch (error) {
    console.error("ChatGPT error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể kết nối với ChatGPT",
      error: error.message,
    });
  }
};

TIKTOK SHOP REVIEW & IMAGE SCRAPER V1.4
=======================================

CHỨC NĂNG
- Chọn số lượng bình luận muốn quét: từ 1 đến 5000.
- Tự bấm "Xem thêm / View more" nhiều lần đến khi đủ số lượng hoặc hết dữ liệu.
- Tự cuộn vùng review, loại bỏ bình luận trùng và dừng an toàn khi không còn dữ liệu mới.
- Quét rating, người mua nếu nhận diện được, nội dung bình luận, ngày, phân loại và ảnh đánh giá.
- Tự nhận diện tên sản phẩm ngắn gọn từ trang TikTok Shop.
- Có thể sửa tên thư mục sản phẩm trực tiếp trong popup trước khi xuất hoặc tải.
- Xuất dữ liệu dạng DOCX, HTML, CSV và JSON.
- File xuất được lưu tại: Downloads/<Tên sản phẩm>/Reviews.docx|html|csv|json
- Ảnh được tải về trong file ZIP tại: Downloads/<Tên sản phẩm>/Images.zip
- Tên ảnh trong ZIP theo định dạng: Images/review-001-01.webp
- Lưu dữ liệu liên tục trong chrome.storage; đóng popup vẫn tiếp tục quét.
- Có bộ lọc preview theo từ khóa, số sao và bình luận có ảnh.
- Hiển thị tiến trình tải ảnh, tự bỏ qua URL ảnh không hợp lệ và retry khi tải lỗi.

ĐIỂM NÂNG CẤP V1.4
- Parser review bền hơn với nhiều kiểu aria-label/DOM hơn.
- Dedupe tốt hơn nhờ kết hợp người mua, rating, ngày, phân loại, nội dung và URL ảnh.
- Giảm lag khi quét nhiều bình luận bằng cách throttle việc ghi state.
- Bỏ quét toàn bộ DOM khi tìm scroller, ưu tiên vùng review/modal.
- Thêm xuất CSV để mở bằng Excel/Google Sheets.
- Thêm xuất JSON để backup hoặc xử lý lại dữ liệu.
- Thêm tiến trình tải ảnh trong popup.
- Thêm validate domain ảnh và retry tải ảnh trong background worker.
- Cập nhật manifest lên 1.4.0 và thêm quyền unlimitedStorage.

CÀI ĐẶT / CẬP NHẬT
1. Mở Chrome hoặc Cốc Cốc và truy cập chrome://extensions.
2. Bật "Chế độ dành cho nhà phát triển / Developer mode".
3. Nếu đang dùng bản cũ, bấm Reload tại extension hoặc xóa bản cũ.
4. Chọn "Tải tiện ích đã giải nén / Load unpacked".
5. Chọn thư mục tiktok-review-scraper-v1.3 chứa các file manifest.json, popup.html, content.js.
6. Mở hoặc tải lại trang sản phẩm tại https://shop.tiktok.com/.
7. Bấm biểu tượng extension, nhập số bình luận và chọn "Bắt đầu quét".
8. Sau khi quét xong, kiểm tra hoặc sửa "Tên thư mục sản phẩm".
9. Chọn DOCX, HTML, CSV, JSON hoặc Ảnh ZIP tùy nhu cầu.

LƯU Ý
- File DOCX là định dạng Word chuẩn, phù hợp iOS, Microsoft Word và các tool đọc Word hiện đại.
- File HTML dùng UTF-8, dễ mở trên iOS, Android, Windows và trình duyệt.
- DOCX và HTML chỉ ghi số lượng ảnh; URL ảnh không xuất trong tài liệu vì ảnh đã nằm trong Images.zip.
- CSV có BOM UTF-8 để Excel đọc tiếng Việt tốt hơn.
- JSON giữ cấu trúc dữ liệu đầy đủ, phù hợp để backup hoặc xử lý bằng tool khác.
- Ảnh tải về là URL ảnh TikTok cung cấp trong DOM, thường là WebP thumbnail.
- TikTok Shop có thể thay đổi DOM hoặc giới hạn nút "Xem thêm"; extension vẫn giữ dữ liệu đã quét được.
- Nếu popup báo không tìm thấy trang TikTok Shop, hãy reload trang sản phẩm rồi chạy lại.

TRUCK CHECK - BROWSER OCR POC V1
================================

MỤC TIÊU
--------
Bản này CHỈ test OCR browser-side:

Phone Browser
-> Camera live
-> crop vùng scan ngay trên phone
-> FastPlateOCR ONNX chạy trong browser
-> nếu fail nhiều frame:
   Tesseract.js fallback cho BKS in trên thân xe
-> normalize:
   50E-360.75 -> 50E36075
-> auto accept khi candidate ổn định
-> hiện BKS + latency

KHÔNG:
- Python
- Streamlit
- PC backend
- server OCR
- cloud OCR API
- Google Sheet
- SeaTalk

ẢNH KHÔNG ĐƯỢC UPLOAD.
Ảnh camera chỉ đi vào Canvas/ONNX/Tesseract trong browser.


FILE
----
index.html
styles.css
config.js
app.js
.nojekyll

models/
  cct_xs_v2_global.onnx   <- optional nhưng RECOMMEND host cùng web


MODEL
-----
App thử theo thứ tự:

1) ./models/cct_xs_v2_global.onnx
2) Official GitHub release URL

Nếu official URL bị corporate network/CORS chặn,
hãy download model và bỏ vào models/ trước khi publish.


AUTO SCAN
---------
- Fast OCR khoảng mỗi 420 ms
- 2 candidate giống nhau để lock
- confidence cực cao có thể lock 1 frame
- cùng BKS bị suppress khoảng 4.5 giây để tránh ghi đúp
- sau khi lock, app tự re-arm cho xe tiếp theo

Body OCR:
- warm-up background
- chỉ fallback sau nhiều Fast OCR miss
- không chạy mỗi frame để giữ tốc độ


KPI POC NÊN TEST
----------------
1) Đọc đúng BKS biển vật lý
2) Đọc đúng BKS in trên thân xe
3) Fast OCR P50
4) Fast OCR P95
5) Tốc độ thao tác thực tế / xe
6) Điện thoại nóng / lag sau 10-15 phút không


SAU KHI POC PASS
----------------
Phase 2 mới nối:

Apps Script
-> source H/F/J
-> local RAM cache trên từng phone
-> result:
   BKS - Priority - Blacklist

và log:
File Record
A = BKS
B = Scan timestamp

# Base image Node.js Alpine nhẹ và bảo mật
FROM node:20-alpine

# Thiết lập thư mục làm việc trong container
WORKDIR /app

# Thiết lập biến môi trường
ENV NODE_ENV=production
ENV PORT=8080

# Sao chép file cấu hình và cài đặt dependencies
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Sao chép file mã nguồn web, server và assets
COPY server.js index.html favicon.svg ./
COPY assets ./assets/

# Khai báo cổng ứng dụng
EXPOSE 8080

# Khởi chạy server phục vụ Web & WebSocket
CMD ["npm", "start"]

# Linux + Nginx 静态部署

应用没有 Node.js 运行时后端。服务器只负责构建或接收 `dist/`，并通过 HTTPS 提供静态文件。

## 构建

```bash
npm ci
npm run build
sudo mkdir -p /var/www/exam-paper
sudo cp -a dist/. /var/www/exam-paper/
```

## Nginx

使用 `vim` 创建站点配置：

```bash
sudo vim /etc/nginx/conf.d/exam-paper.conf
```

```nginx
server {
    listen 443 ssl http2;
    server_name exam.example.com;

    root /var/www/exam-paper;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/exam.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/exam.example.com/privkey.pem;

    types {
        text/html html;
        text/css css;
        application/javascript js;
        application/wasm wasm;
        application/json json;
        application/octet-stream onnx;
        image/jpeg jpg jpeg;
        image/png png;
        image/webp webp;
    }

    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location /models/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=3600";
    }

    location = /models/manifest.json {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

验证并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 发布检查

```bash
curl -I https://exam.example.com/
curl -I https://exam.example.com/models/pp-lcnet-x1-doc-orientation.onnx
curl -I https://exam.example.com/assets/ort-wasm-simd-threaded.jsep-*.wasm
```

浏览器应能获得 `application/octet-stream` 的 ONNX 和 `application/wasm` 的 WASM。WebGPU 不可用时应用会自动回退 WASM；方向模型不可用时仍可手动旋转、裁边、增强、补修和导出。

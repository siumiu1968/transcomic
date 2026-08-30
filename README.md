# TransComic 漫譯

TransComic 係一個網頁漫畫翻譯工作台：由獲授權嘅 Comix 來源揀漫畫，按需要翻譯指定章節，再用桌面或手機閱讀器切換原文／繁體中文譯文。

## 功能

- 搜尋 Comix 目錄，只有明確加入書庫嘅作品先會處理
- 逐話、未翻譯章節或全選批次翻譯
- 可續跑嘅單工翻譯佇列，支援取消、進度同失敗狀態
- GPT-5.6 Luna 三種推理強度選擇，最高品質使用 Max
- 保留作品簡介、上章尾段同最近兩頁對白，維持人物稱謂與前文後理
- 視覺文字定位、繁體中文（香港用語）翻譯及漫畫頁面合成
- 長條、單頁、雙頁、右至左、縮放、全螢幕及手機閱讀模式
- SQLite 本機資料庫；原圖、譯圖同憑證唔會提交到 Git
- 生產環境支援由既有管理員閘道保護，應用程式只監聽 loopback

## 技術

- React 19 + Vite
- Express 5 + Node.js SQLite
- Patchright（已授權網頁連接）
- Codex CLI 或 OpenAI Responses API（圖像輸入 + 結構化輸出）
- Tesseract OCR（對白查漏同原文字行定位）
- Sharp（頁面正規化與譯文合成）

## 本機啟動

需要 Node.js 22 或以上、Chromium、Tesseract 英文語言資料，以及已登入嘅 Codex CLI；亦可改用有效嘅 OpenAI API key。

```bash
cp .env.example .env
npm ci --ignore-scripts
npm run dev
```

開啟 `http://127.0.0.1:5173/transcomic/`。本機預設 `AUTH_MODE=off`；生產環境必須改用可信任嘅反向代理驗證，並令 Node 服務只監聽 `127.0.0.1`。

## 驗證

```bash
npm run check
```

## 部署原則

- API key、Cookie、Token、代理地址、管理員驗證設定同主機資料只放私密環境設定
- 網頁端唔會收到來源憑證或 OpenAI API key
- 反向代理必須覆寫可信任身份標頭，唔可以直接轉發訪客提供嘅同名標頭
- `DATA_DIR` 應放喺非公開目錄，並限制檔案權限

## 使用與授權

只應處理你擁有、獲授權或法律容許處理嘅內容；唔應用嚟繞過存取控制、批量鏡像網站或重新分發未獲授權作品。連接器只會喺管理員明確搜尋、加入或開始翻譯時運作。

本項目受 [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) 啟發，但係獨立實作，冇複製其程式碼。本項目並非 Comix 或 OpenAI 官方產品。

程式碼以 [MIT License](LICENSE) 開源。

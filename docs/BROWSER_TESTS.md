# 浏览器验收

浏览器回归脚本依赖 Playwright，并默认使用 Windows 上的 Microsoft Edge。

```powershell
npm install
npm run test:browser
```

测试本地服务器以外的地址：

```powershell
$env:PREVIEW_URL = "https://example.com"
npm run test:browser
```

自动化覆盖桌面与手机布局、长回复滚动、语音状态、行动卡、会话记忆、安全分流、心灵随笔和页面转场。真实 AI 输出仍需单独人工抽查。

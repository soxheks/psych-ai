# 对话形象

角色素材：`core/static/core/images/companion-poses.png`。
参考：用户桌面的微信角色图片（白发双丸子头、星星发夹、星月抱枕）。使用内置 imagegen 生成，没有调用项目的 AI Key。

## 页面行为

- 桌面：聊天记录右侧显示角色；手机：聊天记录上方显示紧凑角色区域。
- 默认抱枕轻微呼吸；输入时歪头倾听；等待服务器时思考；回复展示时伸手回应。
- 鼠标在角色上移动时会轻微偏转，点击或键盘激活角色会打招呼；等待回复和风险回复期间不切换为招呼动作。
- 侧栏场景、心情开场选项、语音和发送按钮具有悬停及点击反馈。心情选项仅填入草稿，用户发送后才请求 AI。
- 欢迎内容在开始聊天后收起，给聊天记录留出空间。减少动态效果时关闭位移、涟漪和入场动画，保留文字及按键反馈。
- 回复文字由现有 Django `POST /api/chat/` 接口提供。逐字效果在收到完整回复后由浏览器呈现，并非后端流式接口。
- 语音默认关闭，点击扬声器图标开启。优先从浏览器已有声音中选择晓伊、瑶瑶、晓晓、慧慧等中文声线，音调 1.22、语速 1.02、音量 0.9；没有中文声音或朗读失败时仍正常显示文字。没有新增收费语音服务。
- 播放按钮可以试听固定的角色问候，再次点击停止；试听不发送聊天消息，也不会打开自动朗读。声音列表延迟加载时等待最多 1.8 秒，取消后不会继续播放。
- 聊天区的网格行明确限定为 `minmax(0, 1fr)`，人物不会撑大消息区域；欢迎内容和长回复在各自的滚动区域内显示，输入框与动画消息不会叠在一起。较矮桌面窗口会压缩人物和顶部留白。
- 新文字默认跟随到末尾；向上滚动阅读时暂停跟随，回到底部后恢复。展开输入框或缩小窗口后仍可看到最后一句。
- 新消息会停止上一段朗读，网络失败会保留输入，请求等待最长 45 秒。
- 风险回复直接完整显示，角色保持温和倾听；系统“减少动态效果”设置会关闭循环动作和逐字显示。
- 当前动作是四姿态切换配合轻量 2D 动画，没有实现实时口型或骨骼绑定。

## 素材布局

四格精灵图：左上待机、右上倾听、左下思考、右下回答。CSS 使用同一张图片，不需要额外动画依赖。
图标来自 Lucide，授权见 `core/static/core/icons/LICENSE.txt`。

## 验证

运行 `python manage.py check`。启动本地服务器后，在安装有 Playwright 和 Edge 的开发环境中运行 `node scripts/check_companion.cjs`。

默认测试地址是 `http://127.0.0.1:8003`，可通过 `PREVIEW_URL` 覆盖。
截图和检查结果输出到 `output/companion-preview/`。测试用模拟 AI 回复验证人物状态，不消耗 AI 额度；同时检查实际 Django 页面、静态图片和风险回复接口。语音生命周期使用模拟声音检查，具体设备上的音色和可用性需要在浏览器中试听。

`node scripts/check_scroll_voice.cjs` 检查矮窗口、高像素密度、手机、18 段长回复、逐字回复、手动阅读和输入框高度变化，并检查声音选择、延迟加载、试听及取消。此机器的 Edge 实测选择 Microsoft Yaoyao；该项测试拦截音频播放，只验证实际声音对象和参数。

浏览器声音依赖设备的可用声音，音调参数由具体合成引擎执行，不能保证每台设备都有完全相同的音色。参考：[可用声音列表](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices)、[音调参数](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/pitch)。

## 图像提示词

第一轮：

```text
Use case: stylized-concept.
Asset type: one production-ready 2x2 character sprite sheet for a Chinese university emotional-support chat website.
Input image 1 is the character identity and illustration style reference.
Create exactly four full-body drawings of this SAME character in a perfectly regular 2 columns x 2 rows square sprite sheet, each cell exactly half the canvas width and height. Prefer 2048x2048 output. Transparent RGBA background; no checkerboard drawn, no panels, no captions, no letters, no extra decoration, no ground or shadows. Characters must never cross cell boundaries.
Preserve the reference character identity: white/silver hair with pale blue and subtle pink highlights, two round hair buns, teal blue eyes, yellow star hair clip on viewer right, oversized white hoodie with pale cyan trim and tiny cloud detail, white boots, holding the pale yellow moon-and-star plush. Same delicate dark purple outlines, soft pastel anime chibi style.
Use consistent camera, scale, proportions, face structure and feet baseline within every square cell. Each full-body figure fits in the central 74% width and 90% height of its cell, with clear transparent margins. Entire boots and hair visible.
Top-left: calm idle pose, eyes open, small closed smile, both hands cuddling moon-star plush, upright and relaxed.
Top-right: listening pose, gentle slight head tilt, sympathetic attentive eyes, closed mouth, hands holding plush close.
Bottom-left: thoughtful pose, gaze gently upward to the side, one hand lightly near cheek/chin, other arm holds plush, small closed mouth, calm rather than sad.
Bottom-right: answering pose, warm small open mouth, one hand with open palm in a gentle conversational gesture, other arm hugs plush. Eyes open, reassuring rather than exaggerated excitement.
No other characters, no props other than the reference plush, no scene, no speech bubbles. Match reference closely and ensure a clean aligned sprite atlas suitable for CSS background-position.
```

修订轮（第一轮图像的棋盘格被画进了背景，因此最终素材使用纯白背景）：

```text
Use case: precise-object-edit. Edit the provided 2x2 character sprite atlas. Replace ALL gray checkerboard background and ALL background texture with completely uniform pure solid white (#FFFFFF, RGB 255 255 255). This is an opaque white background request, not a transparency request. No checkerboard, no shadow, no texture, no gray marks anywhere in the background. Preserve exactly the four character illustrations, their relative scale and layout within four equal square cells, their colors, poses, expressions, details, full boots, full hair and outlines. Keep the same image size and precise 2x2 arrangement for use as a CSS sprite sheet. Do not add any text, borders, grid lines, labels or other elements.
```

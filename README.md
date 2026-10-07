# C++ 学习进度

单文件 HTML 学习进度工具，提供手动每日记录、分集累计预览和可复用的中文注释模板。

## 在线使用

- [网页入口](https://alexx-powered.github.io/cpp-study-progress/)
- [C++ 学习进度](https://alexx-powered.github.io/cpp-study-progress/cpp%E5%AD%A6%E4%B9%A0%E8%BF%9B%E5%BA%A6.html)
- [学习进度模板](https://alexx-powered.github.io/cpp-study-progress/templates/%E5%AD%A6%E4%B9%A0%E8%BF%9B%E5%BA%A6%E6%A8%A1%E6%9D%BF.html)

也可以下载 HTML 后直接用浏览器打开，无需安装依赖。

## 功能

- 手动选择日期与学习分集，统计每天的学习分钟。
- 蓝色柱子表示首次学习，红色堆叠表示跨天复习；提供复习显示与空白日期过滤开关。
- 课程完成比例按实际时长计算，跨天复习计入每日时长。
- 分集预览点选第 n 集后，前面的 1～n 集全部勾选；支持快速跳到当前预览位置。
- 固定顶部统计与操作区、深浅主题切换、图表与柱顶字号的平滑过渡。

## 文件

- `cpp学习进度.html`：314 集参考课程的学习页面。
- `templates/学习进度模板.html`：带源码注释的可复用模板。
- `index.html`：在线访问入口。
- `.nojekyll`：直接发布静态文件。

## 复用模板

复制模板后修改顶部 `TEMPLATE_CONFIG` 和分集数据 `BASE`。每门课程使用独立的 `storagePrefix`；课程名称、来源链接、动画时长与字号范围均有注释说明。

## 记录保存

学习记录、预览位置和显示偏好保存在当前浏览器的 `localStorage` 中。在线地址与本地文件使用独立存储，原本地进度不会自动迁移到在线页面。学习页面与模板也使用不同的存储键。

## 课程来源

分集目录与时长参考 [B 站 C++ 课程](https://www.bilibili.com/video/BV1et411b73Z/)。仓库包含进度工具和课程目录元数据。

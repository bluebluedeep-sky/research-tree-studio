# Research Tree Studio / 研究树工作台

Research Tree Studio 是一个本地优先的论文研究脉络管理工具。它把论文组织成可缩放的研究树，并用明确的关系类型和中文说明展示论文之间的继承、改进、替代、融合、对照、启发与问题迁移。

## 直接使用

- **Windows 用户**：进入 GitHub Releases，下载最新的 `Research-Tree-Studio-Windows-*.zip`，完整解压后双击 `1-双击打开研究树.exe`。若 Windows 阻止未签名程序，使用同目录中的 CMD 备用入口。
- **手机或平板体验**：下载 `Research-Tree-Studio-Mobile-*.html`，使用 Chrome、Edge 或 Safari 打开。
- **在线只读体验**：仓库启用 GitHub Pages 后，可直接浏览 `docs/index.html` 部署的示例树。

公开发行包只包含一棵高效 Attention 示例树和论文来源链接，不包含 API Key、用户研究树、上传论文、批注、浏览器数据库或本地 PDF。

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm ci
npm start
```

打开 <http://127.0.0.1:4318/>。服务只监听 `127.0.0.1`，不会向局域网公开端口。

## AI 与论文访问

- AI 功能使用用户自己的 DeepSeek API Key；项目不会内置作者的密钥。
- Key 默认保存在当前浏览器会话，可由用户选择是否保存在浏览器本地存储。
- OpenAlex、arXiv、OpenReview、会议页面、作者主页和机构仓储用于查询论文元数据及开放版本。
- 未取得全文时，系统只允许摘要级或元数据级判断，不会声称阅读过全文。
- 需要机构权限的论文保留 DOI 或出版社入口，用户可在校外 VPN、校园网或图书馆网站自行下载后上传。
- 系统不收集、保存或代理学校账号、密码和 Cookie。

## 核心功能

- 多研究方向首页及可编辑研究树。
- 中英双语论文节点、分支、年份和访问状态。
- 悬停临时高亮，离开立即清除；单击可同时锁定多篇论文，双击进入阅读页。
- 论文关系回溯线和中文关系解释。
- PDF 上传、替换、全文重分析、撤销与重做。
- JSON 导入导出、独立 HTML 导出和空白分享包。
- 全文、摘要、机构权限、元数据和待补充状态，以及分析依据与置信度。

## 测试

```powershell
npm test
node tests/ui-smoke.mjs
node tests/visual-check.mjs
```

浏览器测试默认使用 Windows 中的 Microsoft Edge。DeepSeek 真实调用需要使用者自己的 Key，自动化测试不会发起付费模型请求。

## 隐私与授权

代码使用 MIT License。论文标题、作者、摘要、链接等元数据归各自来源；本仓库不重新分发第三方论文 PDF。详见 [PRIVACY.md](PRIVACY.md)、[SECURITY.md](SECURITY.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

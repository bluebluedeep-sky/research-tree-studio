import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readyRoot = path.resolve(root, "..", "research-tree-studio-github-ready");
const repo = path.join(readyRoot, "repository");
const assets = path.join(readyRoot, "release-assets");
const version = "1.0.0";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd || root, env: { ...process.env, ...(options.env || {}) }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 执行失败。`);
};
const write = (relative, content) => fs.writeFile(path.join(repo, relative), content.replace(/^\n/, ""), "utf8");
const copy = relative => fs.cp(path.join(root, relative), path.join(repo, relative), { recursive: true });
const hashFile = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex").toUpperCase();

await fs.rm(readyRoot, { recursive: true, force: true });
await fs.mkdir(repo, { recursive: true });
await fs.mkdir(assets, { recursive: true });

for (const directory of ["client", "server", "tests", "examples"]) await copy(directory);
for (const file of ["package.json", "package-lock.json", ".env.example", ".gitignore", "start-local.bat", "stop-local.bat", "TEST_RESULTS.md"]) await copy(file);

await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
for (const file of [
  "build-friend-share.mjs",
  "build-github-ready.mjs",
  "build-mobile-share.mjs",
  "build-portable.mjs",
  "build-share.mjs",
  "build-single-exe.mjs",
  "create-backup.mjs",
  "download-seed-papers.mjs",
  "extract-seed.mjs",
  "portable-launcher.cs",
  "self-extracting-launcher.cs",
  "start-local.ps1",
  "stop-local.ps1",
  "verify-mobile-share.mjs"
]) await fs.copyFile(path.join(root, "scripts", file), path.join(repo, "scripts", file));

await fs.mkdir(path.join(repo, "paper-library", "preset"), { recursive: true });
await fs.mkdir(path.join(repo, "paper-library", "uploads"), { recursive: true });
await fs.writeFile(path.join(repo, "paper-library", "preset", ".gitkeep"), "", "utf8");
await fs.writeFile(path.join(repo, "paper-library", "uploads", ".gitkeep"), "", "utf8");

const seedPath = path.join(repo, "client", "seed-attention.json");
const seed = JSON.parse(await fs.readFile(seedPath, "utf8"));
seed.pending = [];
seed.queue = [];
seed.history = [];
seed.future = [];
seed.papers = seed.papers.map(paper => {
  const clean = { ...paper };
  delete clean.localPdf;
  if (clean.accessStatus === "local_pdf") clean.accessStatus = clean.abstract ? "abstract_only" : "metadata_only";
  if (clean.accessSource === "manual" || clean.accessSource === "demo") clean.accessSource = "source_link";
  return clean;
});
await fs.writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

await write("README.md", `
# Research Tree Studio / 研究树工作台

Research Tree Studio 是一个本地优先的论文研究脉络管理工具。它把论文组织成可缩放的研究树，并用明确的关系类型和中文说明展示论文之间的继承、改进、替代、融合、对照、启发与问题迁移。

## 直接使用

- **Windows 用户**：进入 GitHub Releases，下载最新的 \`Research-Tree-Studio-Windows-*.zip\`，完整解压后双击 \`1-双击打开研究树.exe\`。若 Windows 阻止未签名程序，使用同目录中的 CMD 备用入口。
- **手机或平板体验**：下载 \`Research-Tree-Studio-Mobile-*.html\`，使用 Chrome、Edge 或 Safari 打开。
- **在线只读体验**：仓库启用 GitHub Pages 后，可直接浏览 \`docs/index.html\` 部署的示例树。

公开发行包只包含一棵高效 Attention 示例树和论文来源链接，不包含 API Key、用户研究树、上传论文、批注、浏览器数据库或本地 PDF。

## 本地开发

需要 Node.js 20 或更高版本。

\`\`\`powershell
npm ci
npm start
\`\`\`

打开 <http://127.0.0.1:4318/>。服务只监听 \`127.0.0.1\`，不会向局域网公开端口。

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

\`\`\`powershell
npm test
node tests/ui-smoke.mjs
node tests/visual-check.mjs
\`\`\`

浏览器测试默认使用 Windows 中的 Microsoft Edge。DeepSeek 真实调用需要使用者自己的 Key，自动化测试不会发起付费模型请求。

## 隐私与授权

代码使用 MIT License。论文标题、作者、摘要、链接等元数据归各自来源；本仓库不重新分发第三方论文 PDF。详见 [PRIVACY.md](PRIVACY.md)、[SECURITY.md](SECURITY.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
`);

await write("LICENSE", `
MIT License

Copyright (c) 2026 Research Tree Studio contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);

await write("PRIVACY.md", `
# 隐私说明

- 本项目没有遥测、广告或制作者控制的远程数据库。
- 研究树、设置和版本记录保存在使用者浏览器的 IndexedDB。
- DeepSeek API Key 由使用者自行填写，仅发送给本机服务和 DeepSeek；工作区导出会排除 Key。
- 上传和下载的论文保存在使用者本机，不进入本仓库或公开分享包。
- 本系统不会要求、保存或代理学校账号、密码、Cookie 或图书馆会话。
- 使用者打开论文来源、OpenAlex、arXiv、OpenReview、出版社或机构仓储时，需遵守相应网站的隐私政策。
`);

await write("SECURITY.md", `
# Security Policy

## Supported version

Only the latest GitHub Release is supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for issues involving API keys, local file access, PDF parsing, SSRF protections or arbitrary code execution. Do not place secrets, private papers or school credentials in a public issue.

The local server intentionally binds only to \`127.0.0.1\`. Changes that expose it on \`0.0.0.0\` should be treated as security-sensitive.
`);

await write("THIRD_PARTY_NOTICES.md", `
# Third-party content

The example research tree contains bibliographic metadata and source links for publicly described academic papers. Copyright in paper titles, abstracts, figures and full text remains with the respective authors and publishers.

The public source repository and generated public release do not redistribute third-party paper PDF files. Users obtain papers from the linked official or open-access sources and are responsible for complying with applicable licenses and access terms.

Runtime dependencies are listed in \`package.json\` and retain their own licenses.
`);

await write("CHANGELOG.md", `
# Changelog

## 1.0.0

- Initial public release.
- Research-tree visualization with bilingual paper nodes.
- Multi-paper locking, temporary hover highlighting and relationship explanations.
- Local PDF reading and replacement workflow.
- DeepSeek-assisted research-tree generation with evidence and access-state controls.
- Windows portable package and mobile read-only HTML experience.
`);

await write("PUBLISHING.md", `
# GitHub 发布步骤

1. 在 GitHub 创建一个空的公开仓库，例如 \`research-tree-studio\`，不要勾选自动创建 README 或 License。
2. 在本目录运行：

\`\`\`powershell
git add .
git commit -m "Initial public release"
git remote add origin https://github.com/YOUR_NAME/research-tree-studio.git
git push -u origin main
\`\`\`

3. 在仓库 \`Settings > Pages\` 中选择 **GitHub Actions**。\`pages.yml\` 会发布 \`docs/index.html\`。
4. 创建首个版本：

\`\`\`powershell
git tag v1.0.0
git push origin v1.0.0
\`\`\`

\`release.yml\` 会测试项目并创建 GitHub Release。也可以在 GitHub Release 页面手动上传旁边 \`release-assets\` 文件夹中的四个成品文件和校验文件。
5. 在 \`Settings > Security and analysis\` 中确认 Dependabot、Secret scanning 和 Push protection 已启用。

公开前不要把任何 API Key、学校凭据、用户 PDF、浏览器数据或本地工作区导出文件加入提交。
`);

await fs.mkdir(path.join(repo, ".github", "workflows"), { recursive: true });
await write(path.join(".github", "workflows", "test.yml"), `
name: Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
`);

await write(path.join(".github", "workflows", "pages.yml"), `
name: Deploy Pages

on:
  push:
    branches: [main]
    paths: ["docs/**", ".github/workflows/pages.yml"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
`);

await write(path.join(".github", "workflows", "release.yml"), `
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
      - name: Build privacy-clean downloads
        shell: pwsh
        env:
          RTS_INCLUDE_DEMO_PDF: "0"
        run: |
          npm run build:friend-share
          npm run build:mobile-share
          Copy-Item dist/Research-Tree-Studio-WeChat-Demo.zip "dist/Research-Tree-Studio-Windows-$env:GITHUB_REF_NAME.zip"
          Copy-Item dist/Research-Tree-Mobile-Demo.html "dist/Research-Tree-Studio-Mobile-$env:GITHUB_REF_NAME.html"
          Copy-Item dist/Research-Tree-Mobile-Demo.zip "dist/Research-Tree-Studio-Mobile-$env:GITHUB_REF_NAME.zip"
      - name: Publish GitHub Release
        shell: pwsh
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create $env:GITHUB_REF_NAME --generate-notes --title "Research Tree Studio $env:GITHUB_REF_NAME" \`
            "dist/Research-Tree-Studio-Windows-$env:GITHUB_REF_NAME.zip" \`
            "dist/Research-Tree-Studio-Mobile-$env:GITHUB_REF_NAME.html" \`
            "dist/Research-Tree-Studio-Mobile-$env:GITHUB_REF_NAME.zip"
`);

await fs.cp(path.join(root, "node_modules"), path.join(repo, "node_modules"), { recursive: true });
run(process.execPath, [path.join(repo, "scripts", "build-friend-share.mjs")], { cwd: repo, env: { RTS_INCLUDE_DEMO_PDF: "0" } });
await fs.copyFile(path.join(repo, "dist", "Research-Tree-Studio-WeChat-Demo.zip"), path.join(assets, `Research-Tree-Studio-Windows-v${version}.zip`));
run(process.execPath, [path.join(repo, "scripts", "build-mobile-share.mjs")], { cwd: repo, env: { RTS_INCLUDE_DEMO_PDF: "0" } });
await fs.copyFile(path.join(repo, "dist", "Research-Tree-Mobile-Demo.html"), path.join(assets, `Research-Tree-Studio-Mobile-v${version}.html`));
await fs.copyFile(path.join(repo, "dist", "Research-Tree-Mobile-Demo.zip"), path.join(assets, `Research-Tree-Studio-Mobile-v${version}.zip`));
await fs.mkdir(path.join(repo, "docs"), { recursive: true });
await fs.copyFile(path.join(repo, "dist", "Research-Tree-Mobile-Demo.html"), path.join(repo, "docs", "index.html"));
await fs.rm(path.join(repo, "node_modules"), { recursive: true, force: true });
await fs.rm(path.join(repo, "dist"), { recursive: true, force: true });

const sourceZip = path.join(assets, `Research-Tree-Studio-Source-v${version}.zip`);
run("tar.exe", ["-a", "-c", "-f", sourceZip, "repository"], { cwd: readyRoot });

const assetFiles = (await fs.readdir(assets)).filter(name => name !== "SHA256SUMS.txt").sort();
const checksums = [];
for (const name of assetFiles) checksums.push(`${await hashFile(path.join(assets, name))}  ${name}`);
await fs.writeFile(path.join(assets, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

await fs.writeFile(path.join(readyRoot, "UPLOAD-ME-FIRST.txt"), [
  "Research Tree Studio GitHub 发布目录",
  "",
  "repository：独立、隐私清理后的源码仓库，已包含 GitHub Pages 和 Release 自动化。",
  "release-assets：可直接上传到 GitHub Release 的 Windows、手机版和源码附件。",
  "",
  "先阅读 repository/PUBLISHING.md。不要从上一级“学视频”目录执行 git add。"
].join("\r\n"), "utf8");

run("git", ["init", "-b", "main"], { cwd: repo });
console.log(readyRoot);

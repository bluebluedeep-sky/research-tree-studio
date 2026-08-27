# GitHub 发布步骤

1. 在 GitHub 创建一个空的公开仓库，例如 `research-tree-studio`，不要勾选自动创建 README 或 License。
2. 在本目录运行：

```powershell
git add .
git commit -m "Initial public release"
git remote add origin https://github.com/YOUR_NAME/research-tree-studio.git
git push -u origin main
```

3. 在仓库 `Settings > Pages` 中选择 **GitHub Actions**。`pages.yml` 会发布 `docs/index.html`。
4. 创建首个版本：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

`release.yml` 会测试项目并创建 GitHub Release。也可以在 GitHub Release 页面手动上传旁边 `release-assets` 文件夹中的四个成品文件和校验文件。
5. 在 `Settings > Security and analysis` 中确认 Dependabot、Secret scanning 和 Push protection 已启用。

公开前不要把任何 API Key、学校凭据、用户 PDF、浏览器数据或本地工作区导出文件加入提交。

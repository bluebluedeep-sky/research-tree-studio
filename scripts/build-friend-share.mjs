import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const packageName = "Research-Tree-Studio-Demo";
const out = path.join(dist, packageName);
const zip = path.join(dist, "Research-Tree-Studio-WeChat-Demo.zip");
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(out, "runtime"), { recursive: true });

for (const name of ["client", "server"]) {
  await fs.cp(path.join(root, name), path.join(out, name), { recursive: true });
}
await fs.cp(path.join(root, "node_modules"), path.join(out, "node_modules"), { recursive: true });
await fs.rm(path.join(out, "node_modules", "playwright-core"), { recursive: true, force: true });
await fs.rm(path.join(out, "node_modules", ".bin"), { recursive: true, force: true });
await fs.copyFile(process.execPath, path.join(out, "runtime", "node.exe"));

const demoPaperId = "system-1";
const demoPdfName = `${demoPaperId}.pdf`;
const demoPdfSource = path.join(root, "paper-library", "preset", demoPdfName);
const includeDemoPdf = process.env.RTS_INCLUDE_DEMO_PDF !== "0" && await fs.stat(demoPdfSource).then(() => true).catch(() => false);
await fs.mkdir(path.join(out, "paper-library", "preset"), { recursive: true });
if (includeDemoPdf) await fs.copyFile(demoPdfSource, path.join(out, "paper-library", "preset", demoPdfName));

const seedPath = path.join(out, "client", "seed-attention.json");
const seed = JSON.parse(await fs.readFile(seedPath, "utf8"));
seed.pending = [];
seed.queue = [];
seed.history = [];
seed.future = [];
seed.papers = seed.papers.map(paper => {
  const sanitized = { ...paper };
  delete sanitized.localPdf;
  if (paper.id === demoPaperId && includeDemoPdf) {
    sanitized.localPdf = `/paper-files/preset/${demoPdfName}`;
    sanitized.accessStatus = "local_pdf";
    sanitized.accessSource = "demo";
    sanitized.accessMessage = "体验包内附公开示例 PDF。";
  }
  return sanitized;
});
await fs.writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

const launcherPath = path.join(out, "1-双击打开研究树.exe");
const compile = spawnSync(csc, ["/nologo", "/target:winexe", `/out:${launcherPath}`, "/r:System.Windows.Forms.dll", path.join(root, "scripts", "portable-launcher.cs")], { stdio: "inherit" });
if (compile.status !== 0) throw new Error("体验版一键启动器编译失败。");

await fs.writeFile(path.join(out, "1-如果EXE打不开请点这个.cmd"), [
  "@echo off",
  "cd /d \"%~dp0\"",
  "set \"RTS_ROOT=%~dp0\"",
  "powershell.exe -NoProfile -WindowStyle Hidden -Command \"$root=$env:RTS_ROOT; $url='http://127.0.0.1:4318/'; $ready=$false; try { $health=Invoke-RestMethod ($url+'api/health') -TimeoutSec 1; $ready=($health.service -eq 'research-tree-studio') } catch {}; if(-not $ready){ $p=Start-Process -FilePath (Join-Path $root 'runtime\\node.exe') -ArgumentList (Join-Path $root 'server\\index.mjs') -WorkingDirectory $root -WindowStyle Hidden -PassThru; Set-Content -LiteralPath (Join-Path $root '.research-tree.pid') -Value $p.Id; for($i=0;$i -lt 50;$i++){ Start-Sleep -Milliseconds 200; try { $health=Invoke-RestMethod ($url+'api/health') -TimeoutSec 1; if($health.service -eq 'research-tree-studio'){ $ready=$true; break } } catch {} } }; if($ready){ Start-Process $url } else { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('本地服务未能启动，请检查 4318 端口。','研究树工作台') | Out-Null }\"",
  "exit /b"
].join("\r\n") + "\r\n", "utf8");

await fs.writeFile(path.join(out, "2-停止研究树.cmd"), "@echo off\r\ncd /d \"%~dp0\"\r\nif exist .research-tree.pid for /f %%p in (.research-tree.pid) do taskkill /pid %%p /t /f >nul 2>nul\r\ndel /q .research-tree.pid >nul 2>nul\r\n", "utf8");

await fs.writeFile(path.join(out, "打开说明.txt"), [
  "研究树工作台 - 微信体验版（Windows 10/11）",
  "",
  "最简单的打开方法：",
  "1. 将压缩包完整解压，不能直接在微信压缩包预览里运行。",
  "2. 双击“1-双击打开研究树.exe”。",
  "3. 等待几秒，网页会自动在默认浏览器中打开。",
  "",
  "若 Windows 提示未知发布者：可选择“更多信息”后“仍要运行”。",
  "若 EXE 仍打不开：双击“1-如果EXE打不开请点这个.cmd”。",
  "使用结束后可双击“2-停止研究树.cmd”关闭后台服务。",
  "",
  `隐私说明：本包只含一棵公开示例研究树${includeDemoPdf ? "和一篇公开示例 PDF" : "及公开论文来源链接"}，不含制作者的 API Key、浏览器数据、上传论文、批注文件或个人研究树。`,
  "AI 检索功能如需使用，请由使用者在设置中填写自己的 DeepSeek API Key。"
].join("\r\n"), "utf8");

const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zip, packageName], { cwd: dist, stdio: "inherit" });
if (archive.status !== 0) throw new Error("微信体验版压缩失败。");
await fs.rm(out, { recursive: true, force: true });

console.log(zip);

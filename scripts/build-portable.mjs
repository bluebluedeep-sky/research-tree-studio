import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "research-tree-studio-portable-win-x64");
const nodeSource = process.execPath;
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, "runtime"), { recursive: true });
for (const name of ["client", "server"]) await fs.cp(path.join(root, name), path.join(out, name), { recursive: true });
await fs.cp(path.join(root, "paper-library", "preset"), path.join(out, "paper-library", "preset"), { recursive: true });
await fs.cp(path.join(root, "node_modules"), path.join(out, "node_modules"), { recursive: true });
await fs.rm(path.join(out, "node_modules", "playwright-core"), { recursive: true, force: true });
await fs.rm(path.join(out, "node_modules", ".bin"), { recursive: true, force: true });
await fs.copyFile(nodeSource, path.join(out, "runtime", "node.exe"));

const compile = spawnSync(csc, ["/nologo", "/target:winexe", `/out:${path.join(out, "1-OPEN-RESEARCH-TREE.exe")}`, "/r:System.Windows.Forms.dll", path.join(root, "scripts", "portable-launcher.cs")], { stdio: "inherit" });
if (compile.status !== 0) throw new Error("便携启动器编译失败。");

await fs.writeFile(path.join(out, "1-OPEN-RESEARCH-TREE.cmd"), [
  "@echo off",
  "cd /d \"%~dp0\"",
  "set \"RTS_ROOT=%~dp0\"",
  "powershell.exe -NoProfile -WindowStyle Hidden -Command \"$root=$env:RTS_ROOT; $url='http://127.0.0.1:4318/'; $ready=$false; try { $health=Invoke-RestMethod ($url+'api/health') -TimeoutSec 1; $ready=($health.service -eq 'research-tree-studio') } catch {}; if(-not $ready){ $p=Start-Process -FilePath (Join-Path $root 'runtime\\node.exe') -ArgumentList (Join-Path $root 'server\\index.mjs') -WorkingDirectory $root -WindowStyle Hidden -PassThru; Set-Content -LiteralPath (Join-Path $root '.research-tree.pid') -Value $p.Id; for($i=0;$i -lt 50;$i++){ Start-Sleep -Milliseconds 200; try { $health=Invoke-RestMethod ($url+'api/health') -TimeoutSec 1; if($health.service -eq 'research-tree-studio'){ $ready=$true; break } } catch {} } }; if($ready){ if($env:RTS_SKIP_BROWSER -ne '1'){ Start-Process $url } } else { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('本地服务未能启动，请检查 4318 端口。','研究树工作台') | Out-Null }\"",
  "exit /b"
].join("\r\n") + "\r\n", "utf8");
await fs.writeFile(path.join(out, "2-STOP-RESEARCH-TREE.cmd"), "@echo off\r\ncd /d \"%~dp0\"\r\nif exist .research-tree.pid for /f %%p in (.research-tree.pid) do taskkill /pid %%p /t /f >nul 2>nul\r\ndel /q .research-tree.pid >nul 2>nul\r\n", "utf8");
await fs.writeFile(path.join(out, "README-FIRST.txt"), [
  "研究树工作台 - Windows 免安装版",
  "",
  "1. 请先完整解压本压缩包。",
  "2. 双击‘1-OPEN-RESEARCH-TREE.cmd’，网页会自动在默认浏览器中打开。",
  "   也可以使用同名 exe；若 Windows 拦截未签名程序，请改用 cmd。",
  "3. 使用结束后可双击‘2-STOP-RESEARCH-TREE.cmd’停止后台服务。",
  "4. AI 功能需要在网页右上角设置中填写使用者自己的 DeepSeek API Key。",
  "5. 不要只把 exe 单独复制出去；runtime、server、client、node_modules 和 paper-library 文件夹必须保留。"
].join("\r\n"), "utf8");

const zip = path.join(dist, "research-tree-studio-portable-win-x64.zip");
await fs.rm(zip, { force: true });
const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zip, path.basename(out)], { cwd: dist, stdio: "inherit" });
if (archive.status !== 0) throw new Error("便携版压缩失败。");
await fs.rm(out, { recursive: true, force: true });
console.log(zip);

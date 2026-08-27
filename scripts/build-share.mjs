import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "research-tree-studio-empty");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
for (const name of ["client", "server", "scripts", "tests", "examples"]) await fs.cp(path.join(root, name), path.join(out, name), { recursive: true });
await fs.cp(path.join(root, "paper-library", "preset"), path.join(out, "paper-library", "preset"), { recursive: true });
for (const name of ["package.json", "package-lock.json", "README.md", "TEST_RESULTS.md", ".env.example", "start-local.bat"]) {
  try { await fs.copyFile(path.join(root, name), path.join(out, name)); } catch {}
}
const zip = path.join(root, "dist", "research-tree-studio-empty-share.zip");
const result = spawnSync("tar.exe", ["-a", "-c", "-f", zip, path.basename(out)], { cwd: path.dirname(out), stdio: "inherit" });
if (result.status !== 0) throw new Error("空白分享包压缩失败。");
await fs.rm(out, { recursive: true, force: true });
console.log(zip);

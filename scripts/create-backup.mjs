import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupDir = path.join(root, "backups");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const stageName = `.backup-stage-${stamp}`;
const stage = path.join(backupDir, stageName);
const temporaryZip = path.join(backupDir, `.backup-${stamp}.tmp.zip`);
const finalZip = path.join(backupDir, `research-tree-studio-previous-${stamp}.zip`);

await fs.mkdir(backupDir, { recursive: true });
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

for (const name of ["client", "server", "scripts", "tests", "examples"]) {
  await fs.cp(path.join(root, name), path.join(stage, name), { recursive: true });
}
for (const name of ["package.json", "package-lock.json", "README.md", "TEST_RESULTS.md", ".env.example", "start-local.bat", "AGENTS.md"]) {
  try { await fs.copyFile(path.join(root, name), path.join(stage, name)); } catch {}
}

const archive = spawnSync("tar.exe", ["-a", "-c", "-f", temporaryZip, stageName], { cwd: backupDir, stdio: "inherit" });
await fs.rm(stage, { recursive: true, force: true });
if (archive.status !== 0) {
  await fs.rm(temporaryZip, { force: true });
  throw new Error("项目备份创建失败，原有备份未删除。");
}

for (const entry of await fs.readdir(backupDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip") && entry.name !== path.basename(temporaryZip)) await fs.rm(path.join(backupDir, entry.name));
}
await fs.rename(temporaryZip, finalZip);
console.log(finalZip);

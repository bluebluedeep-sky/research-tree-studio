import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const payloadPath = path.join(dist, "research-tree-studio-portable-win-x64.zip");
const stubPath = path.join(dist, ".research-tree-self-extract-stub.exe");
const outputPath = path.join(dist, "Research-Tree-Studio-Portable.exe");
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const marker = Buffer.from("RTS_PAYLOAD_V1!!", "ascii");

const compile = spawnSync(csc, ["/nologo", "/target:winexe", `/out:${stubPath}`, "/r:System.Windows.Forms.dll", "/r:System.IO.Compression.dll", "/r:System.IO.Compression.FileSystem.dll", path.join(root, "scripts", "self-extracting-launcher.cs")], { stdio: "inherit" });
if (compile.status !== 0) throw new Error("单文件启动器编译失败。");

const [stub, payload] = await Promise.all([fs.readFile(stubPath), fs.readFile(payloadPath)]);
const length = Buffer.alloc(8); length.writeBigInt64LE(BigInt(payload.length));
await fs.writeFile(outputPath, Buffer.concat([stub, payload, length, marker]));
await fs.rm(stubPath, { force: true });
console.log(outputPath);

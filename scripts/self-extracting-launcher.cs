using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Windows.Forms;

internal static class SelfExtractingLauncher
{
    private const string Marker = "RTS_PAYLOAD_V1!!";

    [STAThread]
    private static void Main()
    {
        try
        {
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            long payloadLength;
            long payloadStart;
            using (var source = File.OpenRead(executable))
            {
                if (source.Length < 24) throw new InvalidDataException("便携程序缺少数据包。");
                source.Seek(-16, SeekOrigin.End);
                var marker = new byte[16]; source.Read(marker, 0, marker.Length);
                if (Encoding.ASCII.GetString(marker) != Marker) throw new InvalidDataException("便携程序数据包校验失败。");
                source.Seek(-24, SeekOrigin.End);
                var length = new byte[8]; source.Read(length, 0, length.Length);
                payloadLength = BitConverter.ToInt64(length, 0);
                payloadStart = source.Length - 24 - payloadLength;
                if (payloadLength <= 0 || payloadStart <= 0) throw new InvalidDataException("便携程序数据包长度无效。");
            }

            string customHome = Environment.GetEnvironmentVariable("RTS_PORTABLE_HOME");
            string baseDirectory = string.IsNullOrWhiteSpace(customHome) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ResearchTreeStudioPortable") : customHome;
            string target = Path.Combine(baseDirectory, payloadLength.ToString());
            string appRoot = Path.Combine(target, "research-tree-studio-portable-win-x64");
            string innerLauncher = Path.Combine(appRoot, "1-OPEN-RESEARCH-TREE.exe");

            if (!File.Exists(innerLauncher))
            {
                if (Directory.Exists(target)) Directory.Delete(target, true);
                Directory.CreateDirectory(target);
                string archivePath = Path.Combine(target, "payload.zip");
                using (var source = File.OpenRead(executable))
                using (var archive = File.Create(archivePath))
                {
                    source.Seek(payloadStart, SeekOrigin.Begin);
                    var buffer = new byte[1024 * 1024];
                    long remaining = payloadLength;
                    while (remaining > 0)
                    {
                        int read = source.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                        if (read <= 0) throw new EndOfStreamException("便携数据包读取不完整。");
                        archive.Write(buffer, 0, read); remaining -= read;
                    }
                }
                ExtractSafely(archivePath, target);
                File.Delete(archivePath);
            }

            if (!File.Exists(innerLauncher)) throw new FileNotFoundException("一键启动器未能正确释放，请重新下载文件。");
            if (Environment.GetEnvironmentVariable("RTS_SKIP_LAUNCH") == "1") return;
            Process.Start(new ProcessStartInfo(innerLauncher) { WorkingDirectory = appRoot, UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "研究树工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void ExtractSafely(string archivePath, string target)
    {
        string root = Path.GetFullPath(target + Path.DirectorySeparatorChar);
        using (var archive = ZipFile.OpenRead(archivePath))
        {
            foreach (var entry in archive.Entries)
            {
                string destination = Path.GetFullPath(Path.Combine(target, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("压缩包包含不安全路径。");
                if (string.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(destination); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                using (var input = entry.Open()) using (var output = File.Create(destination)) input.CopyTo(output);
            }
        }
    }
}

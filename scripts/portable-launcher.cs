using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal static class PortableLauncher
{
    private const string Url = "http://127.0.0.1:4318/";

    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            if (!ServiceReady())
            {
                string node = Path.Combine(root, "runtime", "node.exe");
                string server = Path.Combine(root, "server", "index.mjs");
                if (!File.Exists(node) || !File.Exists(server)) throw new FileNotFoundException("便携运行文件不完整，请重新解压压缩包。");

                var process = Process.Start(new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "\"" + server + "\"",
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                File.WriteAllText(Path.Combine(root, ".research-tree.pid"), process.Id.ToString());

                for (int attempt = 0; attempt < 50 && !ServiceReady(); attempt++) Thread.Sleep(200);
            }

            if (!ServiceReady()) throw new Exception("本地服务未能启动。请检查 4318 端口是否被其他程序占用。");
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "研究树工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static bool ServiceReady()
    {
        try
        {
            var request = WebRequest.Create(Url + "api/health");
            request.Timeout = 700;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return reader.ReadToEnd().Contains("research-tree-studio");
        }
        catch { return false; }
    }
}

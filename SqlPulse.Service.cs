using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[DataContract]
public sealed class SqlPulseServiceConfiguration
{
    [DataMember] public string ServiceName;
    [DataMember] public string OwnerSid;
    [DataMember] public string InstallDir;
    [DataMember] public string DataDir;
    [DataMember] public string NodePath;
    [DataMember] public string[] ToolDirectories;
    [DataMember] public string UserProfile;
    [DataMember] public string AppData;
    [DataMember] public string LocalAppData;
    [DataMember] public int Port;
    [DataMember] public string HealthPath;
    [DataMember] public string StopPath;
}

[DataContract]
public sealed class SqlPulseServiceHealth
{
    [DataMember] public string status;
    [DataMember] public double heartbeat;
    [DataMember] public int pid;
    [DataMember] public string heartbeatAt;
    [DataMember] public double heartbeatAgeMs;
    [DataMember] public SqlPulseServiceProcess process;
}

[DataContract]
public sealed class SqlPulseServiceProcess
{
    [DataMember] public int pid;
}

[DataContract]
public sealed class SqlPulseMonitorApproval
{
    [DataMember(IsRequired = true)] public bool enabled;
}

public sealed class SqlPulseWindowsService : ServiceBase
{
    private readonly SqlPulseServiceConfiguration config;
    private readonly ManualResetEvent stopping = new ManualResetEvent(false);
    private readonly object logLock = new object();
    private Thread worker;
    private string token;
    private Semaphore instance;

    public SqlPulseWindowsService(SqlPulseServiceConfiguration value)
    {
        config = value;
        ServiceName = value.ServiceName;
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }

    public static bool SupportedNodeVersion(string value)
    {
        Match match = Regex.Match(value.Trim(), @"^v?(\d+)\.(\d+)\.(\d+)$");
        if (!match.Success) return false;
        int major = Int32.Parse(match.Groups[1].Value), minor = Int32.Parse(match.Groups[2].Value);
        return (major == 20 && minor >= 19) || (major == 22 && minor >= 12) || major > 22;
    }

    public static bool Healthy(SqlPulseServiceHealth health, int processId, double now)
    {
        if (health == null) return false;
        int pid = health.process == null ? health.pid : health.process.pid;
        double heartbeat = health.heartbeat;
        if (heartbeat <= 0)
        {
            DateTime parsed;
            if (!DateTime.TryParse(health.heartbeatAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)) return false;
            heartbeat = (parsed.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds;
        }
        // SQL/storage degradation is an operator issue, not evidence of a dead host.
        return pid == processId && heartbeat > 0 && now - heartbeat >= -5000 && now - heartbeat < 45000 &&
            health.heartbeatAgeMs >= 0 && health.heartbeatAgeMs < 45000;
    }

    public static SqlPulseServiceConfiguration ReadConfiguration(string file)
    {
        // Windows PowerShell 5.1's UTF8 writer emits a BOM; the Framework JSON reader does not accept it.
        using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(File.ReadAllText(file))))
            return (SqlPulseServiceConfiguration)new DataContractJsonSerializer(typeof(SqlPulseServiceConfiguration)).ReadObject(stream);
    }

    public static void ValidateMonitoringConfiguration(string file)
    {
        using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(File.ReadAllText(file))))
        {
            SqlPulseMonitorApproval approval = (SqlPulseMonitorApproval)new DataContractJsonSerializer(typeof(SqlPulseMonitorApproval)).ReadObject(stream);
            if (!approval.enabled) throw new InvalidOperationException("Independent monitoring must already be enabled in the saved configuration. Service mode never enables monitoring or email.");
        }
    }

    private void ValidateIdentity()
    {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        if (sid != config.OwnerSid || sid == "S-1-5-18" || sid == "S-1-5-19" || sid == "S-1-5-20")
            throw new InvalidOperationException("Service identity is not the DPAPI configuration owner. LocalSystem and identity migration are not supported.");
        string key = Path.Combine(config.DataDir, ".encryption-key");
        if (!File.Exists(key)) return;
        string wrapped = File.ReadAllText(key).Trim();
        if (!wrapped.StartsWith("dpapi:v1:", StringComparison.Ordinal))
            throw new InvalidOperationException("Migrate the legacy encryption key using the owner's desktop session before enabling service mode.");
        byte[] plain = ProtectedData.Unprotect(Convert.FromBase64String(wrapped.Substring(9)), null, DataProtectionScope.CurrentUser);
        try { if (plain.Length != 32) throw new InvalidOperationException("Invalid DPAPI encryption-key length."); }
        finally { Array.Clear(plain, 0, plain.Length); }
    }

    protected override void OnStart(string[] args)
    {
        try
        {
            ValidateIdentity();
            ValidateMonitoringConfiguration(Path.Combine(config.DataDir, "monitor-settings.json"));
            bool created;
            instance = new Semaphore(1, 1, @"Global\" + config.ServiceName, out created);
            if (!instance.WaitOne(0)) throw new InvalidOperationException("Another service host already owns this installation.");
            byte[] random = new byte[32];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) { rng.GetBytes(random); }
            token = Convert.ToBase64String(random);
            worker = new Thread(Supervise);
            worker.IsBackground = true;
            worker.Start();
        }
        catch (Exception error) { Log("Service start refused: " + error.Message); throw; }
    }

    protected override void OnStop()
    {
        RequestAdditionalTime(35000);
        stopping.Set();
        if (worker != null && !worker.Join(30000))
            throw new InvalidOperationException("Owned dashboard shutdown did not complete; inspect service-host.log.");
        if (instance != null) { instance.Release(); instance.Dispose(); instance = null; }
    }

    protected override void OnShutdown() { OnStop(); }

    private void VerifyNode()
    {
        ProcessStartInfo info = new ProcessStartInfo(config.NodePath, "--version");
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        using (Process probe = Process.Start(info))
        {
            if (!probe.WaitForExit(5000)) { probe.Kill(); throw new InvalidOperationException("Configured Node version probe timed out."); }
            if (probe.ExitCode != 0 || !SupportedNodeVersion(probe.StandardOutput.ReadToEnd()))
                throw new InvalidOperationException("Configured Node is missing or unsupported. Repair/reinstall service configuration using the owner account.");
        }
    }

    private void AssertNoOtherDashboard()
    {
        string entry = Path.Combine(config.InstallDir, "server.mjs");
        string pattern = "(?i)(?:^|\\s)\"?" + Regex.Escape(entry) + "\"?(?=\\s|$)";
        using (ManagementObjectSearcher search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'"))
        using (ManagementObjectCollection processes = search.Get())
        {
            foreach (ManagementObject process in processes)
                using (process)
                    if (Regex.IsMatch(Convert.ToString(process["CommandLine"]), pattern))
                        throw new InvalidOperationException("An existing desktop dashboard owns this installation. Stop it before starting the service.");
        }
        // Binding is only a preflight. Node's exclusive listener is the final race-safe port arbiter.
        TcpListener port = new TcpListener(IPAddress.Loopback, config.Port);
        port.Server.ExclusiveAddressUse = true;
        try { port.Start(); } finally { port.Stop(); }
    }

    private Process StartDashboard(OwnedJob job)
    {
        VerifyNode();
        AssertNoOtherDashboard();
        // Do not import application code until the process is assigned to its kill-on-close job.
        string bootstrap = "let allowed=false;process.stdin.once('data',()=>{allowed=true;process.stdin.destroy();" +
            "import(require('node:url').pathToFileURL(process.argv[1]).href).catch(error=>{console.error(error);process.exitCode=1;});});" +
            "process.stdin.once('end',()=>{if(!allowed)process.exit(1);});";
        ProcessStartInfo info = new ProcessStartInfo(config.NodePath, "--input-type=commonjs -e \"" + bootstrap + "\" \"" + Path.Combine(config.InstallDir, "server.mjs") + "\"");
        info.WorkingDirectory = config.InstallDir;
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.RedirectStandardInput = true;
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        info.EnvironmentVariables["SQL_DASHBOARD_DATA_DIR"] = config.DataDir;
        info.EnvironmentVariables["SQL_DASHBOARD_PORT"] = config.Port.ToString();
        info.EnvironmentVariables["SQL_PULSE_SERVICE_TOKEN"] = token;
        info.EnvironmentVariables["SQL_PULSE_SERVICE_MODE"] = "1";
        info.EnvironmentVariables["USERPROFILE"] = config.UserProfile;
        info.EnvironmentVariables["APPDATA"] = config.AppData;
        info.EnvironmentVariables["LOCALAPPDATA"] = config.LocalAppData;
        info.EnvironmentVariables["PATH"] = String.Join(";", config.ToolDirectories ?? new string[0]) + ";" + Environment.GetEnvironmentVariable("PATH");
        Process child = new Process();
        child.StartInfo = info;
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog("service-server.log", e.Data); };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog("service-server.err.log", e.Data); };
        child.Start();
        try { job.Assign(child); child.StandardInput.WriteLine("go"); child.StandardInput.Close(); }
        catch { try { child.Kill(); } catch { } child.Dispose(); throw; }
        child.BeginOutputReadLine(); child.BeginErrorReadLine();
        Log("Started owned dashboard PID " + child.Id + ".");
        return child;
    }

    private HttpWebRequest Request(string endpoint)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + config.Port + endpoint);
        request.Proxy = null; request.Timeout = 2000; request.ReadWriteTimeout = 2000; request.AllowAutoRedirect = false;
        request.Headers["X-SQL-Pulse-Service-Token"] = token;
        return request;
    }

    private bool IsHealthy(Process child)
    {
        try
        {
            using (WebResponse response = Request(config.HealthPath).GetResponse())
            using (Stream stream = response.GetResponseStream())
            {
                SqlPulseServiceHealth health = (SqlPulseServiceHealth)new DataContractJsonSerializer(typeof(SqlPulseServiceHealth)).ReadObject(stream);
                return Healthy(health, child.Id, (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds);
            }
        }
        catch { return false; }
    }

    private void GracefulStop(Process child)
    {
        if (child.HasExited) return;
        try
        {
            HttpWebRequest request = Request(config.StopPath);
            request.Method = "POST"; request.ContentLength = 0;
            using (WebResponse response = request.GetResponse()) { }
        }
        catch (Exception error) { Log("Graceful stop unavailable: " + error.Message); }
        if (!child.WaitForExit(15000)) Log("Graceful shutdown deadline exceeded; closing the owned process job.");
    }

    private void Supervise()
    {
        try
        {
            int consecutiveFailures = 0;
            while (!stopping.WaitOne(0))
            {
                using (OwnedJob job = new OwnedJob())
                {
                    Process child = null;
                    try
                    {
                        child = StartDashboard(job);
                        DateTime started = DateTime.UtcNow, lastGood = started;
                        while (!stopping.WaitOne(5000) && !child.HasExited)
                        {
                            if (IsHealthy(child)) { lastGood = DateTime.UtcNow; consecutiveFailures = 0; }
                            else if ((DateTime.UtcNow - started).TotalSeconds > 60 && (DateTime.UtcNow - lastGood).TotalSeconds > 45)
                            { Log("Heartbeat watchdog expired for owned PID " + child.Id + "."); break; }
                        }
                    }
                    finally
                    {
                        if (child != null)
                        {
                            GracefulStop(child);
                            job.Dispose();
                            if (!child.HasExited) child.WaitForExit(5000);
                            child.Dispose();
                        }
                    }
                }
                if (stopping.WaitOne(0)) break;
                consecutiveFailures++;
                if (consecutiveFailures >= 6) throw new InvalidOperationException("Repeated dashboard failures; handing recovery to Windows Service Control Manager.");
                Log("Restarting owned dashboard after failure.");
                stopping.WaitOne(Math.Min(30000, consecutiveFailures * 5000));
            }
        }
        catch (Exception error)
        {
            Log("Service host failed: " + error.Message);
            if (!stopping.WaitOne(0)) Environment.Exit(1);
        }
    }

    private void Log(string message) { WriteLog("service-host.log", message); }
    private void WriteLog(string name, string message)
    {
        lock (logLock)
        {
            try
            {
                string file = Path.Combine(config.InstallDir, name);
                if (File.Exists(file) && new FileInfo(file).Length > 5 * 1024 * 1024)
                { string rotated = file + ".1"; if (File.Exists(rotated)) File.Delete(rotated); File.Move(file, rotated); }
                File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            }
            catch { }
        }
    }

    public static void Main()
    {
        if (Environment.UserInteractive) return;
        string directory = Path.GetDirectoryName(typeof(SqlPulseWindowsService).Assembly.Location);
        SqlPulseServiceConfiguration config = ReadConfiguration(Path.Combine(directory, ".sql-pulse-service.json"));
        if (Path.GetFullPath(config.InstallDir).TrimEnd('\\') != Path.GetFullPath(directory).TrimEnd('\\') ||
            config.Port != 8765 || config.HealthPath != "/health/details" || config.StopPath != "/api/service-stop" ||
            !Regex.IsMatch(config.ServiceName ?? "", "^SqlPulse-[a-f0-9]{12}$"))
            throw new InvalidOperationException("Invalid service configuration.");
        ServiceBase.Run(new SqlPulseWindowsService(config));
    }

    private sealed class OwnedJob : IDisposable
    {
        private IntPtr handle;
        public OwnedJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            ExtendedLimit info = new ExtendedLimit();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(ExtendedLimit));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)size)) throw new System.ComponentModel.Win32Exception();
            }
            catch { Dispose(); throw; }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception();
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimit
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit
        {
            public BasicLimit BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}

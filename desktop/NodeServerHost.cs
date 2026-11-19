using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace AlexaAlarmSkip.Desktop;

/// <summary>
/// Manages the lifecycle of the background Node.js backend server process.
/// </summary>
internal sealed class NodeServerHost : IDisposable
{
    private sealed record ReadyPayload(int Port);

    private readonly object _stderrLock = new();
    private readonly Queue<string> _recentStderrLines = new();
    private const int MaxStderrLines = 12;

    private Process? _process;
    private SafeJobHandle? _jobHandle;
    private CancellationTokenSource? _outputPumpCts;
    private bool _disposed;

    /// <summary>
    /// Gets the local HTTP port assigned to the running Node.js server.
    /// </summary>
    public int Port { get; private set; }

    /// <summary>
    /// Resolves the repository root directory containing prototype\web-ui.js from AppContext.BaseDirectory.
    /// </summary>
    public static string? ResolveRepoRoot()
    {
        DirectoryInfo? current = new DirectoryInfo(AppContext.BaseDirectory);
        for (int depth = 0; depth <= DesktopConstants.MaxRepoRootSearchDepth && current is not null; depth++)
        {
            string candidate = Path.Combine(current.FullName, DesktopConstants.EntryScriptRelPath);
            if (File.Exists(candidate))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
        return null;
    }

    /// <summary>
    /// Locates node.exe via PATH or standard Windows installation directories.
    /// </summary>
    public static string? ResolveNodeExecutable()
    {
        string? pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrWhiteSpace(pathEnv))
        {
            foreach (string entry in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                string trimmed = entry.Trim().Trim('"');
                if (string.IsNullOrEmpty(trimmed))
                {
                    continue;
                }
                string candidate = Path.Combine(trimmed, "node.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        string programFilesNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(programFilesNode))
        {
            return programFilesNode;
        }

        string localAppDataNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe");
        if (File.Exists(localAppDataNode))
        {
            return localAppDataNode;
        }

        return null;
    }

    /// <summary>
    /// Starts the Node.js backend in --desktop-host mode and waits for the ready port notification.
    /// </summary>
    public async Task<int> StartAsync(CancellationToken ct = default)
    {
        string repoRoot = ResolveRepoRoot()
            ?? throw new FileNotFoundException($"エントリーポイントが見つかりません: {DesktopConstants.EntryScriptRelPath}");

        string nodePath = ResolveNodeExecutable()
            ?? throw new FileNotFoundException("Node.js (node.exe) が見つかりませんでした。Node.js 22 以上をインストールしてください。");

        string entryScript = Path.Combine(repoRoot, DesktopConstants.EntryScriptRelPath);
        _jobHandle = CreateKillOnCloseJob();

        var psi = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{entryScript}\" {DesktopConstants.DesktopHostArg}",
            WorkingDirectory = repoRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException("Node.js プロセスの起動に失敗しました。");
        }

        _process = process;
        AssignToJobObject(_jobHandle, process.Handle);

        var portTcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        _outputPumpCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        CancellationToken pumpCt = _outputPumpCts.Token;

        _ = PumpStdoutAsync(process.StandardOutput, portTcs, pumpCt);
        _ = PumpStderrAsync(process.StandardError, pumpCt);
        _ = WatchEarlyExitAsync(process, portTcs);

        using var timeoutCts = new CancellationTokenSource(DesktopConstants.NodeStartupTimeoutMs);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        using (linkedCts.Token.Register(() => portTcs.TrySetCanceled(linkedCts.Token)))
        {
            try
            {
                int port = await portTcs.Task.ConfigureAwait(false);
                Port = port;
                return port;
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new TimeoutException(BuildDiagnosticMessage("バックエンドサーバーの起動がタイムアウトしました。"));
            }
        }
    }

    /// <summary>
    /// Requests graceful shutdown via POST /api/shutdown and waits for Node.js to drain and exit.
    /// </summary>
    public async Task ShutdownGracefullyAsync()
    {
        Process? proc = _process;
        if (proc is null || proc.HasExited)
        {
            CleanupHandles();
            return;
        }

        if (Port > 0)
        {
            try
            {
                using var handler = new SocketsHttpHandler
                {
                    UseProxy = false,
                    PooledConnectionLifetime = TimeSpan.Zero,
                };
                using var http = new HttpClient(handler)
                {
                    Timeout = TimeSpan.FromMilliseconds(DesktopConstants.ShutdownHttpTimeoutMs),
                };
                using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{Port}/api/shutdown");
                request.Headers.ConnectionClose = true;
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            }
            catch
            {
                // Ignore HTTP errors during shutdown and still wait/fallback below.
            }
        }

        try
        {
            using var waitCts = new CancellationTokenSource(DesktopConstants.NodeGracefulExitTimeoutMs);
            await proc.WaitForExitAsync(waitCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!proc.HasExited)
                {
                    proc.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Process may have exited concurrently.
            }
        }
        finally
        {
            CleanupHandles();
        }
    }

    private async Task PumpStdoutAsync(StreamReader reader, TaskCompletionSource<int> portTcs, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                string? line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (!portTcs.Task.IsCompleted && line.StartsWith(DesktopConstants.NodeReadyPrefix, StringComparison.Ordinal))
                {
                    string json = line[DesktopConstants.NodeReadyPrefix.Length..].Trim();
                    try
                    {
                        ReadyPayload? payload = JsonSerializer.Deserialize<ReadyPayload>(json, new JsonSerializerOptions
                        {
                            PropertyNameCaseInsensitive = true,
                        });
                        if (payload is { Port: > 0 and <= 65535 })
                        {
                            portTcs.TrySetResult(payload.Port);
                        }
                    }
                    catch (Exception ex)
                    {
                        portTcs.TrySetException(new InvalidDataException($"ポート通知の解析に失敗しました: {ex.Message}"));
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on disposal.
        }
        catch
        {
            // Ignore stream errors during shutdown.
        }
    }

    private async Task PumpStderrAsync(StreamReader reader, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                string? line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                lock (_stderrLock)
                {
                    if (_recentStderrLines.Count >= MaxStderrLines)
                    {
                        _recentStderrLines.Dequeue();
                    }
                    _recentStderrLines.Enqueue(line);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on disposal.
        }
        catch
        {
            // Ignore stream errors during shutdown.
        }
    }

    private async Task WatchEarlyExitAsync(Process proc, TaskCompletionSource<int> portTcs)
    {
        try
        {
            await proc.WaitForExitAsync().ConfigureAwait(false);
            if (!portTcs.Task.IsCompleted)
            {
                portTcs.TrySetException(new InvalidOperationException(
                    BuildDiagnosticMessage($"バックエンドサーバーが起動完了前に終了しました (ExitCode={proc.ExitCode})。")));
            }
        }
        catch
        {
            // Ignore if already disposed.
        }
    }

    private string BuildDiagnosticMessage(string header)
    {
        lock (_stderrLock)
        {
            if (_recentStderrLines.Count == 0)
            {
                return header;
            }
            return $"{header}\n\n[エラー出力]\n{string.Join(Environment.NewLine, _recentStderrLines)}";
        }
    }

    private static SafeJobHandle? CreateKillOnCloseJob()
    {
        SafeJobHandle job = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid)
        {
            job.Dispose();
            return null;
        }

        var info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint length = (uint)Marshal.SizeOf<NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();

        if (!NativeMethods.SetInformationJobObject(job, NativeMethods.JobObjectExtendedLimitInformation, ref info, length))
        {
            job.Dispose();
            return null;
        }

        return job;
    }

    private static void AssignToJobObject(SafeJobHandle? job, IntPtr processHandle)
    {
        if (job is null || job.IsInvalid)
        {
            return;
        }

        try
        {
            NativeMethods.AssignProcessToJobObject(job, processHandle);
        }
        catch
        {
            // Continue even if nested job assignment is restricted by the parent environment.
        }
    }

    private void CleanupHandles()
    {
        if (_outputPumpCts is not null)
        {
            _outputPumpCts.Cancel();
            _outputPumpCts.Dispose();
            _outputPumpCts = null;
        }

        if (_process is not null)
        {
            _process.Dispose();
            _process = null;
        }

        if (_jobHandle is not null)
        {
            _jobHandle.Dispose();
            _jobHandle = null;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        CleanupHandles();
    }
}

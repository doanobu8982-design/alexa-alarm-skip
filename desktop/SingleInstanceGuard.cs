using System.IO.Pipes;
using System.Text;

namespace AlexaAlarmSkip.Desktop;

/// <summary>
/// Enforces single-instance execution using a named Mutex and activates the existing window via NamedPipe.
/// </summary>
internal sealed class SingleInstanceGuard : IDisposable
{
    private Mutex? _mutex;
    private bool _ownsMutex;
    private CancellationTokenSource? _listenerCts;
    private Task? _listenerTask;
    private int _released;

    /// <summary>
    /// Attempts to acquire the single-instance Mutex. If already held, notifies the existing instance to activate.
    /// </summary>
    public bool TryAcquireOrNotifyExisting()
    {
        _mutex = new Mutex(initiallyOwned: true, DesktopConstants.MutexName, out bool createdNew);
        _ownsMutex = createdNew;
        if (createdNew)
        {
            return true;
        }

        NotifyExistingInstance();
        return false;
    }

    /// <summary>
    /// Starts a background NamedPipe listener that invokes <paramref name="onActivate"/> when another instance starts.
    /// </summary>
    public void StartActivationListener(Action onActivate)
    {
        ArgumentNullException.ThrowIfNull(onActivate);

        _listenerCts = new CancellationTokenSource();
        CancellationToken ct = _listenerCts.Token;
        _listenerTask = Task.Run(() => ListenLoopAsync(onActivate, ct), ct);
    }

    private static void NotifyExistingInstance()
    {
        try
        {
            NativeMethods.AllowSetForegroundWindow(NativeMethods.ASFW_ANY);
            using var client = new NamedPipeClientStream(".", DesktopConstants.PipeName, PipeDirection.Out);
            client.Connect(DesktopConstants.PipeConnectTimeoutMs);
            byte[] payload = Encoding.UTF8.GetBytes(DesktopConstants.ActivateMessage);
            client.Write(payload, 0, payload.Length);
            client.Flush();
        }
        catch
        {
            // Existing instance may be closing or unresponsive; exit silently.
        }
    }

    private static async Task ListenLoopAsync(Action onActivate, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(
                    DesktopConstants.PipeName,
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);

                using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                string? message = await reader.ReadToEndAsync(ct).ConfigureAwait(false);
                if (string.Equals(message.Trim(), DesktopConstants.ActivateMessage, StringComparison.Ordinal))
                {
                    onActivate();
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                // Continue listening on transient pipe errors.
            }
        }
    }

    /// <summary>
    /// Idempotently cancels the activation pipe listener and releases the single-instance Mutex.
    /// Must be called from the owning UI thread when releasing the Mutex.
    /// </summary>
    public void Release()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0)
        {
            return;
        }

        if (_listenerCts is not null)
        {
            _listenerCts.Cancel();
            _listenerCts.Dispose();
            _listenerCts = null;
        }

        if (_mutex is not null)
        {
            if (_ownsMutex)
            {
                try
                {
                    _mutex.ReleaseMutex();
                }
                catch (ApplicationException)
                {
                }
                catch (ObjectDisposedException)
                {
                }
            }
            _mutex.Dispose();
            _mutex = null;
            _ownsMutex = false;
        }
    }

    public void Dispose()
    {
        Release();
    }
}

using System.Diagnostics;
using System.Drawing;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AlexaAlarmSkip.Desktop;

/// <summary>
/// Main desktop window hosting WebView2 and managing the backend Node.js server lifecycle.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly WebView2 _webView;
    private readonly NodeServerHost _nodeHost = new();
    private readonly Action? _onBeginShutdown;
    private bool _initialNavigationShown;
    private bool _isShuttingDown;
    private bool _shutdownCompleted;

    public MainForm(Action? onBeginShutdown = null)
    {
        _onBeginShutdown = onBeginShutdown;
        Text = DesktopConstants.AppDisplayName;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.Manual;
        BackColor = DesktopConstants.BackgroundColor;
        ClientSize = new Size(
            LogicalToDeviceUnits(DesktopConstants.InitialClientWidth),
            LogicalToDeviceUnits(DesktopConstants.InitialClientHeight));
        MinimumSize = new Size(
            LogicalToDeviceUnits(DesktopConstants.MinClientWidth),
            LogicalToDeviceUnits(DesktopConstants.MinClientHeight));

        ApplyProcessIcon();
        Location = WindowStateStore.LoadValidLocation(Size);

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = DesktopConstants.BackgroundColor,
            Visible = false,
        };
        Controls.Add(_webView);
    }

    /// <summary>
    /// Restores and brings the window to the foreground when activated by a second launch.
    /// </summary>
    public void BringToFrontFromActivation()
    {
        if (IsDisposed || _isShuttingDown || _shutdownCompleted)
        {
            return;
        }

        if (InvokeRequired)
        {
            BeginInvoke(() =>
            {
                if (IsDisposed || _isShuttingDown || _shutdownCompleted)
                {
                    return;
                }
                BringToFrontFromActivation();
            });
            return;
        }

        if (WindowState == FormWindowState.Minimized)
        {
            NativeMethods.ShowWindow(Handle, NativeMethods.SW_RESTORE);
        }

        Show();
        Activate();
        NativeMethods.SetForegroundWindow(Handle);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int useDarkMode = 1;
        _ = NativeMethods.DwmSetWindowAttribute(
            Handle,
            NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE,
            ref useDarkMode,
            sizeof(int));
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await InitializeHostAsync();
    }

    private async Task InitializeHostAsync()
    {
        int port;
        try
        {
            port = await _nodeHost.StartAsync();
        }
        catch (Exception ex)
        {
            if (_isShuttingDown || IsDisposed)
            {
                return;
            }
            ShowFatalError($"バックエンドサーバーの起動に失敗しました。\n\n{ex.Message}");
            await ForceCloseAsync();
            return;
        }

        if (_isShuttingDown || IsDisposed || _webView.IsDisposed)
        {
            return;
        }

        try
        {
            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                DesktopConstants.LocalAppDataDirName,
                DesktopConstants.WebView2DataSubDir);

            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder);

            if (_isShuttingDown || IsDisposed || _webView.IsDisposed)
            {
                return;
            }

            CoreWebView2ControllerOptions controllerOptions = env.CreateCoreWebView2ControllerOptions();
            controllerOptions.DefaultBackgroundColor = DesktopConstants.BackgroundColor;

            await _webView.EnsureCoreWebView2Async(env, controllerOptions);

            if (_isShuttingDown || IsDisposed || _webView.IsDisposed)
            {
                return;
            }

            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
            _webView.CoreWebView2.NewWindowRequested += OnWebViewNewWindowRequested;
            _webView.NavigationCompleted += OnWebViewNavigationCompleted;
            _webView.Source = new Uri($"http://127.0.0.1:{port}/");
        }
        catch (Exception ex)
        {
            if (_isShuttingDown || IsDisposed)
            {
                return;
            }
            ShowFatalError(
                "WebView2 ランタイムの初期化に失敗しました。\nMicrosoft Edge WebView2 Runtime が導入されているか確認してください。\n\n" + ex.Message);
            await ForceCloseAsync();
        }
    }

    private void OnWebViewNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? uri))
        {
            return;
        }

        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch
        {
            // Ignore if default browser launch fails.
        }
    }

    private void OnWebViewNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_initialNavigationShown)
        {
            return;
        }
        _initialNavigationShown = true;
        _webView.Visible = true;
    }

    protected override async void OnFormClosing(FormClosingEventArgs e)
    {
        if (_shutdownCompleted)
        {
            base.OnFormClosing(e);
            return;
        }

        e.Cancel = true;
        if (_isShuttingDown)
        {
            return;
        }
        _isShuttingDown = true;

        Point loc = WindowState == FormWindowState.Normal ? Location : RestoreBounds.Location;
        WindowStateStore.SaveLocation(loc);

        Hide();
        _onBeginShutdown?.Invoke();

        if (!_webView.IsDisposed)
        {
            Controls.Remove(_webView);
            _webView.Dispose();
        }

        await _nodeHost.ShutdownGracefullyAsync();

        _shutdownCompleted = true;
        if (!IsDisposed)
        {
            Close();
        }
    }

    private async Task ForceCloseAsync()
    {
        _isShuttingDown = true;
        await _nodeHost.ShutdownGracefullyAsync();
        _shutdownCompleted = true;
        if (!IsDisposed)
        {
            Close();
        }
    }

    private void ApplyProcessIcon()
    {
        string? processPath = Environment.ProcessPath;
        if (string.IsNullOrEmpty(processPath) || !File.Exists(processPath))
        {
            return;
        }

        try
        {
            Icon? extracted = Icon.ExtractAssociatedIcon(processPath);
            if (extracted is not null)
            {
                Icon = extracted;
            }
        }
        catch
        {
            // Fall back to default window icon if extraction fails.
        }
    }

    private void ShowFatalError(string message)
    {
        MessageBox.Show(
            this,
            message,
            DesktopConstants.AppDisplayName,
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _webView.Dispose();
            _nodeHost.Dispose();
        }
        base.Dispose(disposing);
    }
}

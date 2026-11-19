using System.Drawing;

namespace AlexaAlarmSkip.Desktop;

/// <summary>
/// Shared constants for the desktop WebView2 host application.
/// </summary>
internal static class DesktopConstants
{
    internal const string AppDisplayName = "Alexa アラーム管理";
    internal const string AppUserModelId = "jp.personal.alexaalarmskips.desktop";
    internal const string MutexName = @"Local\AlexaAlarmSkip_DesktopHost_SingleInstance";
    internal const string PipeName = "AlexaAlarmSkip_DesktopHost_ActivatePipe";
    internal const string ActivateMessage = "ACTIVATE";
    internal const int PipeConnectTimeoutMs = 1_500;

    internal const int InitialClientWidth = 420;
    internal const int InitialClientHeight = 720;
    internal const int MinClientWidth = 320;
    internal const int MinClientHeight = 480;

    internal static readonly Color BackgroundColor = Color.FromArgb(255, 0x0E, 0x11, 0x17);

    internal const string LocalAppDataDirName = "AlexaAlarmSkip";
    internal const string WebView2DataSubDir = "WebView2";
    internal const string WindowStateFileName = "window-state.json";

    internal const string EntryScriptRelPath = @"prototype\web-ui.js";
    internal const string DesktopHostArg = "--desktop-host";
    internal const string NodeReadyPrefix = "__ALEXA_HOST_READY__ ";
    internal const int MaxRepoRootSearchDepth = 6;
    internal const int NodeStartupTimeoutMs = 15_000;
    internal const int ShutdownHttpTimeoutMs = 3_000;
    internal const int NodeGracefulExitTimeoutMs = 35_000;
}

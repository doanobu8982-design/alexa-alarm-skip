namespace AlexaAlarmSkip.Desktop;

/// <summary>
/// Application entry point for the WebView2 desktop host.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main()
    {
        _ = NativeMethods.SetCurrentProcessExplicitAppUserModelID(DesktopConstants.AppUserModelId);

        using var guard = new SingleInstanceGuard();
        if (!guard.TryAcquireOrNotifyExisting())
        {
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetColorMode(SystemColorMode.Dark);

        using var form = new MainForm(guard.Release);
        guard.StartActivationListener(() => form.BringToFrontFromActivation());
        Application.Run(form);
    }
}

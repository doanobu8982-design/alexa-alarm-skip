using System.Drawing;
using System.Text.Json;

namespace AlexaAlarmSkip.Desktop;

/// <summary>
/// Persists and validates the desktop window coordinates across sessions and monitor changes.
/// </summary>
internal static class WindowStateStore
{
    private sealed record WindowPositionDto(int X, int Y);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    internal static string GetStateFilePath()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(localAppData, DesktopConstants.LocalAppDataDirName, DesktopConstants.WindowStateFileName);
    }

    /// <summary>
    /// Loads the saved window coordinates if its title bar intersects any active screen's working area;
    /// otherwise returns the centered position on the primary screen.
    /// </summary>
    public static Point LoadValidLocation(Size windowSize)
    {
        Point fallback = GetPrimaryCenteredLocation(windowSize);
        string filePath = GetStateFilePath();
        if (!File.Exists(filePath))
        {
            return fallback;
        }

        try
        {
            string raw = File.ReadAllText(filePath);
            WindowPositionDto? dto = JsonSerializer.Deserialize<WindowPositionDto>(raw, JsonOptions);
            if (dto is null)
            {
                return fallback;
            }

            int titleBarWidth = Math.Max(40, Math.Min(windowSize.Width - 40, 160));
            var titleBarRect = new Rectangle(dto.X + 20, dto.Y, titleBarWidth, 40);
            foreach (Screen screen in Screen.AllScreens)
            {
                if (screen.WorkingArea.IntersectsWith(titleBarRect))
                {
                    return new Point(dto.X, dto.Y);
                }
            }

            return fallback;
        }
        catch
        {
            return fallback;
        }
    }

    /// <summary>
    /// Saves the window coordinates (x, y) to local application data.
    /// </summary>
    public static void SaveLocation(Point location)
    {
        try
        {
            string filePath = GetStateFilePath();
            string? dir = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            string json = JsonSerializer.Serialize(new WindowPositionDto(location.X, location.Y), JsonOptions);
            string tempPath = filePath + ".tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, filePath, overwrite: true);
        }
        catch
        {
            // Never block application exit if saving window coordinates fails.
        }
    }

    private static Point GetPrimaryCenteredLocation(Size windowSize)
    {
        Rectangle area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        int x = area.Left + Math.Max(0, (area.Width - windowSize.Width) / 2);
        int y = area.Top + Math.Max(0, (area.Height - windowSize.Height) / 2);
        return new Point(x, y);
    }
}

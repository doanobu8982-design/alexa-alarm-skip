param(
    [switch]$DryRun,
    [ValidateSet('Both', 'Repo', 'Desktop')]
    [string]$Scope = 'Both'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppUserModelId = 'jp.personal.alexaalarmskips.desktop'
$AppDisplayName = 'Alexa アラーム管理'
$ShortcutFileName = "$AppDisplayName.lnk"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetExe = Join-Path $RepoRoot 'dist\desktop\AlexaAlarmSkip.exe'
$IconFile = Join-Path $RepoRoot 'assets\icons\app.ico'
$IconLocation = "$IconFile,0"

if (-not (Test-Path -LiteralPath $TargetExe -PathType Leaf)) {
    if ($DryRun) {
        Write-Warning "デスクトップアプリ実行ファイルが未ビルドです（先に npm run build:launcher を実行してください）: $TargetExe"
    } else {
        Write-Error "デスクトップアプリ実行ファイルが見つかりません。先に npm run build:launcher を実行してください: $TargetExe"
        exit 1
    }
}
if (-not (Test-Path -LiteralPath $IconFile -PathType Leaf)) {
    Write-Error "アイコンファイルが見つかりません: $IconFile"
    exit 1
}

$Targets = New-Object System.Collections.Generic.List[string]
if ($Scope -eq 'Both' -or $Scope -eq 'Repo') {
    $Targets.Add((Join-Path $RepoRoot $ShortcutFileName))
}
if ($Scope -eq 'Both' -or $Scope -eq 'Desktop') {
    $DesktopDir = [Environment]::GetFolderPath('Desktop')
    if ([string]::IsNullOrWhiteSpace($DesktopDir)) {
        Write-Error "デスクトップフォルダのパスを取得できませんでした。"
        exit 1
    }
    $Targets.Add((Join-Path $DesktopDir $ShortcutFileName))
}

if ($DryRun) {
    Write-Output "Dry-run mode enabled (Scope=$Scope)."
    Write-Output "TargetPath      : $TargetExe"
    Write-Output "WorkingDirectory: $RepoRoot"
    Write-Output "IconLocation    : $IconLocation"
    Write-Output "AppUserModelID  : $AppUserModelId"
    foreach ($lnkPath in $Targets) {
        $exists = Test-Path -LiteralPath $lnkPath -PathType Leaf
        Write-Output ("Shortcut        : {0} (Exists={1})" -f $lnkPath, $exists)
    }
    exit 0
}

$ShortcutHelperCode = @'
using System;
using System.Runtime.InteropServices;

public static class ShortcutAppIdHelper
{
    private static readonly Guid CLSID_ShellLink = new Guid("00021401-0000-0000-C000-000000000046");
    private static readonly Guid PKEY_FMTID_APPUSERMODEL = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private const uint STGM_READWRITE = 0x00000002;
    private const uint STGM_READ = 0x00000000;

    public static void SetAppUserModelId(string lnkPath, string appId)
    {
        Type shellLinkType = Type.GetTypeFromCLSID(CLSID_ShellLink);
        object linkObj = Activator.CreateInstance(shellLinkType);
        IPersistFile persistFile = null;
        IPropertyStore propStore = null;
        try
        {
            persistFile = (IPersistFile)linkObj;
            int hr = persistFile.Load(lnkPath, STGM_READWRITE);
            if (hr != 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            propStore = (IPropertyStore)linkObj;
            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = PKEY_FMTID_APPUSERMODEL;
            key.pid = 5;

            PROPVARIANT pv = new PROPVARIANT();
            pv.vt = 31; // VT_LPWSTR
            pv.pwszVal = Marshal.StringToCoTaskMemUni(appId);
            try
            {
                hr = propStore.SetValue(ref key, ref pv);
                if (hr != 0)
                {
                    Marshal.ThrowExceptionForHR(hr);
                }
                hr = propStore.Commit();
                if (hr != 0)
                {
                    Marshal.ThrowExceptionForHR(hr);
                }
            }
            finally
            {
                PropVariantClear(ref pv);
            }

            hr = persistFile.Save(lnkPath, true);
            if (hr != 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }
        }
        finally
        {
            if (propStore != null && Marshal.IsComObject(propStore))
            {
                Marshal.ReleaseComObject(propStore);
            }
            if (persistFile != null && Marshal.IsComObject(persistFile))
            {
                Marshal.ReleaseComObject(persistFile);
            }
            if (linkObj != null && Marshal.IsComObject(linkObj))
            {
                Marshal.ReleaseComObject(linkObj);
            }
        }
    }

    public static string GetAppUserModelId(string lnkPath)
    {
        Type shellLinkType = Type.GetTypeFromCLSID(CLSID_ShellLink);
        object linkObj = Activator.CreateInstance(shellLinkType);
        IPersistFile persistFile = null;
        IPropertyStore propStore = null;
        try
        {
            persistFile = (IPersistFile)linkObj;
            int hr = persistFile.Load(lnkPath, STGM_READ);
            if (hr != 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }
            propStore = (IPropertyStore)linkObj;
            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = PKEY_FMTID_APPUSERMODEL;
            key.pid = 5;
            PROPVARIANT pv;
            hr = propStore.GetValue(ref key, out pv);
            if (hr != 0)
            {
                return "";
            }
            try
            {
                if (pv.vt == 31 && pv.pwszVal != IntPtr.Zero)
                {
                    return Marshal.PtrToStringUni(pv.pwszVal);
                }
                return "";
            }
            finally
            {
                PropVariantClear(ref pv);
            }
        }
        finally
        {
            if (propStore != null && Marshal.IsComObject(propStore))
            {
                Marshal.ReleaseComObject(propStore);
            }
            if (persistFile != null && Marshal.IsComObject(persistFile))
            {
                Marshal.ReleaseComObject(persistFile);
            }
            if (linkObj != null && Marshal.IsComObject(linkObj))
            {
                Marshal.ReleaseComObject(linkObj);
            }
        }
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PROPVARIANT pvar);

    [ComImport]
    [Guid("0000010b-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        int GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPVARIANT
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public IntPtr pwszVal;
        public IntPtr padding;
    }
}
'@

if (-not ('ShortcutAppIdHelper' -as [type])) {
    Add-Type -TypeDefinition $ShortcutHelperCode -Language CSharp
}

$WshShell = New-Object -ComObject WScript.Shell
try {
    foreach ($lnkPath in $Targets) {
        $action = if (Test-Path -LiteralPath $lnkPath -PathType Leaf) { 'Updating' } else { 'Creating' }
        $parentDir = Split-Path -Parent $lnkPath
        if (-not (Test-Path -LiteralPath $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        $shortcut = $WshShell.CreateShortcut($lnkPath)
        try {
            $shortcut.TargetPath = $TargetExe
            $shortcut.Arguments = ''
            $shortcut.WorkingDirectory = $RepoRoot
            $shortcut.IconLocation = $IconLocation
            $shortcut.WindowStyle = 1
            $shortcut.Description = 'Alexa アラーム管理アプリを起動'
            $shortcut.Save()
        } finally {
            if ($shortcut -and [System.Runtime.InteropServices.Marshal]::IsComObject($shortcut)) {
                [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
            }
        }

        [ShortcutAppIdHelper]::SetAppUserModelId($lnkPath, $AppUserModelId)
        Write-Output ("{0}: {1}" -f $action, $lnkPath)
    }
} finally {
    if ($WshShell -and [System.Runtime.InteropServices.Marshal]::IsComObject($WshShell)) {
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($WshShell) | Out-Null
    }
}

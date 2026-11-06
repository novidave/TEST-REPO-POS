; Inno Setup 6 script for the TEST-REPO-POS inventory agent (per-user install, no administrator rights).
; Build on Windows after `npm run package:win`:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\test-repo-pos.iss
; Output: release\installer\TEST-REPO-POS-Setup-<version>.exe (unsigned unless you sign it).
#define AppName "TEST-REPO-POS Inventory Agent"
#define AppVersion "0.1.0"
#define AppExe "CACADUU-Inventory.exe"
#define SourceDir "..\..\release\CACADUU-Inventory-win32-x64"

[Setup]
AppId={{6C3F9C1E-6E0B-4C2A-9E8E-3E2A6E5B7A11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=novidave
DefaultDirName={localappdata}\Programs\TEST-REPO-POS
DefaultGroupName=TEST-REPO-POS
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\release\installer
OutputBaseFilename=TEST-REPO-POS-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Restart Manager closes a running agent (including one minimised to the tray) before files are replaced.
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\{#AppExe}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "slovak"; MessagesFile: "compiler:Languages\Slovak.isl"
Name: "czech"; MessagesFile: "compiler:Languages\Czech.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The complete packaged folder: Electron runtime, licence files, ASAR and the unpacked native SQLite module.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Remove the sign-in entry the app may have registered (Settings → Start the agent when I sign in).
Filename: "{app}\{#AppExe}"; Parameters: "--unregister-login-item"; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterLoginItem"

; Settings, connections, encrypted credentials and export history live in %APPDATA% and are kept on uninstall.
; Exported stock.csv/manifest.json folders are never deleted by the installer.

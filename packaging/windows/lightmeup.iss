; Inno Setup script for the LightMeUp Windows installer.
; Built by packaging/build.py, which passes AppVersion, SourceDir (the PyInstaller folder),
; OutputDir and RepoRoot on the iscc command line.

[Setup]
AppId={{8F3C2A51-6B1E-4C7D-9A2F-5E4B7C1D2A90}
AppName=LightMeUp
AppVersion={#AppVersion}
AppPublisher=Pascal Seguin
AppPublisherURL=https://github.com/pascalseguin/lightmeup
AppSupportURL=https://github.com/pascalseguin/lightmeup/issues
DefaultDirName={autopf}\LightMeUp
DefaultGroupName=LightMeUp
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=LightMeUp-Setup-{#AppVersion}-windows-x64
SetupIconFile={#RepoRoot}\packaging\icons\lightmeup.ico
UninstallDisplayIcon={app}\LightMeUp.exe
LicenseFile={#RepoRoot}\LICENSE
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\LightMeUp"; Filename: "{app}\LightMeUp.exe"; Comment: "Animatronic and light show builder"
Name: "{group}\Arduino receiver sketches"; Filename: "{app}\arduino"
Name: "{group}\Uninstall LightMeUp"; Filename: "{uninstallexe}"
Name: "{autodesktop}\LightMeUp"; Filename: "{app}\LightMeUp.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\LightMeUp.exe"; Description: "Start LightMeUp now"; Flags: nowait postinstall skipifsilent

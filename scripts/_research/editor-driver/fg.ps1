Add-Type -Name F -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
$s = New-Object System.Text.StringBuilder 256; [void][U.F]::GetWindowText([U.F]::GetForegroundWindow(), $s, 256); $s.ToString()

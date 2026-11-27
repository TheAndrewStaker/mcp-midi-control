# Fractal editor driver over Windows UI Automation (JUCE exposes its widgets).
# No focus change, no mouse, no OCR: the editor can sit behind other windows.
#
# Usage: powershell -NoProfile -File uia.ps1 [-Title AM4-Edit] "<cmd>; <cmd>; ..."
#   read                 JSON of the open block page: title, tab, channel, and
#                        every control {label, kind, display, pos (0..10 slider)}
#   block <name>         select a placed block in the chain ("Amp", "Reverb")
#   press <name>         invoke a button / tab / menu item by exact name
#                        ("Speaker", "Preamp", "B" for channel B)
#   tree                 raw dump (type | name | value | patterns | rect)
#   wait <ms>            pause (the editor repaints after the device answers)
param([string]$Title = 'AM4-Edit', [Parameter(Position = 0)][string]$Script = 'read')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition
$VP = [System.Windows.Automation.ValuePattern]::Pattern
$RVP = [System.Windows.Automation.RangeValuePattern]::Pattern
$IP = [System.Windows.Automation.InvokePattern]::Pattern
$SIP = [System.Windows.Automation.SelectionItemPattern]::Pattern
$TP = [System.Windows.Automation.TogglePattern]::Pattern

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "$Title*" -or $_.ProcessName -eq $Title } | Select-Object -First 1
if (-not $proc) { throw "no window for '$Title'" }
# Pick the window by its exact title: JUCE editors also own drop-shadow
# windows, and Process.MainWindowHandle can land on one of those (Axe-Edit).
Add-Type -Name FW -Namespace U2 -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);'
$hwnd = [U2.FW]::FindWindow($null, $Title)
if ($hwnd -eq [IntPtr]::Zero -and $proc.MainWindowTitle) { $hwnd = [U2.FW]::FindWindow($null, $proc.MainWindowTitle) }
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle }
$root = $AE::FromHandle($hwnd)

function All { $root.FindAll($Scope::Descendants, $True_) }
function Val($e) { try { $e.GetCurrentPattern($VP).Current.Value } catch { $null } }
function Toggled($e) { try { $e.GetCurrentPattern($TP).Current.ToggleState -eq 'On' } catch { $false } }

function Read-Page {
  $els = @(All)
  $controls = New-Object System.Collections.ArrayList
  $tab = $null; $channel = $null; $title = $null; $bypassed = $null; $tabs = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $els.Count; $i++) {
    $e = $els[$i]; $c = $e.Current; $t = $c.ControlType.ProgrammaticName
    # Hidden controls (other LFO sections, other types' knobs) stay in the
    # tree with empty text; only what the page shows counts.
    if ($c.IsOffscreen -or $c.BoundingRectangle.Width -le 0) { continue }
    if ($t -eq 'ControlType.Slider' -and $c.Name) {
      # A labelled slider group is followed (after its text label) by the
      # unnamed value slider that carries the display string and position.
      $label = $c.Name -replace ', Modifier \w+$', ''
      for ($j = $i + 1; $j -le [math]::Min($i + 4, $els.Count - 1); $j++) {
        $n = $els[$j]
        if ($n.Current.ControlType.ProgrammaticName -eq 'ControlType.Slider' -and -not $n.Current.Name) {
          $pos = $null; try { $pos = [math]::Round($n.GetCurrentPattern($RVP).Current.Value, 6) } catch {}
          [void]$controls.Add([ordered]@{ label = $label; kind = 'slider'; display = (Val $n); pos = $pos; modifier = ($c.Name -match ', Modifier ') })
          $i = $j; break
        }
      }
    } elseif ($t -eq 'ControlType.Custom' -and $c.Name) {
      # Dropdown: a named group, then the button that carries the value.
      $kid = $els[$i + 1]
      if ($kid -and $kid.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') {
        [void]$controls.Add([ordered]@{ label = $c.Name; kind = 'dropdown'; display = $kid.Current.Name; enabled = $kid.Current.IsEnabled })
        $i++
      }
    } elseif ($t -eq 'ControlType.Button' -and $c.Name -eq 'Bypass') {
      # The block's Bypass switch is a same-size toggle: NEVER treat it as a tab
      # (pressing it sends a bypass request; that caused the 2026-11-26 stall).
      $bypassed = (Toggled $e)
    } elseif ($t -eq 'ControlType.Button' -and $c.Name -and $c.BoundingRectangle.Height -ge 46 -and $c.BoundingRectangle.Height -le 54 -and $c.BoundingRectangle.Width -ge 100 -and ($e.GetSupportedPatterns() -contains $TP)) {
      # Page tabs are the ~154x50 toggle buttons above the block page.
      [void]$tabs.Add($c.Name)
      if (Toggled $e) { $tab = $c.Name }
    } elseif ($t -eq 'ControlType.Button' -and (Toggled $e) -and $c.Name -match '^[A-D]$') {
      $channel = $c.Name
    } elseif ($t -eq 'ControlType.Text' -and $c.Name -match '^FX\d+: ') { $title = $c.Name }
  }
  [ordered]@{ block = $title; tab = $tab; tabs = $tabs; channel = $channel; bypassed = $bypassed; controls = $controls } | ConvertTo-Json -Depth 4 -Compress
}

function Find-Named($name, [string[]]$types) {
  foreach ($e in (All)) {
    $c = $e.Current
    if ($c.Name -eq $name -and ($types.Count -eq 0 -or $types -contains $c.ControlType.ProgrammaticName)) { return $e }
  }
  throw "no control named '$name'"
}

function Press($e) {
  try { $e.GetCurrentPattern($SIP).Select(); return } catch {}
  $e.GetCurrentPattern($IP).Invoke()
}

foreach ($cmd in ($Script -split ';')) {
  $cmd = $cmd.Trim(); if (-not $cmd) { continue }
  $verb, $arg = $cmd -split '\s+', 2
  switch ($verb) {
    'read' { Read-Page }
    'press' { if ($arg -eq 'Bypass') { throw 'refusing to press Bypass: it changes the device' }; Press (Find-Named $arg @('ControlType.Button', 'ControlType.MenuItem', 'ControlType.RadioButton')); Start-Sleep -Milliseconds 300 }
    'block' {
      # The chain lists first in the tree; the block picker grid below reuses
      # the same "Grid row r column c: Name 1A, State" names, so take the first.
      # Retry for ~3 s: right after a set_block the chain has not redrawn yet.
      $hit = $null
      for ($try = 0; $try -lt 10 -and -not $hit; $try++) {
        $hit = All | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.RadioButton' -and $_.Current.Name -match "^Grid row \d+ column \d+: $([regex]::Escape($arg)) \d" } | Select-Object -First 1
        if (-not $hit) { Start-Sleep -Milliseconds 300 }
      }
      if (-not $hit) { throw "no placed block '$arg'" }
      Press $hit; Start-Sleep -Milliseconds 500
    }
    'wait' { Start-Sleep -Milliseconds ([int]$arg) }
    'tree' {
      foreach ($e in (All)) {
        $c = $e.Current
        $p = ($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern', '' }) -join ','
        '{0} | {1} | {2} | {3} | {4}' -f ($c.ControlType.ProgrammaticName -replace 'ControlType.', ''), $c.Name, (Val $e), $p, $c.BoundingRectangle
      }
    }
    default { throw "unknown command '$verb'" }
  }
}

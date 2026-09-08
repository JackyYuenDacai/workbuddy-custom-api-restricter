# Read only the focused control and its ancestry. Never read Value/Text patterns.
param([long]$WindowId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$element = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $element) { throw 'No focused control' }
$current = $element.Current
$within = $false
$terminal = $false
$parent = $element
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
for ($depth = 0; $null -ne $parent -and $depth -lt 32; $depth++) {
    $p = $parent.Current
    if (($p.Name + ' ' + $p.ClassName + ' ' + $p.AutomationId) -match '(?i)(\bxterm\b|\bterminal\b|\bdevtools\b|developer tools|终端|終端)') { $terminal = $true }
    if ($p.NativeWindowHandle -eq $WindowId) { $within = $true; break }
    $parent = $walker.GetParent($parent)
}
$bounds = $current.BoundingRectangle
@{
    available = $true
    within_target = $within
    runtime_id = @($element.GetRuntimeId()) -join '.'
    process_id = $current.ProcessId
    control_type = $current.ControlType.ProgrammaticName
    name = $(if ($current.IsPassword) { '' } else { $current.Name.Substring(0, [Math]::Min(160, $current.Name.Length)) })
    is_password = $current.IsPassword
    terminal = $terminal
    keyboard_focus = $current.HasKeyboardFocus
    screen_rect = @{ left = $bounds.Left; top = $bounds.Top; right = $bounds.Right; bottom = $bounds.Bottom }
} | ConvertTo-Json -Compress -Depth 4
